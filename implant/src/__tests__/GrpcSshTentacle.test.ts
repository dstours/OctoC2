/**
 * OctoC2 — GrpcSshTentacle unit tests
 *
 * All tests use SVC_GRPC_DIRECT=localhost:<port> with a real mTLS server,
 * trusted client certificate, and bearer credential. No insecure test-only
 * transport path is permitted.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer }  from "node:net";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import * as grpc        from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join }         from "node:path";

import { GrpcSshTentacle }  from "../tentacles/GrpcSshTentacle.ts";
import { ConnectionFactory } from "../factory/ConnectionFactory.ts";
import type {
  BeaconConfig,
  CheckinPayload,
  TaskResult,
  ITentacle,
  Task,
} from "../types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Ask the OS for a free TCP port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

const PROTO_PATH = join(import.meta.dir, "../../../proto/svc.proto");

function makeConfig(overrides: Partial<BeaconConfig> = {}): BeaconConfig {
  return {
    id:               "test-beacon",
    repo:             { owner: "test", name: "test" },
    token:            "",
    controllerToken:  "beacon-api-token",
    tentaclePriority: ["codespaces"],
    sleepSeconds:     60,
    jitter:           0.1,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair:    { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    ...overrides,
  };
}

const TEST_PAYLOAD: CheckinPayload = {
  beaconId:  "test-beacon",
  publicKey: "dGVzdA==",
  hostname:  "test-host",
  username:  "test-user",
  os:        "linux",
  arch:      "x64",
  pid:       1,
  checkinAt: new Date().toISOString(),
};

// ── Inline gRPC test server ────────────────────────────────────────────────────

let testPort: number;
let grpcServer: grpc.Server | null = null;
let certificateDirectory: string;
let caCertificate: Buffer;
let serverCertificate: Buffer;
let serverKey: Buffer;
let clientCertificatePath: string;
let clientKeyPath: string;
let caCertificatePath: string;
let submitResultResponse = { accepted: true, message: "ok" };
let lastSubmitResultRequest: {
  result?: {
    data?: string;
    metadataJson?: string;
    hasData?: boolean;
  };
} | null = null;

async function startInlineGrpcServer(port: number): Promise<void> {
  const packageDef = await protoLoader.load(PROTO_PATH, {
    keepCase: false,
    longs:    String,
    enums:    String,
    defaults: true,
    oneofs:   true,
  });

  const proto = grpc.loadPackageDefinition(packageDef) as Record<string, any>;
  const BeaconService = (proto["svc"] as Record<string, any>)["BeaconService"] as grpc.ServiceClientConstructor;

  grpcServer = new grpc.Server();
  grpcServer.addService(BeaconService.service, {
    checkin: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      callback(null, {
        pendingTasks: [
          {
            id:        "test-task-1",
            kind:      "shell",
            argsJson:  JSON.stringify({ cmd: "echo grpc-ok" }),
            issuedAt:  new Date().toISOString(),
          },
        ],
      });
    },

    submitResult: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      lastSubmitResultRequest = (call as any).request;
      callback(null, submitResultResponse);
    },
  });

  return new Promise((resolve, reject) => {
    grpcServer!.bindAsync(
      `localhost:${port}`,
      grpc.ServerCredentials.createSsl(
        caCertificate,
        [{ private_key: serverKey, cert_chain: serverCertificate }],
        true,
      ),
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function stopInlineGrpcServer(): Promise<void> {
  if (!grpcServer) return Promise.resolve();
  return new Promise((resolve) => {
    grpcServer!.tryShutdown((err) => {
      if (err) grpcServer!.forceShutdown();
      grpcServer = null;
      resolve();
    });
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Clear SSH env vars so they don't interfere
  delete process.env["SVC_GRPC_CODESPACE_NAME"];
  delete process.env["SVC_GITHUB_USER"];
  delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];

  certificateDirectory = await mkdtemp(
    join(tmpdir(), "octoc2-implant-grpc-tls-"),
  );
  const certificates = await createCertificateFixture(certificateDirectory);
  caCertificatePath = certificates.caCertificate;
  clientCertificatePath = certificates.clientCertificate;
  clientKeyPath = certificates.clientKey;
  caCertificate = await readFile(certificates.caCertificate);
  serverCertificate = await readFile(certificates.serverCertificate);
  serverKey = await readFile(certificates.serverKey);
  process.env["SVC_GRPC_CA_CERT"] = caCertificatePath;
  process.env["SVC_GRPC_CLIENT_CERT"] = clientCertificatePath;
  process.env["SVC_GRPC_CLIENT_KEY"] = clientKeyPath;

  testPort = await findFreePort();
  await startInlineGrpcServer(testPort);
  process.env["SVC_GRPC_DIRECT"] = `localhost:${testPort}`;
});

afterAll(async () => {
  delete process.env["SVC_GRPC_DIRECT"];
  delete process.env["SVC_GRPC_CA_CERT"];
  delete process.env["SVC_GRPC_CLIENT_CERT"];
  delete process.env["SVC_GRPC_CLIENT_KEY"];
  await stopInlineGrpcServer();
  if (certificateDirectory) {
    await rm(certificateDirectory, { recursive: true, force: true });
  }
});

// ── isAvailable() ──────────────────────────────────────────────────────────────

describe("isAvailable()", () => {
  it("returns true in GRPC_DIRECT mode when test server is running", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      expect(await t.isAvailable()).toBe(true);
    } finally {
      await t.teardown();
    }
  });

  it("returns false (no error) when no GRPC env vars are set", async () => {
    const saved = process.env["SVC_GRPC_DIRECT"];
    delete process.env["SVC_GRPC_DIRECT"];
    const t = new GrpcSshTentacle(makeConfig());
    try {
      expect(await t.isAvailable()).toBe(false);
    } finally {
      process.env["SVC_GRPC_DIRECT"] = saved;
      await t.teardown();
    }
  });

  it("requires an explicit user credential for Codespaces SSH mode", async () => {
    const direct = process.env["SVC_GRPC_DIRECT"];
    delete process.env["SVC_GRPC_DIRECT"];
    process.env["SVC_GRPC_CODESPACE_NAME"] = "example-codespace";
    process.env["SVC_GITHUB_USER"] = "example-user";
    delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];
    const t = new GrpcSshTentacle(makeConfig());
    try {
      expect(await t.isAvailable()).toBe(false);
    } finally {
      delete process.env["SVC_GRPC_CODESPACE_NAME"];
      delete process.env["SVC_GITHUB_USER"];
      process.env["SVC_GRPC_DIRECT"] = direct;
      await t.teardown();
    }
  });
});

// ── checkin() ──────────────────────────────────────────────────────────────────

describe("checkin()", () => {
  it("maps proto pendingTasks to Task[]", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const tasks = await t.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      const task = tasks[0]!;
      expect(task.taskId).toBe("test-task-1");
      expect(task.kind).toBe("shell");
      expect(task.args).toEqual({ cmd: "echo grpc-ok" });
    } finally {
      await t.teardown();
    }
  });

  it("returns array when server sends tasks", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const tasks = await t.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
    } finally {
      await t.teardown();
    }
  });
});

// ── submitResult() ─────────────────────────────────────────────────────────────

describe("submitResult()", () => {
  it("sends result and resolves without throwing", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      await t.checkin(TEST_PAYLOAD);

      const result: TaskResult = {
        taskId:      "test-task-1",
        beaconId:    "test-beacon",
        success:     true,
        output:      "grpc-ok",
        data:        "",
        completedAt: new Date().toISOString(),
        signature:   "signed-result-envelope-fixture",
        metadata:    { shellInvoked: true, exitCode: 0 },
      };
      const outcome = await t.submitResult(result);
      expect(outcome).toEqual({
        artifactWritten: true,
        controllerAccepted: true,
        channel: "codespaces",
        acceptance: "direct-response",
      });
      expect(lastSubmitResultRequest?.result).toMatchObject({
        data: "",
        hasData: true,
        metadataJson: '{"exitCode":0,"shellInvoked":true}',
      });
    } finally {
      await t.teardown();
    }
  });

  it("distinguishes absent data and metadata from present empty data", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const outcome = await t.submitResult({
        taskId:      "absent-data-task",
        beaconId:    "test-beacon",
        success:     true,
        output:      "no optional fields",
        completedAt: new Date().toISOString(),
        signature:   "signed-result-envelope-fixture",
      });
      expect(outcome).toEqual({
        artifactWritten: true,
        controllerAccepted: true,
        channel: "codespaces",
        acceptance: "direct-response",
      });
      expect(lastSubmitResultRequest?.result).toMatchObject({
        data: "",
        hasData: false,
        metadataJson: "",
      });
    } finally {
      await t.teardown();
    }
  });

  it("reports an unaccepted outcome when the server rejects the result", async () => {
    const previousResponse = submitResultResponse;
    submitResultResponse = {
      accepted: false,
      message: "result signature rejected",
    };
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const outcome = await t.submitResult({
        taskId:      "rejected-task",
        beaconId:    "test-beacon",
        success:     true,
        output:      "unaccepted",
        completedAt: new Date().toISOString(),
        signature:   "invalid-result-signature",
      });
      expect(outcome).toEqual({
        artifactWritten: false,
        controllerAccepted: false,
        channel: "codespaces",
        acceptance: null,
      });
    } finally {
      submitResultResponse = previousResponse;
      await t.teardown();
    }
  });

  it("preserves transport errors from the gRPC client", async () => {
    const transportError = Object.assign(
      new Error("14 UNAVAILABLE: transport closed"),
      { code: grpc.status.UNAVAILABLE },
    );
    const t = new GrpcSshTentacle(makeConfig());
    const internal = t as any;
    internal.connected = true;
    internal.client = {
      submitResult: async () => {
        throw transportError;
      },
      close: () => {},
    };

    try {
      await expect(t.submitResult({
        taskId:      "transport-task",
        beaconId:    "test-beacon",
        success:     true,
        output:      "retry me",
        completedAt: new Date().toISOString(),
      })).rejects.toBe(transportError);
    } finally {
      await t.teardown();
    }
  });
});

// ── teardown() ─────────────────────────────────────────────────────────────────

describe("teardown()", () => {
  it("is idempotent — calling twice does not throw", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    await t.checkin(TEST_PAYLOAD);
    await t.teardown();
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});

// ── ConnectionFactory failover ─────────────────────────────────────────────────

describe("ConnectionFactory failover", () => {
  it("falls over to GrpcSsh when IssuesTentacle is unavailable", async () => {
    class FailingTentacle implements ITentacle {
      readonly kind = "issues" as const;
      async isAvailable(): Promise<boolean> { return false; }
      async checkin(): Promise<Task[]> { throw new Error("should not be called"); }
      async submitResult(): Promise<import("../types.ts").ResultSubmissionOutcome> {
        throw new Error("should not be called");
      }
      async teardown(): Promise<void> {}
    }

    const config = makeConfig({ tentaclePriority: ["issues", "codespaces"] });
    const factory = new ConnectionFactory({ config, maxFailures: 3 });
    factory.register(new FailingTentacle());

    const grpcTentacle = new GrpcSshTentacle(config);
    factory.register(grpcTentacle);

    try {
      const tasks = await factory.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]!.taskId).toBe("test-task-1");

      const health = factory.healthSnapshot();
      expect(health["issues"]!.failures).toBe(1);
      expect(health["codespaces"]!.totalSuccesses).toBe(1);
    } finally {
      await factory.teardown();
    }
  });
});

interface CertificateFixture {
  caCertificate: string;
  serverCertificate: string;
  serverKey: string;
  clientCertificate: string;
  clientKey: string;
}

async function createCertificateFixture(
  targetDirectory: string,
): Promise<CertificateFixture> {
  const openssl = findOpenSsl();
  const caKey = join(targetDirectory, "ca.key");
  const caCertificateFile = join(targetDirectory, "ca.crt");
  const serverKeyFile = join(targetDirectory, "server.key");
  const serverCsr = join(targetDirectory, "server.csr");
  const serverCertificateFile = join(targetDirectory, "server.crt");
  const serverExtensions = join(targetDirectory, "server.ext");
  const clientKeyFile = join(targetDirectory, "client.key");
  const clientCsr = join(targetDirectory, "client.csr");
  const clientCertificateFile = join(targetDirectory, "client.crt");
  const clientExtensions = join(targetDirectory, "client.ext");

  await writeFile(
    serverExtensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "",
    ].join("\n"),
  );
  await writeFile(
    clientExtensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      "",
    ].join("\n"),
  );
  runOpenSsl(openssl, targetDirectory, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey,
    "-out", caCertificateFile,
    "-subj", "/CN=OctoC2 Implant Test CA",
    "-days", "1",
    "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKeyFile,
    "-out", serverCsr,
    "-subj", "/CN=localhost",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", serverCsr,
    "-CA", caCertificateFile,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", serverCertificateFile,
    "-days", "1",
    "-sha256",
    "-extfile", serverExtensions,
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", clientKeyFile,
    "-out", clientCsr,
    "-subj", "/CN=test-beacon",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", clientCsr,
    "-CA", caCertificateFile,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", clientCertificateFile,
    "-days", "1",
    "-sha256",
    "-extfile", clientExtensions,
  ]);
  return {
    caCertificate: caCertificateFile,
    serverCertificate: serverCertificateFile,
    serverKey: serverKeyFile,
    clientCertificate: clientCertificateFile,
    clientKey: clientKeyFile,
  };
}

function findOpenSsl(): string {
  const onPath = Bun.which("openssl");
  if (onPath) return onPath;
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (candidate) return candidate;
  throw new Error("OpenSSL is required for the gRPC mTLS integration test");
}

function runOpenSsl(
  executable: string,
  cwd: string,
  args: string[],
): void {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `OpenSSL failed (${args.join(" ")}): ${result.stderr || result.stdout}`,
    );
  }
}
