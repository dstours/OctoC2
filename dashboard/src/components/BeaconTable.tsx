// dashboard/src/components/BeaconTable.tsx
/**
 * BeaconTable — sortable, filterable operator beacon list.
 *
 * Data source:
 *   api / live mode  → GitHubApiClient.getBeacons() (GitHub Issues, 30s polling)
 *   offline          → query disabled; prompt shown instead
 *
 * Phase 2 will switch live mode to C2ServerClient once gRPC transport is wired.
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { GitHubApiClient } from '@/lib/GitHubApiClient';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { SSEBeaconUpdate } from '@/lib/C2ServerClient';
import { parseBeacon } from '@/lib/parseBeacon';
import { getGitHubCoords } from '@/lib/coords';
import { TENTACLE_NAMES } from '@/types/beacon';
import {
  applyBeaconFilters,
  DEFAULT_FILTER_STATE,
  SORT_LABELS,
  TENTACLE_FILTER_OPTIONS,
} from '@/lib/beaconFilters';
import type { BeaconFilterState, StatusFilter, OSFilter, TentacleFilter, SortKey } from '@/lib/beaconFilters';
import type { ConnectionMode } from '@/types';
import type { Beacon } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BeaconStatusDot } from './BeaconStatusDot';

// ── Relative time ──────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return 'just now';
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ── Filter controls ────────────────────────────────────────────────────────────

const SELECT_CLS =
  'bg-octo-surface border border-octo-border text-gray-400 font-mono text-[10px] ' +
  'rounded px-1.5 py-0.5 focus:outline-none focus:border-octo-blue/60 ' +
  'hover:border-octo-blue/40 transition-colors cursor-pointer';

interface FilterBarProps {
  filters:   BeaconFilterState;
  onChange:  (next: BeaconFilterState) => void;
  total:     number;
  visible:   number;
  inputRef?: React.RefObject<HTMLInputElement>;
}

function FilterBar({ filters, onChange, total, visible, inputRef }: FilterBarProps) {
  function set<K extends keyof BeaconFilterState>(key: K, value: BeaconFilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div
      data-testid="beacon-filter-bar"
      className="flex flex-wrap items-center gap-2 mb-3 font-mono text-[10px] text-gray-500"
    >
      {/* Status */}
      <select
        aria-label="Filter by status"
        value={filters.status}
        onChange={e => set('status', e.target.value as StatusFilter)}
        className={SELECT_CLS}
      >
        <option value="all">status: all</option>
        <option value="active">active</option>
        <option value="stale">stale</option>
        <option value="dead">dead</option>
      </select>

      {/* OS */}
      <select
        aria-label="Filter by OS"
        value={filters.os}
        onChange={e => set('os', e.target.value as OSFilter)}
        className={SELECT_CLS}
      >
        <option value="all">os: all</option>
        <option value="linux">linux</option>
        <option value="windows">windows</option>
        <option value="macos">macos</option>
      </select>

      {/* Tentacle */}
      <select
        aria-label="Filter by tentacle"
        value={filters.tentacle === 'all' ? 'all' : String(filters.tentacle)}
        onChange={e => {
          const v = e.target.value;
          set('tentacle', v === 'all' ? 'all' : (parseInt(v, 10) as TentacleFilter));
        }}
        className={SELECT_CLS}
      >
        {TENTACLE_FILTER_OPTIONS.map(opt => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.value === 'all' ? 'tentacle: all' : opt.label}
          </option>
        ))}
      </select>

      {/* Search */}
      <input
        ref={inputRef}
        aria-label="Search beacons"
        type="text"
        placeholder="search beacons…"
        value={filters.search}
        onChange={e => set('search', e.target.value)}
        className={
          'bg-octo-surface border border-octo-border text-gray-300 font-mono text-[10px] ' +
          'rounded px-1.5 py-0.5 focus:outline-none focus:border-octo-blue/60 ' +
          'placeholder:text-gray-700 w-28 transition-colors'
        }
      />

      {/* Sort */}
      <select
        aria-label="Sort beacons"
        value={filters.sort}
        onChange={e => set('sort', e.target.value as SortKey)}
        className={SELECT_CLS}
      >
        {(Object.keys(SORT_LABELS) as SortKey[]).map(key => (
          <option key={key} value={key}>{SORT_LABELS[key]}</option>
        ))}
      </select>

      {/* Count */}
      <span className="ml-auto text-gray-700 tabular-nums">
        {visible}/{total}
      </span>
    </div>
  );
}

// ── Bulk action bar ────────────────────────────────────────────────────────────

interface BulkActionBarProps {
  count:       number;
  mode:        ConnectionMode;
  serverUrl:   string;
  pat:         string;
  selectedIds: Set<string>;
  onClear:     () => void;
}

const DIVIDER_CLS = 'text-gray-700 select-none px-1';

const ACTION_BTN_ENABLED =
  'border-octo-blue/60 text-octo-blue hover:bg-octo-blue/10 cursor-pointer';
const ACTION_BTN_DISABLED =
  'border-octo-border text-gray-600 cursor-not-allowed opacity-50';

function actionBtnCls(enabled: boolean) {
  return (
    'font-mono text-[10px] rounded px-2 py-0.5 border transition-colors ' +
    (enabled ? ACTION_BTN_ENABLED : ACTION_BTN_DISABLED)
  );
}

type PersistMethod = 'auto' | 'crontab' | 'launchd' | 'registry' | 'gh-runner';
type EvasionAction = 'hide' | 'anti_debug' | 'sleep' | 'self_delete' | 'status' | 'propagate';
type StegoAction = 'ack' | 'encode' | 'decode';

function BulkActionBar({ count, mode, serverUrl, pat, selectedIds, onClear }: BulkActionBarProps) {
  const [command,      setCommand]      = useState('');
  const [moduleName,   setModuleName]   = useState('');
  const [persistMethod, setPersistMethod] = useState<PersistMethod>('auto');
  const [evasionAction, setEvasionAction] = useState<EvasionAction>('hide');
  const [stegoAction,   setStegoAction]   = useState<StegoAction>('encode');

  if (count === 0) return null;

  const isLive      = mode === 'live';
  const canShell    = isLive && command.trim().length > 0;
  const canLoadMod  = isLive && moduleName.trim().length > 0;

  async function handleQueue() {
    if (!canShell) return;
    const client = new C2ServerClient(serverUrl, pat);
    await Promise.all(
      Array.from(selectedIds).map(id => client.queueTask(id, 'shell', { cmd: command }))
    );
    setCommand('');
    onClear();
  }

  async function handleLoadModule() {
    if (!canLoadMod) return;
    const client = new C2ServerClient(serverUrl, pat);
    await Promise.all(
      Array.from(selectedIds).map(id => client.queueTask(id, 'load-module', { name: moduleName }))
    );
    setModuleName('');
    onClear();
  }

  async function handlePersist() {
    if (!isLive) return;
    const confirmed = window.confirm(
      `Queue "persist (${persistMethod})" on ${selectedIds.size} beacon(s)? This action cannot be undone.`
    );
    if (!confirmed) return;
    const client = new C2ServerClient(serverUrl, pat);
    await Promise.all(
      Array.from(selectedIds).map(id =>
        client.queueTask(id, 'evasion', { action: 'persist', method: persistMethod })
      )
    );
    onClear();
  }

  async function handleOpenHulud() {
    if (!isLive) return;
    const confirmed = window.confirm(
      `Queue "openhulud (${evasionAction})" on ${selectedIds.size} beacon(s)? This action cannot be undone.`
    );
    if (!confirmed) return;
    const client = new C2ServerClient(serverUrl, pat);
    await Promise.all(
      Array.from(selectedIds).map(id =>
        client.queueTask(id, 'openhulud', { action: evasionAction })
      )
    );
    onClear();
  }

  async function handleStego() {
    if (!isLive) return;
    const confirmed = window.confirm(
      `Queue "stego (${stegoAction})" on ${selectedIds.size} beacon(s)? This action cannot be undone.`
    );
    if (!confirmed) return;
    const client = new C2ServerClient(serverUrl, pat);
    await Promise.all(
      Array.from(selectedIds).map(id =>
        client.queueTask(id, 'stego', { action: stegoAction })
      )
    );
    onClear();
  }

  return (
    <div
      data-testid="bulk-action-bar"
      className="flex items-center gap-2 mb-3 font-mono text-[10px] text-gray-400 bg-octo-surface border border-octo-border rounded px-2 py-1.5 overflow-x-auto"
    >
      <span className="text-octo-blue font-semibold whitespace-nowrap">{count} selected</span>

      {/* ── Shell group ──────────────────────────────────────────────────── */}
      <input
        aria-label="Shell command"
        type="text"
        placeholder="shell command…"
        value={command}
        onChange={e => setCommand(e.target.value)}
        className={
          'bg-octo-surface border border-octo-border text-gray-300 font-mono text-[10px] ' +
          'rounded px-1.5 py-0.5 focus:outline-none focus:border-octo-blue/60 ' +
          'placeholder:text-gray-700 w-40 transition-colors shrink-0'
        }
      />
      <button
        aria-label="Queue shell task"
        disabled={!canShell}
        title={!isLive ? 'Live mode required' : undefined}
        onClick={handleQueue}
        className={actionBtnCls(canShell)}
      >
        Queue shell task
      </button>

      <span className={DIVIDER_CLS}>|</span>

      {/* ── Load-module group ─────────────────────────────────────────────── */}
      <input
        aria-label="Module name"
        type="text"
        placeholder="module name…"
        value={moduleName}
        onChange={e => setModuleName(e.target.value)}
        className={
          'bg-octo-surface border border-octo-border text-gray-300 font-mono text-[10px] ' +
          'rounded px-1.5 py-0.5 focus:outline-none focus:border-octo-blue/60 ' +
          'placeholder:text-gray-700 w-32 transition-colors shrink-0'
        }
      />
      <button
        aria-label="Queue load-module task"
        disabled={!canLoadMod}
        title={!isLive ? 'Live mode required' : !moduleName.trim() ? 'Enter a module name' : undefined}
        onClick={handleLoadModule}
        className={actionBtnCls(canLoadMod)}
      >
        Load module
      </button>

      <span className={DIVIDER_CLS}>|</span>

      {/* ── Persist group ─────────────────────────────────────────────────── */}
      <select
        aria-label="Persistence method"
        value={persistMethod}
        onChange={e => setPersistMethod(e.target.value as PersistMethod)}
        className={SELECT_CLS + ' shrink-0'}
      >
        <option value="auto">auto</option>
        <option value="crontab">crontab</option>
        <option value="launchd">launchd</option>
        <option value="registry">registry</option>
        <option value="gh-runner">gh-runner</option>
      </select>
      <button
        aria-label="Queue persist task"
        disabled={!isLive}
        title={!isLive ? 'Live mode required' : undefined}
        onClick={handlePersist}
        className={actionBtnCls(isLive)}
      >
        Persist
      </button>

      <span className={DIVIDER_CLS}>|</span>

      {/* ── OpenHulud group ───────────────────────────────────────────────── */}
      <select
        aria-label="Evasion action"
        value={evasionAction}
        onChange={e => setEvasionAction(e.target.value as EvasionAction)}
        className={SELECT_CLS + ' shrink-0'}
      >
        <option value="hide">hide</option>
        <option value="anti_debug">anti_debug</option>
        <option value="sleep">sleep</option>
        <option value="self_delete">self_delete</option>
        <option value="status">status</option>
        <option value="propagate">propagate</option>
      </select>
      <button
        aria-label="Queue openhulud task"
        disabled={!isLive}
        title={!isLive ? 'Live mode required' : undefined}
        onClick={handleOpenHulud}
        className={actionBtnCls(isLive)}
      >
        OpenHulud
      </button>

      <span className={DIVIDER_CLS}>|</span>

      {/* ── Stego group ──────────────────────────────────────────────────── */}
      <select
        aria-label="Stego action"
        value={stegoAction}
        onChange={e => setStegoAction(e.target.value as StegoAction)}
        className={SELECT_CLS + ' shrink-0'}
      >
        <option value="ack">ack</option>
        <option value="encode">encode</option>
        <option value="decode">decode</option>
      </select>
      <button
        aria-label="Queue stego task"
        disabled={!isLive}
        title={!isLive ? 'Live mode required' : undefined}
        onClick={handleStego}
        className={actionBtnCls(isLive)}
      >
        Stego
      </button>

      <span className={DIVIDER_CLS}>|</span>

      <a
        href={`/results?beacons=${Array.from(selectedIds).join(',')}`}
        className="font-mono text-[10px] rounded px-2 py-0.5 border border-octo-border text-gray-500 hover:text-gray-300 transition-colors shrink-0"
      >
        View Results
      </a>

      <button
        aria-label="Clear selection"
        onClick={onClear}
        className="font-mono text-[10px] rounded px-2 py-0.5 border border-octo-border text-gray-500 hover:border-octo-border/60 hover:text-gray-400 cursor-pointer transition-colors shrink-0"
      >
        Clear
      </button>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BeaconTable() {
  const { pat, mode, serverUrl, latencyMs } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { owner, repo } = getGitHubCoords();

  const [filters, setFilters] = useState<BeaconFilterState>(DEFAULT_FILTER_STATE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sseActive, setSseActive] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Cmd+K / Ctrl+K global shortcut to focus the search input
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Clear selection whenever filters change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filters]);

  // SSE subscription — live mode only
  // Pushes server-pushed beacon updates straight into the react-query cache
  // so the table refreshes instantly without waiting for the 30s poll cycle.
  useEffect(() => {
    if (mode !== 'live' || !pat || !serverUrl) return;

    const ctrl   = new AbortController();
    const client = new C2ServerClient(serverUrl, pat);
    setSseActive(false);

    client.subscribeEvents((event) => {
      if (event.type === 'beacon-update') {
        queryClient.setQueryData(['beacons-live', serverUrl, pat], event.beacons);
        setSseActive(true);
      }
    }, ctrl.signal).catch(() => { /* stream closed or aborted */ });

    return () => ctrl.abort();
  }, [mode, serverUrl, pat, queryClient]);

  // ── API-mode query (GitHub Issues) ─────────────────────────────────────────

  const {
    data: issues = [],
    isLoading: ghLoading,
    error: ghError,
  } = useQuery({
    queryKey:        ['beacons', pat, owner, repo],
    queryFn:         () => new GitHubApiClient(pat, owner, repo).getBeacons(),
    enabled:         mode === 'api' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  // ── Live-mode query (C2 server) ─────────────────────────────────────────────

  const {
    data: liveBeacons = [],
    isLoading: liveLoading,
    error: liveError,
  } = useQuery({
    queryKey:        ['beacons-live', serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getBeacons(),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  const isLoading = mode === 'live' ? liveLoading : ghLoading;
  const error     = mode === 'live' ? liveError   : ghError;

  const beacons: Beacon[] = useMemo(
    () => mode === 'live' ? liveBeacons : issues.map(parseBeacon),
    [mode, liveBeacons, issues],
  );

  const filtered = useMemo(
    () => applyBeaconFilters(beacons, filters),
    [beacons, filters],
  );

  // ── States ──────────────────────────────────────────────────────────────────

  if (mode === 'offline') {
    return (
      <div className="text-gray-600 font-mono text-xs p-6 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-orange-500 inline-block" />
        Connect with a PAT to load beacons.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="text-gray-600 font-mono text-xs p-6 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-pulse inline-block" />
        Loading beacons…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs p-6" role="alert">
        {error instanceof Error ? error.message : 'Failed to load beacons'}
      </div>
    );
  }

  if (beacons.length === 0) {
    return (
      <div className="text-gray-700 font-mono text-xs p-6">
        No active beacons.
      </div>
    );
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  const allVisibleSelected =
    filtered.length > 0 && filtered.every(b => selectedIds.has(b.id));

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(b => b.id)));
    }
  }

  function toggleSelectOne(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      {mode === 'live' && (
        <div className="flex items-center gap-1 mb-1 font-mono text-[9px] text-gray-600">
          <span
            data-testid="sse-indicator"
            className={`w-1 h-1 rounded-full inline-block transition-colors duration-300 ${sseActive ? 'bg-octo-blue animate-pulse' : 'bg-gray-700'}`}
          />
          LIVE
        </div>
      )}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        total={beacons.length}
        visible={filtered.length}
        inputRef={searchRef}
      />

      <BulkActionBar
        count={selectedIds.size}
        mode={mode}
        serverUrl={serverUrl}
        pat={pat}
        selectedIds={selectedIds}
        onClear={() => setSelectedIds(new Set())}
      />

      {filtered.length === 0 ? (
        <div className="text-gray-700 font-mono text-xs p-4">
          No beacons match the current filters.
        </div>
      ) : (
        <div className="rounded-md border border-gray-800 overflow-hidden">
          <Table className="font-mono text-xs">
            <TableHeader>
              <TableRow className="border-b border-octo-border">
                <TableHead className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all beacons"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="cursor-pointer accent-octo-blue"
                  />
                </TableHead>

                <TableHead
                  role="columnheader"
                  className="w-10 text-[10px] uppercase tracking-[0.15em] font-mono px-3 py-2 text-gray-500"
                >
                  Status
                </TableHead>

                <TableHead className="text-[10px] text-octo-blue uppercase tracking-[0.15em] font-mono px-3 py-2">
                  Beacon ID
                </TableHead>

                <TableHead
                  role="columnheader"
                  className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2"
                >
                  Hostname
                </TableHead>

                <TableHead
                  role="columnheader"
                  className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2"
                >
                  OS/Arch
                </TableHead>

                <TableHead
                  role="columnheader"
                  className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2"
                >
                  Tentacle
                </TableHead>

                <TableHead
                  role="columnheader"
                  className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2"
                >
                  Last Seen
                </TableHead>

                <TableHead className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2">
                  Latency
                </TableHead>

                <TableHead className="text-[10px] text-gray-500 uppercase tracking-[0.15em] font-mono px-3 py-2 w-20">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {filtered.map(beacon => (
                <TableRow
                  key={beacon.id}
                  data-testid={`beacon-row-${beacon.id}`}
                  onClick={() => navigate(`/beacon/${beacon.id}`)}
                  className={`
                    border-b border-octo-border/40
                    cursor-pointer
                    transition-colors duration-150
                    hover:bg-octo-blue/[0.03]
                  `}
                >
                  <TableCell className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select beacon ${beacon.id}`}
                      checked={selectedIds.has(beacon.id)}
                      onChange={() => toggleSelectOne(beacon.id)}
                      className="cursor-pointer accent-octo-blue"
                    />
                  </TableCell>

                  <TableCell className="px-3 py-2.5">
                    <BeaconStatusDot status={beacon.status} />
                  </TableCell>

                  <TableCell className="font-mono text-xs text-octo-blue/80 px-3 py-2.5">
                    {beacon.id}
                  </TableCell>

                  <TableCell className="text-xs text-gray-200 px-3 py-2.5">
                    {beacon.hostname}
                  </TableCell>

                  <TableCell className="text-[11px] text-gray-500 font-mono px-3 py-2.5">
                    {beacon.os}/{beacon.arch}
                  </TableCell>

                  <TableCell className="px-3 py-2.5">
                    <span className="text-[9px] font-mono bg-octo-surface border border-octo-border text-gray-400 shadow-neon-blue-faint px-1.5 py-0.5 rounded inline-block">
                      T{beacon.activeTentacle} {TENTACLE_NAMES[beacon.activeTentacle]}
                    </span>
                  </TableCell>

                  <TableCell className="text-[11px] text-gray-400 font-mono px-3 py-2.5">
                    {formatRelative(beacon.lastSeen)}
                  </TableCell>

                  {/* Latency — gRPC live mode only */}
                  <TableCell className="text-[11px] text-gray-600 font-mono px-3 py-2.5">
                    {mode === 'live' && latencyMs !== null ? `${latencyMs}ms` : '—'}
                  </TableCell>

                  <TableCell className="px-3 py-2.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={e => {
                        e.stopPropagation();
                        navigate(`/beacon/${beacon.id}`);
                      }}
                      className="h-6 px-2 text-[10px] text-octo-blue/60 hover:text-octo-blue transition-colors duration-150 font-mono"
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
