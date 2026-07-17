import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskQueue } from "../TaskQueue.ts";
import { OctoStore, sha256Hex } from "../store/index.ts";

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  it("returns tasks by taskId and ref", () => {
    const task = queue.queueTask("beacon-1", "shell", { cmd: "whoami" });
    expect(queue.getTask(task.taskId)).toBe(task);
    expect(queue.getTaskByRef(task.ref)).toBe(task);
    expect(queue.getTask("unknown-id")).toBeUndefined();
    expect(queue.getTaskByRef("unknown-ref")).toBeUndefined();
  });

  it("markDelivered updates state", () => {
    const task = queue.queueTask("beacon-2", "shell", { cmd: "id" });
    expect(queue.markDelivered(task.taskId)).toBe(true);
    expect(queue.getTask(task.taskId)?.state).toBe("delivered");
  });

  it("completeTask enforces ownership and stores an in-memory result", () => {
    const task = queue.queueTask("beacon-3", "shell", { cmd: "echo ok" });
    queue.markDelivered(task.taskId);
    expect(queue.completeTask("beacon-other", task.taskId, "stolen")).toBe(
      "wrong_owner",
    );
    expect(queue.completeTask("beacon-3", task.taskId, "ok output")).toBe(
      "completed",
    );
    expect(queue.getTask(task.taskId)?.state).toBe("completed");
    expect(queue.getTask(task.taskId)?.result).toBe("ok output");
  });

  it("accepts exact in-memory duplicates and rejects conflicts", () => {
    const task = queue.queueTask("beacon-dup", "ping");
    expect(queue.completeTask("beacon-dup", task.taskId, "same")).toBe(
      "completed",
    );
    expect(queue.completeTask("beacon-dup", task.taskId, "same")).toBe(
      "duplicate",
    );
    expect(queue.completeTask("beacon-dup", task.taskId, "different")).toBe(
      "conflict",
    );
    expect(queue.getTask(task.taskId)?.result).toBe("same");
  });

  it("handles many tasks with indexed lookups", () => {
    const tasks: ReturnType<typeof queue.queueTask>[] = [];
    for (let i = 0; i < 1_000; i++) {
      tasks.push(queue.queueTask("beacon-bulk", "ping"));
    }
    for (const task of tasks) {
      expect(queue.getTask(task.taskId)).toBe(task);
      expect(queue.getTaskByRef(task.ref)).toBe(task);
    }
  });

  it("uses exclusive in-memory claims and honors preferred channels", () => {
    const shared = queue.queueTask("beacon-lease", "ping");
    const oidcOnly = queue.queueTask(
      "beacon-lease",
      "shell",
      { cmd: "id" },
      "oidc",
    );

    const http = queue.claimDeliveries(
      "beacon-lease",
      "http",
      60_000,
    );
    expect(http.map(({ task }) => task.taskId)).toEqual([shared.taskId]);
    expect(
      queue.claimDeliveries("beacon-lease", "codespaces", 60_000),
    ).toHaveLength(0);

    queue.finishDeliveries(http, "delivered");
    expect(queue.getTask(shared.taskId)?.state).toBe("delivered");
    expect(
      queue.claimDeliveries("beacon-lease", "oidc", 60_000)
        .map(({ task }) => task.taskId),
    ).toEqual([oidcOnly.taskId]);
  });
});

describe("TaskQueue with OctoStore", () => {
  let dataDir: string;
  let store: OctoStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "octoc2-queue-"));
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    store.upsertBeacon({
      beaconId: "beacon-a",
      issueNumber: null,
      x25519PublicKey: "x25519-a",
      hostname: "host-a",
      username: "user-a",
      os: "linux",
      arch: "x64",
      lastSeq: 1,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  });

  it("hydrates pending, delivered, and failed task state after restart", () => {
    let persistentQueue = new TaskQueue(store);
    const pending = persistentQueue.queueTask(
      "beacon-a",
      "ping",
      {},
      "issues",
    );
    const delivered = persistentQueue.queueTask("beacon-a", "shell", {
      cmd: "id",
    });
    const failed = persistentQueue.queueTask("beacon-a", "exec", { cmd: "id" });
    expect(persistentQueue.markDelivered(delivered.taskId)).toBe(true);
    expect(persistentQueue.markFailed(failed.taskId)).toBe(true);

    store.close();
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    persistentQueue = new TaskQueue(store);

    expect(persistentQueue.getTask(pending.taskId)).toMatchObject({
      state: "pending",
      args: {},
      preferredChannel: "issues",
    });
    expect(persistentQueue.getTask(delivered.taskId)).toMatchObject({
      state: "delivered",
    });
    expect(persistentQueue.getTask(delivered.taskId)?.deliveredAt).not.toBeNull();
    expect(persistentQueue.getTask(failed.taskId)).toMatchObject({
      state: "failed",
    });
    expect(persistentQueue.getTaskByRef(pending.ref)?.taskId).toBe(
      pending.taskId,
    );
  });

  it("returns delivered tasks for retry only after their lease expires", () => {
    const persistentQueue = new TaskQueue(store);
    const task = persistentQueue.queueTask(
      "beacon-a",
      "ping",
      {},
      "issues",
    );
    const claim = store.claimDelivery({
      taskId: task.taskId,
      beaconId: "beacon-a",
      channel: "issues",
      workerId: "server:issues",
      leaseDurationMs: 1_000,
      now: "2099-07-16T12:00:00.000Z",
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected lease");
    expect(store.finishDelivery({
      leaseToken: claim.lease.leaseToken,
      outcome: "delivered",
      finishedAt: "2099-07-16T12:00:00.100Z",
    })).toBe(true);
    persistentQueue.refreshFromStore(task.taskId);

    expect(
      persistentQueue.getDeliverableTasks(
        "beacon-a",
        "issues",
        "2099-07-16T12:00:00.500Z",
      ),
    ).toHaveLength(0);
    expect(
      persistentQueue.getDeliverableTasks(
        "beacon-a",
        "issues",
        "2099-07-16T12:00:01.100Z",
      ).map((candidate) => candidate.taskId),
    ).toEqual([task.taskId]);
    expect(
      persistentQueue.getDeliverableTasks(
        "beacon-a",
        "branch",
        "2099-07-16T12:00:01.100Z",
      ),
    ).toHaveLength(0);
  });

  it("prevents competing transports from claiming one task", () => {
    const persistentQueue = new TaskQueue(store);
    const task = persistentQueue.queueTask("beacon-a", "ping");

    const http = persistentQueue.claimDeliveries(
      "beacon-a",
      "http",
      60_000,
    );
    expect(http.map(({ task: claimed }) => claimed.taskId)).toEqual([
      task.taskId,
    ]);
    expect(
      persistentQueue.claimDeliveries(
        "beacon-a",
        "codespaces",
        60_000,
      ),
    ).toHaveLength(0);

    persistentQueue.finishDeliveries(http, "delivered");
    expect(persistentQueue.getTask(task.taskId)?.state).toBe("delivered");
    expect(store.getDeliveryLease(task.taskId)?.channel).toBe("http");
    expect(
      persistentQueue.claimDeliveries("beacon-a", "oidc", 60_000),
    ).toHaveLength(0);
  });

  it("releases transient failures for retry on the same allowed channel", () => {
    const persistentQueue = new TaskQueue(store);
    const task = persistentQueue.queueTask(
      "beacon-a",
      "ping",
      {},
      "oidc",
    );
    expect(
      persistentQueue.claimDeliveries("beacon-a", "http", 60_000),
    ).toHaveLength(0);

    const first = persistentQueue.claimDeliveries(
      "beacon-a",
      "oidc",
      60_000,
    );
    persistentQueue.finishDeliveries(
      first,
      "transient_failure",
      new Error("response construction failed"),
    );
    expect(store.getDeliveryLease(task.taskId)).toBeUndefined();

    const retry = persistentQueue.claimDeliveries(
      "beacon-a",
      "oidc",
      60_000,
    );
    expect(retry.map(({ task: claimed }) => claimed.taskId)).toEqual([
      task.taskId,
    ]);
  });

  it("fails closed for raw completion and persists verified idempotent results", () => {
    store.provisionIdentityKey({
      keyId: "ed25519-a-v1",
      beaconId: "beacon-a",
      publicKey: "ed25519-public-a",
      provisionedBy: "operator:test",
    });
    let persistentQueue = new TaskQueue(store);
    const task = persistentQueue.queueTask("beacon-a", "ping");
    const canonicalResult = JSON.stringify({
      beaconId: "beacon-a",
      taskId: task.taskId,
      success: true,
      output: "pong",
    });
    const completion = {
      taskId: task.taskId,
      beaconId: "beacon-a",
      canonicalResult,
      canonicalDigest: sha256Hex(canonicalResult),
      signature: "verified-signature",
      signatureKeyId: "ed25519-a-v1",
      resultId: "result-a",
      source: {
        channel: "issues",
        messageId: "comment-100",
      },
    };

    expect(
      persistentQueue.completeTask("beacon-a", task.taskId, canonicalResult),
    ).toBe("verification_required");
    expect(persistentQueue.getTask(task.taskId)?.state).toBe("pending");
    expect(persistentQueue.completeVerifiedTask(completion).status).toBe(
      "completed",
    );
    expect(persistentQueue.completeVerifiedTask(completion).status).toBe(
      "exact_duplicate",
    );
    expect(
      persistentQueue.completeVerifiedTask({
        ...completion,
        canonicalResult: JSON.stringify({
          beaconId: "beacon-a",
          taskId: task.taskId,
          success: false,
        }),
        canonicalDigest: sha256Hex(
          JSON.stringify({
            beaconId: "beacon-a",
            taskId: task.taskId,
            success: false,
          }),
        ),
        signature: "different-signature",
        resultId: "result-conflict",
      }).status,
    ).toBe("conflicting_duplicate");

    store.close();
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    persistentQueue = new TaskQueue(store);
    expect(persistentQueue.getTask(task.taskId)).toMatchObject({
      state: "completed",
      result: canonicalResult,
    });
    expect(persistentQueue.completeVerifiedTask(completion).status).toBe(
      "exact_duplicate",
    );
  });

  it("rejects a mismatched canonical digest before store mutation", () => {
    store.provisionIdentityKey({
      keyId: "ed25519-a-v1",
      beaconId: "beacon-a",
      publicKey: "ed25519-public-a",
      provisionedBy: "operator:test",
    });
    const persistentQueue = new TaskQueue(store);
    const task = persistentQueue.queueTask("beacon-a", "ping");

    expect(() =>
      persistentQueue.completeVerifiedTask({
        taskId: task.taskId,
        beaconId: "beacon-a",
        canonicalResult: JSON.stringify({ success: true }),
        canonicalDigest: sha256Hex("different"),
        signature: "verified-signature",
        signatureKeyId: "ed25519-a-v1",
      }),
    ).toThrow("canonicalDigest does not match canonicalResult");
    expect(persistentQueue.getTask(task.taskId)?.state).toBe("pending");
  });

  it("fails closed when persisted state contains an unsupported task kind", () => {
    store.createTask({
      beaconId: "beacon-a",
      kind: "load-module",
      ref: "unsafe-ref",
    });
    expect(() => new TaskQueue(store)).toThrow(
      "Unsupported persisted task kind: load-module",
    );
  });
});
