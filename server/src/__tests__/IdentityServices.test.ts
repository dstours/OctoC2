import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalJson,
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  signEnvelope,
  type CheckinPayload,
  type TaskResult,
} from "@octoc2/shared";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { RejectedArtifactError } from "../services/ArtifactErrors.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore, sha256Hex } from "../store/index.ts";
import { DurablePollState } from "../lib/PollRunner.ts";

describe("central identity and task authorization", () => {
  let dir: string;
  let store: OctoStore;
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let identities: BeaconIdentityService;
  let tasks: TaskService;
  let keys: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
  let keyId: string;
  const beaconId = "beacon-identity-test";
  const encryptionPublicKey = encodeBase64Url(new Uint8Array(32).fill(7));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "octoc2-identity-"));
    store = OctoStore.open({ dataDir: dir });
    registry = new BeaconRegistry(store);
    queue = new TaskQueue(store);
    identities = new BeaconIdentityService(store, registry);
    tasks = new TaskService(store, registry, queue);
    keys = await generateEd25519KeyPair();
    keyId = await ed25519KeyId(keys.publicKey);
    await identities.enroll({
      version: 1,
      beaconId,
      encryptionPublicKey,
      signingPublicKey: encodeBase64Url(keys.publicKey),
      signingKeyId: keyId,
      createdAt: new Date().toISOString(),
    });
    await registry.load();
  });

  afterEach(async () => {
    await registry.shutdown();
    store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  });

  it("validates enrollment key material before persisting a beacon", async () => {
    const otherKeys = await generateEd25519KeyPair();
    const otherKeyId = await ed25519KeyId(otherKeys.publicKey);
    const createdAt = new Date().toISOString();

    await expect(identities.enroll({
      version: 1,
      beaconId: "invalid-enrollment",
      encryptionPublicKey: "not-a-32-byte-key",
      signingPublicKey: encodeBase64Url(otherKeys.publicKey),
      signingKeyId: otherKeyId,
      createdAt,
    })).rejects.toThrow("X25519");
    expect(store.getBeacon("invalid-enrollment")).toBeUndefined();

    await expect(identities.enroll({
      version: 1,
      beaconId: "mismatched-key-id",
      encryptionPublicKey: encodeBase64Url(new Uint8Array(32).fill(11)),
      signingPublicKey: encodeBase64Url(otherKeys.publicKey),
      signingKeyId: keyId,
      createdAt,
    })).rejects.toThrow("signingKeyId");
    expect(store.getBeacon("mismatched-key-id")).toBeUndefined();

    await expect(identities.enroll({
      version: 1,
      beaconId: "reused-signing-key",
      encryptionPublicKey: encodeBase64Url(new Uint8Array(32).fill(12)),
      signingPublicKey: encodeBase64Url(keys.publicKey),
      signingKeyId: keyId,
      createdAt,
    })).rejects.toThrow("already assigned");
    expect(store.getBeacon("reused-signing-key")).toBeUndefined();
  });

  async function signedCheckin(
    sequence: number,
    checkinAt = new Date().toISOString(),
  ): Promise<CheckinPayload> {
    const payload = {
      beaconId,
      encryptionPublicKey,
      signingPublicKey: encodeBase64Url(keys.publicKey),
      hostname: "identity-host",
      username: "tester",
      os: "linux",
      arch: "x64",
      pid: 42,
      checkinAt,
    };
    return {
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
          keyId,
          issuedAt: checkinAt,
          sequence,
          payload,
        }),
        keys.secretKey,
      ),
    };
  }

  async function signedResult(
    taskId: string,
    sequence: number,
    output = "ok",
  ): Promise<TaskResult> {
    const unsigned: TaskResult = {
      taskId,
      beaconId,
      success: true,
      output,
      completedAt: new Date().toISOString(),
    };
    const envelope = await signEnvelope(
      createUnsignedEnvelope({
        kind: "task-result",
        signerId: beaconId,
        keyId,
        issuedAt: unsigned.completedAt,
        sequence,
        payload: await createTaskResultSignaturePayload(unsigned),
      }),
      keys.secretKey,
    );
    return { ...unsigned, signature: JSON.stringify(envelope) };
  }

  it("accepts only pre-enrolled, signed, monotonic check-ins", async () => {
    const checkin = await signedCheckin(1);
    await expect(
      identities.verifyAndRegisterCheckin(checkin, beaconId, 13),
    ).resolves.toBe("accepted");
    expect(registry.get(beaconId)?.activeTentacle).toBe(13);

    await expect(
      identities.verifyAndRegisterCheckin(checkin, beaconId, 13),
    ).resolves.toBe("duplicate");
    await expect(
      identities.verifyAndRegisterCheckin(
        await signedCheckin(1),
        beaconId,
        13,
      ),
    ).rejects.toThrow("conflicting replayed");
    try {
      await identities.verifyAndRegisterCheckin(
        { ...await signedCheckin(2), hostname: "tampered" },
        beaconId,
        13,
      );
      throw new Error("Expected tampered check-in to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RejectedArtifactError);
      expect((error as Error).message).toContain("does not match");
    }

    registry.register({
      beaconId,
      issueNumber: 0,
      publicKey: encryptionPublicKey,
      hostname: "identity-host",
      username: "tester",
      os: "linux",
      arch: "x64",
      seq: 0,
      tentacleId: 13,
    });
    expect(store.getBeacon(beaconId)?.lastSeq).toBe(1);
  });

  it("rejects stale and excessively future check-ins while allowing bounded skew", async () => {
    identities = new BeaconIdentityService(
      store,
      registry,
      5 * 60 * 1000,
      30 * 60 * 1000,
    );

    await expect(
      identities.verifyAndRegisterCheckin(
        await signedCheckin(
          1,
          new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        ),
        beaconId,
        13,
      ),
    ).rejects.toThrow("too old");
    await expect(
      identities.verifyAndRegisterCheckin(
        await signedCheckin(
          2,
          new Date(Date.now() + 6 * 60 * 1000).toISOString(),
        ),
        beaconId,
        13,
      ),
    ).rejects.toThrow("too far in the future");
    await expect(
      identities.verifyAndRegisterCheckin(
        await signedCheckin(
          3,
          new Date(Date.now() + 4 * 60 * 1000).toISOString(),
        ),
        beaconId,
        13,
      ),
    ).resolves.toBe("accepted");
  });

  it("recovers a durable poll crash after checkin mutation", async () => {
    const checkin = await signedCheckin(1);
    const advanced = store.acceptBeaconCheckin({
      beaconId,
      sequence: checkin.identity!.sequence,
      envelopeDigest: sha256Hex(canonicalJson(checkin.identity)),
      issueNumber: 42,
      x25519PublicKey: checkin.publicKey,
      hostname: checkin.hostname,
      username: checkin.username,
      os: checkin.os,
      arch: checkin.arch,
      activeTentacle: 1,
    });
    expect(advanced.status).toBe("advanced");
    expect(registry.get(beaconId)).toMatchObject({
      issueNumber: 0,
      hostname: "pre-enrolled",
      lastSeq: 0,
    });

    const progress = new DurablePollState(
      store,
      "issues-poll",
      "repo:owner/repo",
    );
    await expect(progress.process({
      messageId: "comment:42",
      payload: JSON.stringify(checkin),
      cursor: checkin.checkinAt,
    }, async () => {
      expect(
        await identities.verifyAndRegisterCheckin(checkin, beaconId, 1, 42),
      ).toBe("duplicate");
    })).resolves.toEqual({ status: "processed" });
    expect(progress.cursor).toBe(checkin.checkinAt);
    expect(registry.get(beaconId)).toMatchObject({
      issueNumber: 42,
      hostname: "identity-host",
      activeTentacle: 1,
      lastSeq: 1,
    });
  });

  it("does not refresh liveness or switch channels for a captured duplicate", async () => {
    const checkin = await signedCheckin(1);
    await identities.verifyAndRegisterCheckin(checkin, beaconId, 13);
    const accepted = store.getBeacon(beaconId)!;

    await expect(
      identities.verifyAndRegisterCheckin(checkin, beaconId, 1, 42),
    ).resolves.toBe("duplicate");
    const duplicate = store.getBeacon(beaconId)!;
    expect(duplicate.lastSeen).toBe(accepted.lastSeen);
    expect(duplicate.issueNumber).toBe(accepted.issueNumber);
    expect(duplicate.activeTentacle).toBe(13);
  });

  it("recovers an exact accepted check-in after its freshness window expires", async () => {
    const checkinAt = new Date(Date.now() - 60_000).toISOString();
    const checkin = await signedCheckin(1, checkinAt);
    await identities.verifyAndRegisterCheckin(checkin, beaconId, 13);
    const accepted = store.getBeacon(beaconId)!;

    identities = new BeaconIdentityService(store, registry, 5 * 60_000, 30_000);
    await expect(
      identities.verifyAndRegisterCheckin(checkin, beaconId, 1, 42),
    ).resolves.toBe("stale_duplicate");

    const duplicate = store.getBeacon(beaconId)!;
    expect(duplicate.lastSeen).toBe(accepted.lastSeen);
    expect(duplicate.issueNumber).toBe(accepted.issueNumber);
    expect(duplicate.activeTentacle).toBe(accepted.activeTentacle);
    expect(duplicate.lastSeq).toBe(accepted.lastSeq);
  });

  it("does not let a stale conflicting sequence use duplicate recovery", async () => {
    const acceptedAt = new Date(Date.now() - 60_000).toISOString();
    await identities.verifyAndRegisterCheckin(
      await signedCheckin(1, acceptedAt),
      beaconId,
      13,
    );

    identities = new BeaconIdentityService(store, registry, 5 * 60_000, 30_000);
    const conflictingAt = new Date(
      new Date(acceptedAt).getTime() + 1,
    ).toISOString();
    await expect(
      identities.verifyAndRegisterCheckin(
        await signedCheckin(1, conflictingAt),
        beaconId,
        1,
        42,
      ),
    ).rejects.toThrow("too old");
  });

  it("persists verified results and rejects replay, tampering, and wrong owners", async () => {
    await identities.verifyAndRegisterCheckin(await signedCheckin(1), beaconId, 13);
    const task = queue.queueTask(beaconId, "shell", { cmd: "echo ok" });
    queue.markDelivered(task.taskId);
    const result = await signedResult(task.taskId, 2);

    expect((await tasks.acceptSignedResult(result, beaconId)).status).toBe("completed");
    expect((await tasks.acceptSignedResult(result, beaconId)).status).toBe("exact_duplicate");
    expect((await tasks.acceptSignedResult(
      { ...result, output: "tampered" },
      beaconId,
    )).status).toBe("invalid_signature");
    expect((await tasks.acceptSignedResult(result, "another-beacon")).status)
      .toBe("owner_mismatch");

    const reopened = OctoStore.open({ dataDir: dir });
    try {
      expect(reopened.getTaskResult(task.taskId)?.signatureVerified).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("accepts a cached signed result after a newer check-in was delivered", async () => {
    await identities.verifyAndRegisterCheckin(
      await signedCheckin(1),
      beaconId,
      13,
    );
    const task = queue.queueTask(beaconId, "ping", {});
    queue.markDelivered(task.taskId);
    const cachedResult = await signedResult(task.taskId, 2);

    await identities.verifyAndRegisterCheckin(
      await signedCheckin(3),
      beaconId,
      13,
    );
    expect(store.getBeacon(beaconId)?.lastSeq).toBe(3);

    expect(
      (await tasks.acceptSignedResult(cachedResult, beaconId)).status,
    ).toBe("completed");
    expect(store.getBeacon(beaconId)?.lastSeq).toBe(3);
    expect(
      (await tasks.acceptSignedResult(cachedResult, beaconId)).status,
    ).toBe("exact_duplicate");
  });

  it("advances result sequence atomically with accepted completion", async () => {
    await identities.verifyAndRegisterCheckin(await signedCheckin(1), beaconId, 13);
    const task = queue.queueTask(beaconId, "shell", { cmd: "echo atomic" });
    const result = await signedResult(task.taskId, 2);

    store.commitChannelProgress({
      channel: "issues:result",
      scope: "repo:owner/repo",
      messageId: "comment:42",
      payloadDigest: sha256Hex("different immutable artifact"),
      cursor: result.completedAt,
    });

    expect((await tasks.acceptSignedResult(result, beaconId, {
      channel: "issues:result",
      messageId: "comment:42",
    })).status).toBe("conflicting_message");
    expect(store.getBeacon(beaconId)?.lastSeq).toBe(1);

    expect((await tasks.acceptSignedResult(result, beaconId, {
      channel: "issues:result",
      messageId: "comment:43",
    })).status).toBe("completed");
    expect(store.getBeacon(beaconId)?.lastSeq).toBe(2);
    expect(registry.get(beaconId)?.lastSeq).toBe(2);
  });
});
