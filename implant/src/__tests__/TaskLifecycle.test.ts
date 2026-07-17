import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createState,
  loadState,
  type BeaconState,
} from "../state/BeaconState.ts";
import {
  retryPendingResults,
  resumeAcknowledgedDirectives,
  submitAndApplyDirective,
} from "../tasks/TaskLifecycle.ts";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
  type TaskResult,
} from "@octoc2/shared";
import { generateKeyPair } from "../crypto/sodium.ts";

const BEACON_ID = "550e8400-e29b-41d4-a716-446655440099";
const X25519_KEYS = await generateKeyPair();
const ED25519_KEYS = await generateEd25519KeyPair();
const KEY_PAIR = {
  publicKey: encodeBase64Url(X25519_KEYS.publicKey),
  secretKey: encodeBase64Url(X25519_KEYS.secretKey),
};
const SIGNING_KEY_PAIR = {
  publicKey: encodeBase64Url(ED25519_KEYS.publicKey),
  secretKey: encodeBase64Url(ED25519_KEYS.secretKey),
  keyId: await ed25519KeyId(ED25519_KEYS.publicKey),
};

let testDir: string;
let originalXdg: string | undefined;
let originalAppData: string | undefined;

beforeEach(async () => {
  testDir = join(tmpdir(), `svc-lifecycle-${crypto.randomUUID()}`);
  originalXdg = process.env["XDG_CONFIG_HOME"];
  originalAppData = process.env["APPDATA"];
  process.env["XDG_CONFIG_HOME"] = testDir;
  process.env["APPDATA"] = testDir;
  await mkdir(join(testDir, "svc"), { recursive: true });
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdg;
  if (originalAppData === undefined) delete process.env["APPDATA"];
  else process.env["APPDATA"] = originalAppData;
  await rm(testDir, { recursive: true, force: true });
});

async function result(
  state: BeaconState,
  taskId: string,
): Promise<TaskResult> {
  const completedAt = new Date().toISOString();
  const unsigned = {
    taskId,
    beaconId: BEACON_ID,
    success: true,
    output: "acknowledge before action",
    completedAt,
  };
  return {
    ...unsigned,
    signature: serializeSignedEnvelope(await signEnvelope(
      createUnsignedEnvelope({
        kind: "task-result",
        signerId: BEACON_ID,
        keyId: SIGNING_KEY_PAIR.keyId,
        issuedAt: completedAt,
        sequence: state.nextIdentitySeq(),
        payload: await createTaskResultSignaturePayload(unsigned),
      }),
      ED25519_KEYS.secretKey,
    )),
  };
}

describe("post-acknowledgement task lifecycle", () => {
  it("does not self-delete after an artifact write without controller acceptance", async () => {
    const state = await createState(
      BEACON_ID,
      KEY_PAIR,
      SIGNING_KEY_PAIR,
    );
    const taskResult = await result(state, "self-delete-task");
    state.completeTask(taskResult, { kind: "self_delete" });
    await state.persist();

    let deleteAttempts = 0;
    const rejected = await submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: false,
        }),
      },
      state,
      result: taskResult,
      selfDeleteAction: async () => {
        deleteAttempts += 1;
        return { success: true, detail: "deleted" };
      },
    });
    expect(rejected).toEqual({
      artifactWritten: true,
      controllerAccepted: false,
      effect: { kind: "none" },
    });
    expect(deleteAttempts).toBe(0);
    expect(state.getTaskLedgerEntry(taskResult.taskId)?.resultSubmittedAt)
      .toBeNull();
  });

  it("leaves a failed self-delete pending and completes it once after restart", async () => {
    const state = await createState(
      BEACON_ID,
      KEY_PAIR,
      SIGNING_KEY_PAIR,
    );
    const taskResult = await result(state, "self-delete-task");
    state.completeTask(taskResult, { kind: "self_delete" });
    await state.persist();

    let deleteAttempts = 0;
    const failed = await submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: true,
        }),
      },
      state,
      result: taskResult,
      selfDeleteAction: async () => {
        deleteAttempts += 1;
        return { success: false, detail: "unlink denied" };
      },
    });
    expect(failed).toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      effect: {
        kind: "self_delete",
        success: false,
        detail: "unlink denied",
      },
    });
    expect(deleteAttempts).toBe(1);
    expect(state.getTaskLedgerEntry(taskResult.taskId)?.directiveAppliedAt)
      .toBeNull();
    expect(await resumeAcknowledgedDirectives(
      state,
      async () => {
        deleteAttempts += 1;
        return { success: true, detail: "deleted too soon" };
      },
      new Set([taskResult.taskId]),
    )).toEqual([]);
    expect(deleteAttempts).toBe(1);

    const reloaded = await loadState(BEACON_ID);
    expect(reloaded).not.toBeNull();
    const resumed = await resumeAcknowledgedDirectives(
      reloaded!,
      async () => {
        deleteAttempts += 1;
        return { success: true, detail: "deleted" };
      },
    );
    expect(resumed).toEqual([{
      taskId: taskResult.taskId,
      effect: {
        kind: "self_delete",
        success: true,
        detail: "deleted",
      },
    }]);
    expect(deleteAttempts).toBe(2);
    expect(reloaded!.getTaskLedgerEntry(taskResult.taskId)?.directiveAppliedAt)
      .not.toBeNull();
    expect(await resumeAcknowledgedDirectives(reloaded!)).toEqual([]);
  });

  it("persists termination intent only after the kill result is accepted", async () => {
    const state = await createState(
      BEACON_ID,
      KEY_PAIR,
      SIGNING_KEY_PAIR,
    );
    const taskResult = await result(state, "kill-task");
    state.completeTask(taskResult, { kind: "kill" });
    await state.persist();

    expect(await submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: false,
        }),
      },
      state,
      result: taskResult,
    })).toEqual({
      artifactWritten: true,
      controllerAccepted: false,
      effect: { kind: "none" },
    });
    expect(state.terminationRequested).toBe(false);
    expect(await submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: true,
        }),
      },
      state,
      result: taskResult,
    })).toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      effect: { kind: "kill" },
    });
    expect(state.terminationRequested).toBe(true);
    const reloaded = await loadState(BEACON_ID);
    expect(reloaded?.terminationRequested).toBe(true);
    expect(await submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: true,
        }),
      },
      state,
      result: taskResult,
    })).toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      effect: { kind: "none" },
    });
  });

  it("rolls back an unpersisted sleep effect and resumes it durably", async () => {
    const state = await createState(
      BEACON_ID,
      KEY_PAIR,
      SIGNING_KEY_PAIR,
    );
    const taskResult = await result(state, "sleep-task");
    state.completeTask(taskResult, {
      kind: "update_sleep",
      seconds: 120,
      jitter: 0.25,
    });
    await state.persist();

    const realPersist = state.persist.bind(state);
    let persistCalls = 0;
    state.persist = async () => {
      persistCalls += 1;
      if (persistCalls === 2) {
        throw new Error("simulated directive persist interruption");
      }
      await realPersist();
    };

    await expect(submitAndApplyDirective({
      submitter: {
        submitResult: async () => ({
          artifactWritten: true,
          controllerAccepted: true,
        }),
      },
      state,
      result: taskResult,
    })).rejects.toThrow("simulated directive persist interruption");
    expect(state.sleepOverride).toBeNull();
    expect(state.getTaskLedgerEntry(taskResult.taskId)?.directiveAppliedAt)
      .toBeNull();

    const reloaded = await loadState(BEACON_ID);
    expect(reloaded?.sleepOverride).toBeNull();
    expect(reloaded?.getTaskLedgerEntry(taskResult.taskId)?.resultSubmittedAt)
      .not.toBeNull();
    expect(await resumeAcknowledgedDirectives(reloaded!)).toEqual([{
      taskId: taskResult.taskId,
      effect: {
        kind: "update_sleep",
        seconds: 120,
        jitter: 0.25,
      },
    }]);
    expect(reloaded?.sleepOverride).toEqual({
      seconds: 120,
      jitter: 0.25,
    });
  });

  it("retries the exact cached signed result after acceptance persistence is interrupted", async () => {
    const state = await createState(
      BEACON_ID,
      KEY_PAIR,
      SIGNING_KEY_PAIR,
    );
    const taskResult = await result(state, "crash-window-task");
    state.completeTask(taskResult);
    await state.persist();

    const submitted: TaskResult[] = [];
    const realPersist = state.persist.bind(state);
    let failNextPersist = true;
    state.persist = async () => {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error("simulated acceptance persistence interruption");
      }
      await realPersist();
    };

    await expect(retryPendingResults({
      submitter: {
        submitResult: async (candidate) => {
          submitted.push(structuredClone(candidate));
          return {
            artifactWritten: true,
            controllerAccepted: true,
          };
        },
      },
      state,
    })).rejects.toThrow("simulated acceptance persistence interruption");
    expect(state.getTaskLedgerEntry(taskResult.taskId)?.resultSubmittedAt)
      .toBeNull();

    const reloaded = await loadState(BEACON_ID);
    expect(reloaded).not.toBeNull();
    const retried = await retryPendingResults({
      submitter: {
        submitResult: async (candidate) => {
          submitted.push(structuredClone(candidate));
          return {
            artifactWritten: true,
            controllerAccepted: true,
          };
        },
      },
      state: reloaded!,
    });

    expect(retried).toEqual([{
      taskId: taskResult.taskId,
      outcome: {
        artifactWritten: true,
        controllerAccepted: true,
        effect: { kind: "none" },
      },
    }]);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(submitted[1]?.signature).toBe(taskResult.signature);
    expect(reloaded!.listPendingResults()).toEqual([]);
  });
});
