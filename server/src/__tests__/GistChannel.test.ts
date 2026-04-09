import { describe, it, expect, mock, beforeEach } from "bun:test";
import { GistChannel } from "../channels/GistChannel.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { generateOperatorKeyPair, bytesToBase64 } from "../crypto/sodium.ts";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeOctokit(overrides: Record<string, any> = {}) {
  return {
    rest: {
      gists: {
        list:   mock(async () => ({ data: [] })),
        get:    mock(async () => ({ data: { id: "gist-id", files: {} } })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
        ...(overrides.gists ?? {}),
      },
    },
    ...overrides,
  } as any;
}

describe("GistChannel", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry = new BeaconRegistry("/tmp/gist-channel-test-registry");
    queue    = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("start() and stop() do not throw", () => {
    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit: makeOctokit(),
    });
    ch.start();
    ch.stop();
  });

  it("poll registers beacon from ACK gist", async () => {
    const beaconId = "ack-gist-beacon-1234";
    const beaconKp = await generateOperatorKeyPair();
    const ackContent = JSON.stringify({
      beaconId,
      publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "host", username: "user", os: "linux", arch: "x64",
      checkinAt: new Date().toISOString(),
    });

    const ackFilename = `svc-a-${beaconId.slice(0, 8)}.json`;

    const octokit = makeOctokit({
      gists: {
        list: mock(async () => ({
          data: [{ id: "ack-gist-id", files: { [ackFilename]: { filename: ackFilename } } }],
        })),
        get: mock(async () => ({
          data: {
            id: "ack-gist-id",
            files: { [ackFilename]: { content: ackContent } },
          },
        })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
      },
    });

    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    const beacon = registry.get(beaconId);
    expect(beacon).not.toBeUndefined();
    expect(beacon!.hostname).toBe("host");
    expect(beacon!.publicKey).toBe(await bytesToBase64(beaconKp.publicKey));
  });

  it("poll delivers pending tasks to gist beacon via task gist", async () => {
    const beaconId = "task-gist-beacon-abcd";
    const beaconKp = await generateOperatorKeyPair();
    const pubB64   = await bytesToBase64(beaconKp.publicKey);

    // Register the beacon
    registry.register({
      beaconId, issueNumber: 0, publicKey: pubB64,
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    // Queue a task
    queue.queueTask(beaconId, "shell", { cmd: "whoami" });

    const octokit = makeOctokit({
      gists: {
        list:   mock(async () => ({ data: [] })),
        get:    mock(async () => ({ data: { id: "gist-id", files: {} } })),
        create: mock(async () => ({ data: { id: "task-gist-created" } })),
        delete: mock(async () => ({})),
      },
    });

    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    // Prime the gist-beacon set so the channel knows this is a gist beacon
    (ch as any).gistBeacons.add(beaconId);
    await (ch as any).poll();

    // A task gist should have been created with encrypted tasks
    expect(octokit.rest.gists.create).toHaveBeenCalled();
    const createCall = octokit.rest.gists.create.mock.calls[0]![0] as any;
    const fileKeys = Object.keys(createCall.files as object);
    expect(fileKeys[0]).toMatch(/^svc-t-/);
  });

  it("poll skips ACK gist for already-registered beacon (idempotent)", async () => {
    const beaconId = "idempotent-beacon-1234";
    const beaconKp = await generateOperatorKeyPair();
    const pubB64   = await bytesToBase64(beaconKp.publicKey);

    // Pre-register the beacon
    registry.register({
      beaconId, issueNumber: 0, publicKey: pubB64,
      hostname: "preregistered", username: "u", os: "linux", arch: "x64", seq: 0,
    });

    const ackFilename = `svc-a-${beaconId.slice(0, 8)}.json`;
    const ackContent  = JSON.stringify({
      beaconId, publicKey: pubB64,
      hostname: "preregistered", username: "u", os: "linux", arch: "x64",
      checkinAt: new Date().toISOString(),
    });

    const octokit = makeOctokit({
      gists: {
        list: mock(async () => ({
          data: [{ id: "ack-gist-idempotent", files: { [ackFilename]: { filename: ackFilename } } }],
        })),
        get: mock(async () => ({
          data: {
            id: "ack-gist-idempotent",
            files: { [ackFilename]: { content: ackContent } },
          },
        })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
      },
    });

    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    // Beacon still registered correctly
    const beacon = registry.get(beaconId);
    expect(beacon).not.toBeUndefined();
    expect(beacon!.hostname).toBe("preregistered");

    // No task gist created (queue is empty)
    expect(octokit.rest.gists.create).not.toHaveBeenCalled();
  });

  it("poll skips result gist when task is not found in queue", async () => {
    const beaconId = "orphan-result-beacon-5678";
    const unknownTaskId = "task-does-not-exist";

    const { sealBox: serverSealBox } = await import("../crypto/sodium.ts");
    const resultPayload = JSON.stringify({
      taskId: unknownTaskId, beaconId,
      success: true, output: "whoami", completedAt: new Date().toISOString(),
    });
    const sealed = await serverSealBox(resultPayload, operatorKp.publicKey);

    const resultFilename = `svc-r-${beaconId.slice(0, 8)}.json`;

    const octokit = makeOctokit({
      gists: {
        list: mock(async () => ({
          data: [{ id: "orphan-result-gist", files: { [resultFilename]: { filename: resultFilename } } }],
        })),
        get: mock(async () => ({
          data: {
            id: "orphan-result-gist",
            files: { [resultFilename]: { content: sealed } },
          },
        })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
      },
    });

    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    // poll should not throw even though the task doesn't exist
    await expect((ch as any).poll()).resolves.toBeUndefined();
    // Gist is still deleted as cleanup (GistChannel deletes unconditionally)
    expect(octokit.rest.gists.delete).toHaveBeenCalledTimes(1);
    expect((octokit.rest.gists.delete.mock.calls[0]![0] as any).gist_id).toBe("orphan-result-gist");
  });

  it("poll processes result gist, marks task completed, deletes result gist", async () => {
    const beaconId = "result-gist-beacon-ef56";
    const beaconKp = await generateOperatorKeyPair();

    registry.register({
      beaconId, issueNumber: 0, publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    queue.markDelivered(task.taskId);

    const { sealBox: serverSealBox } = await import("../crypto/sodium.ts");
    const resultPayload = JSON.stringify({
      taskId: task.taskId, beaconId,
      success: true, output: "uid=0(root)", completedAt: new Date().toISOString(),
    });
    const sealed = await serverSealBox(resultPayload, operatorKp.publicKey);

    const resultFilename = `svc-r-${beaconId.slice(0, 8)}.json`;

    const octokit = makeOctokit({
      gists: {
        list: mock(async () => ({
          data: [{ id: "result-gist-id", files: { [resultFilename]: { filename: resultFilename } } }],
        })),
        get: mock(async () => ({
          data: {
            id: "result-gist-id",
            files: { [resultFilename]: { content: sealed } },
          },
        })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
      },
    });

    const ch = new GistChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    const completed = queue.getTask(task.taskId);
    expect(completed?.state).toBe("completed");
    expect(octokit.rest.gists.delete).toHaveBeenCalledTimes(1);
    expect((octokit.rest.gists.delete.mock.calls[0]![0] as any).gist_id).toBe("result-gist-id");
  });
});
