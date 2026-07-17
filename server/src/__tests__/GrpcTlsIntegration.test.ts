import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  canonicalJson,
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
  type TaskResult,
} from "@octoc2/shared";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { PROTO_DEFINITION } from "@octoc2/shared/proto";
import { BeaconGrpcService } from "../grpc/BeaconGrpcService.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { CredentialVerifier } from "../services/CredentialVerifier.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore, sha256Hex } from "../store/index.ts";

interface CheckinRequest {
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

interface CheckinResponse {
  pendingTasks: unknown[];
}

interface SubmitResultRequest {
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

interface SubmitResultResponse {
  accepted: boolean;
  message: string;
}

interface TestClient extends grpc.Client {
  checkin(
    request: CheckinRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (
      error: grpc.ServiceError | null,
      response: CheckinResponse,
    ) => void,
  ): grpc.ClientUnaryCall;
  submitResult(
    request: SubmitResultRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (
      error: grpc.ServiceError | null,
      response: SubmitResultResponse,
    ) => void,
  ): grpc.ClientUnaryCall;
}

const BEACON_ID = "grpc-mtls-beacon";
const TOKEN = "grpc-mtls-token";
const SECOND_BEACON_ID = "grpc-mtls-beacon-two";
const SECOND_TOKEN = "grpc-mtls-token-two";

let directory: string;
let store: OctoStore;
let registry: BeaconRegistry;
let queue: TaskQueue;
let service: BeaconGrpcService;
let port: number;
let packageDefinition: protoLoader.PackageDefinition;
let caCertificate: Buffer;
let clientCertificate: Buffer;
let clientKey: Buffer;
let secondClientCertificate: Buffer;
let secondClientKey: Buffer;
let rogueClientCertificate: Buffer;
let rogueClientKey: Buffer;
let request: CheckinRequest;
let secondRequest: CheckinRequest;
let credentialVerifier: CredentialVerifier;
let signing: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
let signingKeyId: string;
const CREDENTIAL_ID = "grpc-route-credential";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "octoc2-grpc-tls-"));
  const certificates = await createCertificateFixture(directory);
  caCertificate = await readFile(certificates.caCertificate);
  clientCertificate = await readFile(certificates.clientCertificate);
  clientKey = await readFile(certificates.clientKey);
  secondClientCertificate = await readFile(
    certificates.secondClientCertificate,
  );
  secondClientKey = await readFile(certificates.secondClientKey);
  rogueClientCertificate = await readFile(certificates.rogueClientCertificate);
  rogueClientKey = await readFile(certificates.rogueClientKey);

  store = OctoStore.open({
    dataDir: join(directory, "data"),
    importLegacyRegistry: false,
  });
  registry = new BeaconRegistry(store);
  queue = new TaskQueue(store);
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  signing = await generateEd25519KeyPair();
  signingKeyId = await ed25519KeyId(signing.publicKey);
  const encryptionPublicKey = encodeBase64Url(new Uint8Array(32).fill(8));
  const createdAt = new Date().toISOString();
  await identities.enroll({
    version: 1,
    beaconId: BEACON_ID,
    encryptionPublicKey,
    signingPublicKey: encodeBase64Url(signing.publicKey),
    signingKeyId,
    createdAt,
  });
  const secondSigning = await generateEd25519KeyPair();
  const secondSigningKeyId = await ed25519KeyId(secondSigning.publicKey);
  const secondEncryptionPublicKey = encodeBase64Url(
    new Uint8Array(32).fill(9),
  );
  await identities.enroll({
    version: 1,
    beaconId: SECOND_BEACON_ID,
    encryptionPublicKey: secondEncryptionPublicKey,
    signingPublicKey: encodeBase64Url(secondSigning.publicKey),
    signingKeyId: secondSigningKeyId,
    createdAt,
  });
  await registry.load();
  store.insertCredentialHash({
    credentialId: CREDENTIAL_ID,
    principalType: "beacon",
    beaconId: BEACON_ID,
    tokenHash: sha256Hex(TOKEN),
    hashAlgorithm: "sha256",
  });
  store.insertCredentialHash({
    credentialId: "grpc-route-credential-two",
    principalType: "beacon",
    beaconId: SECOND_BEACON_ID,
    tokenHash: sha256Hex(SECOND_TOKEN),
    hashAlgorithm: "sha256",
  });
  credentialVerifier = new CredentialVerifier({
    [BEACON_ID]: TOKEN,
    [SECOND_BEACON_ID]: SECOND_TOKEN,
  });
  credentialVerifier.attachStore(store, "beacon");

  service = new BeaconGrpcService(
    registry,
    queue,
    credentialVerifier,
    {
      rootCerts: caCertificate,
      privateKey: await readFile(certificates.serverKey),
      certChain: await readFile(certificates.serverCertificate),
      clientCertificateFingerprints: {
        [BEACON_ID]: certificateFingerprint(clientCertificate),
        [SECOND_BEACON_ID]: certificateFingerprint(secondClientCertificate),
      },
    },
    identities,
    tasks,
  );
  port = await service.start(0, "127.0.0.1");

  const checkinAt = new Date().toISOString();
  const identity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: BEACON_ID,
      keyId: signingKeyId,
      issuedAt: checkinAt,
      sequence: 1,
      payload: {
        beaconId: BEACON_ID,
        encryptionPublicKey,
        signingPublicKey: encodeBase64Url(signing.publicKey),
        hostname: "grpc-test-host",
        username: "tester",
        os: "windows",
        arch: "x64",
        pid: 42,
        checkinAt,
      },
    }),
    signing.secretKey,
  );
  request = {
    beaconId: BEACON_ID,
    publicKey: encryptionPublicKey,
    hostname: "grpc-test-host",
    username: "tester",
    os: "windows",
    arch: "x64",
    pid: 42,
    checkinAt,
    identityEnvelope: JSON.stringify(identity),
  };
  const secondCheckinAt = new Date().toISOString();
  const secondIdentity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: SECOND_BEACON_ID,
      keyId: secondSigningKeyId,
      issuedAt: secondCheckinAt,
      sequence: 1,
      payload: {
        beaconId: SECOND_BEACON_ID,
        encryptionPublicKey: secondEncryptionPublicKey,
        signingPublicKey: encodeBase64Url(secondSigning.publicKey),
        hostname: "grpc-test-host-two",
        username: "tester-two",
        os: "linux",
        arch: "arm64",
        pid: 84,
        checkinAt: secondCheckinAt,
      },
    }),
    secondSigning.secretKey,
  );
  secondRequest = {
    beaconId: SECOND_BEACON_ID,
    publicKey: secondEncryptionPublicKey,
    hostname: "grpc-test-host-two",
    username: "tester-two",
    os: "linux",
    arch: "arm64",
    pid: 84,
    checkinAt: secondCheckinAt,
    identityEnvelope: JSON.stringify(secondIdentity),
  };

  const protoPath = join(directory, "svc.proto");
  await writeFile(protoPath, PROTO_DEFINITION, "utf8");
  packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
});

afterAll(async () => {
  await service?.stop();
  await registry?.shutdown();
  store?.close();
  if (directory) {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});

describe("gRPC mTLS and per-beacon application authentication", () => {
  it("rejects a client that presents no certificate", async () => {
    const client = createClient(grpc.credentials.createSsl(caCertificate));
    try {
      const error = await invokeExpectingError(client, request, TOKEN);
      expect(error.code).toBe(grpc.status.UNAVAILABLE);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(0);
    } finally {
      client.close();
    }
  });

  it("rejects a client certificate signed by an untrusted CA", async () => {
    const client = createClient(
      grpc.credentials.createSsl(
        caCertificate,
        rogueClientKey,
        rogueClientCertificate,
      ),
    );
    try {
      const error = await invokeExpectingError(client, request, TOKEN);
      expect(error.code).toBe(grpc.status.UNAVAILABLE);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(0);
    } finally {
      client.close();
    }
  });

  it("rejects a missing or wrong bearer token before identity mutation", async () => {
    const client = createTrustedClient();
    try {
      const missing = await invokeExpectingError(client, request, null);
      expect(missing.code).toBe(grpc.status.UNAUTHENTICATED);
      const wrong = await invokeExpectingError(client, request, "wrong-token");
      expect(wrong.code).toBe(grpc.status.UNAUTHENTICATED);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(0);
    } finally {
      client.close();
    }
  });

  it("binds the bearer principal to the claimed beacon ID", async () => {
    const client = createTrustedClient();
    try {
      const error = await invokeExpectingError(
        client,
        { ...request, beaconId: "another-beacon" },
        TOKEN,
      );
      expect(error.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(0);
    } finally {
      client.close();
    }
  });

  it("rejects certificate A with beacon B's bearer and signed request before mutation", async () => {
    const client = createTrustedClient();
    try {
      const error = await invokeExpectingError(
        client,
        secondRequest,
        SECOND_TOKEN,
      );
      expect(error.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(error.message).toContain(
        "client certificate does not match beacon credential",
      );
      expect(registry.get(SECOND_BEACON_ID)?.lastSeq).toBe(0);
    } finally {
      client.close();
    }
  });

  it("accepts certificate B with beacon B's bearer and signed request", async () => {
    const client = createSecondTrustedClient();
    try {
      const response = await invoke(client, secondRequest, SECOND_TOKEN);
      expect(response.pendingTasks).toEqual([]);
      expect(registry.get(SECOND_BEACON_ID)?.lastSeq).toBe(1);
      expect(registry.get(SECOND_BEACON_ID)?.activeTentacle).toBe(4);
    } finally {
      client.close();
    }
  });

  it("accepts a trusted certificate, matching bearer principal, and signed identity", async () => {
    const client = createTrustedClient();
    try {
      const response = await invoke(client, request, TOKEN);
      expect(response.pendingTasks).toEqual([]);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(1);
      expect(registry.get(BEACON_ID)?.activeTentacle).toBe(4);
    } finally {
      client.close();
    }
  });

  it("preserves signed metadata and a deliberately present empty data field", async () => {
    const task = queue.queueTask(BEACON_ID, "shell", { cmd: "printf ''" });
    const completedAt = new Date().toISOString();
    const unsignedResult: TaskResult = {
      taskId: task.taskId,
      beaconId: BEACON_ID,
      success: true,
      output: "",
      data: "",
      completedAt,
      metadata: { shellInvoked: true, exitCode: 0 },
    };
    const signed = serializeSignedEnvelope(await signEnvelope(
      createUnsignedEnvelope({
        kind: "task-result",
        signerId: BEACON_ID,
        keyId: signingKeyId,
        issuedAt: completedAt,
        sequence: 2,
        payload: await createTaskResultSignaturePayload(unsignedResult),
      }),
      signing.secretKey,
    ));
    const client = createTrustedClient();
    try {
      const response = await invokeSubmitResult(
        client,
        {
          result: {
            taskId: unsignedResult.taskId,
            beaconId: unsignedResult.beaconId,
            success: unsignedResult.success,
            output: unsignedResult.output,
            data: "",
            completedAt,
            signature: signed,
            metadataJson: canonicalJson(unsignedResult.metadata),
            hasData: true,
          },
        },
        TOKEN,
      );
      expect(response).toEqual({ accepted: true, message: "completed" });
      const stored = store.getTaskResult(task.taskId);
      expect(stored).toBeDefined();
      const canonicalResult = JSON.parse(stored!.canonicalResult) as Record<
        string,
        unknown
      >;
      expect(Object.hasOwn(canonicalResult, "data")).toBe(true);
      expect(canonicalResult["data"]).toBe("");
      expect(canonicalResult["metadata"]).toEqual({
        exitCode: 0,
        shellInvoked: true,
      });
    } finally {
      client.close();
    }
  });

  it("rejects a revoked credential at the gRPC route before identity mutation", async () => {
    expect(store.revokeCredential(
      CREDENTIAL_ID,
      "gRPC route-level regression",
    )).toBe(true);
    const client = createTrustedClient();
    try {
      const error = await invokeExpectingError(client, request, TOKEN);
      expect(error.code).toBe(grpc.status.UNAUTHENTICATED);
      expect(registry.get(BEACON_ID)?.lastSeq).toBe(2);
    } finally {
      client.close();
    }
  });
});

function createClient(credentials: grpc.ChannelCredentials): TestClient {
  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    svc: {
      BeaconService: grpc.ServiceClientConstructor;
    };
  };
  return new loaded.svc.BeaconService(
    `localhost:${port}`,
    credentials,
  ) as unknown as TestClient;
}

function createTrustedClient(): TestClient {
  return createClient(
    grpc.credentials.createSsl(
      caCertificate,
      clientKey,
      clientCertificate,
    ),
  );
}

function createSecondTrustedClient(): TestClient {
  return createClient(
    grpc.credentials.createSsl(
      caCertificate,
      secondClientKey,
      secondClientCertificate,
    ),
  );
}

function certificateFingerprint(certificate: Buffer): string {
  return new X509Certificate(certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}

function metadata(token: string | null): grpc.Metadata {
  const value = new grpc.Metadata();
  if (token !== null) value.set("authorization", `Bearer ${token}`);
  return value;
}

function invoke(
  client: TestClient,
  checkin: CheckinRequest,
  token: string | null,
): Promise<CheckinResponse> {
  return new Promise((resolve, reject) => {
    client.checkin(
      checkin,
      metadata(token),
      { deadline: new Date(Date.now() + 5_000) },
      (error, response) => {
        if (error) reject(error);
        else resolve(response);
      },
    );
  });
}

function invokeSubmitResult(
  client: TestClient,
  result: SubmitResultRequest,
  token: string | null,
): Promise<SubmitResultResponse> {
  return new Promise((resolve, reject) => {
    client.submitResult(
      result,
      metadata(token),
      { deadline: new Date(Date.now() + 5_000) },
      (error, response) => {
        if (error) reject(error);
        else resolve(response);
      },
    );
  });
}

async function invokeExpectingError(
  client: TestClient,
  checkin: CheckinRequest,
  token: string | null,
): Promise<grpc.ServiceError> {
  try {
    await invoke(client, checkin, token);
  } catch (error) {
    return error as grpc.ServiceError;
  }
  throw new Error("Expected gRPC call to fail");
}

interface CertificateFixture {
  caCertificate: string;
  serverCertificate: string;
  serverKey: string;
  clientCertificate: string;
  clientKey: string;
  secondClientCertificate: string;
  secondClientKey: string;
  rogueClientCertificate: string;
  rogueClientKey: string;
}

async function createCertificateFixture(
  targetDirectory: string,
): Promise<CertificateFixture> {
  const openssl = findOpenSsl();
  const caKey = join(targetDirectory, "ca.key");
  const caCertificate = join(targetDirectory, "ca.crt");
  const serverKey = join(targetDirectory, "server.key");
  const serverCsr = join(targetDirectory, "server.csr");
  const serverCertificate = join(targetDirectory, "server.crt");
  const serverExtensions = join(targetDirectory, "server.ext");
  const clientKey = join(targetDirectory, "client.key");
  const clientCsr = join(targetDirectory, "client.csr");
  const clientCertificate = join(targetDirectory, "client.crt");
  const secondClientKey = join(targetDirectory, "client-two.key");
  const secondClientCsr = join(targetDirectory, "client-two.csr");
  const secondClientCertificate = join(targetDirectory, "client-two.crt");
  const clientExtensions = join(targetDirectory, "client.ext");
  const rogueCaKey = join(targetDirectory, "rogue-ca.key");
  const rogueCaCertificate = join(targetDirectory, "rogue-ca.crt");
  const rogueClientKey = join(targetDirectory, "rogue-client.key");
  const rogueClientCsr = join(targetDirectory, "rogue-client.csr");
  const rogueClientCertificate = join(targetDirectory, "rogue-client.crt");

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
    "-out", caCertificate,
    "-subj", "/CN=OctoC2 Test CA",
    "-days", "1",
    "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey,
    "-out", serverCsr,
    "-subj", "/CN=localhost",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", serverCsr,
    "-CA", caCertificate,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", serverCertificate,
    "-days", "1",
    "-sha256",
    "-extfile", serverExtensions,
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", clientKey,
    "-out", clientCsr,
    "-subj", "/CN=grpc-mtls-beacon",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", clientCsr,
    "-CA", caCertificate,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", clientCertificate,
    "-days", "1",
    "-sha256",
    "-extfile", clientExtensions,
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", secondClientKey,
    "-out", secondClientCsr,
    "-subj", "/CN=grpc-mtls-beacon-two",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", secondClientCsr,
    "-CA", caCertificate,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", secondClientCertificate,
    "-days", "1",
    "-sha256",
    "-extfile", clientExtensions,
  ]);

  runOpenSsl(openssl, targetDirectory, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", rogueCaKey,
    "-out", rogueCaCertificate,
    "-subj", "/CN=Untrusted Test CA",
    "-days", "1",
    "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", rogueClientKey,
    "-out", rogueClientCsr,
    "-subj", "/CN=untrusted-client",
    "-sha256",
  ]);
  runOpenSsl(openssl, targetDirectory, [
    "x509", "-req",
    "-in", rogueClientCsr,
    "-CA", rogueCaCertificate,
    "-CAkey", rogueCaKey,
    "-CAcreateserial",
    "-out", rogueClientCertificate,
    "-days", "1",
    "-sha256",
    "-extfile", clientExtensions,
  ]);

  return {
    caCertificate,
    serverCertificate,
    serverKey,
    clientCertificate,
    clientKey,
    secondClientCertificate,
    secondClientKey,
    rogueClientCertificate,
    rogueClientKey,
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
  throw new Error(
    "OpenSSL is required for the local gRPC mTLS integration test",
  );
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
