import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BeaconGrpcService,
  parseGrpcClientCertificateFingerprintMap,
  type GrpcTlsConfig,
} from "../grpc/BeaconGrpcService.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { CredentialVerifier } from "../services/CredentialVerifier.ts";
import {
  checkinAuthorizesTaskDelivery,
  type CheckinVerificationStatus,
} from "../services/BeaconIdentityService.ts";

interface CheckinReq {
  beaconId: string;
  publicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  pid: number;
  checkinAt: string;
  identityEnvelope: string;
}

interface SubmitResultReq {
  result: {
    taskId: string;
    beaconId: string;
    success: boolean;
    output: string;
    data: string;
    completedAt: string;
    signature: string;
    metadataJson: string;
    hasData: boolean;
  };
}

const BASE_CHECKIN: CheckinReq = {
  beaconId: "test-beacon-001",
  publicKey: "dGVzdC1wdWJsaWMta2V5",
  hostname: "test-host",
  username: "test-user",
  os: "linux",
  arch: "x64",
  pid: 1234,
  checkinAt: new Date().toISOString(),
  identityEnvelope: "{}",
};

const CERTIFICATE_FINGERPRINT_001 = "11".repeat(32);
const CERTIFICATE_FINGERPRINT_002 = "22".repeat(32);

const DUMMY_TLS: GrpcTlsConfig = {
  rootCerts: Buffer.from("unused"),
  privateKey: Buffer.from("unused"),
  certChain: Buffer.from("unused"),
  clientCertificateFingerprints: {
    "test-beacon-001": CERTIFICATE_FINGERPRINT_001,
    "test-beacon-002": CERTIFICATE_FINGERPRINT_002,
  },
};

function makeCall<T>(
  request: T,
  bearer?: string,
  peerFingerprint = bearer === "token-002"
    ? CERTIFICATE_FINGERPRINT_002
    : CERTIFICATE_FINGERPRINT_001,
): {
  request: T;
  metadata: grpc.Metadata;
  getAuthContext: () => {
    transportSecurityType: string;
    sslPeerCertificate: { fingerprint256: string };
  };
} {
  const metadata = new grpc.Metadata();
  if (bearer) metadata.set("authorization", `Bearer ${bearer}`);
  return {
    request,
    metadata,
    getAuthContext: () => ({
      transportSecurityType: "ssl",
      sslPeerCertificate: {
        fingerprint256: peerFingerprint.match(/.{2}/g)!.join(":"),
      },
    }),
  };
}

function callHandler<Req, Res>(
  handler: (call: any, cb: any) => void,
  request: Req,
  bearer = "token-001",
  peerFingerprint?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    handler(
      makeCall(request, bearer, peerFingerprint),
      (err: unknown, response: Res) => {
        if (err) reject(err);
        else resolve(response);
      },
    );
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function bindPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function findOpenSsl(): string {
  const onPath = Bun.which("openssl");
  if (onPath) return onPath;
  for (const candidate of [
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("openssl is required for the local gRPC TLS test");
}

async function ephemeralTls(): Promise<{ dir: string; tls: GrpcTlsConfig }> {
  const openssl = findOpenSsl();
  const dir = await mkdtemp(join(tmpdir(), "octoc2-grpc-tls-"));
  const key = join(dir, "server.key");
  const cert = join(dir, "server.crt");
  const proc = Bun.spawn([
    openssl,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdout: "ignore", stderr: "pipe" });
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
  }
  const certBytes = await readFile(cert);
  return {
    dir,
    tls: {
      rootCerts: certBytes,
      privateKey: await readFile(key),
      certChain: certBytes,
      clientCertificateFingerprints: {
        "test-beacon-001": CERTIFICATE_FINGERPRINT_001,
      },
    },
  };
}

describe("gRPC client certificate fingerprint configuration", () => {
  it("normalizes fingerprints and requires a unique binding for every beacon", () => {
    const normalized = parseGrpcClientCertificateFingerprintMap(
      JSON.stringify({
        "test-beacon-001":
          CERTIFICATE_FINGERPRINT_001.match(/.{2}/g)!.join(":").toUpperCase(),
        "test-beacon-002": CERTIFICATE_FINGERPRINT_002,
      }),
      ["test-beacon-001", "test-beacon-002"],
    );
    expect(normalized).toEqual({
      "test-beacon-001": CERTIFICATE_FINGERPRINT_001,
      "test-beacon-002": CERTIFICATE_FINGERPRINT_002,
    });

    expect(() => parseGrpcClientCertificateFingerprintMap(
      JSON.stringify({
        "test-beacon-001": CERTIFICATE_FINGERPRINT_001,
      }),
      ["test-beacon-001", "test-beacon-002"],
    )).toThrow("missing test-beacon-002");
    expect(() => parseGrpcClientCertificateFingerprintMap(
      JSON.stringify({
        "test-beacon-001": CERTIFICATE_FINGERPRINT_001,
        "test-beacon-002": CERTIFICATE_FINGERPRINT_001,
      }),
      ["test-beacon-001", "test-beacon-002"],
    )).toThrow("distinct client certificate");
  });
});

describe("BeaconGrpcService", () => {
  let dataDir: string;
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let service: BeaconGrpcService;
  let acceptedResults: any[];
  let checkinStatus: CheckinVerificationStatus;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "octoc2-grpc-"));
    registry = new BeaconRegistry(dataDir);
    queue = new TaskQueue();
    acceptedResults = [];
    checkinStatus = "accepted";
    service = new BeaconGrpcService(
      registry,
      queue,
      new CredentialVerifier({
        "test-beacon-001": "token-001",
        "test-beacon-002": "token-002",
      }),
      DUMMY_TLS,
      {
        verifyAndRegisterCheckin: async (payload: any, beaconId: string) => {
          const status = checkinStatus;
          if (checkinAuthorizesTaskDelivery(status)) {
            const existing = registry.get(beaconId);
            if (existing && existing.publicKey !== payload.publicKey) {
              throw new Error("encryption key replacement requires operator authorization");
            }
            registry.register({
              beaconId,
              issueNumber: existing?.issueNumber ?? 0,
              publicKey: payload.publicKey,
              hostname: payload.hostname,
              username: payload.username,
              os: payload.os,
              arch: payload.arch,
              seq: (existing?.lastSeq ?? 0) + 1,
              tentacleId: 4,
            });
          }
          return status;
        },
      } as any,
      {
        acceptSignedResult: async (result: any, beaconId: string) => {
          acceptedResults.push(result);
          const outcome = queue.completeTask(
            beaconId,
            result.taskId,
            JSON.stringify(result),
          );
          if (outcome === "completed") {
            return { status: "completed" as const, result: {} as any };
          }
          if (outcome === "duplicate") {
            return { status: "exact_duplicate" as const, result: {} as any };
          }
          if (outcome === "conflict") {
            return { status: "conflicting_duplicate" as const, result: {} as any };
          }
          if (outcome === "wrong_owner") return { status: "owner_mismatch" as const };
          return { status: "task_not_found" as const };
        },
      } as any,
    );
  });

  afterEach(async () => {
    await service.stop();
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("rejects missing and wrong-principal credentials before registry access", async () => {
    await expect(callHandler(service.checkin, BASE_CHECKIN, "")).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
    });
    await expect(callHandler(service.checkin, BASE_CHECKIN, "token-002")).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
    expect(registry.get(BASE_CHECKIN.beaconId)).toBeUndefined();
  });

  it("rejects a trusted certificate bound to another beacon before registry access", async () => {
    await expect(callHandler(
      service.checkin,
      BASE_CHECKIN,
      "token-001",
      CERTIFICATE_FINGERPRINT_002,
    )).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
      message: "client certificate does not match beacon credential",
    });
    expect(registry.get(BASE_CHECKIN.beaconId)).toBeUndefined();
  });

  it("registers an authenticated beacon and delivers only its tasks", async () => {
    await callHandler(service.checkin, BASE_CHECKIN);
    const task = queue.queueTask(BASE_CHECKIN.beaconId, "shell", { cmd: "id" });
    const otherChannel = queue.queueTask(
      BASE_CHECKIN.beaconId,
      "ping",
      {},
      "issues",
    );
    queue.queueTask("test-beacon-002", "shell", { cmd: "whoami" });

    const response = await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string; argsJson: string }>;
    }>(service.checkin, BASE_CHECKIN);

    expect(response.pendingTasks).toHaveLength(1);
    expect(response.pendingTasks[0]!.id).toBe(task.taskId);
    expect(queue.getTask(task.taskId)!.state).toBe("delivered");
    expect(queue.getTask(otherChannel.taskId)!.state).toBe("pending");
    expect(registry.get(BASE_CHECKIN.beaconId)!.activeTentacle).toBe(4);

    const duplicate = await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string }>;
    }>(service.checkin, BASE_CHECKIN);
    expect(duplicate.pendingTasks).toHaveLength(0);
  });

  it("lets only accepted or gap checkins authorize new gRPC deliveries", async () => {
    await callHandler(service.checkin, BASE_CHECKIN);

    const duplicateTask = queue.queueTask(
      BASE_CHECKIN.beaconId,
      "ping",
      {},
      "codespaces",
    );
    checkinStatus = "duplicate";
    expect((await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string }>;
    }>(service.checkin, BASE_CHECKIN)).pendingTasks).toEqual([]);
    expect(queue.getTask(duplicateTask.taskId)?.state).toBe("pending");

    const staleTask = queue.queueTask(
      BASE_CHECKIN.beaconId,
      "ping",
      {},
      "codespaces",
    );
    checkinStatus = "stale_duplicate";
    expect((await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string }>;
    }>(service.checkin, BASE_CHECKIN)).pendingTasks).toEqual([]);
    expect(queue.getTask(staleTask.taskId)?.state).toBe("pending");

    checkinStatus = "gap";
    expect((await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string }>;
    }>(service.checkin, BASE_CHECKIN)).pendingTasks.map(({ id }) => id).sort())
      .toEqual([duplicateTask.taskId, staleTask.taskId].sort());

    const acceptedTask = queue.queueTask(
      BASE_CHECKIN.beaconId,
      "ping",
      {},
      "codespaces",
    );
    checkinStatus = "accepted";
    expect((await callHandler<CheckinReq, {
      pendingTasks: Array<{ id: string }>;
    }>(service.checkin, BASE_CHECKIN)).pendingTasks.map(({ id }) => id))
      .toEqual([acceptedTask.taskId]);
  });

  it("rejects unauthenticated encryption-key replacement", async () => {
    await callHandler(service.checkin, BASE_CHECKIN);
    await expect(callHandler(service.checkin, {
      ...BASE_CHECKIN,
      publicKey: "replacement-key",
    })).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    expect(registry.get(BASE_CHECKIN.beaconId)!.publicKey).toBe(BASE_CHECKIN.publicKey);
  });

  it("enforces result ownership and duplicate consistency", async () => {
    await callHandler(service.checkin, BASE_CHECKIN);
    const task = queue.queueTask(BASE_CHECKIN.beaconId, "shell", { cmd: "echo hi" });
    const request: SubmitResultReq = {
      result: {
        taskId: task.taskId,
        beaconId: BASE_CHECKIN.beaconId,
        success: true,
        output: "hi",
        data: "",
        completedAt: "2026-07-16T00:00:00.000Z",
        signature: "test-signature",
        metadataJson: '{"exitCode":0,"shellInvoked":true}',
        hasData: true,
      },
    };

    await expect(callHandler(service.submitResult, request, "token-002")).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
    const first = await callHandler<SubmitResultReq, { accepted: boolean; message: string }>(
      service.submitResult,
      request,
    );
    const duplicate = await callHandler<SubmitResultReq, { accepted: boolean; message: string }>(
      service.submitResult,
      request,
    );
    const conflict = await callHandler<SubmitResultReq, { accepted: boolean; message: string }>(
      service.submitResult,
      { result: { ...request.result, output: "different" } },
    );

    expect(first).toEqual({ accepted: true, message: "completed" });
    expect(duplicate).toEqual({ accepted: true, message: "exact_duplicate" });
    expect(conflict).toEqual({ accepted: false, message: "conflicting_duplicate" });
    expect(acceptedResults[0]).toMatchObject({
      data: "",
      metadata: { exitCode: 0, shellInvoked: true },
    });
  });

  it("rejects malformed or non-canonical result metadata before task mutation", async () => {
    const task = queue.queueTask(BASE_CHECKIN.beaconId, "shell", { cmd: "echo hi" });
    const base: SubmitResultReq["result"] = {
      taskId: task.taskId,
      beaconId: BASE_CHECKIN.beaconId,
      success: true,
      output: "hi",
      data: "",
      completedAt: "2026-07-16T00:00:00.000Z",
      signature: "test-signature",
      metadataJson: "{not-json",
      hasData: false,
    };

    await expect(callHandler(
      service.submitResult,
      { result: base },
    )).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      message: "result metadata_json must be valid JSON",
    });
    await expect(callHandler(
      service.submitResult,
      {
        result: {
          ...base,
          metadataJson: '{"shellInvoked":true,"exitCode":0}',
        },
      },
    )).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      message: "result metadata_json must use canonical JSON",
    });
    expect(acceptedResults).toHaveLength(0);
  });

  it("authenticates submit-result before handling a missing result", async () => {
    await expect(callHandler(
      service.submitResult,
      {} as SubmitResultReq,
      "",
    )).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
    });
  });

  it("binds with TLS credentials and releases the loopback port", async () => {
    const generated = await ephemeralTls();
    const tlsService = new BeaconGrpcService(
      registry,
      queue,
      new CredentialVerifier({ "test-beacon-001": "token-001" }),
      generated.tls,
      {
        verifyAndRegisterCheckin: async () => "accepted" as const,
      } as any,
      {
        acceptSignedResult: async () => ({ status: "task_not_found" as const }),
      } as any,
    );
    const port = await freePort();
    try {
      await tlsService.start(port, "127.0.0.1");
      await expect(bindPort(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await tlsService.stop();
      await rm(generated.dir, { recursive: true, force: true });
    }
    await expect(bindPort(port)).resolves.toBeUndefined();
  });
});
