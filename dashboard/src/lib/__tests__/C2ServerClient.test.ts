// dashboard/src/lib/__tests__/C2ServerClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { C2ServerClient } from '../C2ServerClient';
import type { MaintenanceState, SSEBeaconUpdate, SSEEvent } from '../C2ServerClient';
import type { Beacon } from '@/types';

const BASE = 'http://localhost:8080';
const PAT  = 'ghp_test';

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok:     status >= 200 && status < 300,
    status,
    json:   () => Promise.resolve(body),
    text:   () => Promise.resolve(JSON.stringify(body)),
  }));
}

beforeEach(() => vi.unstubAllGlobals());

describe('C2ServerClient', () => {
  describe('health()', () => {
    it('calls GET /api/health and returns ok + latencyMs', async () => {
      mockFetch({ ok: true });
      const client = new C2ServerClient(BASE, PAT);
      const result = await client.health();
      expect(result.ok).toBe(true);
      expect(typeof result.latencyMs).toBe('number');
      const call = vi.mocked(fetch).mock.calls[0]!;
      expect(call[0]).toBe(`${BASE}/api/health`);
    });
  });

  describe('getBeacons()', () => {
    it('calls GET /api/beacons with Bearer auth and returns Beacon[]', async () => {
      const beaconData: Beacon[] = [{
        id: 'b1', hostname: 'host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
      }];
      mockFetch(beaconData);
      const client = new C2ServerClient(BASE, PAT);
      const result = await client.getBeacons();
      expect(result).toEqual(beaconData);

      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe(`${BASE}/api/beacons`);
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: `Bearer ${PAT}`,
      });
    });

    it('throws when server returns non-ok response', async () => {
      mockFetch({ error: 'unauthorized' }, 401);
      const client = new C2ServerClient(BASE, PAT);
      await expect(client.getBeacons()).rejects.toThrow(/401/);
    });
  });

  describe('queueTask()', () => {
    it('POSTs to /api/beacon/:id/task with kind and args', async () => {
      mockFetch({ taskId: 'uuid-123', beaconId: 'b1', kind: 'shell', status: 'pending', createdAt: '' });
      const client = new C2ServerClient(BASE, PAT);
      const result = await client.queueTask('b1', 'shell', { cmd: 'whoami' });
      expect(result.taskId).toBe('uuid-123');

      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe(`${BASE}/api/beacon/b1/task`);
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ kind: 'shell', args: { cmd: 'whoami' } });
    });
  });

  describe('getResults()', () => {
    it('calls GET /api/beacon/:id/results and returns task list', async () => {
      const tasks = [{ taskId: 'tid', beaconId: 'b1', kind: 'shell', args: {}, status: 'completed',
        ref: 'abc', createdAt: '', deliveredAt: null, completedAt: null, result: null }];
      mockFetch(tasks);
      const client = new C2ServerClient(BASE, PAT);
      const result = await client.getResults('b1');
      expect(result).toEqual(tasks);

      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${BASE}/api/beacon/b1/results`);
    });
  });
});

describe('getMaintenance()', () => {
  it('calls GET /api/beacon/:id/maintenance and returns MaintenanceState', async () => {
    const state: MaintenanceState = {
      beaconId: 'b1', hostname: 'host', os: 'linux', arch: 'x64',
      status: 'active', lastSeen: new Date().toISOString(),
      taskCount: 3, completedCount: 2, failedCount: 0, pendingCount: 1,
      tasks: [],
      commentBody: null,
    };
    mockFetch(state);
    const client = new C2ServerClient(BASE, PAT);
    const result = await client.getMaintenance('b1');
    expect(result.beaconId).toBe('b1');
    expect(result.taskCount).toBe(3);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${BASE}/api/beacon/b1/maintenance`);
  });
});

describe('subscribeEvents()', () => {
  it('calls GET /api/events with Bearer auth', async () => {
    const beacons: Beacon[] = [{
      id: 'b1', hostname: 'host', os: 'linux', arch: 'x64',
      status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
    }];
    const ssePayload = `data: ${JSON.stringify({ type: 'beacon-update', beacons })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ssePayload));
          c.close();
        },
      }),
    }));

    const events: SSEEvent[] = [];
    const client = new C2ServerClient(BASE, PAT);
    await client.subscribeEvents(e => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('beacon-update');
    expect((events[0] as SSEBeaconUpdate).beacons[0]!.id).toBe('b1');

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/events`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${PAT}` });
  });

  it('resolves without throwing when AbortError is raised', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
    ));
    const client = new C2ServerClient(BASE, PAT);
    await expect(client.subscribeEvents(() => {})).resolves.toBeUndefined();
  });

  it('ignores malformed SSE JSON lines without throwing', async () => {
    const ssePayload = 'data: {bad json}\n\ndata: not-json-at-all\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ssePayload));
          c.close();
        },
      }),
    }));
    const client = new C2ServerClient(BASE, PAT);
    const events: SSEEvent[] = [];
    await expect(client.subscribeEvents(e => events.push(e))).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('returns early when server returns non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const client = new C2ServerClient(BASE, PAT);
    const called: boolean[] = [];
    await client.subscribeEvents(() => { called.push(true); });
    expect(called).toHaveLength(0);
  });

  it('dispatches task-update events', async () => {
    const ssePayload = `data: ${JSON.stringify({ type: 'task-update', beaconId: 'b1' })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ssePayload));
          c.close();
        },
      }),
    }));

    const events: SSEEvent[] = [];
    const client = new C2ServerClient(BASE, PAT);
    await client.subscribeEvents(e => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('task-update');
    expect((events[0] as { type: string; beaconId: string }).beaconId).toBe('b1');
  });

  it('dispatches maintenance-update events', async () => {
    const ssePayload = `data: ${JSON.stringify({ type: 'maintenance-update', beaconId: 'b1' })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ssePayload));
          c.close();
        },
      }),
    }));

    const events: SSEEvent[] = [];
    const client = new C2ServerClient(BASE, PAT);
    await client.subscribeEvents(e => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('maintenance-update');
    expect((events[0] as { type: string; beaconId: string }).beaconId).toBe('b1');
  });
});
