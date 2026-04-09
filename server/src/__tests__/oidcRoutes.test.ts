/**
 * OctoC2 Server — OidcRoutes tests
 *
 * Tests for POST /api/oidc/checkin and POST /api/oidc/result.
 * `jwtVerify` from `jose` is mocked to avoid real network calls.
 */

import { describe, it, expect, mock, beforeAll } from "bun:test";

// ── Mock jose before importing OidcRoutes ────────────────────────────────────

const mockJwtVerify = mock(async (_jwt: string, _jwks: unknown, _opts: unknown) => ({
  payload: {
    iss:        "https://token.actions.githubusercontent.com",
    aud:        "github-actions",
    repository: "testowner/testrepo",
    sub:        "repo:testowner/testrepo:ref:refs/heads/main",
    exp:        Math.floor(Date.now() / 1000) + 300,
  },
  protectedHeader: { alg: "RS256" },
}));

mock.module("jose", () => ({
  createRemoteJWKSet: (_url: URL) => ({}),
  jwtVerify:          mockJwtVerify,
}));

import { OidcRoutes, beaconIdFromRepository } from "../http/OidcRoutes.ts";
import { BeaconRegistry }                     from "../BeaconRegistry.ts";
import { TaskQueue }                          from "../TaskQueue.ts";
import {
  generateOperatorKeyPair,
  encryptForBeacon,
  base64ToBytes,
}                                             from "../crypto/sodium.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoutes(opts?: {
  registry?:          BeaconRegistry;
  taskQueue?:         TaskQueue;
  operatorSecretKey?: Uint8Array;
}): OidcRoutes {
  return new OidcRoutes({
    registry:          opts?.registry          ?? new BeaconRegistry("/tmp/svc-oidc-test"),
    taskQueue:         opts?.taskQueue          ?? new TaskQueue(),
    operatorSecretKey: opts?.operatorSecretKey  ?? new Uint8Array(32),
  });
}

function postReq(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// ── beaconIdFromRepository ────────────────────────────────────────────────────

describe("beaconIdFromRepository()", () => {
  it("returns a 16-character hex string", () => {
    const id = beaconIdFromRepository("testowner/testrepo");
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it("is deterministic", () => {
    const a = beaconIdFromRepository("owner/repo");
    const b = beaconIdFromRepository("owner/repo");
    expect(a).toBe(b);
  });

  it("differs for different repositories", () => {
    expect(beaconIdFromRepository("owner/a")).not.toBe(beaconIdFromRepository("owner/b"));
  });
});

// ── POST /api/oidc/checkin ────────────────────────────────────────────────────

describe("POST /api/oidc/checkin", () => {
  it("returns 200 with empty task list when no pending tasks", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        iss:        "https://token.actions.githubusercontent.com",
        aud:        "github-actions",
        repository: "testowner/testrepo",
        sub:        "repo:testowner/testrepo:ref:refs/heads/main",
        exp:        Math.floor(Date.now() / 1000) + 300,
      },
      protectedHeader: { alg: "RS256" },
    });

    const routes = makeRoutes();
    const req    = postReq("/api/oidc/checkin", { jwt: "valid.jwt.token", pubkey: "aGVsbG8" });
    const resp   = await routes.handle(req, "/api/oidc/checkin");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { tasks: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(0);
  });

  it("returns 200 with encrypted tasks when tasks are pending", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        iss:        "https://token.actions.githubusercontent.com",
        aud:        "github-actions",
        repository: "testowner/testrepo",
        sub:        "repo:testowner/testrepo:ref:refs/heads/main",
        exp:        Math.floor(Date.now() / 1000) + 300,
      },
      protectedHeader: { alg: "RS256" },
    });

    const { publicKey: beaconPub, secretKey: _beaconSec } = await generateOperatorKeyPair();
    const { publicKey: operatorPub, secretKey: operatorSec } = await generateOperatorKeyPair();

    // Import the sodium module to encode the beacon public key
    const { bytesToBase64 } = await import("../crypto/sodium.ts");
    const beaconPubB64 = await bytesToBase64(beaconPub);

    const registry  = new BeaconRegistry("/tmp/svc-oidc-tasks-test");
    const taskQueue = new TaskQueue();

    const beaconId = beaconIdFromRepository("testowner/testrepo");

    // Pre-register the beacon
    registry.register({
      beaconId,
      issueNumber: 0,
      publicKey:   beaconPubB64,
      hostname:    "testowner/testrepo",
      username:    "actions",
      os:          "linux",
      arch:        "x64",
      seq:         1,
    });

    // Queue a task
    const task = taskQueue.queueTask(beaconId, "shell", { cmd: "whoami" });

    const routes = makeRoutes({ registry, taskQueue, operatorSecretKey: operatorSec });
    const req    = postReq("/api/oidc/checkin", { jwt: "valid.jwt.token", pubkey: beaconPubB64 });
    const resp   = await routes.handle(req, "/api/oidc/checkin");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as {
      tasks: Array<{ taskId: string; nonce: string; ciphertext: string }>;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.taskId).toBe(task.taskId);
    expect(typeof body.tasks[0]!.nonce).toBe("string");
    expect(typeof body.tasks[0]!.ciphertext).toBe("string");

    // Verify the task was marked delivered
    expect(taskQueue.getTask(task.taskId)!.state).toBe("delivered");
  });

  it("returns 401 when JWT verification fails", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("invalid signature"));

    const routes = makeRoutes();
    const req    = postReq("/api/oidc/checkin", { jwt: "bad.jwt.token", pubkey: "" });
    const resp   = await routes.handle(req, "/api/oidc/checkin");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(401);
    const body = await resp!.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 400 when jwt field is missing", async () => {
    const routes = makeRoutes();
    const req    = postReq("/api/oidc/checkin", { pubkey: "abc" });
    const resp   = await routes.handle(req, "/api/oidc/checkin");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(400);
  });

  it("returns null for unmatched paths", async () => {
    const routes = makeRoutes();
    const req    = new Request("http://localhost/api/beacons", { method: "POST" });
    const resp   = await routes.handle(req, "/api/beacons");
    expect(resp).toBeNull();
  });
});

// ── POST /api/oidc/result ─────────────────────────────────────────────────────

describe("POST /api/oidc/result", () => {
  it("returns 200 with ok:true when JWT is valid", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        iss:        "https://token.actions.githubusercontent.com",
        aud:        "github-actions",
        repository: "testowner/testrepo",
        sub:        "repo:testowner/testrepo:ref:refs/heads/main",
        exp:        Math.floor(Date.now() / 1000) + 300,
      },
      protectedHeader: { alg: "RS256" },
    });

    const taskQueue = new TaskQueue();
    const beaconId  = beaconIdFromRepository("testowner/testrepo");
    const task      = taskQueue.queueTask(beaconId, "shell", { cmd: "id" });

    const routes = makeRoutes({ taskQueue });
    const req    = postReq("/api/oidc/result", {
      jwt:    "valid.jwt.token",
      taskId: task.taskId,
      sealed: "sealedpayloadbase64",
    });
    const resp = await routes.handle(req, "/api/oidc/result");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Task should be marked completed with the sealed payload
    const updated = taskQueue.getTask(task.taskId)!;
    expect(updated.state).toBe("completed");
    expect(updated.result).toBe("sealedpayloadbase64");
  });

  it("returns 401 when JWT verification fails", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("expired"));

    const routes = makeRoutes();
    const req    = postReq("/api/oidc/result", {
      jwt:    "expired.jwt.token",
      taskId: "task-123",
      sealed: "abc",
    });
    const resp = await routes.handle(req, "/api/oidc/result");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(401);
    const body = await resp!.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 400 when jwt field is missing", async () => {
    const routes = makeRoutes();
    const req    = postReq("/api/oidc/result", { taskId: "t1", sealed: "abc" });
    const resp   = await routes.handle(req, "/api/oidc/result");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(400);
  });

  it("returns 200 ok:true even when taskId is unknown (idempotent)", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        iss:        "https://token.actions.githubusercontent.com",
        aud:        "github-actions",
        repository: "testowner/testrepo",
        sub:        "repo:testowner/testrepo:ref:refs/heads/main",
        exp:        Math.floor(Date.now() / 1000) + 300,
      },
      protectedHeader: { alg: "RS256" },
    });

    const routes = makeRoutes();
    const req    = postReq("/api/oidc/result", {
      jwt:    "valid.jwt.token",
      taskId: "nonexistent-task-id",
      sealed: "abc",
    });
    const resp = await routes.handle(req, "/api/oidc/result");

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
