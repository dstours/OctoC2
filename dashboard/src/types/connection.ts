// dashboard/src/types/connection.ts

import type { TentacleId } from './beacon';

/** Which data source mode the dashboard is currently operating in. */
export type ConnectionMode = 'live' | 'api' | 'offline';

/** Health report for a single tentacle channel. */
export interface TentacleHealth {
  /** Tentacle number 1–10. */
  id: TentacleId;
  /** Human-readable name (e.g. "Issues", "Codespaces"). */
  name: string;
  /** Whether this tentacle channel is currently reachable/active. */
  status: 'active' | 'idle' | 'error';
  /** Number of beacons currently using this channel. */
  beaconCount: number;
  /** ISO 8601 timestamp of the most recent activity through this channel. */
  lastActivity?: string;
  /** Optional error message if status is 'error'. */
  errorMessage?: string;
}

/** Wraps a successful API response with metadata. */
export interface ApiResponse<T> {
  data: T;
  /** ISO 8601 timestamp of when the server produced this response. */
  fetchedAt: string;
  /** Whether this data came from a live server (true) or GitHub API (false). */
  isLive: boolean;
}

/** Standardised error shape for all dashboard API calls. */
export interface ApiError {
  message: string;
  /** HTTP status code if applicable. */
  status?: number;
  /** Machine-readable code (e.g. "RATE_LIMITED", "UNAUTHORIZED"). */
  code?: string;
}
