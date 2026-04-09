// dashboard/src/lib/__tests__/beaconFilters.test.ts
import { describe, it, expect } from 'vitest';
import {
  applyBeaconFilters,
  DEFAULT_FILTER_STATE,
} from '../beaconFilters';
import type { BeaconFilterState } from '../beaconFilters';
import type { Beacon } from '@/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW   = new Date().toISOString();
const OLDER = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const OLDER2 = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago

function makeBeacon(overrides: Partial<Beacon> = {}): Beacon {
  return {
    id:             'beacon-1',
    hostname:       'alpha',
    os:             'linux',
    arch:           'x64',
    status:         'active',
    lastSeen:       NOW,
    activeTentacle: 1,
    ...overrides,
  };
}

const BEACONS: Beacon[] = [
  makeBeacon({ id: 'b1', hostname: 'alpha',   os: 'linux',   status: 'active', lastSeen: NOW,    activeTentacle: 1  }),
  makeBeacon({ id: 'b2', hostname: 'bravo',   os: 'windows', status: 'stale',  lastSeen: OLDER,  activeTentacle: 4  }),
  makeBeacon({ id: 'b3', hostname: 'charlie', os: 'macos',   status: 'dead',   lastSeen: OLDER2, activeTentacle: 6  }),
  makeBeacon({ id: 'b4', hostname: 'delta',   os: 'linux',   status: 'stale',  lastSeen: OLDER,  activeTentacle: 11 }),
];

function f(overrides: Partial<BeaconFilterState> = {}): BeaconFilterState {
  return { ...DEFAULT_FILTER_STATE, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyBeaconFilters', () => {

  describe('no filters applied', () => {
    it('returns all beacons with default filter state', () => {
      const result = applyBeaconFilters(BEACONS, DEFAULT_FILTER_STATE);
      expect(result).toHaveLength(4);
    });

    it('returns a new array (does not mutate input)', () => {
      const result = applyBeaconFilters(BEACONS, DEFAULT_FILTER_STATE);
      expect(result).not.toBe(BEACONS);
    });
  });

  // ── Status filter ──────────────────────────────────────────────────────────

  describe('status filter', () => {
    it('filters to active beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'active' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b1');
    });

    it('filters to stale beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'stale' }));
      expect(result).toHaveLength(2);
      expect(result.map(b => b.id).sort()).toEqual(['b2', 'b4']);
    });

    it('filters to dead beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'dead' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b3');
    });

    it('returns all when status is "all"', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'all' }));
      expect(result).toHaveLength(4);
    });

    it('returns empty array when no beacons match the status', () => {
      const active = [makeBeacon({ id: 'x', status: 'active' })];
      const result = applyBeaconFilters(active, f({ status: 'dead' }));
      expect(result).toHaveLength(0);
    });
  });

  // ── OS filter ──────────────────────────────────────────────────────────────

  describe('os filter', () => {
    it('filters to linux beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ os: 'linux' }));
      expect(result).toHaveLength(2);
      expect(result.map(b => b.id).sort()).toEqual(['b1', 'b4']);
    });

    it('filters to windows beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ os: 'windows' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b2');
    });

    it('filters to macos beacons only', () => {
      const result = applyBeaconFilters(BEACONS, f({ os: 'macos' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b3');
    });

    it('returns all when os is "all"', () => {
      const result = applyBeaconFilters(BEACONS, f({ os: 'all' }));
      expect(result).toHaveLength(4);
    });
  });

  // ── Tentacle filter ────────────────────────────────────────────────────────

  describe('tentacle filter', () => {
    it('filters to tentacle 1 (Issues) only', () => {
      const result = applyBeaconFilters(BEACONS, f({ tentacle: 1 }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b1');
    });

    it('filters to tentacle 4 (Codespaces) only', () => {
      const result = applyBeaconFilters(BEACONS, f({ tentacle: 4 }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b2');
    });

    it('filters to tentacle 6 (Gists) only', () => {
      const result = applyBeaconFilters(BEACONS, f({ tentacle: 6 }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b3');
    });

    it('filters to tentacle 11 (Notes) only', () => {
      const result = applyBeaconFilters(BEACONS, f({ tentacle: 11 }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b4');
    });

    it('returns all when tentacle is "all"', () => {
      const result = applyBeaconFilters(BEACONS, f({ tentacle: 'all' }));
      expect(result).toHaveLength(4);
    });
  });

  // ── Search filter ──────────────────────────────────────────────────────────

  describe('search filter (hostname substring)', () => {
    it('matches full hostname (case-insensitive)', () => {
      const result = applyBeaconFilters(BEACONS, f({ search: 'ALPHA' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b1');
    });

    it('matches partial hostname', () => {
      const result = applyBeaconFilters(BEACONS, f({ search: 'arli' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b3');
    });

    it('returns all when search string is empty', () => {
      const result = applyBeaconFilters(BEACONS, f({ search: '' }));
      expect(result).toHaveLength(4);
    });

    it('returns all when search string is only whitespace', () => {
      const result = applyBeaconFilters(BEACONS, f({ search: '   ' }));
      expect(result).toHaveLength(4);
    });

    it('returns empty when search matches nothing', () => {
      const result = applyBeaconFilters(BEACONS, f({ search: 'zzznomatch' }));
      expect(result).toHaveLength(0);
    });
  });

  // ── Sort ───────────────────────────────────────────────────────────────────

  describe('sort', () => {
    it('sorts by lastSeen desc (newest first) — default', () => {
      const result = applyBeaconFilters(BEACONS, f({ sort: 'lastSeen_desc' }));
      expect(result[0]!.id).toBe('b1'); // NOW
      expect(result[result.length - 1]!.id).toBe('b3'); // oldest
    });

    it('sorts by lastSeen asc (oldest first)', () => {
      const result = applyBeaconFilters(BEACONS, f({ sort: 'lastSeen_asc' }));
      expect(result[0]!.id).toBe('b3'); // oldest
      expect(result[result.length - 1]!.id).toBe('b1'); // newest
    });

    it('sorts by hostname A→Z', () => {
      const result = applyBeaconFilters(BEACONS, f({ sort: 'hostname_asc' }));
      expect(result.map(b => b.hostname)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    });

    it('sorts by hostname Z→A', () => {
      const result = applyBeaconFilters(BEACONS, f({ sort: 'hostname_desc' }));
      expect(result.map(b => b.hostname)).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
    });
  });

  // ── Combined filters ───────────────────────────────────────────────────────

  describe('combined filters', () => {
    it('applies status + os filter together', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'stale', os: 'linux' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b4');
    });

    it('applies os filter + search together', () => {
      const result = applyBeaconFilters(BEACONS, f({ os: 'linux', search: 'del' }));
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('b4');
    });

    it('returns empty when combined filters exclude all beacons', () => {
      const result = applyBeaconFilters(BEACONS, f({ status: 'active', os: 'windows' }));
      expect(result).toHaveLength(0);
    });
  });
});
