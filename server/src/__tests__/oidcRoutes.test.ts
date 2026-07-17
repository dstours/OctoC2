import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const mockJwtVerify = mock(async () => ({ payload: {}, protectedHeader: {} }));
mock.module("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: mockJwtVerify,
}));

import {
  OidcRoutes,
  beaconIdFromRepository,
  parseOidcBindings,
} from "../http/OidcRoutes.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import {
  bytesToBase64,
  generateOperatorKeyPair,
  sealBox,
} from "../crypto/sodium.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore } from "../store/index.ts";

const REPOSITORY = "testowner/testrepo";
const SUBJECT = `repo:${REPOSITORY}:ref:refs/heads/main`;
const WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/beacon.yml@refs/heads/main`;
const BEACON_ID = "beacon-oidc-test";

interface Fixture {
  dataDir: string;
  store: OctoStore;
  registry: BeaconRegistry;
  queue: TaskQueue;
  identities: BeaconIdentityService;
  tasks: TaskService;
  routes: OidcRoutes;
  operatorPublicKey: Uint8Array;
  operatorSecretKey: Uint8Array;
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  signingKeyId: string;
  encryptionPublicKey: string;
}

const fixtures: Fixture[] = [];
const additionalStores: OctoStore[] = [];

beforeEach(() => {
  mockJwtVerify.mockReset();
});

afterEach(() => {
  for (const store of additionalStores.splice(0)) {
    store.close();
  }
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    try {
      rmSync(fixture.dataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      });
    } catch {
      // Windows can briefly retain SQLite WAL handles after close. The fixture
      // is isolated under the OS temp directory and contains no credentials.
    }
  }
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "github-actions",
    repository: REPOSITORY,
    sub: SUBJECT,
    workflow_ref: WORKFLOW_REF,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

function useClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = claims(overrides);
  mockJwtVerify.mockResolvedValueOnce({
    payload,
    protectedHeader: { alg: "RS256" },
  });
  return payload;
}

async function createFixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "octoc2-oidc-"));
  const store = OctoStore.open({ dataDir, importLegacyRegistry: false });
  const registry = new BeaconRegistry(store);
  const queue = new TaskQueue(store);
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  const operator = await generateOperatorKeyPair();
  const signing = await generateEd25519KeyPair();
  const signingKeyId = await ed25519KeyId(signing.publicKey);
  const encryption = await generateOperatorKeyPair();
  const encryptionPublicKey = await bytesToBase64(encryption.publicKey);

  await identities.enroll({
    version: 1,
    beaconId: BEACON_ID,
    encryptionPublicKey,
    signingPublicKey: encodeBase64Url(signing.publicKey),
    signingKeyId,
    createdAt: new Date().toISOString(),
  });
  await registry.load();

  const routes = new OidcRoutes({
    registry,
    taskQueue: queue,
    store,
    identities,
    tasks,
    operatorPublicKey: operator.publicKey,
    operatorSecretKey: operator.secretKey,
    bindings: [{
      repository: REPOSITORY,
      beaconId: BEACON_ID,
      subjects: [SUBJECT],
      workflowRefs: [WORKFLOW_REF],
    }],
  });
  const fixture = {
    dataDir,
    store,
    registry,
    queue,
    identities,
    tasks,
    routes,
    operatorPublicKey: operator.publicKey,
    operatorSecretKey: operator.secretKey,
    signingPublicKey: signing.publicKey,
    signingSecretKey: signing.secretKey,
    signingKeyId,
    encryptionPublicKey,
  };
  fixtures.push(fixture);
  return fixture;
}

async function createPeerRoutes(fixture: Fixture): Promise<{
  store: OctoStore;
  registry: BeaconRegistry;
  queue: TaskQueue;
  identities: BeaconIdentityService;
  routes: OidcRoutes;
}> {
  const store = OctoStore.open({
    dataDir: fixture.dataDir,
    importLegacyRegistry: false,
  });
  additionalStores.push(store);
  const registry = new BeaconRegistry(store);
  const queue = new TaskQueue(store);
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  await registry.load();
  return {
    store,
    registry,
    queue,
    identities,
    routes: new OidcRoutes({
      registry,
      taskQueue: queue,
      store,
      identities,
      tasks,
      operatorPublicKey: fixture.operatorPublicKey,
      operatorSecretKey: fixture.operatorSecretKey,
      bindings: [{
        repository: REPOSITORY,
        beaconId: BEACON_ID,
        subjects: [SUBJECT],
        workflowRefs: [WORKFLOW_REF],
      }],
    }),
  };
}

async function signedCheckin(
  fixture: Fixture,
  sequence = 1,
  checkinAt = new Date().toISOString(),
): Promise<CheckinPayload> {
  const common = {
    beaconId: BEACON_ID,
    publicKey: fixture.encryptionPublicKey,
    hostname: "gha-runner",
    username: "actions",
    os: "linux",
    arch: "x64",
    pid: 1234,
    checkinAt,
  };
  return {
    ...common,
    identity: await signEnvelope(createUnsignedEnvelope({
      kind: "checkin",
      signerId: BEACON_ID,
      keyId: fixture.signingKeyId,
      issuedAt: checkinAt,
      sequence,
      payload: {
        beaconId: BEACON_ID,
        encryptionPublicKey: fixture.encryptionPublicKey,
        signingPublicKey: encodeBase64Url(fixture.signingPublicKey),
        hostname: common.hostname,
        username: common.username,
        os: common.os,
        arch: common.arch,
        pid: common.pid,
        checkinAt,
      },
    }), fixture.signingSecretKey),
  };
}

async function signedResult(
  fixture: Fixture,
  taskId: string,
  sequence: number,
): Promise<TaskResult> {
  const unsigned: TaskResult = {
    taskId,
    beaconId: BEACON_ID,
    success: true,
    output: "ok",
    completedAt: new Date().toISOString(),
  };
  const signature = await signEnvelope(createUnsignedEnvelope({
    kind: "task-result",
    signerId: BEACON_ID,
    keyId: fixture.signingKeyId,
    issuedAt: unsigned.completedAt,
    sequence,
    payload: await createTaskResultSignaturePayload(unsigned),
  }), fixture.signingSecretKey);
  return { ...unsigned, signature: serializeSignedEnvelope(signature) };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OIDC binding configuration", () => {
  it("parses exact repository, subject, and workflow allowlists", () => {
    expect(parseOidcBindings(JSON.stringify([{
      repository: "Owner/Repo",
      beaconId: "beacon-1",
      subjects: ["repo:Owner/Repo:environment:prod"],
      workflowRefs: ["Owner/Repo/.github/workflows/a.yml@refs/heads/main"],
    }]))).toEqual([{
      repository: "owner/repo",
      beaconId: "beacon-1",
      subjects: ["repo:Owner/Repo:environment:prod"],
      workflowRefs: ["Owner/Repo/.github/workflows/a.yml@refs/heads/main"],
    }]);
  });

  it("rejects empty or wildcard-like configuration", () => {
    expect(() => parseOidcBindings("[]")).toThrow("non-empty");
    expect(() => parseOidcBindings(JSON.stringify([{
      repository: REPOSITORY,
      beaconId: BEACON_ID,
      subjects: [],
      workflowRefs: [WORKFLOW_REF],
    }]))).toThrow("subjects");
  });

  it("keeps the legacy repository hash deterministic but does not authorize it", () => {
    expect(beaconIdFromRepository(REPOSITORY)).toMatch(/^[0-9a-f]{16}$/);
    expect(beaconIdFromRepository(REPOSITORY)).toBe(
      beaconIdFromRepository(REPOSITORY),
    );
  });
});

describe("OIDC checkin authorization", () => {
  it("accepts only an allowlisted, signed, pre-enrolled checkin", async () => {
    const fixture = await createFixture();
    useClaims();
    const response = await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-1",
        checkin: await signedCheckin(fixture),
      }),
      "/api/oidc/checkin",
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      tasks: [],
      sequence: "accepted",
    });
    expect(fixture.registry.get(BEACON_ID)?.activeTentacle).toBe(7);
  });

  it("leases only OIDC tasks and does not redeliver an active claim", async () => {
    const fixture = await createFixture();
    const oidcTask = fixture.queue.queueTask(
      BEACON_ID,
      "ping",
      {},
      "oidc",
    );
    const httpTask = fixture.queue.queueTask(
      BEACON_ID,
      "ping",
      {},
      "http",
    );

    useClaims();
    const first = await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-lease-1",
        checkin: await signedCheckin(fixture, 1),
      }),
      "/api/oidc/checkin",
    );
    const firstBody = await first?.json() as {
      tasks: Array<{ taskId: string }>;
    };
    expect(first?.status).toBe(200);
    expect(firstBody.tasks.map(({ taskId }) => taskId)).toEqual([
      oidcTask.taskId,
    ]);
    expect(fixture.store.getDeliveryLease(oidcTask.taskId)?.channel).toBe(
      "oidc",
    );
    expect(fixture.queue.getTask(httpTask.taskId)?.state).toBe("pending");

    useClaims();
    const second = await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-lease-2",
        checkin: await signedCheckin(fixture, 2),
      }),
      "/api/oidc/checkin",
    );
    expect((await second?.json() as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("does not claim newly queued tasks for a duplicate under a new jti", async () => {
    const fixture = await createFixture();
    const checkin = await signedCheckin(fixture);
    useClaims({ jti: "accepted-jti" });
    const accepted = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "accepted-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(accepted?.status).toBe(200);

    const task = fixture.queue.queueTask(BEACON_ID, "ping", {}, "oidc");
    useClaims({ jti: "duplicate-jti" });
    const duplicate = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "duplicate-jwt", checkin }),
      "/api/oidc/checkin",
    );
    const body = await duplicate?.json() as {
      tasks: Array<{ taskId: string }>;
      sequence: string;
    };
    expect(duplicate?.status).toBe(200);
    expect(body).toEqual({ tasks: [], sequence: "duplicate" });
    expect(fixture.store.getDeliveryLease(task.taskId)).toBeUndefined();
    expect(fixture.store.getTask(task.taskId)?.state).toBe("pending");
  });

  it("does not let stale exact-checkin recovery claim new tasks", async () => {
    const fixture = await createFixture();
    const checkin = await signedCheckin(
      fixture,
      1,
      new Date(Date.now() - 60_000).toISOString(),
    );
    useClaims({ jti: "accepted-before-stale-jti" });
    const accepted = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "accepted-before-stale-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(accepted?.status).toBe(200);

    const task = fixture.queue.queueTask(BEACON_ID, "ping", {}, "oidc");
    const staleIdentities = new BeaconIdentityService(
      fixture.store,
      fixture.registry,
      5 * 60_000,
      30_000,
    );
    const staleRoutes = new OidcRoutes({
      registry: fixture.registry,
      taskQueue: fixture.queue,
      store: fixture.store,
      identities: staleIdentities,
      tasks: fixture.tasks,
      operatorPublicKey: fixture.operatorPublicKey,
      operatorSecretKey: fixture.operatorSecretKey,
      bindings: [{
        repository: REPOSITORY,
        beaconId: BEACON_ID,
        subjects: [SUBJECT],
        workflowRefs: [WORKFLOW_REF],
      }],
    });
    useClaims({ jti: "stale-duplicate-jti" });
    const duplicate = await staleRoutes.handle(
      post("/api/oidc/checkin", { jwt: "stale-duplicate-jwt", checkin }),
      "/api/oidc/checkin",
    );
    const body = await duplicate?.json() as {
      tasks: Array<{ taskId: string }>;
      sequence: string;
    };
    expect(duplicate?.status).toBe(200);
    expect(body).toEqual({ tasks: [], sequence: "stale_duplicate" });
    expect(fixture.store.getDeliveryLease(task.taskId)).toBeUndefined();
    expect(fixture.store.getTask(task.taskId)?.state).toBe("pending");
  });

  it.each([
    ["repository", { repository: "attacker/repo" }],
    ["subject", { sub: `repo:${REPOSITORY}:pull_request` }],
    ["workflow", {
      workflow_ref:
        `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`,
    }],
  ])("rejects a non-allowlisted %s claim", async (_name, overrides) => {
    const fixture = await createFixture();
    useClaims(overrides);
    const response = await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-provenance",
        checkin: await signedCheckin(fixture),
      }),
      "/api/oidc/checkin",
    );
    expect(response?.status).toBe(403);
  });

  it("rejects a missing jti before beacon mutation", async () => {
    const fixture = await createFixture();
    useClaims({ jti: undefined });
    const response = await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-no-jti",
        checkin: await signedCheckin(fixture),
      }),
      "/api/oidc/checkin",
    );
    expect(response?.status).toBe(401);
    expect(fixture.registry.get(BEACON_ID)?.lastSeq).toBe(0);
  });

  it("durably replays the cached response for the same jti and payload", async () => {
    const fixture = await createFixture();
    const checkin = await signedCheckin(fixture);
    const replayClaims = claims({ jti: "fixed-jti" });
    mockJwtVerify.mockResolvedValueOnce({
      payload: replayClaims,
      protectedHeader: { alg: "RS256" },
    });
    const first = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "same-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(first?.status).toBe(200);
    const firstBody = await first?.text();

    const reconstructed = new OidcRoutes({
      registry: fixture.registry,
      taskQueue: fixture.queue,
      store: fixture.store,
      identities: fixture.identities,
      tasks: fixture.tasks,
      operatorPublicKey: fixture.operatorPublicKey,
      operatorSecretKey: fixture.operatorSecretKey,
      bindings: [{
        repository: REPOSITORY,
        beaconId: BEACON_ID,
        subjects: [SUBJECT],
        workflowRefs: [WORKFLOW_REF],
      }],
    });
    mockJwtVerify.mockResolvedValueOnce({
      payload: replayClaims,
      protectedHeader: { alg: "RS256" },
    });
    const replay = await reconstructed.handle(
      post("/api/oidc/checkin", { jwt: "same-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(replay?.status).toBe(200);
    expect(await replay?.text()).toBe(firstBody);
    expect(fixture.store.getProcessedMessage("oidc-jti", "fixed-jti"))
      .toBeDefined();
    expect(fixture.store.getOidcRequest("fixed-jti")).toMatchObject({
      state: "completed",
      responseStatus: 200,
      responseBody: firstBody,
    });

    const conflicting = structuredClone(checkin);
    conflicting.hostname = "different-payload";
    mockJwtVerify.mockResolvedValueOnce({
      payload: replayClaims,
      protectedHeader: { alg: "RS256" },
    });
    const conflict = await reconstructed.handle(
      post("/api/oidc/checkin", {
        jwt: "same-jwt",
        checkin: conflicting,
      }),
      "/api/oidc/checkin",
    );
    expect(conflict?.status).toBe(409);
  });

  it("releases a payload-bound jti after a transient post-auth failure", async () => {
    const fixture = await createFixture();
    const checkin = await signedCheckin(fixture);
    const retryClaims = claims({ jti: "retryable-jti" });
    const original = fixture.identities.verifyAndRegisterCheckin.bind(
      fixture.identities,
    );
    let attempts = 0;
    fixture.identities.verifyAndRegisterCheckin = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated SQLite interruption");
      return original(...args);
    };

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const first = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(first?.status).toBe(503);
    expect(fixture.store.getProcessedMessage("oidc-jti", "retryable-jti"))
      .toBeUndefined();
    expect(fixture.registry.get(BEACON_ID)?.lastSeq).toBe(0);

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const retry = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(retry?.status).toBe(200);
    expect(fixture.store.getProcessedMessage("oidc-jti", "retryable-jti"))
      .toMatchObject({ outcome: "accepted" });
    expect(attempts).toBe(2);
  });

  it("preserves the payload binding and releases task claims before commit", async () => {
    const fixture = await createFixture();
    const task = fixture.queue.queueTask(BEACON_ID, "ping", {}, "oidc");
    const checkin = await signedCheckin(fixture);
    const retryClaims = claims({ jti: "precommit-failure-jti" });
    const complete = fixture.store.completeOidcRequest.bind(fixture.store);
    let attempts = 0;
    fixture.store.completeOidcRequest = (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("simulated failure before OIDC commit");
      }
      return complete(input);
    };

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const first = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(first?.status).toBe(503);
    expect(fixture.store.getOidcRequest(retryClaims["jti"] as string))
      .toMatchObject({
        state: "processing",
        repository: REPOSITORY,
        beaconId: BEACON_ID,
      });
    expect(fixture.store.getDeliveryLease(task.taskId)).toBeUndefined();
    expect(fixture.store.listDeliveryAttempts(task.taskId)[0]).toMatchObject({
      outcome: "transient_failure",
      error: "simulated failure before OIDC commit",
    });

    const conflicting = structuredClone(checkin);
    conflicting.hostname = "different-payload";
    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const conflict = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin: conflicting }),
      "/api/oidc/checkin",
    );
    expect(conflict?.status).toBe(409);

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const retry = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    const body = await retry?.json() as {
      tasks: Array<{ taskId: string }>;
    };
    expect(retry?.status).toBe(200);
    expect(body.tasks.map(({ taskId }) => taskId)).toEqual([task.taskId]);
    expect(attempts).toBe(2);
  });

  it("returns the cached task response after a post-commit failure", async () => {
    const fixture = await createFixture();
    const task = fixture.queue.queueTask(BEACON_ID, "ping", {}, "oidc");
    const checkin = await signedCheckin(fixture);
    const retryClaims = claims({ jti: "postcommit-failure-jti" });
    const complete = fixture.store.completeOidcRequest.bind(fixture.store);
    let failAfterCommit = true;
    fixture.store.completeOidcRequest = (input) => {
      const outcome = complete(input);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("simulated response loss after OIDC commit");
      }
      return outcome;
    };

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const first = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(first?.status).toBe(503);
    const cached = fixture.store.getOidcRequest(
      retryClaims["jti"] as string,
    );
    expect(cached).toMatchObject({
      state: "completed",
      responseStatus: 200,
    });
    if (cached?.state !== "completed" || cached.responseBody === null) {
      throw new Error("expected cached OIDC response");
    }
    expect(fixture.store.getDeliveryLease(task.taskId)).toBeDefined();
    expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);

    mockJwtVerify.mockResolvedValueOnce({
      payload: retryClaims,
      protectedHeader: { alg: "RS256" },
    });
    const retry = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "retry-jwt", checkin }),
      "/api/oidc/checkin",
    );
    expect(retry?.status).toBe(200);
    expect(await retry?.text()).toBe(cached.responseBody);
    expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);
  });

  it("coordinates the same jti across independent route and store instances", async () => {
    const fixture = await createFixture();
    const peer = await createPeerRoutes(fixture);
    const task = fixture.queue.queueTask(BEACON_ID, "ping", {}, "oidc");
    peer.queue.refreshTask(task.taskId);
    const checkin = await signedCheckin(fixture);
    const concurrentClaims = claims({ jti: "concurrent-jti" });
    mockJwtVerify.mockResolvedValueOnce({
      payload: concurrentClaims,
      protectedHeader: { alg: "RS256" },
    });
    mockJwtVerify.mockResolvedValueOnce({
      payload: concurrentClaims,
      protectedHeader: { alg: "RS256" },
    });

    const verify = fixture.identities.verifyAndRegisterCheckin.bind(
      fixture.identities,
    );
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.identities.verifyAndRegisterCheckin = async (...args) => {
      entered();
      await gate;
      return verify(...args);
    };

    const firstPromise = fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "same-jwt", checkin }),
      "/api/oidc/checkin",
    );
    await enteredPromise;
    const secondPromise = peer.routes.handle(
      post("/api/oidc/checkin", { jwt: "same-jwt", checkin }),
      "/api/oidc/checkin",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await second?.text()).toBe(await first?.text());
    expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);
    expect(fixture.store.getOidcRequest("concurrent-jti")?.state).toBe(
      "completed",
    );
  });

  it("rejects a tampered signed checkin", async () => {
    const fixture = await createFixture();
    useClaims();
    const checkin = await signedCheckin(fixture);
    checkin.hostname = "tampered";
    const response = await fixture.routes.handle(
      post("/api/oidc/checkin", { jwt: "jwt-tampered", checkin }),
      "/api/oidc/checkin",
    );
    expect(response?.status).toBe(403);
  });
});

describe("OIDC signed results", () => {
  it("hydrates a task queued by another process before caching not-found", async () => {
    const fixture = await createFixture();
    const peer = await createPeerRoutes(fixture);
    const task = fixture.queue.queueTask(BEACON_ID, "shell", { cmd: "id" });
    expect(peer.queue.getTask(task.taskId)).toBeUndefined();

    const result = await signedResult(fixture, task.taskId, 1);
    useClaims({ jti: "cross-process-result-jti" });
    const accepted = await peer.routes.handle(
      post("/api/oidc/result", {
        jwt: "cross-process-result-jwt",
        taskId: task.taskId,
        sealed: await sealBox(
          JSON.stringify(result),
          fixture.operatorPublicKey,
        ),
      }),
      "/api/oidc/result",
    );
    expect(accepted?.status).toBe(200);
    expect(peer.queue.getTask(task.taskId)?.state).toBe("completed");
    expect(peer.store.getTaskResult(task.taskId)?.signatureVerified).toBe(true);

    const missingTaskId = "actually-unknown-task";
    const missingResult = await signedResult(fixture, missingTaskId, 2);
    useClaims({ jti: "cross-process-missing-result-jti" });
    const missing = await peer.routes.handle(
      post("/api/oidc/result", {
        jwt: "cross-process-missing-result-jwt",
        taskId: missingTaskId,
        sealed: await sealBox(
          JSON.stringify(missingResult),
          fixture.operatorPublicKey,
        ),
      }),
      "/api/oidc/result",
    );
    expect(missing?.status).toBe(404);
    expect(peer.store.getOidcRequest("cross-process-missing-result-jti"))
      .toMatchObject({
        state: "completed",
        outcome: "rejected",
        responseStatus: 404,
      });
  });

  it("routes a signed result through TaskService", async () => {
    const fixture = await createFixture();
    useClaims();
    await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-checkin",
        checkin: await signedCheckin(fixture),
      }),
      "/api/oidc/checkin",
    );
    const task = fixture.queue.queueTask(BEACON_ID, "shell", { cmd: "id" });
    const result = await signedResult(fixture, task.taskId, 2);
    const sealed = await sealBox(
      JSON.stringify(result),
      fixture.operatorPublicKey,
    );
    useClaims();
    const response = await fixture.routes.handle(
      post("/api/oidc/result", {
        jwt: "jwt-result",
        taskId: task.taskId,
        sealed,
      }),
      "/api/oidc/result",
    );

    expect(response?.status).toBe(200);
    expect(fixture.queue.getTask(task.taskId)?.state).toBe("completed");
    expect(fixture.store.getTaskResult(task.taskId)?.signatureVerified).toBe(true);
  });

  it("rejects a result whose signature does not match its content", async () => {
    const fixture = await createFixture();
    useClaims();
    await fixture.routes.handle(
      post("/api/oidc/checkin", {
        jwt: "jwt-checkin",
        checkin: await signedCheckin(fixture),
      }),
      "/api/oidc/checkin",
    );
    const task = fixture.queue.queueTask(BEACON_ID, "shell", { cmd: "id" });
    const result = await signedResult(fixture, task.taskId, 2);
    result.output = "tampered";
    useClaims();
    const response = await fixture.routes.handle(
      post("/api/oidc/result", {
        jwt: "jwt-result",
        taskId: task.taskId,
        sealed: await sealBox(
          JSON.stringify(result),
          fixture.operatorPublicKey,
        ),
      }),
      "/api/oidc/result",
    );
    expect(response?.status).toBe(403);
    expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");
  });

  it("rejects a body task ID that differs from the signed result", async () => {
    const fixture = await createFixture();
    const task = fixture.queue.queueTask(BEACON_ID, "shell", { cmd: "id" });
    const result = await signedResult(fixture, task.taskId, 1);
    useClaims();
    const response = await fixture.routes.handle(
      post("/api/oidc/result", {
        jwt: "jwt-result",
        taskId: "different-task",
        sealed: await sealBox(
          JSON.stringify(result),
          fixture.operatorPublicKey,
        ),
      }),
      "/api/oidc/result",
    );
    expect(response?.status).toBe(400);
  });
});
