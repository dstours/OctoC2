// server/src/__tests__/DashboardHttpServer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { DashboardHttpServer } from '../http/DashboardHttpServer.ts';
import { BeaconRegistry } from '../BeaconRegistry.ts';
import { TaskQueue } from '../TaskQueue.ts';
import { ModuleStore } from '../http/ModuleStore.ts';
import { rm } from 'node:fs/promises';

const TOKEN = 'test-token-abc';
const MODULE_TEST_DIR = '/tmp/svc-http-module-test';
let server: DashboardHttpServer;
let reg: BeaconRegistry;
let q: TaskQueue;
let moduleStore: ModuleStore;
let BASE: string;

beforeAll(() => {
  reg         = new BeaconRegistry('/tmp/svc-http-test');
  q           = new TaskQueue();
  moduleStore = new ModuleStore(MODULE_TEST_DIR);
  server      = new DashboardHttpServer(reg, q, TOKEN, moduleStore);
  const port  = server.start(0);
  BASE        = `http://localhost:${port}`;
});

afterAll(async () => {
  server.stop();
  await rm(MODULE_TEST_DIR, { recursive: true, force: true });
});

const AUTH = { Authorization: `Bearer ${TOKEN}` };

describe('GET /api/health', () => {
  it('returns 200 with ok:true and no auth required', async () => {
    const res  = await fetch(`${BASE}/api/health`);
    const body = await res.json() as { ok: boolean; serverTime: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.serverTime).toBe('string');
  });
});

describe('auth middleware', () => {
  it('returns 401 when Authorization header is absent', async () => {
    expect((await fetch(`${BASE}/api/beacons`)).status).toBe(401);
  });

  it('returns 401 when token is wrong', async () => {
    expect((await fetch(`${BASE}/api/beacons`, {
      headers: { Authorization: 'Bearer wrong' },
    })).status).toBe(401);
  });
});

describe('CORS', () => {
  it('OPTIONS preflight returns 204 with CORS headers (no auth required)', async () => {
    const res = await fetch(`${BASE}/api/beacons`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('authenticated responses include CORS header', async () => {
    const res = await fetch(`${BASE}/api/beacons`, { headers: AUTH });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('GET /api/beacons', () => {
  it('returns empty array when registry is empty', async () => {
    const body = await (await fetch(`${BASE}/api/beacons`, { headers: AUTH })).json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('maps BeaconRecord to dashboard Beacon shape', async () => {
    reg.register({
      beaconId: 'b1', issueNumber: 42, publicKey: 'pk64',
      hostname: 'WIN-HOST', username: 'corp\\user', os: 'windows', arch: 'x64', seq: 1,
    });
    const [b] = await (await fetch(`${BASE}/api/beacons`, { headers: AUTH }))
      .json() as Array<{ id: string; hostname: string; os: string; status: string; activeTentacle: number }>;
    expect(b!.id).toBe('b1');
    expect(b!.hostname).toBe('WIN-HOST');
    expect(b!.os).toBe('windows');
    expect(b!.activeTentacle).toBe(1);
    expect(b!.status).toBe('active');
  });

  it("returns activeTentacle from registry (not hardcoded)", async () => {
    reg.register({
      beaconId: 'b-grpc', issueNumber: 0, publicKey: 'pk64',
      hostname: 'linux-host', username: 'root', os: 'linux', arch: 'x64',
      seq: 1, tentacleId: 4,
    });
    const beacons = await (await fetch(`${BASE}/api/beacons`, { headers: AUTH }))
      .json() as Array<{ id: string; activeTentacle: number }>;
    const b = beacons.find(x => x.id === 'b-grpc');
    expect(b).toBeDefined();
    expect(b!.activeTentacle).toBe(4);
  });

  it('maps dormant->stale', async () => {
    reg.markDormant('b1');
    const [b] = await (await fetch(`${BASE}/api/beacons`, { headers: AUTH }))
      .json() as Array<{ status: string }>;
    expect(b!.status).toBe('stale');
    // restore
    reg.register({ beaconId: 'b1', issueNumber: 42, publicKey: 'pk64',
      hostname: 'WIN-HOST', username: 'corp\\user', os: 'windows', arch: 'x64', seq: 2 });
  });

  it('maps lost->dead', async () => {
    reg.markLost('b1');
    const [b] = await (await fetch(`${BASE}/api/beacons`, { headers: AUTH }))
      .json() as Array<{ status: string }>;
    expect(b!.status).toBe('dead');
  });
});

describe('POST /api/beacon/:id/task', () => {
  // re-register b1 as active for these tests
  beforeAll(() => {
    reg.register({ beaconId: 'b1', issueNumber: 42, publicKey: 'pk64',
      hostname: 'WIN-HOST', username: 'corp\\user', os: 'windows', arch: 'x64', seq: 10 });
  });

  it('returns 201 with task summary on valid input', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: { cmd: 'whoami' } }),
    });
    const task = await res.json() as {
      taskId: string; beaconId: string; kind: string; status: string;
    };
    expect(res.status).toBe(201);
    expect(task.beaconId).toBe('b1');
    expect(task.kind).toBe('shell');
    expect(task.status).toBe('pending');
  });

  it('returns 404 for unknown beacon', async () => {
    const res = await fetch(`${BASE}/api/beacon/unknown/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid kind', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'notakind', args: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts evasion task kind', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'evasion', args: { action: 'status' } }),
    });
    expect(res.status).toBe(201);
  });

  it('returns 400 when args is not an object', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: 'bad' }),
    });
    expect(res.status).toBe(400);
  });

  it('queues a load-module task (201)', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'load-module', args: { name: 'recon', serverUrl: 'https://localhost:8080' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('load-module');
  });

  it('stores and returns preferredChannel when provided', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: { cmd: 'id' }, preferredChannel: 'notes' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { preferredChannel?: string };
    expect(body.preferredChannel).toBe('notes');
  });

  it('returns undefined preferredChannel when not provided', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: { cmd: 'hostname' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { preferredChannel?: string };
    expect(body.preferredChannel).toBeUndefined();
  });

  it('ignores non-string preferredChannel values', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', args: { cmd: 'echo' }, preferredChannel: 42 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { preferredChannel?: string };
    expect(body.preferredChannel).toBeUndefined();
  });
});

describe('GET /api/beacon/:id/results', () => {
  it('returns empty array for beacon with no tasks (unknown id)', async () => {
    const res  = await fetch(`${BASE}/api/beacon/nobody/results`, { headers: AUTH });
    const body = await res.json() as unknown[];
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns tasks sorted newest-first with parsed result field', async () => {
    const task = q.queueTask('b1', 'shell', { cmd: 'id' });
    q.markDelivered(task.taskId);
    q.markCompleted(task.taskId, JSON.stringify({
      success: true, output: 'root\n', data: '', signature: '',
    }));

    const tasks = await (await fetch(`${BASE}/api/beacon/b1/results`, { headers: AUTH }))
      .json() as Array<{
        taskId: string; status: string; result: { success: boolean; output: string } | null;
      }>;
    const done = tasks.find(t => t.taskId === task.taskId)!;
    expect(done.status).toBe('completed');
    expect(done.result?.output).toBe('root\n');
  });

  it('returns null result for pending tasks', async () => {
    const task = q.queueTask('b1', 'screenshot', {});
    const tasks = await (await fetch(`${BASE}/api/beacon/b1/results`, { headers: AUTH }))
      .json() as Array<{ taskId: string; result: unknown }>;
    const pending = tasks.find(t => t.taskId === task.taskId)!;
    expect(pending.result).toBeNull();
  });
});

describe('POST /api/modules/:beaconId/:name', () => {
  it('stores a module binary (201)', async () => {
    const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    const res = await fetch(`${BASE}/api/modules/b1/recon`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: binary,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { beaconId: string; name: string; bytes: number };
    expect(body.beaconId).toBe('b1');
    expect(body.name).toBe('recon');
    expect(body.bytes).toBe(4);
  });

  it('returns 404 for unknown beacon', async () => {
    const res = await fetch(`${BASE}/api/modules/unknown-beacon/recon`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid module name', async () => {
    const res = await fetch(`${BASE}/api/modules/b1/bad..name`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty body', async () => {
    const res = await fetch(`${BASE}/api/modules/b1/empty-mod`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([]),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/modules/b1/recon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/modules/:beaconId/:name', () => {
  it('returns the stored binary', async () => {
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await moduleStore.store('b1', 'payload', binary);
    const res = await fetch(`${BASE}/api/modules/b1/payload`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(binary);
  });

  it('returns 404 for missing module', async () => {
    const res = await fetch(`${BASE}/api/modules/b1/not-there`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/modules/b1/payload`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/beacon/:id/modules', () => {
  it('returns empty array when no modules are stored for the beacon', async () => {
    const body = await (await fetch(`${BASE}/api/beacon/no-such-beacon/modules`, {
      headers: AUTH,
    })).json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns { name, lastExecuted: null } when module stored but never executed', async () => {
    reg.register({
      beaconId: 'mod-beacon-1', issueNumber: 88, publicKey: 'pk88',
      hostname: 'h', username: 'u', os: 'linux', arch: 'x64', seq: 1,
    });
    await fetch(`${BASE}/api/modules/mod-beacon-1/recon`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
    });

    const body = await (await fetch(`${BASE}/api/beacon/mod-beacon-1/modules`, {
      headers: AUTH,
    })).json() as Array<{ name: string; lastExecuted: string | null }>;

    expect(Array.isArray(body)).toBe(true);
    const entry = body.find(m => m.name === 'recon');
    expect(entry).toBeDefined();
    expect(entry!.lastExecuted).toBeNull();
  });

  it('returns ISO lastExecuted after a completed load-module task', async () => {
    reg.register({
      beaconId: 'mod-beacon-2', issueNumber: 89, publicKey: 'pk89',
      hostname: 'h', username: 'u', os: 'linux', arch: 'x64', seq: 1,
    });
    await fetch(`${BASE}/api/modules/mod-beacon-2/recon`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
    });
    const task = q.queueTask('mod-beacon-2', 'load-module', { name: 'recon', serverUrl: 'http://localhost' });
    q.markDelivered(task.taskId);
    q.markCompleted(task.taskId, JSON.stringify({ success: true, output: '{}' }));

    const body = await (await fetch(`${BASE}/api/beacon/mod-beacon-2/modules`, {
      headers: AUTH,
    })).json() as Array<{ name: string; lastExecuted: string | null }>;

    const entry = body.find(m => m.name === 'recon');
    expect(entry).toBeDefined();
    expect(typeof entry!.lastExecuted).toBe('string');
    expect(new Date(entry!.lastExecuted!).getTime()).toBeGreaterThan(0);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/modules`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/events', () => {
  it('returns 200 with text/event-stream content type', async () => {
    const res = await fetch(`${BASE}/api/events`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/events`);
    expect(res.status).toBe(401);
  });

  it('immediately sends a beacon-update SSE event', async () => {
    const res = await fetch(`${BASE}/api/events`, { headers: AUTH });
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data:');
    expect(text).toContain('beacon-update');
    await reader.cancel();
  });

  it('SSE event body contains a beacons array', async () => {
    const res = await fetch(`${BASE}/api/events`, { headers: AUTH });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value).split('\n')[0]!;
    const json = JSON.parse(line.replace(/^data: /, '')) as { type: string; beacons: unknown[] };
    expect(json.type).toBe('beacon-update');
    expect(Array.isArray(json.beacons)).toBe(true);
    await reader.cancel();
  });
});

describe('GET /api/beacon/:id/maintenance', () => {
  it('returns 404 for unknown beacon', async () => {
    const res = await fetch(`${BASE}/api/beacon/nobody/maintenance`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('returns 200 with MaintenanceState for known beacon', async () => {
    // b1 is already registered from earlier tests
    const res  = await fetch(`${BASE}/api/beacon/b1/maintenance`, { headers: AUTH });
    const body = await res.json() as {
      beaconId: string; hostname: string; os: string; arch: string;
      status: string; lastSeen: string;
      taskCount: number; completedCount: number; failedCount: number; pendingCount: number;
      tasks: unknown[];
      commentBody: string | null;
    };
    expect(res.status).toBe(200);
    expect(body.beaconId).toBe('b1');
    expect(body.hostname).toBe('WIN-HOST');
    expect(body.os).toBe('windows');
    expect(typeof body.taskCount).toBe('number');
    expect(typeof body.completedCount).toBe('number');
    expect(typeof body.failedCount).toBe('number');
    expect(typeof body.pendingCount).toBe('number');
    expect(Array.isArray(body.tasks)).toBe(true);
    // commentBody is null when no githubConfig is provided (test environment)
    expect('commentBody' in body).toBe(true);
    expect(body.commentBody).toBeNull();
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/maintenance`);
    expect(res.status).toBe(401);
  });
});
