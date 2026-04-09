// dashboard/src/pages/TentacleMonitorPage.tsx
//
// 12-cell tentacle health grid.
// Data is derived from the beacon list — no separate API endpoint needed.
// Active tentacles show beacon count; health is color-coded by recency.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { SSEEvent } from '@/lib/C2ServerClient';
import { GitHubApiClient } from '@/lib/GitHubApiClient';
import { parseBeacon } from '@/lib/parseBeacon';
import { getGitHubCoords } from '@/lib/coords';
import { TENTACLE_NAMES } from '@/types/beacon';
import type { Beacon, TentacleId } from '@/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const GREEN_MS  = 5  * 60 * 1_000;   // 5 min
const YELLOW_MS = 30 * 60 * 1_000;   // 30 min

// ── Helpers ───────────────────────────────────────────────────────────────────

type HealthColor = 'green' | 'yellow' | 'red' | 'gray';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return 'just now';
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function healthColor(beaconsForKind: Beacon[]): HealthColor {
  if (beaconsForKind.length === 0) return 'gray';
  const now = Date.now();
  let mostRecentMs = Infinity;
  for (const b of beaconsForKind) {
    const age = now - new Date(b.lastSeen).getTime();
    if (age < mostRecentMs) mostRecentMs = age;
  }
  if (mostRecentMs < GREEN_MS)  return 'green';
  if (mostRecentMs < YELLOW_MS) return 'yellow';
  return 'red';
}

function healthDotClass(color: HealthColor): string {
  switch (color) {
    case 'green':  return 'bg-green-400 animate-pulse';
    case 'yellow': return 'bg-yellow-400';
    case 'red':    return 'bg-red-500';
    default:       return 'bg-gray-700';
  }
}

function cellBorderClass(color: HealthColor): string {
  switch (color) {
    case 'green':  return 'border-green-900/50 bg-green-950/10';
    case 'yellow': return 'border-yellow-900/50 bg-yellow-950/10';
    case 'red':    return 'border-red-900/40 bg-red-950/10';
    default:       return 'border-octo-border bg-octo-surface/50';
  }
}

function mostRecentLastSeen(beaconsForKind: Beacon[]): string | null {
  if (beaconsForKind.length === 0) return null;
  return beaconsForKind.reduce((latest, b) =>
    b.lastSeen > latest ? b.lastSeen : latest,
    beaconsForKind[0]!.lastSeen,
  );
}

// ── RecoveryPanel ─────────────────────────────────────────────────────────────

interface RecoveryPanelProps {
  notesCount: number;
  relayCount: number;
}

function RecoveryPanel({ notesCount, relayCount }: RecoveryPanelProps) {
  return (
    <div className="space-y-3 font-mono">
      <h2 className="text-xs text-gray-600 uppercase tracking-widest">
        Recovery Status
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div
          data-testid="recovery-notes-count"
          className="border border-octo-border rounded p-3 space-y-1"
        >
          <p className="text-[9px] text-gray-600 uppercase tracking-widest">Channel 11</p>
          <p className={`text-xs ${notesCount > 0 ? 'text-gray-200' : 'text-gray-600'}`}>
            {notesCount} beacon{notesCount === 1 ? '' : 's'}
          </p>
        </div>
        <div
          data-testid="recovery-relay-count"
          className="border border-octo-border rounded p-3 space-y-1"
        >
          <p className="text-[9px] text-gray-600 uppercase tracking-widest">Channel 12</p>
          <p className={`text-xs ${relayCount > 0 ? 'text-gray-200' : 'text-gray-600'}`}>
            {relayCount} beacon{relayCount === 1 ? '' : 's'}
          </p>
        </div>
        <div
          data-testid="recovery-dead-drop"
          className="border border-octo-border rounded p-3 space-y-1"
        >
          <p className="text-[9px] text-gray-600 uppercase tracking-widest">Dead-drop</p>
          <p className="text-xs text-green-400">Armed</p>
          <p className="text-[9px] text-gray-700">gist: data-&#123;sha256[:16]&#125;.bin</p>
        </div>
      </div>
    </div>
  );
}

// ── ProxyPanel ────────────────────────────────────────────────────────────────

interface ProxyPanelProps {
  proxyCount: number;
}

function ProxyPanel({ proxyCount }: ProxyPanelProps) {
  const active = proxyCount > 0;
  return (
    <div className="space-y-3 font-mono">
      <h2 className="text-xs text-gray-600 uppercase tracking-widest">
        Proxy Status
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          data-testid="proxy-panel-count"
          className={`
            border rounded p-3 space-y-1 transition-colors duration-150
            ${active
              ? 'border-octo-blue/30 bg-octo-blue/[0.03]'
              : 'border-octo-border'
            }
          `}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                active ? 'bg-green-400' : 'bg-gray-700'
              }`}
            />
            <p className="text-[9px] text-gray-600 uppercase tracking-widest">Channel 10</p>
          </div>
          <p className={`text-xs ${active ? 'text-gray-200' : 'text-gray-600'}`}>
            {proxyCount} beacon{proxyCount === 1 ? '' : 's'}
          </p>
          {active && (
            <p className="text-[9px] text-octo-blue">
              via OctoProxy
            </p>
          )}
        </div>
        <div
          data-testid="proxy-panel-hint"
          className="border border-octo-border rounded p-3 space-y-1"
        >
          <p className="text-[9px] text-gray-600 uppercase tracking-widest">Config</p>
          <p className="text-[9px] text-gray-700 font-mono break-all">
            OCTOC2_PROXY_REPOS=&#91;&#123;"owner":…&#125;&#93;
          </p>
        </div>
      </div>
    </div>
  );
}

// ── TentacleCell ──────────────────────────────────────────────────────────────

interface TentacleCellProps {
  tid:      TentacleId;
  beacons:  Beacon[];
  expanded: boolean;
  onToggle: () => void;
}

function TentacleCell({ tid, beacons, expanded, onToggle }: TentacleCellProps) {
  const count  = beacons.length;
  const color  = healthColor(beacons);
  const lastTs = mostRecentLastSeen(beacons);

  return (
    <div
      key={tid}
      data-testid={`tentacle-cell-${tid}`}
      className={`
        border rounded p-3 space-y-1.5 transition-colors duration-150
        ${cellBorderClass(color)}
      `}
    >
      <div className="flex items-center gap-1.5">
        <span
          data-testid={`tentacle-dot-${tid}`}
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${healthDotClass(color)}`}
        />
        <span className="text-[9px] text-gray-600 uppercase tracking-widest">
          T{tid}
        </span>
      </div>

      <p className={`text-xs ${count > 0 ? 'text-gray-200' : 'text-gray-600'}`}>
        {TENTACLE_NAMES[tid]}
      </p>

      <p className="text-[10px] text-gray-600">
        {count > 0
          ? `${count} beacon${count === 1 ? '' : 's'}`
          : 'idle'
        }
      </p>

      {lastTs && (
        <p
          data-testid={`tentacle-lastseen-${tid}`}
          className="text-[9px] text-gray-700"
        >
          {relTime(lastTs)}
        </p>
      )}

      {count > 0 && (
        <button
          data-testid={`tentacle-expand-${tid}`}
          onClick={onToggle}
          className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? '▲ hide' : '▼ beacons'}
        </button>
      )}

      {expanded && count > 0 && (
        <ul
          data-testid={`tentacle-beacon-list-${tid}`}
          className="pt-1 space-y-1 border-t border-octo-border/40"
        >
          {beacons.map(b => (
            <li key={b.id} className="text-[9px] text-gray-500 font-mono truncate">
              {b.hostname}
              <span className="ml-1 text-gray-700">{relTime(b.lastSeen)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── TentacleMonitorPage ───────────────────────────────────────────────────────

export function TentacleMonitorPage() {
  const { pat, mode, serverUrl } = useAuth();
  const { owner, repo }          = getGitHubCoords();
  const queryClient              = useQueryClient();

  const [expandedId, setExpandedId]     = useState<TentacleId | null>(null);
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);

  const { data: liveBeacons, isLoading: liveLoading } = useQuery({
    queryKey:        ['beacons-live', serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getBeacons(),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  const { data: issues = [], isLoading: apiLoading } = useQuery({
    queryKey:        ['beacons', pat, owner, repo],
    queryFn:         () => new GitHubApiClient(pat, owner, repo).getBeacons(),
    enabled:         mode === 'api' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  const isLoading = mode === 'live' ? liveLoading : apiLoading;

  // SSE subscription for immediate query invalidation on beacon-update events
  useEffect(() => {
    if (mode !== 'live') return;
    const ctrl = new AbortController();
    void new C2ServerClient(serverUrl, pat).subscribeEvents((event: SSEEvent) => {
      if (event.type === 'beacon-update') {
        void queryClient.invalidateQueries({ queryKey: ['beacons-live', serverUrl, pat] });
      }
    }, ctrl.signal);
    return () => ctrl.abort();
  }, [mode, serverUrl, pat, queryClient]);

  // Track last updated time whenever liveBeacons changes
  useEffect(() => {
    if (liveBeacons !== undefined) {
      setLastUpdated(new Date());
    }
  }, [liveBeacons]);

  const beacons = useMemo(
    () => mode === 'live' ? (liveBeacons ?? []) : issues.map(parseBeacon),
    [mode, liveBeacons, issues],
  );

  // Group beacons by tentacle id
  const beaconsByTentacle = useMemo(() => {
    const map = new Map<TentacleId, Beacon[]>();
    for (const b of beacons) {
      const tid: TentacleId = b.activeTentacle ?? 1;
      const arr = map.get(tid) ?? [];
      arr.push(b);
      map.set(tid, arr);
    }
    return map;
  }, [beacons]);

  // Legacy count helpers for sub-panels
  const notesCount  = (beaconsByTentacle.get(11) ?? []).length;
  const relayCount  = (beaconsByTentacle.get(12) ?? []).length;
  const proxyCount  = (beaconsByTentacle.get(10) ?? []).length;

  const tentacleIds = Object.keys(TENTACLE_NAMES).map(Number) as TentacleId[];

  // Summary: count green + yellow tentacles
  const activeChannelCount = useMemo(() => {
    return tentacleIds.filter(tid => {
      const color = healthColor(beaconsByTentacle.get(tid) ?? []);
      return color === 'green' || color === 'yellow';
    }).length;
  }, [tentacleIds, beaconsByTentacle]);

  const totalChannels = tentacleIds.length;

  function toggleExpand(tid: TentacleId) {
    setExpandedId(prev => (prev === tid ? null : tid));
  }

  if (isLoading) {
    return (
      <div className="space-y-4 font-mono">
        <h2 className="text-xs text-gray-600 uppercase tracking-widest">
          Tentacle Health
        </h2>
        <p className="text-xs text-gray-600">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 font-mono">
      <div className="flex items-center justify-between">
        <h2 className="text-xs text-gray-600 uppercase tracking-widest">
          Tentacle Health
        </h2>
        <div className="flex items-center gap-3">
          {lastUpdated !== null && (
            <span
              data-testid="last-updated"
              className="text-[9px] text-gray-700 font-mono"
            >
              updated {relTime(lastUpdated.toISOString())}
            </span>
          )}
          <p
            data-testid="channel-summary"
            className={`text-xs font-mono ${
              activeChannelCount > 0 ? 'text-green-400' : 'text-gray-600'
            }`}
          >
            {activeChannelCount} of {totalChannels} channels active
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {tentacleIds.map(tid => (
          <TentacleCell
            key={tid}
            tid={tid}
            beacons={beaconsByTentacle.get(tid) ?? []}
            expanded={expandedId === tid}
            onToggle={() => toggleExpand(tid)}
          />
        ))}
      </div>

      <RecoveryPanel notesCount={notesCount} relayCount={relayCount} />
      <ProxyPanel proxyCount={proxyCount} />
    </div>
  );
}
