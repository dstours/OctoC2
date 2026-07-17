// server/src/http/DashboardHttpServer.ts
import type { Octokit } from '@octokit/rest';
import type { BeaconRegistry } from '../BeaconRegistry.ts';
import type { TaskQueue, QueuedTask } from '../TaskQueue.ts';
import {
  OidcRoutes,
  type OidcBeaconBinding,
} from './OidcRoutes.ts';
import type {
  CredentialSession,
  CredentialVerifier,
} from '../services/CredentialVerifier.ts';
import {
  checkinAuthorizesTaskDelivery,
  type BeaconIdentityService,
} from '../services/BeaconIdentityService.ts';
import type { TaskService } from '../services/TaskService.ts';
import type { OctoStore } from '../store/index.ts';
import type { CheckinPayload, TaskResult as TaskResultPayload } from '@octoc2/shared';
import {
  TASK_KINDS,
  isChannelKind,
  isSelectableChannel,
  validateTaskArgs,
  type ChannelKind,
  type TaskKind,
} from '@octoc2/shared';

interface BeaconSocketData {
  credential: CredentialSession;
}

interface GitHubConfig {
  octokit: Octokit;
  owner:   string;
  repo:    string;
}

export interface OidcHttpConfig {
  store: OctoStore;
  operatorPublicKey: Uint8Array;
  operatorSecretKey: Uint8Array;
  bindings: readonly OidcBeaconBinding[];
  audience?: string;
}

export interface HttpTlsConfig {
  cert: string | Buffer;
  key: string | Buffer;
}

interface Task {
  taskId:           string;
  kind:             string;
  args:             Record<string, unknown>;
  ref?:             string;
  issuedAt?:        string;
  preferredChannel?: string;
}

const VALID_KINDS = new Set<TaskKind>(TASK_KINDS);
const DIRECT_DELIVERY_LEASE_MS = 5 * 60_000;

const STATUS_MAP: Record<string, 'active' | 'stale' | 'dead'> = {
  active:  'active',
  dormant: 'stale',
  lost:    'dead',
};

export class DashboardHttpServer {
  private server: ReturnType<typeof Bun.serve<BeaconSocketData>> | null = null;
  private readonly oidcRoutes: OidcRoutes | null;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly operatorCredentials: CredentialVerifier,
    private readonly beaconCredentials: CredentialVerifier,
    private readonly identities: BeaconIdentityService,
    private readonly tasks: TaskService,
    private readonly githubConfig?: GitHubConfig,
    oidcConfig?: OidcHttpConfig,
  ) {
    this.oidcRoutes = oidcConfig
      ? new OidcRoutes({
          registry,
          taskQueue: queue,
          identities,
          tasks,
          store: oidcConfig.store,
          operatorPublicKey: oidcConfig.operatorPublicKey,
          operatorSecretKey: oidcConfig.operatorSecretKey,
          bindings: oidcConfig.bindings,
          ...(oidcConfig.audience && { audience: oidcConfig.audience }),
        })
      : null;
  }

  /** Starts the server. Pass port=0 to let the OS pick a free port. */
  start(
    port: number,
    hostname = '127.0.0.1',
    tls: HttpTlsConfig,
  ): number {
    if (!tls.cert || !tls.key) {
      throw new Error('HTTP TLS certificate and private key are required');
    }
    this.server = Bun.serve({
      port,
      hostname,
      tls,
      idleTimeout: 0, // disable — SSE streams and WS connections must not time out
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open:    (ws) => this.wsOpen(ws),
        message: (ws, msg) => this.wsMessage(ws, msg),
        close:   (ws) => this.wsClose(ws),
      },
    });
    if (this.server.protocol !== 'https') {
      this.server.stop(true);
      this.server = null;
      throw new Error('Dashboard API refused to start without TLS');
    }
    console.log(`[HTTP] Dashboard API listening with TLS on port ${this.server.port}`);
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
        return this.json({
          ok: true,
          serverTime: new Date().toISOString(),
          owner: this.githubConfig?.owner ?? null,
          repo:  this.githubConfig?.repo  ?? null,
        });
      }

      // WebSocket upgrade for beacon channel
      if (req.method === 'GET' && pathname === '/ws') {
        const credential = this.beaconCredentials.authenticateHeadersSession(
          req.headers,
        );
        if (!credential) {
          return this.err('unauthorized', 401);
        }
        const upgraded = (server as Bun.Server<BeaconSocketData>).upgrade(req, {
          data: { credential },
        });
        if (upgraded) return undefined as unknown as Response;
        return this.err('WebSocket upgrade failed', 400);
      }

      // OIDC routes use JWT auth — bypass the Bearer token check
      if (this.oidcRoutes && pathname.startsWith('/api/oidc/')) {
        const oidcResp = await this.oidcRoutes.handle(req, pathname);
        if (oidcResp) return oidcResp;
      }

      const beaconRoute = pathname === '/api/beacon/checkin' || pathname === '/api/beacon/submit-result';
      let beaconPrincipal: string | null = null;
      if (beaconRoute) {
        beaconPrincipal = this.beaconCredentials.authenticateHeaders(req.headers);
        if (!beaconPrincipal) return this.err('unauthorized', 401);
      } else if (!this.operatorCredentials.authenticateHeaders(req.headers)) {
        return this.err('unauthorized', 401);
      }

      return this.route(req, pathname, beaconPrincipal);
    } catch (err) {
      console.error('[HTTP] Unhandled error:', err);
      return this.err('internal server error', 500);
    }
  }

  private async route(
    req: Request,
    pathname: string,
    beaconPrincipal: string | null,
  ): Promise<Response> {
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
      return this.err('module loading is disabled', 410);
    }

    const moduleListMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/modules$/);
    if (req.method === 'GET' && moduleListMatch) {
      return this.err('module loading is disabled', 410);
    }

    const maintenanceMatch = pathname.match(/^\/api\/beacon\/([^/]+)\/maintenance$/);
    if (req.method === 'GET' && maintenanceMatch) {
      return this.getMaintenance(maintenanceMatch[1]!);
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      return this.getEvents();
    }

    if (req.method === 'POST' && pathname === '/api/beacon/checkin') {
      return this.beaconCheckin(req, beaconPrincipal!);
    }

    if (req.method === 'POST' && pathname === '/api/beacon/submit-result') {
      return this.beaconSubmitResult(req, beaconPrincipal!);
    }

    return this.err('not found', 404);
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────────────

  private wsOpen(_ws: Bun.ServerWebSocket<BeaconSocketData>): void {
    // nothing needed on open
  }

  private async wsMessage(
    ws: Bun.ServerWebSocket<BeaconSocketData>,
    msg: string | Buffer,
  ): Promise<void> {
    let credentialActive = false;
    try {
      credentialActive = this.beaconCredentials.isSessionActive(
        ws.data.credential,
      );
    } catch {
      // Store failures must not leave a long-lived authenticated channel open.
    }
    if (!credentialActive) {
      const message = 'credential expired or revoked';
      ws.send(JSON.stringify({ type: 'error', message }));
      ws.close(1008, message);
      return;
    }

    try {
      const text   = typeof msg === 'string' ? msg : msg.toString('utf8');
      const parsed = JSON.parse(text) as { type: string; payload?: unknown; result?: unknown };
      const beaconId = ws.data.credential.principal;

      if (parsed.type === 'checkin') {
        const tasks = await this.handleCheckinPayload(
          parsed.payload as CheckinPayload,
          beaconId,
        );
        ws.send(JSON.stringify({ type: 'checkin-response', tasks }));
      } else if (parsed.type === 'submit-result') {
        await this.handleSubmitResult(
          parsed.result as TaskResultPayload,
          beaconId,
        );
        ws.send(JSON.stringify({ type: 'result-accepted' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
    }
  }

  private wsClose(_ws: Bun.ServerWebSocket<BeaconSocketData>): void {
    // nothing needed on close
  }

  // ── Shared beacon business logic ────────────────────────────────────────────

  private async handleCheckinPayload(
    payload: CheckinPayload,
    authenticatedBeaconId: string,
  ): Promise<Task[]> {
    if (payload.beaconId !== authenticatedBeaconId) {
      throw new Error('credential does not match beaconId');
    }
    const status = await this.identities.verifyAndRegisterCheckin(
      payload,
      authenticatedBeaconId,
      13,
      this.registry.get(payload.beaconId)?.issueNumber ?? 0,
    );
    const deliveries = checkinAuthorizesTaskDelivery(status)
      ? this.queue.claimDeliveries(
        payload.beaconId,
        "http",
        DIRECT_DELIVERY_LEASE_MS,
      )
      : [];
    try {
      const response = deliveries.map(({ task }: {
        task: QueuedTask;
      }): Task => ({
        taskId: task.taskId,
        kind: task.kind,
        args: task.args,
        ref: task.ref,
        issuedAt: task.createdAt,
        ...(task.preferredChannel !== undefined && {
          preferredChannel: task.preferredChannel,
        }),
      }));
      this.queue.finishDeliveries(deliveries, "delivered");
      return response;
    } catch (error) {
      this.queue.finishDeliveries(
        deliveries,
        "transient_failure",
        error,
      );
      throw error;
    }

  }

  private async handleSubmitResult(
    result: TaskResultPayload,
    authenticatedBeaconId: string,
  ): Promise<"completed" | "duplicate"> {
    if (result.beaconId !== authenticatedBeaconId) {
      throw new Error("credential does not match beaconId");
    }
    const verified = await this.tasks.acceptSignedResult(
      result,
      authenticatedBeaconId,
    );
    if (verified.status === "completed") return "completed";
    if (verified.status === "exact_duplicate") return "duplicate";
    if (verified.status === "owner_mismatch") {
      throw new Error("task belongs to another beacon");
    }
    if (
      verified.status === "conflicting_duplicate" ||
      verified.status === "conflicting_message"
    ) {
      throw new Error("conflicting duplicate result");
    }
    if (
      verified.status === "invalid_signature" ||
      verified.status === "identity_key_mismatch"
    ) {
      throw new Error("invalid result signature");
    }
    throw new Error("task not found or no longer accepts results");

  }

  private async beaconCheckin(req: Request, authenticatedBeaconId: string): Promise<Response> {
    let payload: CheckinPayload;
    try {
      payload = await req.json() as CheckinPayload;
    } catch {
      return this.err('invalid JSON', 400);
    }
    try {
      const tasks = await this.handleCheckinPayload(payload, authenticatedBeaconId);
      return this.json({ tasks });
    } catch (err) {
      return this.err((err as Error).message, 403);
    }
  }

  private async beaconSubmitResult(req: Request, authenticatedBeaconId: string): Promise<Response> {
    let result: TaskResultPayload;
    try {
      result = await req.json() as TaskResultPayload;
    } catch {
      return this.err('invalid JSON', 400);
    }
    try {
      const outcome = await this.handleSubmitResult(result, authenticatedBeaconId);
      return this.json({ accepted: true, duplicate: outcome === "duplicate" });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("another beacon")) return this.err(message, 403);
      if (message.includes("signature")) return this.err(message, 403);
      if (message.includes("conflicting")) return this.err(message, 409);
      return this.err(message, 404);
    }
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
    const validation = validateTaskArgs(
      body.kind as TaskKind,
      body.args,
    );
    if (!validation.ok) {
      return this.err(
        validation.issues.map((issue) => issue.message).join('; '),
        400,
      );
    }

    let preferredChannel: ChannelKind | undefined;
    if (body.preferredChannel !== undefined) {
      if (
        !isChannelKind(body.preferredChannel) ||
        !isSelectableChannel(body.preferredChannel)
      ) {
        return this.err('preferredChannel must be a selectable channel kind', 400);
      }
      preferredChannel = body.preferredChannel;
    }

    const task = this.queue.queueTask(
      beaconId,
      body.kind as TaskKind,
      validation.value as Record<string, unknown>,
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

}
