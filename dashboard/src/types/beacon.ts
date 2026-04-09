// dashboard/src/types/beacon.ts

/**
 * UI-computed liveness status for display in the dashboard.
 * Derived from `lastSeen` vs configurable TTL — NOT from the server's own state field.
 *
 * Mapping from server `ServerBeaconStatus`:
 *   'active'  → 'active'   (checked in recently)
 *   'dormant' → 'stale'    (not checked in, still within extended TTL)
 *   'lost'    → 'dead'     (exceeded extended TTL or explicitly marked lost)
 */
export type BeaconStatus = 'active' | 'stale' | 'dead';

/**
 * Lifecycle status as assigned by the C2 server (Live mode only).
 * Used in the mapping layer when translating server responses to Beacon objects.
 */
export type ServerBeaconStatus = 'active' | 'dormant' | 'lost';

export type OS = 'windows' | 'linux' | 'macos';

export type Arch = 'x64' | 'arm64' | 'x86';

/** One of the 12 OctoC2 tentacle channels. Numbers match the spec (1–12). */
export type TentacleId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export const TENTACLE_NAMES: Record<TentacleId, string> = {
  1:  'Issues',
  2:  'Branch',
  3:  'Actions',
  4:  'Codespaces',
  5:  'Pages',
  6:  'Gists',
  7:  'OIDC',
  8:  'PR+SSH',
  9:  'Stego',
  10: 'Proxy',
  11: 'Notes',
  12: 'Relay',
};

export interface Beacon {
  /** Unique stable ID — derived from the GitHub Issue number or server-assigned. */
  id: string;
  /** Human-readable hostname of the target machine. */
  hostname: string;
  /** Operating system of the target. */
  os: OS;
  /** CPU architecture of the target. */
  arch: Arch;
  /** Check-in liveness status, derived from lastSeen vs TTL. */
  status: BeaconStatus;
  /** ISO 8601 timestamp of the most recent beacon check-in. */
  lastSeen: string;
  /** Which tentacle channel the beacon is currently using. */
  activeTentacle: TentacleId;
  /** GitHub Issue number used as the beacon's primary channel (API mode). */
  issueNumber?: number;
  /** Optional operator-assigned label/alias for this beacon. */
  label?: string;
  /** Implant version string. */
  version?: string;
  /** Operator-defined tags for grouping (e.g. ["prod", "web"]). */
  tags?: string[];
  /** Username / account context on the target machine. */
  username?: string;
  /** Beacon's libsodium public key (base64) — used to encrypt tasks and verify result authenticity. */
  publicKey?: string;
}
