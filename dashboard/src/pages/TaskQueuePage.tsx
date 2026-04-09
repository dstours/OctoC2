// dashboard/src/pages/TaskQueuePage.tsx
//
// Global task queue — shows pending and in-flight tasks across all beacons.
// Each beacon section fetches its own tasks; sections hide when empty.
// Live mode only — task management requires direct C2 server access.

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { ServerTask } from '@/lib/C2ServerClient';
import type { Beacon } from '@/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return 'just now';
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const STATUS_COLOURS: Record<string, string> = {
  pending:   'text-gray-400 border-gray-700',
  delivered: 'text-blue-400 border-blue-800',
};

// ── Per-beacon task section ───────────────────────────────────────────────────

function BeaconTasksSection({ beacon }: { beacon: Beacon }) {
  const { pat, serverUrl } = useAuth();

  const { data: tasks = [] } = useQuery({
    queryKey:        ['tasks', beacon.id, serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getResults(beacon.id),
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  const active = tasks.filter((t: ServerTask) => t.status === 'pending' || t.status === 'delivered');
  if (active.length === 0) return null;

  return (
    <div className="space-y-1" data-testid={`beacon-tasks-${beacon.id}`}>
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
          {beacon.hostname}
        </span>
        <Link
          to={`/beacon/${beacon.id}`}
          className="text-[9px] text-octo-blue/60 hover:text-octo-blue transition-colors font-mono"
        >
          detail →
        </Link>
      </div>
      {active.map((task: ServerTask) => (
        <div
          key={task.taskId}
          className="flex items-center gap-2 px-3 py-1.5 border border-octo-border/40 rounded text-xs font-mono"
          data-testid={`task-row-${task.taskId}`}
        >
          <span
            className={`text-[9px] border px-1.5 py-0.5 rounded ${STATUS_COLOURS[task.status] ?? 'text-gray-500 border-gray-800'}`}
          >
            {task.status}
          </span>
          <span className="text-gray-400">{task.kind}</span>
          <span className="text-gray-700 text-[10px] truncate max-w-xs">
            {JSON.stringify(task.args)}
          </span>
          <span className="ml-auto text-[10px] text-gray-600 shrink-0">
            {rel(task.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── TaskQueuePage ─────────────────────────────────────────────────────────────

export function TaskQueuePage() {
  const { pat, mode, serverUrl } = useAuth();

  const { data: beacons = [], isLoading } = useQuery({
    queryKey:        ['beacons-live', serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getBeacons(),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  if (mode !== 'live') {
    return (
      <div className="space-y-4 font-mono">
        <h2 className="text-xs text-gray-600 uppercase tracking-widest">Task Queue</h2>
        <p className="text-xs text-gray-600">Live mode required for task management.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4 font-mono">
        <h2 className="text-xs text-gray-600 uppercase tracking-widest">Task Queue</h2>
        <p className="text-xs text-gray-600">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 font-mono">
      <h2 className="text-xs text-gray-600 uppercase tracking-widest">Task Queue</h2>
      {beacons.length === 0 ? (
        <p className="text-xs text-gray-600">No active beacons.</p>
      ) : (
        <div className="space-y-4">
          {beacons.map((beacon: Beacon) => (
            <BeaconTasksSection key={beacon.id} beacon={beacon} />
          ))}
          <p className="text-[10px] text-gray-700">
            Showing pending and in-flight tasks only. Completed results appear in each beacon&apos;s{' '}
            Results tab.
          </p>
        </div>
      )}
    </div>
  );
}
