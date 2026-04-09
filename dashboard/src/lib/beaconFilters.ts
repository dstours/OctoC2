// dashboard/src/lib/beaconFilters.ts
/**
 * Pure filter and sort functions for the beacon list.
 * Kept separate so they can be unit-tested independently of React.
 */

import type { Beacon, BeaconStatus, OS } from '@/types';
import type { TentacleId } from '@/types/beacon';

// ── Filter types ───────────────────────────────────────────────────────────────

export type StatusFilter = 'all' | BeaconStatus;
export type OSFilter = 'all' | OS;
export type TentacleFilter = 'all' | TentacleId;
export type SortKey =
  | 'lastSeen_desc'
  | 'lastSeen_asc'
  | 'hostname_asc'
  | 'hostname_desc'
  | 'taskCount_desc';

export interface BeaconFilterState {
  status:   StatusFilter;
  os:       OSFilter;
  tentacle: TentacleFilter;
  search:   string;
  sort:     SortKey;
}

export const DEFAULT_FILTER_STATE: BeaconFilterState = {
  status:   'all',
  os:       'all',
  tentacle: 'all',
  search:   '',
  sort:     'lastSeen_desc',
};

// ── Sort labels (for rendering) ────────────────────────────────────────────────

export const SORT_LABELS: Record<SortKey, string> = {
  lastSeen_desc:  'Last seen ↓',
  lastSeen_asc:   'Last seen ↑',
  hostname_asc:   'Hostname A→Z',
  hostname_desc:  'Hostname Z→A',
  taskCount_desc: 'Task count ↓',
};

// ── Tentacle channel filter options (task requires issues/notes/gist/codespaces)
// Mapping from display label to TentacleId

export const TENTACLE_FILTER_OPTIONS: { label: string; value: TentacleFilter }[] = [
  { label: 'all',        value: 'all' },
  { label: 'issues',     value: 1 },
  { label: 'notes',      value: 11 },
  { label: 'gist',       value: 6 },
  { label: 'codespaces', value: 4 },
];

// ── Core filter function ───────────────────────────────────────────────────────

/**
 * Filter and sort a beacon array by the given filter state.
 * Returns a new array; does not mutate the input.
 */
export function applyBeaconFilters(
  beacons: Beacon[],
  filters: BeaconFilterState,
): Beacon[] {
  let result = beacons;

  // Status filter
  if (filters.status !== 'all') {
    result = result.filter(b => b.status === filters.status);
  }

  // OS filter
  if (filters.os !== 'all') {
    result = result.filter(b => b.os === filters.os);
  }

  // Tentacle filter
  if (filters.tentacle !== 'all') {
    result = result.filter(b => b.activeTentacle === filters.tentacle);
  }

  // Global search (case-insensitive substring across id, hostname, username, os)
  const q = filters.search.trim().toLowerCase();
  if (q.length > 0) {
    result = result.filter(b =>
      b.hostname.toLowerCase().includes(q) ||
      b.id.toLowerCase().includes(q) ||
      (b.username?.toLowerCase().includes(q) ?? false) ||
      b.os.toLowerCase().includes(q)
    );
  }

  // Sort
  result = [...result].sort((a, b) => {
    switch (filters.sort) {
      case 'lastSeen_desc':
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      case 'lastSeen_asc':
        return new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
      case 'hostname_asc':
        return a.hostname.localeCompare(b.hostname);
      case 'hostname_desc':
        return b.hostname.localeCompare(a.hostname);
      case 'taskCount_desc':
        // Beacons don't carry a task count field yet; fall back to lastSeen desc
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    }
  });

  return result;
}
