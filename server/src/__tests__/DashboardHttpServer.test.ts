// server/src/__tests__/DashboardHttpServer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardHttpServer } from '../http/DashboardHttpServer.ts';
import { BeaconRegistry } from '../BeaconRegistry.ts';
import { TaskQueue } from '../TaskQueue.ts';
import { CredentialVerifier } from '../services/CredentialVerifier.ts';
import {
  checkinAuthorizesTaskDelivery,
  type CheckinVerificationStatus,
} from '../services/BeaconIdentityService.ts';
import {
  createHttpTlsFixture,
  type HttpTlsFixture,
} from './helpers/HttpTlsFixture.ts';
import { OctoStore, sha256Hex } from '../store/index.ts';

const TOKEN = 'test-operator-token';
const BEACON_TOKEN = 'test-beacon-token';
let server: DashboardHttpServer;
let reg: BeaconRegistry;
let q: TaskQueue;
let BASE: string;
let tlsFixture: HttpTlsFixture;
let checkinStatus: CheckinVerificationStatus = "accepted";

function fetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  return globalThis.fetch(input, {
    ...init,
    tls: { ca: tlsFixture.certificate },
  });
}

beforeAll(async () => {
  tlsFixture = await createHttpTlsFixture();
  reg         = new BeaconRegistry('/tmp/svc-http-test');
  q           = new TaskQueue();
  server      = new DashboardHttpServer(
    reg,
    q,
    new CredentialVerifier({ operator: TOKEN }),
    new CredentialVerifier({ b1: BEACON_TOKEN }),
    {
      verifyAndRegisterCheckin: async (payload: any, beaconId: string) => {
        const status = checkinStatus;
        if (checkinAuthorizesTaskDelivery(status)) {
          const existing = reg.get(beaconId);
          reg.register({
            beaconId,
            issueNumber: existing?.issueNumber ?? 0,
            publicKey: payload.publicKey,
            hostname: payload.hostname,
            username: payload.username,
            os: payload.os,
            arch: payload.arch,
            seq: (existing?.lastSeq ?? 0) + 1,
            tentacleId: 13,
          });
        }
        return status;
      },
    } as any,
    {
      acceptSignedResult: async (result: any, beaconId: string) => {
        const outcome = q.completeTask(
          beaconId,
          result.taskId,
          JSON.stringify(result),
        );
        if (outcome === "completed") {
          return {
            status: "completed" as const,
            result: {} as any,
          };
        }
        if (outcome === "duplicate") {
          return {
            status: "exact_duplicate" as const,
            result: {} as any,
          };
        }
        if (outcome === "conflict") {
          return {
            status: "conflicting_duplicate" as const,
            result: {} as any,
          };
        }
        if (outcome === "wrong_owner") return { status: "owner_mismatch" as const };
        return { status: "task_not_found" as const };
      },
    } as any,
  );
  const port  = server.start(0, '127.0.0.1', {
    cert: tlsFixture.certificate,
    key: tlsFixture.privateKey,
  });
  BASE        = `https://localhost:${port}`;
});

afterAll(async () => {
  server.stop();
  await tlsFixture.cleanup();
});

const AUTH = { Authorization: `Bearer ${TOKEN}` };

describe('GET /api/health', () => {
  it('refuses plaintext HTTP on the TLS listener', async () => {
    const plaintext = BASE.replace('https://', 'http://');
    await expect(globalThis.fetch(`${plaintext}/api/health`)).rejects.toThrow();
  });

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

  it('rejects a beacon token on operator routes', async () => {
    expect((await fetch(`${BASE}/api/beacons`, {
      headers: { Authorization: `Bearer ${BEACON_TOKEN}` },
    })).status).toBe(401);
  });

  it('rejects an operator token on beacon routes', async () => {
    expect((await fetch(`${BASE}/api/beacon/checkin`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{}',
    })).status).toBe(401);
  });

  it('rejects expired and revoked store-backed credentials at the HTTP route', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'octoc2-http-credentials-'));
    const credentialStore = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
    });
    const expiredToken = 'expired-operator-token';
    const revokedToken = 'revoked-operator-token';
    const verifier = new CredentialVerifier({
      expired: expiredToken,
      revoked: revokedToken,
    });
    credentialStore.insertCredentialHash({
      credentialId: 'operator-expired',
      principalType: 'operator',
      beaconId: null,
      tokenHash: sha256Hex(expiredToken),
      hashAlgorithm: 'sha256',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    credentialStore.insertCredentialHash({
      credentialId: 'operator-revoked',
      principalType: 'operator',
      beaconId: null,
      tokenHash: sha256Hex(revokedToken),
      hashAlgorithm: 'sha256',
    });
    credentialStore.revokeCredential(
      'operator-revoked',
      'route-level regression',
    );
    verifier.attachStore(credentialStore, 'operator');

    const isolatedRegistry = new BeaconRegistry(credentialStore);
    const isolatedQueue = new TaskQueue(credentialStore);
    const isolated = new DashboardHttpServer(
      isolatedRegistry,
      isolatedQueue,
      verifier,
      new CredentialVerifier({ beacon: 'isolated-beacon-token' }),
      {} as any,
      {} as any,
    );
    const isolatedPort = isolated.start(0, '127.0.0.1', {
      cert: tlsFixture.certificate,
      key: tlsFixture.privateKey,
    });
    const isolatedBase = `https://localhost:${isolatedPort}`;

    try {
      for (const token of [expiredToken, revokedToken]) {
        const response = await fetch(`${isolatedBase}/api/beacons`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(401);
      }
    } finally {
      isolated.stop();
      await isolatedRegistry.shutdown();
      credentialStore.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('closes WebSockets when a credential is revoked or expires after upgrade', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'octoc2-ws-credentials-'));
    let now = new Date('2026-01-01T00:00:00.000Z');
    const credentialStore = OctoStore.open({
      dataDir,
      importLegacyRegistry: false,
      now: () => now,
    });
    const definitions = [
      {
        beaconId: 'ws-revoked',
        token: 'ws-revoked-token',
        credentialId: 'ws-revoked-credential',
        expiresAt: null,
      },
      {
        beaconId: 'ws-expired',
        token: 'ws-expired-token',
        credentialId: 'ws-expired-credential',
        expiresAt: '2026-01-01T00:01:00.000Z',
      },
    ] as const;
    for (const definition of definitions) {
      credentialStore.upsertBeacon({
        beaconId: definition.beaconId,
        issueNumber: null,
        x25519PublicKey: `test-x25519-key-${definition.beaconId}`,
        hostname: definition.beaconId,
        username: 'ws-user',
        os: 'test',
        arch: 'test',
      });
      credentialStore.insertCredentialHash({
        credentialId: definition.credentialId,
        principalType: 'beacon',
        beaconId: definition.beaconId,
        tokenHash: sha256Hex(definition.token),
        hashAlgorithm: 'sha256',
        expiresAt: definition.expiresAt,
      });
    }
    const verifier = new CredentialVerifier(Object.fromEntries(
      definitions.map(({ beaconId, token }) => [beaconId, token]),
    ));
    verifier.attachStore(credentialStore, 'beacon');

    const isolated = new DashboardHttpServer(
      new BeaconRegistry(credentialStore),
      new TaskQueue(credentialStore),
      new CredentialVerifier({ operator: 'ws-operator-token' }),
      verifier,
      {} as any,
      {} as any,
    );

    try {
      const sockets = definitions.map((definition) => {
        const credential = verifier.authenticateAuthorizationSession(
          `Bearer ${definition.token}`,
        );
        if (!credential) throw new Error('test credential was not accepted');
        const sent: string[] = [];
        const closed: Array<[number, string]> = [];
        return {
          definition,
          sent,
          closed,
          socket: {
            data: { credential },
            send: (message: string) => {
              sent.push(message);
            },
            close: (code: number, reason: string) => {
              closed.push([code, reason]);
            },
          },
        };
      });
      for (const entry of sockets) {
        await (isolated as any).wsMessage(
          entry.socket,
          JSON.stringify({ type: 'unknown' }),
        );
        expect(JSON.parse(entry.sent.pop()!)).toEqual({
          type: 'error',
          message: 'unknown message type',
        });
        expect(entry.closed).toEqual([]);
      }

      expect(credentialStore.revokeCredential(
        definitions[0].credentialId,
        'WebSocket revocation regression',
      )).toBe(true);
      now = new Date('2026-01-01T00:02:00.000Z');

      for (const entry of sockets) {
        await (isolated as any).wsMessage(
          entry.socket,
          JSON.stringify({ type: 'unknown' }),
        );
        expect(JSON.parse(entry.sent.pop()!)).toEqual({
          type: 'error',
          message: 'credential expired or revoked',
        });
        expect(entry.closed).toEqual([
          [1008, 'credential expired or revoked'],
        ]);
      }
    } finally {
      credentialStore.close();
      await rm(dataDir, { recursive: true, force: true });
    }
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

describe('beacon task delivery leases', () => {
  it('honors the HTTP channel and does not redeliver an active claim', async () => {
    reg.register({
      beaconId: 'b1',
      issueNumber: 0,
      publicKey: 'pk64',
      hostname: 'WIN-HOST',
      username: 'corp\\user',
      os: 'windows',
      arch: 'x64',
      seq: 1,
      tentacleId: 13,
    });
    const httpTask = q.queueTask('b1', 'ping', {}, 'http');
    const oidcTask = q.queueTask('b1', 'ping', {}, 'oidc');
    const checkin = {
      beaconId: 'b1',
      publicKey: 'pk64',
      hostname: 'WIN-HOST',
      username: 'corp\\user',
      os: 'windows',
      arch: 'x64',
      pid: 1234,
      checkinAt: new Date().toISOString(),
      identity: {},
    };

    const first = await fetch(`${BASE}/api/beacon/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEACON_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(checkin),
    });
    const firstBody = await first.json() as {
      tasks: Array<{ taskId: string }>;
    };
    expect(first.status).toBe(200);
    expect(firstBody.tasks.some(({ taskId }) => taskId === httpTask.taskId))
      .toBe(true);
    expect(firstBody.tasks.some(({ taskId }) => taskId === oidcTask.taskId))
      .toBe(false);

    const second = await fetch(`${BASE}/api/beacon/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEACON_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...checkin,
        checkinAt: new Date().toISOString(),
      }),
    });
    const secondBody = await second.json() as {
      tasks: Array<{ taskId: string }>;
    };
    expect(secondBody.tasks.some(({ taskId }) => taskId === httpTask.taskId))
      .toBe(false);
    expect(q.getTask(httpTask.taskId)?.state).toBe('delivered');
    expect(q.getTask(oidcTask.taskId)?.state).toBe('pending');
    const current = reg.get('b1');
    reg.register({
      beaconId: 'b1',
      issueNumber: current?.issueNumber ?? 0,
      publicKey: 'pk64',
      hostname: 'WIN-HOST',
      username: 'corp\\user',
      os: 'windows',
      arch: 'x64',
      seq: (current?.lastSeq ?? 0) + 1,
      tentacleId: 1,
    });
  });

  it('lets only accepted or gap checkins authorize new HTTP deliveries', async () => {
    const checkin = {
      beaconId: 'b1',
      publicKey: 'pk64',
      hostname: 'WIN-HOST',
      username: 'corp\\user',
      os: 'windows',
      arch: 'x64',
      pid: 1234,
      checkinAt: new Date().toISOString(),
      identity: {},
    };
    const post = async (): Promise<Array<{ taskId: string }>> => {
      const response = await fetch(`${BASE}/api/beacon/checkin`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BEACON_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkin),
      });
      expect(response.status).toBe(200);
      return (await response.json() as {
        tasks: Array<{ taskId: string }>;
      }).tasks;
    };

    try {
      checkinStatus = "accepted";
      await post();

      const duplicateTask = q.queueTask('b1', 'ping', {}, 'http');
      checkinStatus = "duplicate";
      expect(await post()).toEqual([]);
      expect(q.getTask(duplicateTask.taskId)?.state).toBe('pending');

      const staleTask = q.queueTask('b1', 'ping', {}, 'http');
      checkinStatus = "stale_duplicate";
      expect(await post()).toEqual([]);
      expect(q.getTask(staleTask.taskId)?.state).toBe('pending');

      checkinStatus = "gap";
      expect((await post()).map(({ taskId }) => taskId).sort()).toEqual(
        [duplicateTask.taskId, staleTask.taskId].sort(),
      );

      const acceptedTask = q.queueTask('b1', 'ping', {}, 'http');
      checkinStatus = "accepted";
      expect((await post()).map(({ taskId }) => taskId)).toEqual([
        acceptedTask.taskId,
      ]);
    } finally {
      checkinStatus = "accepted";
      const current = reg.get('b1');
      if (current) {
        reg.register({
          beaconId: current.beaconId,
          issueNumber: current.issueNumber,
          publicKey: current.publicKey,
          hostname: current.hostname,
          username: current.username,
          os: current.os,
          arch: current.arch,
          seq: current.lastSeq + 1,
          tentacleId: 1,
        });
      }
    }
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

  it('rejects load-module tasks', async () => {
    const res = await fetch(`${BASE}/api/beacon/b1/task`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'load-module', args: { name: 'recon', serverUrl: 'https://localhost:8080' } }),
    });
    expect(res.status).toBe(400);
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

  it('rejects invalid and unavailable preferredChannel values', async () => {
    for (const preferredChannel of [42, 'typo', 'pull_request']) {
      const res = await fetch(`${BASE}/api/beacon/b1/task`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'shell',
          args: { cmd: 'echo' },
          preferredChannel,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('selectable channel');
    }
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
    q.completeTask('b1', task.taskId, JSON.stringify({
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
    const task = q.queueTask('b1', 'ping', {});
    const tasks = await (await fetch(`${BASE}/api/beacon/b1/results`, { headers: AUTH }))
      .json() as Array<{ taskId: string; result: unknown }>;
    const pending = tasks.find(t => t.taskId === task.taskId)!;
    expect(pending.result).toBeNull();
  });
});

describe('disabled module API', () => {
  it('rejects authenticated upload, download, and list requests', async () => {
    const upload = await fetch(`${BASE}/api/modules/b1/recon`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1]),
    });
    const download = await fetch(`${BASE}/api/modules/b1/recon`, { headers: AUTH });
    const list = await fetch(`${BASE}/api/beacon/b1/modules`, { headers: AUTH });
    expect(upload.status).toBe(410);
    expect(download.status).toBe(410);
    expect(list.status).toBe(410);
  });

  it('still authenticates before reporting the feature as disabled', async () => {
    expect((await fetch(`${BASE}/api/modules/b1/recon`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/beacon/b1/modules`)).status).toBe(401);
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
