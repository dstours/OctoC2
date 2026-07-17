import { afterEach, describe, expect, it, mock } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type _SodiumModule from "libsodium-wrappers";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
  type CheckinPayload,
  type TaskResult,
} from "@octoc2/shared";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { IssuesChannel } from "../channels/IssuesChannel.ts";
import type { SecureChannelServices } from "../channels/ChannelServices.ts";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToString,
  generateOperatorKeyPair,
  sealBox,
} from "../crypto/sodium.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore, sha256Hex } from "../store/index.ts";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof _SodiumModule;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }));
});

describe("IssuesChannel explicit registration ACK", () => {
  it("binds the encrypted ACK to the beacon and registration comment", async () => {
    const operatorKeys = await generateOperatorKeyPair();
    const beaconKeys = await generateOperatorKeyPair();
    const beaconId = "abcdef12-1234-5678-90ab-cdef12345678";
    const checkin = {
      beaconId,
      publicKey: await bytesToBase64(beaconKeys.publicKey),
      hostname: "issues-host",
      username: "issues-user",
      os: "linux",
      arch: "x64",
      pid: 42,
      checkinAt: "2026-07-16T12:00:00.000Z",
      identity: {
        kind: "checkin",
        signerId: beaconId,
        sequence: 1,
      },
    };
    const verifyAndRegisterCheckin = mock(async () => "accepted" as const);
    const createComment = mock(async () => ({ data: { id: 88 } }));
    const octokit = {
      rest: {
        issues: { createComment },
      },
    } as any;
    const channel = new IssuesChannel(
      new BeaconRegistry("/tmp/octoc2-issues-channel"),
      new TaskQueue(),
      {
        owner: "owner",
        repo: "repo",
        token: "token",
        operatorPublicKey: operatorKeys.publicKey,
        operatorSecretKey: operatorKeys.secretKey,
        pollIntervalMs: 60_000,
        octokit,
      },
      {
        store: {} as any,
        identities: { verifyAndRegisterCheckin },
        tasks: {
          acceptSignedResult: mock(async () => ({ status: "completed" })),
        } as any,
      },
    );

    const outcome = await (channel as any).onRegistration({
      commentId: 77,
      messageId: "comment:77:2026-07-16T12:00:00.000Z",
      issueNumber: 42,
      type: "reg",
      ciphertext: await sealBox(
        JSON.stringify(checkin),
        operatorKeys.publicKey,
      ),
    });

    expect(outcome).toEqual({ outcome: "accepted", beaconId });
    expect(verifyAndRegisterCheckin).toHaveBeenCalledWith(
      checkin,
      beaconId,
      1,
      42,
    );
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = (createComment.mock.calls as any)[0][0].body as string;
    expect(body).toContain(":deploy:reg-ack");
    const ciphertext = /```text\n([A-Za-z0-9_\-+/=]+)\n```/.exec(body)?.[1];
    const nonce = /<!--\s+([A-Za-z0-9_-]{4,})\s+-->/.exec(body)?.[1];
    expect(ciphertext).toBeDefined();
    expect(nonce).toBeDefined();
    await sodium.ready;
    const plaintext = sodium.crypto_box_open_easy(
      await base64ToBytes(ciphertext!),
      await base64ToBytes(nonce!),
      operatorKeys.publicKey,
      beaconKeys.secretKey,
    );
    expect(plaintext).not.toBeNull();
    expect(JSON.parse(bytesToString(plaintext!))).toEqual({
      kind: "registration-ack",
      beaconId,
      registrationId: "77",
      registrationSequence: 1,
      acceptedAt: expect.any(String),
    });
  });
});

describe("IssuesChannel poll-scoped task delivery", () => {
  it("re-ACKs a duplicate registration comment without releasing queued tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-reg-replay-"));
    temporaryDirectories.push(directory);
    const store = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const registry = new BeaconRegistry(store);
    const queue = new TaskQueue(store);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-registration-replay";
    const signed = await enrollSignedCheckin(
      store,
      registry,
      queue,
      beaconId,
    );
    const sealed = await sealBox(
      JSON.stringify(signed.checkin),
      operatorKeys.publicKey,
    );
    const first = issueComment(
      401,
      new Date(Date.now() - 2_000).toISOString(),
      registrationBody(sealed, "register"),
    );
    const replay = issueComment(
      402,
      new Date(Date.now() - 1_000).toISOString(),
      registrationBody(sealed, "register"),
    );
    const comments = [first, replay];
    const createComment = mock(async () => ({ data: { id: 9100 } }));
    const channel = createPollingChannel({
      registry,
      queue,
      store,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment,
    });
    const task = queue.queueTask(
      beaconId,
      "ping",
      {},
      "issues",
    );

    try {
      await channel.poll();

      expect(createComment).toHaveBeenCalledTimes(2);
      for (const call of createComment.mock.calls as any) {
        expect(call[0].body).toContain(":deploy:reg-ack");
      }
      expect(queue.getTask(task.taskId)?.state).toBe("pending");
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(first),
      )).toMatchObject({ outcome: "accepted", beaconId });
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(replay),
      )).toMatchObject({ outcome: "duplicate", beaconId });

      const restarted = createPollingChannel({
        registry,
        queue,
        store,
        operatorKeys,
        comments,
        identities: signed.identities,
        tasks: signed.tasks,
        createComment,
      });
      await restarted.poll();

      expect(createComment).toHaveBeenCalledTimes(2);
      expect(queue.getTask(task.taskId)?.state).toBe("pending");
    } finally {
      await registry.shutdown();
      store.close();
    }
  });

  it("delivers only for a newly accepted or gap checkin, never durable, exact, or stale replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-ci-gate-"));
    temporaryDirectories.push(directory);
    const store = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const registry = new BeaconRegistry(store);
    const queue = new TaskQueue(store);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-checkin-gate";
    const signed = await enrollSignedCheckin(
      store,
      registry,
      queue,
      beaconId,
    );
    await signed.identities.verifyAndRegisterCheckin(
      signed.checkin,
      beaconId,
      1,
      42,
    );
    const acceptedAt = new Date(Date.now() + 1_000).toISOString();
    const accepted = await resignCheckin(
      signed.checkin,
      signed.signing,
      signed.signingKeyId,
      2,
      acceptedAt,
    );
    const acceptedComment = issueComment(
      501,
      acceptedAt,
      checkinBody(
        await sealBox(JSON.stringify(accepted), operatorKeys.publicKey),
        "accepted",
      ),
    );
    const comments = [acceptedComment];
    const createComment = mock(async () => ({ data: { id: 9200 } }));
    const channel = createPollingChannel({
      registry,
      queue,
      store,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment,
    });
    const firstTask = queue.queueTask(
      beaconId,
      "ping",
      {},
      "issues",
    );

    try {
      await channel.poll();
      expect(queue.getTask(firstTask.taskId)?.state).toBe("delivered");
      expect(createComment).toHaveBeenCalledTimes(1);

      const secondTask = queue.queueTask(
        beaconId,
        "shell",
        { cmd: "whoami" },
        "issues",
      );
      const restarted = createPollingChannel({
        registry,
        queue,
        store,
        operatorKeys,
        comments,
        identities: signed.identities,
        tasks: signed.tasks,
        createComment,
      });

      // The durable accepted comment is not a new authorization after restart.
      await restarted.poll();
      expect(queue.getTask(secondTask.taskId)?.state).toBe("pending");
      expect(createComment).toHaveBeenCalledTimes(1);

      const exactReplay = issueComment(
        502,
        new Date(Date.now() + 2_000).toISOString(),
        acceptedComment.body,
      );
      comments.push(exactReplay);
      await restarted.poll();
      expect(queue.getTask(secondTask.taskId)?.state).toBe("pending");
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(exactReplay),
      )).toMatchObject({ outcome: "duplicate", beaconId });

      const staleReplay = issueComment(
        503,
        new Date(Date.now() + 3_000).toISOString(),
        checkinBody(
          await sealBox(
            JSON.stringify(signed.checkin),
            operatorKeys.publicKey,
          ),
          "stale",
        ),
      );
      comments.push(staleReplay);
      await restarted.poll();
      expect(queue.getTask(secondTask.taskId)?.state).toBe("pending");
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(staleReplay),
      )).toMatchObject({ outcome: "duplicate", beaconId });

      const gapAt = new Date(Date.now() + 4_000).toISOString();
      const gap = await resignCheckin(
        signed.checkin,
        signed.signing,
        signed.signingKeyId,
        4,
        gapAt,
      );
      const gapComment = issueComment(
        504,
        gapAt,
        checkinBody(
          await sealBox(JSON.stringify(gap), operatorKeys.publicKey),
          "gap",
        ),
      );
      comments.push(gapComment);
      await restarted.poll();

      expect(queue.getTask(secondTask.taskId)?.state).toBe("delivered");
      expect(createComment).toHaveBeenCalledTimes(2);
      expect(registry.get(beaconId)?.lastSeq).toBe(4);
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(gapComment),
      )).toMatchObject({ outcome: "accepted", beaconId });

      const proxyTask = queue.queueTask(
        beaconId,
        "ping",
        {},
        "proxy",
      );
      const proxyAt = new Date(Date.now() + 5_000).toISOString();
      const proxyCheckin = await resignCheckin(
        signed.checkin,
        signed.signing,
        signed.signingKeyId,
        5,
        proxyAt,
      );
      const proxyComment = issueComment(
        505,
        proxyAt,
        [
          checkinBody(
            await sealBox(
              JSON.stringify(proxyCheckin),
              operatorKeys.publicKey,
            ),
            "proxy",
          ),
          "<!-- octoc2-relay:ingress:decoy:1:505:digest -->",
        ].join("\n"),
      );
      comments.push(proxyComment);
      await restarted.poll();

      expect(queue.getTask(proxyTask.taskId)?.state).toBe("delivered");
      expect(registry.get(beaconId)?.activeTentacle).toBe(10);
      expect(createComment).toHaveBeenCalledTimes(3);
    } finally {
      await registry.shutdown();
      store.close();
    }
  });

  it("distinguishes same-timestamp edits to one GitHub comment by body digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-same-tick-"));
    temporaryDirectories.push(directory);
    const store = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const registry = new BeaconRegistry(store);
    const queue = new TaskQueue(store);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-same-tick";
    const signed = await enrollSignedCheckin(
      store,
      registry,
      queue,
      beaconId,
    );
    await signed.identities.verifyAndRegisterCheckin(
      signed.checkin,
      beaconId,
      1,
      42,
    );
    const updatedAt = new Date(Date.now() + 1_000).toISOString();
    const second = await resignCheckin(
      signed.checkin,
      signed.signing,
      signed.signingKeyId,
      2,
      updatedAt,
    );
    const firstRevision = issueComment(
      601,
      updatedAt,
      checkinBody(
        await sealBox(JSON.stringify(second), operatorKeys.publicKey),
        "same-tick",
      ),
    );
    const comments = [firstRevision];
    const createComment = mock(async () => ({ data: { id: 9300 } }));
    const channel = createPollingChannel({
      registry,
      queue,
      store,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment,
    });

    try {
      await channel.poll();
      expect(registry.get(beaconId)?.lastSeq).toBe(2);

      const task = queue.queueTask(
        beaconId,
        "ping",
        {},
        "issues",
      );
      const third = await resignCheckin(
        signed.checkin,
        signed.signing,
        signed.signingKeyId,
        3,
        updatedAt,
      );
      const secondRevision = issueComment(
        601,
        updatedAt,
        checkinBody(
          await sealBox(JSON.stringify(third), operatorKeys.publicKey),
          "same-tick",
        ),
      );
      comments[0] = secondRevision;
      await channel.poll();

      expect(registry.get(beaconId)?.lastSeq).toBe(3);
      expect(queue.getTask(task.taskId)?.state).toBe("delivered");
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(commentMessageId(secondRevision)).not.toBe(
        commentMessageId(firstRevision),
      );
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(firstRevision),
      )).toBeDefined();
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(secondRevision),
      )).toBeDefined();
    } finally {
      await registry.shutdown();
      store.close();
    }
  });
});

describe("IssuesChannel durable rejection and retry classification", () => {
  it("durably rejects a malformed artifact and continues to a later valid comment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-progress-"));
    temporaryDirectories.push(directory);
    const store = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const registry = new BeaconRegistry(store);
    const queue = new TaskQueue(store);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-progress-beacon";
    const signed = await enrollSignedCheckin(
      store,
      registry,
      queue,
      beaconId,
    );
    const firstAt = new Date(Date.now() - 2_000).toISOString();
    const secondAt = new Date(Date.now() - 1_000).toISOString();
    const comments = [
      issueComment(
        101,
        firstAt,
        registrationBody(
          await sealBox("{", operatorKeys.publicKey),
          "malformed",
        ),
      ),
      issueComment(
        102,
        secondAt,
        registrationBody(
          await sealBox(JSON.stringify(signed.checkin), operatorKeys.publicKey),
          "valid",
        ),
      ),
    ];
    const createComment = mock(async () => ({ data: { id: 9001 } }));
    const channel = createPollingChannel({
      registry,
      queue,
      store,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment,
    });

    try {
      await expect(channel.poll()).resolves.toBeUndefined();
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(comments[0]!),
      )).toMatchObject({ outcome: "rejected" });
      expect(store.getProcessedMessage(
        "issues-poll",
        commentMessageId(comments[1]!),
      )).toMatchObject({
        outcome: "accepted",
        beaconId,
      });
      expect(store.getPollCursor(
        "issues-poll",
        "repo:owner/repo",
      )?.cursor).toBe(secondAt);
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(store.getBeacon(beaconId)).toMatchObject({
        issueNumber: 42,
        lastSeq: 1,
        activeTentacle: 1,
      });
    } finally {
      await registry.shutdown();
      store.close();
    }
  });

  it("retries a transient identity-service failure after reopening persisted cursor state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-restart-"));
    temporaryDirectories.push(directory);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-restart-beacon";
    const firstAt = new Date(Date.now() - 2_000).toISOString();
    const secondAt = new Date(Date.now() - 1_000).toISOString();
    const firstStore = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const firstRegistry = new BeaconRegistry(firstStore);
    const firstQueue = new TaskQueue(firstStore);
    const signed = await enrollSignedCheckin(
      firstStore,
      firstRegistry,
      firstQueue,
      beaconId,
    );
    const comments = [
      issueComment(201, firstAt, "ordinary non-protocol comment"),
      issueComment(
        202,
        secondAt,
        registrationBody(
          await sealBox(JSON.stringify(signed.checkin), operatorKeys.publicKey),
          "retry",
        ),
      ),
    ];
    const sabotage = new Database(firstStore.databasePath);
    sabotage.exec(`
      CREATE TRIGGER fail_issues_checkin
      BEFORE UPDATE ON beacons
      BEGIN
        SELECT RAISE(ABORT, 'simulated identity write failure');
      END;
    `);
    const firstChannel = createPollingChannel({
      registry: firstRegistry,
      queue: firstQueue,
      store: firstStore,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment: mock(async () => ({ data: { id: 9002 } })),
    });

    await expect(firstChannel.poll()).rejects.toThrow(
      "simulated identity write failure",
    );
    expect(firstStore.getProcessedMessage(
      "issues-poll",
      commentMessageId(comments[0]!),
    )).toMatchObject({ outcome: "rejected" });
    expect(firstStore.getProcessedMessage(
      "issues-poll",
      commentMessageId(comments[1]!),
    )).toBeUndefined();
    expect(firstStore.getPollCursor(
      "issues-poll",
      "repo:owner/repo",
    )?.cursor).toBe(firstAt);
    expect(firstStore.getBeacon(beaconId)?.lastSeq).toBe(0);
    sabotage.exec("DROP TRIGGER fail_issues_checkin");
    sabotage.close();
    await firstRegistry.shutdown();
    firstStore.close();

    const reopenedStore = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const reopenedRegistry = new BeaconRegistry(reopenedStore);
    const reopenedQueue = new TaskQueue(reopenedStore);
    await reopenedRegistry.load();
    const reopenedIdentities = new BeaconIdentityService(
      reopenedStore,
      reopenedRegistry,
    );
    const reopenedTasks = new TaskService(
      reopenedStore,
      reopenedRegistry,
      reopenedQueue,
    );
    const createComment = mock(async () => ({ data: { id: 9003 } }));
    const reopenedChannel = createPollingChannel({
      registry: reopenedRegistry,
      queue: reopenedQueue,
      store: reopenedStore,
      operatorKeys,
      comments,
      identities: reopenedIdentities,
      tasks: reopenedTasks,
      createComment,
    });

    try {
      await expect(reopenedChannel.poll()).resolves.toBeUndefined();
      expect(reopenedStore.getProcessedMessage(
        "issues-poll",
        commentMessageId(comments[1]!),
      )).toMatchObject({
        outcome: "accepted",
        beaconId,
      });
      expect(reopenedStore.getPollCursor(
        "issues-poll",
        "repo:owner/repo",
      )?.cursor).toBe(secondAt);
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(reopenedStore.getBeacon(beaconId)).toMatchObject({
        issueNumber: 42,
        lastSeq: 1,
        activeTentacle: 1,
      });
    } finally {
      await reopenedRegistry.shutdown();
      reopenedStore.close();
    }
  });

  it("leaves a transient task-result store failure uncommitted for retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-issues-result-"));
    temporaryDirectories.push(directory);
    const store = OctoStore.open({
      dataDir: directory,
      importLegacyRegistry: false,
    });
    const registry = new BeaconRegistry(store);
    const queue = new TaskQueue(store);
    const operatorKeys = await generateOperatorKeyPair();
    const beaconId = "issues-result-beacon";
    const signed = await enrollSignedCheckin(
      store,
      registry,
      queue,
      beaconId,
    );
    await signed.identities.verifyAndRegisterCheckin(
      signed.checkin,
      beaconId,
      1,
      42,
    );
    const task = queue.queueTask(beaconId, "shell", { cmd: "echo result" });
    expect(queue.markDelivered(task.taskId)).toBe(true);
    const result = await signedTaskResult(
      beaconId,
      task.taskId,
      signed.signing,
      signed.signingKeyId,
    );
    const timestamp = new Date(Date.now() - 1_000).toISOString();
    const comment = issueComment(
      301,
      timestamp,
      resultBody(
        await sealBox(JSON.stringify(result), operatorKeys.publicKey),
        task.taskId,
      ),
    );
    const comments = [comment];
    const createComment = mock(async () => ({ data: { id: 9004 } }));
    const sabotage = new Database(store.databasePath);
    sabotage.exec(`
      CREATE TRIGGER fail_issues_result
      BEFORE INSERT ON task_results
      BEGIN
        SELECT RAISE(ABORT, 'simulated task result write failure');
      END;
    `);
    const channel = createPollingChannel({
      registry,
      queue,
      store,
      operatorKeys,
      comments,
      identities: signed.identities,
      tasks: signed.tasks,
      createComment,
    });

    await expect(channel.poll()).rejects.toThrow(
      "simulated task result write failure",
    );
    expect(store.getProcessedMessage(
      "issues-poll",
      commentMessageId(comment),
    )).toBeUndefined();
    expect(store.getTaskResult(task.taskId)).toBeUndefined();
    expect(queue.getTask(task.taskId)?.state).toBe("delivered");

    sabotage.exec("DROP TRIGGER fail_issues_result");
    sabotage.close();
    await expect(channel.poll()).resolves.toBeUndefined();
    expect(store.getProcessedMessage(
      "issues-poll",
      commentMessageId(comment),
    )).toMatchObject({
      outcome: "accepted",
      beaconId,
      taskId: task.taskId,
    });
    expect(store.getTaskResult(task.taskId)?.signatureVerified).toBe(true);
    expect(queue.getTask(task.taskId)?.state).toBe("completed");
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(
      (createComment.mock.calls[0] as unknown as [{ body: string }])[0].body,
    ).toContain(`:deploy:result-ack-${task.taskId}`);

    const duplicate = issueComment(
      302,
      new Date(Date.now() + 1_000).toISOString(),
      resultBody(
        await sealBox(JSON.stringify(result), operatorKeys.publicKey),
        task.taskId,
      ),
    );
    comments.push(duplicate);
    await expect(channel.poll()).resolves.toBeUndefined();
    expect(store.getProcessedMessage(
      "issues-poll",
      commentMessageId(duplicate),
    )).toMatchObject({
      outcome: "duplicate",
      beaconId,
      taskId: task.taskId,
    });
    expect(createComment).toHaveBeenCalledTimes(2);

    await registry.shutdown();
    store.close();
  });
});

async function enrollSignedCheckin(
  store: OctoStore,
  registry: BeaconRegistry,
  queue: TaskQueue,
  beaconId: string,
): Promise<{
  checkin: CheckinPayload;
  identities: BeaconIdentityService;
  tasks: TaskService;
  signing: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
  signingKeyId: string;
}> {
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  const signing = await generateEd25519KeyPair();
  const signingKeyId = await ed25519KeyId(signing.publicKey);
  const signingPublicKey = encodeBase64Url(signing.publicKey);
  const encryptionKeys = await generateOperatorKeyPair();
  const encryptionPublicKey = await bytesToBase64(encryptionKeys.publicKey);
  const createdAt = new Date().toISOString();
  await identities.enroll({
    version: 1,
    beaconId,
    encryptionPublicKey,
    signingPublicKey,
    signingKeyId,
    createdAt,
  });
  await registry.load();
  const checkinAt = new Date().toISOString();
  const payload = {
    beaconId,
    encryptionPublicKey,
    signingPublicKey,
    hostname: "issues-host",
    username: "issues-user",
    os: "linux",
    arch: "x64",
    pid: 42,
    checkinAt,
  };
  return {
    checkin: {
      beaconId,
      publicKey: encryptionPublicKey,
      hostname: payload.hostname,
      username: payload.username,
      os: payload.os,
      arch: payload.arch,
      pid: payload.pid,
      checkinAt,
      identity: await signEnvelope(
        createUnsignedEnvelope({
          kind: "checkin",
          signerId: beaconId,
          keyId: signingKeyId,
          issuedAt: checkinAt,
          sequence: 1,
          payload,
        }),
        signing.secretKey,
      ),
    },
    identities,
    tasks,
    signing,
    signingKeyId,
  };
}

async function signedTaskResult(
  beaconId: string,
  taskId: string,
  signing: Awaited<ReturnType<typeof generateEd25519KeyPair>>,
  signingKeyId: string,
): Promise<TaskResult> {
  const unsigned: TaskResult = {
    taskId,
    beaconId,
    success: true,
    output: "result",
    completedAt: new Date().toISOString(),
  };
  const signature = await signEnvelope(
    createUnsignedEnvelope({
      kind: "task-result",
      signerId: beaconId,
      keyId: signingKeyId,
      issuedAt: unsigned.completedAt,
      sequence: 2,
      payload: await createTaskResultSignaturePayload(unsigned),
    }),
    signing.secretKey,
  );
  return {
    ...unsigned,
    signature: serializeSignedEnvelope(signature),
  };
}

function registrationBody(ciphertext: string, ref: string): string {
  return [
    `<!-- job:1:reg:${ref} -->`,
    `<!-- infra-diagnostic:${ref}:${ciphertext} -->`,
  ].join("\n");
}

function resultBody(ciphertext: string, ref: string): string {
  return [
    `<!-- job:1:logs:${ref} -->`,
    `<!-- infra-diagnostic:${ref}:${ciphertext} -->`,
  ].join("\n");
}

function issueComment(id: number, timestamp: string, body: string) {
  return {
    id,
    body,
    issue_url: "https://api.github.test/repos/owner/repo/issues/42",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function resignCheckin(
  base: CheckinPayload,
  signing: Awaited<ReturnType<typeof generateEd25519KeyPair>>,
  signingKeyId: string,
  sequence: number,
  checkinAt: string,
): Promise<CheckinPayload> {
  const identityPayload = {
    beaconId: base.beaconId,
    encryptionPublicKey: base.publicKey,
    signingPublicKey: encodeBase64Url(signing.publicKey),
    hostname: base.hostname,
    username: base.username,
    os: base.os,
    arch: base.arch,
    pid: base.pid,
    checkinAt,
  };

  return {
    ...base,
    checkinAt,
    identity: await signEnvelope(
      createUnsignedEnvelope({
        kind: "checkin",
        signerId: base.beaconId,
        keyId: signingKeyId,
        issuedAt: checkinAt,
        sequence,
        payload: identityPayload,
      }),
      signing.secretKey,
    ),
  };
}

function checkinBody(ciphertext: string, ref: string): string {
  return [
    `<!-- job:1:ci:${ref} -->`,
    `<!-- infra-diagnostic:${ref}:${ciphertext} -->`,
  ].join("\n");
}

function commentMessageId(
  comment: ReturnType<typeof issueComment>,
): string {
  const body = comment.body ?? "";
  const version =
    comment.updated_at ?? comment.created_at ?? sha256Hex(body);
  return `comment:${comment.id}:${version}:${sha256Hex(body)}`;
}

function createPollingChannel(input: {
  registry: BeaconRegistry;
  queue: TaskQueue;
  store: OctoStore;
  operatorKeys: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  comments: ReturnType<typeof issueComment>[];
  identities: SecureChannelServices["identities"];
  tasks: SecureChannelServices["tasks"];
  createComment: ReturnType<typeof mock>;
}): IssuesChannel {
  const paginate = mock(async () => input.comments);
  const octokit = {
    paginate,
    rest: {
      issues: {
        listCommentsForRepo: mock(async () => ({ data: input.comments })),
        createComment: input.createComment,
      },
    },
  } as any;
  return new IssuesChannel(
    input.registry,
    input.queue,
    {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorPublicKey: input.operatorKeys.publicKey,
      operatorSecretKey: input.operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    },
    {
      store: input.store,
      identities: input.identities,
      tasks: input.tasks,
      queue: input.queue,
    },
  );
}
