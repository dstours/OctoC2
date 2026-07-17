// dashboard/src/types/beacon.ts

import {
  CHANNEL_CATALOG,
  type ChannelId,
} from '@octoc2/shared/channels';

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

/** A canonical OctoC2 channel ID, including the historical string ID `7b`. */
export type TentacleId = ChannelId;

export const TENTACLE_NAMES = Object.freeze(
  Object.fromEntries(
    CHANNEL_CATALOG.map(channel => [String(channel.id), channel.name]),
  ),
) as Readonly<Record<TentacleId, string>>;

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
