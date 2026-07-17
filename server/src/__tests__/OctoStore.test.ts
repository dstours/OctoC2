import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  OctoStore,
  sha256Hex,
} from "../store/index.ts";

const NOW = "2026-07-16T12:00:00.000Z";

function beaconInput(beaconId = "beacon-a") {
  return {
    beaconId,
    issueNumber: beaconId === "beacon-a" ? 7 : 8,
    x25519PublicKey: `x25519-${beaconId}`,
    hostname: `${beaconId}-host`,
    username: "operator",
    os: "linux",
    arch: "x64",
    firstSeen: "2026-07-15T00:00:00.000Z",
    lastSeen: NOW,
    status: "active" as const,
    lastSeq: 5,
  };
}

describe("OctoStore", () => {
  let dataDir: string;
  let store: OctoStore | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "octoc2-store-"));
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    try {
      rmSync(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 25,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  });

  it("applies versioned migrations and required SQLite pragmas", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      busyTimeoutMs: 7_500,
      now: () => new Date(NOW),
    });

    expect(store.getAppliedMigrations()).toEqual([
      {
        version: 1,
        name: "identity_credentials_tasks",
        appliedAt: NOW,
      },
      {
        version: 2,
        name: "delivery_dedup_cursors_legacy_import",
        appliedAt: NOW,
      },
      {
        version: 3,
        name: "signed_sequence_receipts",
        appliedAt: NOW,
      },
      {
        version: 4,
        name: "canonical_channel_identifiers",
        appliedAt: NOW,
      },
      {
        version: 5,
        name: "oidc_idempotency_responses",
        appliedAt: NOW,
      },
    ]);
    expect(store.currentSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.getPragmas()).toEqual({
      foreignKeys: true,
      journalMode: "wal",
      busyTimeoutMs: 7_500,
    });
  });

  it("imports registry.json once, retains an exact backup, and stays idempotent", () => {
    const registryPath = join(dataDir, "registry.json");
    const registry = {
      version: 1,
      savedAt: "2026-07-15T23:00:00.000Z",
      beacons: [
        {
          beaconId: "legacy-a",
          issueNumber: 41,
          publicKey: "legacy-x25519-a",
          hostname: "alpha",
          username: "alice",
          os: "linux",
          arch: "x64",
          firstSeen: "2026-07-01T00:00:00.000Z",
          lastSeen: "2026-07-15T22:00:00.000Z",
          status: "active",
          lastSeq: 19,
          activeTentacle: "7b",
        },
        {
          beaconId: "legacy-b",
          issueNumber: 42,
          publicKey: "legacy-x25519-b",
          hostname: "beta",
          username: "bob",
          os: "windows",
          arch: "x64",
          firstSeen: "2026-07-02T00:00:00.000Z",
          lastSeen: "2026-07-15T21:00:00.000Z",
          status: "lost",
          lastSeq: 2,
        },
      ],
    };
    const raw = JSON.stringify(registry, null, 2);
    writeFileSync(registryPath, raw, "utf8");

    store = OctoStore.open({ dataDir, now: () => new Date(NOW) });
    expect(store.legacyImport.status).toBe("imported");
    expect(store.legacyImport.importedCount).toBe(2);
    expect(store.listBeacons()).toHaveLength(2);
    expect(store.getBeacon("legacy-a")).toMatchObject({
      x25519PublicKey: "legacy-x25519-a",
      status: "dormant",
      activeTentacle: "7b",
    });
    // Legacy X25519 keys are never treated as Ed25519 signing identities.
    expect(store.getActiveIdentityKey("legacy-a")).toBeUndefined();

    const backupPath = join(dataDir, "registry.json.pre-sqlite.bak");
    expect(readFileSync(backupPath, "utf8")).toBe(raw);
    store.close();
    store = undefined;

    const changed = {
      ...registry,
      beacons: [
        ...registry.beacons,
        {
          ...registry.beacons[0],
          beaconId: "must-not-reimport",
          issueNumber: 99,
        },
      ],
    };
    writeFileSync(registryPath, JSON.stringify(changed), "utf8");

    store = OctoStore.open({ dataDir, now: () => new Date(NOW) });
    expect(store.legacyImport).toEqual({
      status: "already_imported",
      importedCount: 0,
      backupPath,
    });
    expect(store.listBeacons()).toHaveLength(2);
    expect(store.getBeacon("must-not-reimport")).toBeUndefined();
    expect(readFileSync(backupPath, "utf8")).toBe(raw);
  });

  it("persists beacons, provisioned identities, hashed credentials, tasks, and results across restart", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    expect(
      store.provisionIdentityKey({
        keyId: "ed25519-a-v1",
        beaconId: "beacon-a",
        publicKey: "ed25519-public-a",
        provisionedBy: "operator:test",
      }).status,
    ).toBe("created");
    store.insertCredentialHash({
      credentialId: "cred-a",
      principalType: "beacon",
      beaconId: "beacon-a",
      tokenHash: sha256Hex("ephemeral-test-token"),
      hashAlgorithm: "sha256",
      scopes: ["checkin", "results"],
    });
    const task = store.createTask({
      taskId: "task-a",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "ref-a",
    });
    const completed = store.completeTaskResult({
      taskId: task.taskId,
      beaconId: "beacon-a",
      canonicalResult: JSON.stringify({
        taskId: task.taskId,
        beaconId: "beacon-a",
        success: true,
      }),
      signature: "valid-signature-a",
      signatureKeyId: "ed25519-a-v1",
      signatureVerified: true,
      resultId: "result-a",
      source: {
        channel: "issues",
        messageId: "comment-100",
      },
    });
    expect(completed.status).toBe("completed");

    store.close();
    store = undefined;
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });

    expect(store.getBeacon("beacon-a")).toBeDefined();
    expect(store.getActiveIdentityKey("beacon-a")?.keyId).toBe("ed25519-a-v1");
    expect(
      store.findActiveCredentialByHash(
        "sha256",
        sha256Hex("ephemeral-test-token"),
      )?.credentialId,
    ).toBe("cred-a");
    expect(store.getTask("task-a")?.state).toBe("completed");
    expect(store.getTaskResult("task-a")).toMatchObject({
      resultId: "result-a",
      beaconId: "beacon-a",
      signatureVerified: true,
    });
    expect(store.getProcessedMessage("issues", "comment-100")).toBeDefined();
  });

  it("fails closed on wrong ownership, unsigned results, and unprovisioned identities", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput("beacon-a"));
    store.upsertBeacon(beaconInput("beacon-b"));
    store.provisionIdentityKey({
      keyId: "ed25519-a-v1",
      beaconId: "beacon-a",
      publicKey: "ed25519-public-a",
      provisionedBy: "operator:test",
    });
    store.createTask({
      taskId: "task-a",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "ref-a",
    });

    const base = {
      taskId: "task-a",
      canonicalResult: JSON.stringify({ taskId: "task-a", success: true }),
      signature: "signature",
      resultId: "result-a",
    };
    expect(
      store.completeTaskResult({
        ...base,
        beaconId: "beacon-b",
        signatureKeyId: "missing-b-key",
        signatureVerified: true,
      }).status,
    ).toBe("owner_mismatch");
    expect(
      store.completeTaskResult({
        ...base,
        beaconId: "beacon-a",
        signatureKeyId: "ed25519-a-v1",
        signatureVerified: false,
      }).status,
    ).toBe("invalid_signature");
    expect(
      store.completeTaskResult({
        ...base,
        beaconId: "beacon-a",
        signatureKeyId: "missing-key",
        signatureVerified: true,
      }).status,
    ).toBe("identity_key_mismatch");
    expect(store.getTask("task-a")?.state).toBe("pending");
    expect(store.getTaskResult("task-a")).toBeUndefined();
  });

  it("advances replay counters transactionally and enforces credential revocation", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());

    expect(store.advanceBeaconSequence("beacon-a", 6)).toEqual({
      status: "advanced",
      previousSeq: 5,
    });
    expect(store.advanceBeaconSequence("beacon-a", 6)).toEqual({
      status: "replay",
      lastSeq: 6,
    });
    expect(store.advanceBeaconSequence("beacon-a", 200)).toEqual({
      status: "gap",
      previousSeq: 6,
    });

    const tokenHash = sha256Hex("another-ephemeral-token");
    store.insertCredentialHash({
      credentialId: "cred-a",
      principalType: "beacon",
      beaconId: "beacon-a",
      tokenHash,
      hashAlgorithm: "sha256",
    });
    expect(
      store.findActiveCredentialByHash("sha256", tokenHash)?.credentialId,
    ).toBe("cred-a");
    expect(store.revokeCredential("cred-a", "test revocation")).toBe(true);
    expect(store.findActiveCredentialByHash("sha256", tokenHash)).toBeUndefined();
    expect(store.getCredential("cred-a")).toMatchObject({
      revokedAt: NOW,
      revocationReason: "test revocation",
    });
  });

  it("accepts an exact duplicate result idempotently and rejects a conflict transactionally", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    store.provisionIdentityKey({
      keyId: "ed25519-a-v1",
      beaconId: "beacon-a",
      publicKey: "ed25519-public-a",
      provisionedBy: "operator:test",
    });
    store.createTask({
      taskId: "task-a",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "ref-a",
    });

    const exactInput = {
      taskId: "task-a",
      beaconId: "beacon-a",
      canonicalResult: JSON.stringify({
        taskId: "task-a",
        beaconId: "beacon-a",
        output: "pong",
      }),
      signature: "signature-a",
      signatureKeyId: "ed25519-a-v1",
      signatureVerified: true,
      resultId: "result-a",
    };
    expect(store.completeTaskResult(exactInput).status).toBe("completed");
    expect(store.completeTaskResult(exactInput).status).toBe("exact_duplicate");

    const conflict = store.completeTaskResult({
      ...exactInput,
      canonicalResult: JSON.stringify({
        taskId: "task-a",
        beaconId: "beacon-a",
        output: "tampered",
      }),
      signature: "signature-tampered",
      resultId: "result-conflict",
    });
    expect(conflict.status).toBe("conflicting_duplicate");
    expect(store.getTaskResult("task-a")).toMatchObject({
      resultId: "result-a",
      canonicalResult: exactInput.canonicalResult,
      signature: "signature-a",
    });
    expect(store.getTask("task-a")?.state).toBe("completed");
  });

  it("persists exclusive delivery leases and increments attempts after expiry", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    store.createTask({
      taskId: "task-a",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "ref-a",
    });

    const first = store.claimDelivery({
      taskId: "task-a",
      beaconId: "beacon-a",
      channel: "issues",
      workerId: "poller-1",
      leaseDurationMs: 1_000,
      now: NOW,
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected lease");
    expect(first.lease.attemptNumber).toBe(1);

    const overlapping = store.claimDelivery({
      taskId: "task-a",
      beaconId: "beacon-a",
      channel: "issues",
      workerId: "poller-2",
      leaseDurationMs: 1_000,
      now: "2026-07-16T12:00:00.500Z",
    });
    expect(overlapping.status).toBe("already_leased");

    store.close();
    store = undefined;
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    expect(store.getDeliveryLease("task-a")?.leaseToken).toBe(
      first.lease.leaseToken,
    );

    const second = store.claimDelivery({
      taskId: "task-a",
      beaconId: "beacon-a",
      channel: "issues",
      workerId: "poller-2",
      leaseDurationMs: 1_000,
      now: "2026-07-16T12:00:02.000Z",
    });
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") throw new Error("expected replacement lease");
    expect(second.lease.attemptNumber).toBe(2);
    expect(store.listDeliveryAttempts("task-a")[0]).toMatchObject({
      attemptNumber: 1,
      outcome: "transient_failure",
      error: "lease expired",
    });
    expect(
      store.finishDelivery({
        leaseToken: second.lease.leaseToken,
        outcome: "delivered",
        finishedAt: "2026-07-16T12:00:02.100Z",
      }),
    ).toBe(true);
    expect(store.getDeliveryLease("task-a")?.leaseToken).toBe(
      second.lease.leaseToken,
    );
    expect(store.getTask("task-a")?.state).toBe("delivered");
    expect(
      store.listDeliverableTasks(
        "beacon-a",
        "issues",
        "2026-07-16T12:00:02.500Z",
      ),
    ).toHaveLength(0);
    expect(
      store.listDeliverableTasks(
        "beacon-a",
        "issues",
        "2026-07-16T12:00:03.100Z",
      ).map((task) => task.taskId),
    ).toEqual(["task-a"]);

    store.provisionIdentityKey({
      keyId: "ed25519-a-v1",
      beaconId: "beacon-a",
      publicKey: "ed25519-public-a",
      provisionedBy: "operator:test",
    });
    expect(store.completeTaskResult({
      taskId: "task-a",
      beaconId: "beacon-a",
      canonicalResult: JSON.stringify({ output: "ok" }),
      signature: "signature-a",
      signatureKeyId: "ed25519-a-v1",
      signatureVerified: true,
    }).status).toBe("completed");
    expect(store.getDeliveryLease("task-a")).toBeUndefined();
  });

  it("commits durable message deduplication and its cursor atomically", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    const digest = sha256Hex("comment-body");
    expect(
      store.commitChannelProgress({
        channel: "issues",
        scope: "repo:owner/name",
        messageId: "comment-100",
        payloadDigest: digest,
        cursor: "2026-07-16T11:59:59.000Z",
      }),
    ).toEqual({ status: "committed" });
    expect(store.getPollCursor("issues", "repo:owner/name")?.cursor).toBe(
      "2026-07-16T11:59:59.000Z",
    );

    expect(
      store.commitChannelProgress({
        channel: "issues",
        scope: "repo:owner/name",
        messageId: "comment-100",
        payloadDigest: digest,
        cursor: "must-not-overwrite",
      }),
    ).toEqual({ status: "exact_duplicate" });
    expect(
      store.commitChannelProgress({
        channel: "issues",
        scope: "repo:owner/name",
        messageId: "comment-100",
        payloadDigest: sha256Hex("different-body"),
        cursor: "must-not-overwrite",
      }),
    ).toEqual({ status: "conflicting_duplicate" });
    expect(store.getPollCursor("issues", "repo:owner/name")?.cursor).toBe(
      "2026-07-16T11:59:59.000Z",
    );
  });

  it("recovers an expired OIDC owner and atomically caches its delivered response", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    store.createTask({
      taskId: "task-oidc",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "ref-oidc",
      preferredChannel: "oidc",
    });
    const payloadDigest = sha256Hex("bound OIDC request");
    const request = {
      jti: "oidc-jti-a",
      repository: "owner/repo",
      payloadDigest,
      beaconId: "beacon-a",
      tokenExpiresAt: "2026-07-16T12:05:00.000Z",
      processingLeaseMs: 1_000,
      replayChannel: "oidc-jti",
    };

    const first = store.beginOidcRequest(request);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected owner");
    const firstLease = store.claimDelivery({
      taskId: "task-oidc",
      beaconId: "beacon-a",
      channel: "oidc",
      workerId: first.workerId,
      leaseDurationMs: 60_000,
      now: NOW,
      oidcRequestGuard: {
        jti: request.jti,
        ownerToken: first.ownerToken,
      },
    });
    expect(firstLease.status).toBe("claimed");
    if (firstLease.status !== "claimed") throw new Error("expected lease");

    const recovered = store.beginOidcRequest({
      ...request,
      now: "2026-07-16T12:00:02.000Z",
    });
    expect(recovered).toMatchObject({
      status: "acquired",
      recovered: true,
      releasedTaskIds: ["task-oidc"],
    });
    if (recovered.status !== "acquired") throw new Error("expected recovery");
    expect(store.getDeliveryLease("task-oidc")).toBeUndefined();
    expect(store.listDeliveryAttempts("task-oidc")[0]).toMatchObject({
      outcome: "transient_failure",
      error: "OIDC request processing lease expired",
    });
    expect(store.claimDelivery({
      taskId: "task-oidc",
      beaconId: "beacon-a",
      channel: "oidc",
      workerId: first.workerId,
      leaseDurationMs: 60_000,
      oidcRequestGuard: {
        jti: request.jti,
        ownerToken: first.ownerToken,
      },
    })).toEqual({ status: "oidc_request_ownership_lost" });

    const replacementLease = store.claimDelivery({
      taskId: "task-oidc",
      beaconId: "beacon-a",
      channel: "oidc",
      workerId: recovered.workerId,
      leaseDurationMs: 60_000,
      now: "2026-07-16T12:00:02.000Z",
      oidcRequestGuard: {
        jti: request.jti,
        ownerToken: recovered.ownerToken,
      },
    });
    expect(replacementLease.status).toBe("claimed");
    if (replacementLease.status !== "claimed") {
      throw new Error("expected replacement lease");
    }

    const completed = store.completeOidcRequest({
      jti: request.jti,
      repository: request.repository,
      payloadDigest,
      beaconId: request.beaconId,
      ownerToken: recovered.ownerToken,
      responseStatus: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"tasks":["task-oidc"]}',
      outcome: "accepted",
      deliveryLeaseTokens: [replacementLease.lease.leaseToken],
      replayChannel: request.replayChannel,
      replayScope: "repo:owner/repo",
      replayCursor: request.tokenExpiresAt,
      completedAt: "2026-07-16T12:00:02.100Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      deliveredTaskIds: ["task-oidc"],
      request: {
        responseStatus: 200,
        responseBody: '{"tasks":["task-oidc"]}',
      },
    });
    expect(store.getTask("task-oidc")?.state).toBe("delivered");
    expect(store.getProcessedMessage("oidc-jti", request.jti)).toMatchObject({
      payloadDigest,
      outcome: "accepted",
    });
    expect(store.beginOidcRequest(request)).toMatchObject({
      status: "cached",
      request: {
        responseBody: '{"tasks":["task-oidc"]}',
      },
    });
    expect(store.beginOidcRequest({
      ...request,
      payloadDigest: sha256Hex("different request"),
    })).toEqual({ status: "conflicting_replay" });
  });

  it("preserves an aborted OIDC payload binding across store instances", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    const request = {
      jti: "oidc-abort-binding",
      repository: "owner/repo",
      payloadDigest: sha256Hex("original request"),
      beaconId: "beacon-a",
      tokenExpiresAt: "2026-07-16T12:05:00.000Z",
      processingLeaseMs: 30_000,
      replayChannel: "oidc-jti",
    };
    const first = store.beginOidcRequest(request);
    if (first.status !== "acquired") throw new Error("expected owner");

    expect(store.abortOidcRequest({
      jti: request.jti,
      ownerToken: first.ownerToken,
      workerId: first.workerId,
      error: "transient failure",
      abortedAt: "2026-07-16T12:00:00.100Z",
    })).toEqual([]);
    expect(store.getOidcRequest(request.jti)).toMatchObject({
      state: "processing",
      repository: request.repository,
      payloadDigest: request.payloadDigest,
      beaconId: request.beaconId,
      tokenExpiresAt: request.tokenExpiresAt,
      processingLeaseExpiresAt: "2026-07-16T12:00:00.100Z",
    });

    const peer = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date("2026-07-16T12:00:00.200Z"),
    });
    try {
      expect(peer.beginOidcRequest({
        ...request,
        payloadDigest: sha256Hex("different request"),
        now: "2026-07-16T12:00:00.200Z",
      })).toEqual({ status: "conflicting_replay" });
      expect(peer.beginOidcRequest({
        ...request,
        now: "2026-07-16T12:00:00.200Z",
      })).toMatchObject({
        status: "acquired",
        recovered: true,
      });
    } finally {
      peer.close();
    }
  });

  it("retains OIDC replay state until both retention and token expiry", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    const legacyDigest = sha256Hex("legacy oidc request");
    store.commitChannelProgress({
      channel: "oidc-jti",
      scope: "repo:owner/repo",
      messageId: "legacy-oidc-jti",
      payloadDigest: legacyDigest,
      cursor: "2026-07-16T12:05:00.000Z",
      beaconId: "beacon-a",
      processedAt: NOW,
    });

    const request = {
      jti: "completed-oidc-jti",
      repository: "owner/repo",
      payloadDigest: sha256Hex("completed oidc request"),
      beaconId: "beacon-a",
      tokenExpiresAt: "2026-07-16T12:05:00.000Z",
      processingLeaseMs: 30_000,
      replayChannel: "oidc-jti",
    };
    const begun = store.beginOidcRequest(request);
    if (begun.status !== "acquired") throw new Error("expected owner");
    expect(store.completeOidcRequest({
      jti: request.jti,
      repository: request.repository,
      payloadDigest: request.payloadDigest,
      beaconId: request.beaconId,
      ownerToken: begun.ownerToken,
      responseStatus: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"tasks":[]}',
      outcome: "accepted",
      replayChannel: request.replayChannel,
      replayScope: "repo:owner/repo",
      replayCursor: request.tokenExpiresAt,
      completedAt: "2026-07-16T12:00:00.100Z",
    }).status).toBe("completed");

    expect(store.deleteProcessedMessagesBefore(
      "2026-07-16T12:01:00.000Z",
    )).toBe(0);
    expect(store.getProcessedMessage("oidc-jti", "legacy-oidc-jti"))
      .toBeDefined();
    expect(store.getProcessedMessage("oidc-jti", request.jti)).toBeDefined();
    expect(store.sweepOidcRequests(
      "2026-07-16T12:01:00.000Z",
      "2026-07-16T12:04:59.999Z",
    )).toEqual({
      completedDeleted: 0,
      processingDeleted: 0,
      releasedTaskIds: [],
    });
    expect(store.getOidcRequest(request.jti)).toBeDefined();

    expect(store.sweepOidcRequests(
      "2026-07-16T12:01:00.000Z",
      request.tokenExpiresAt,
    )).toEqual({
      completedDeleted: 1,
      processingDeleted: 0,
      releasedTaskIds: [],
    });
    expect(store.getOidcRequest(request.jti)).toBeUndefined();
    expect(store.getProcessedMessage("oidc-jti", request.jti)).toBeUndefined();
    expect(store.getProcessedMessage("oidc-jti", "legacy-oidc-jti"))
      .toBeDefined();
  });

  it("sweeps expired processing requests and task leases after restart", () => {
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date(NOW),
    });
    store.upsertBeacon(beaconInput());
    store.createTask({
      taskId: "task-expired-oidc-worker",
      beaconId: "beacon-a",
      kind: "ping",
      ref: "expired-oidc-worker",
      preferredChannel: "oidc",
    });
    const request = {
      jti: "expired-processing-jti",
      repository: "owner/repo",
      payloadDigest: sha256Hex("expired processing request"),
      beaconId: "beacon-a",
      tokenExpiresAt: "2026-07-16T12:01:00.000Z",
      processingLeaseMs: 1_000,
      replayChannel: "oidc-jti",
    };
    const begun = store.beginOidcRequest(request);
    if (begun.status !== "acquired") throw new Error("expected owner");
    const lease = store.claimDelivery({
      taskId: "task-expired-oidc-worker",
      beaconId: "beacon-a",
      channel: "oidc",
      workerId: begun.workerId,
      leaseDurationMs: 60_000,
      now: NOW,
      oidcRequestGuard: {
        jti: request.jti,
        ownerToken: begun.ownerToken,
      },
    });
    expect(lease.status).toBe("claimed");
    expect(store.sweepOidcRequests(
      "2026-07-16T12:00:30.000Z",
      "2026-07-16T12:00:30.000Z",
    )).toEqual({
      completedDeleted: 0,
      processingDeleted: 0,
      releasedTaskIds: [],
    });
    expect(store.getOidcRequest(request.jti)).toBeDefined();
    expect(store.getDeliveryLease("task-expired-oidc-worker")).toBeDefined();

    store.close();
    store = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => new Date("2026-07-16T12:02:00.000Z"),
    });
    expect(store.sweepOidcRequests(
      "2026-07-16T12:02:00.000Z",
      "2026-07-16T12:02:00.000Z",
    )).toEqual({
      completedDeleted: 0,
      processingDeleted: 1,
      releasedTaskIds: ["task-expired-oidc-worker"],
    });
    expect(store.getOidcRequest(request.jti)).toBeUndefined();
    expect(store.getDeliveryLease("task-expired-oidc-worker")).toBeUndefined();
    expect(store.listDeliveryAttempts("task-expired-oidc-worker")[0])
      .toMatchObject({
        outcome: "transient_failure",
        error: "OIDC token and processing lease expired",
      });
  });
});
