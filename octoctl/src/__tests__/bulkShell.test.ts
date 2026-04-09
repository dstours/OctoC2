/**
 * Tests for `octoctl bulk shell`
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { postBulkTask, runBulkShellQueue, pollBulkResults, type BulkShellResult } from "../commands/bulkShell.ts";

// ── fetch mock helpers ────────────────────────────────────────────────────────

type MockCall = { url: string; init?: RequestInit };

function makeFetchMock(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  const calls: MockCall[] = [];
  let idx = 0;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    idx++;
    const bodyText = JSON.stringify(resp.body);
    return new Response(bodyText, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { mockFetch, calls };
}

// ── postBulkTask ──────────────────────────────────────────────────────────────

describe("postBulkTask", () => {
  afterEach(() => {
    // restore global fetch
    (globalThis as Record<string, unknown>).fetch = undefined;
  });

  it("POSTs to /api/beacon/:id/task and returns taskId", async () => {
    const { mockFetch, calls } = makeFetchMock([
      { ok: true, status: 200, body: { taskId: "task-uuid-1" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const taskId = await postBulkTask("http://c2:8080", "beacon-abc", "tok", "whoami");

    expect(taskId).toBe("task-uuid-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://c2:8080/api/beacon/beacon-abc/task");
  });

  it("accepts 'id' field as fallback for taskId", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: true, status: 200, body: { id: "task-uuid-alt" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const taskId = await postBulkTask("http://c2:8080", "beacon-abc", "tok", "id");
    expect(taskId).toBe("task-uuid-alt");
  });

  it("sends correct JSON body with kind=shell and cmd", async () => {
    const { mockFetch, calls } = makeFetchMock([
      { ok: true, status: 200, body: { taskId: "t1" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    await postBulkTask("http://c2:8080", "beacon-abc", "tok", "cat /etc/passwd");

    const bodyRaw = calls[0]!.init?.body;
    const body = JSON.parse(bodyRaw as string);
    expect(body.kind).toBe("shell");
    expect(body.args.cmd).toBe("cat /etc/passwd");
  });

  it("includes Authorization Bearer token header", async () => {
    const { mockFetch, calls } = makeFetchMock([
      { ok: true, status: 200, body: { taskId: "t1" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    await postBulkTask("http://c2:8080", "beacon-abc", "my-secret-token", "id");

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("throws on non-2xx response", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: false, status: 404, body: "Not Found" },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    await expect(
      postBulkTask("http://c2:8080", "no-such-beacon", "tok", "ls"),
    ).rejects.toThrow("404");
  });

  it("throws when server returns no taskId", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: true, status: 200, body: { other: "field" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    await expect(
      postBulkTask("http://c2:8080", "beacon-abc", "tok", "ls"),
    ).rejects.toThrow("taskId");
  });
});

// ── runBulkShellQueue ─────────────────────────────────────────────────────────

describe("runBulkShellQueue", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = undefined;
  });

  it("makes one POST per beacon ID", async () => {
    const { mockFetch, calls } = makeFetchMock([
      { ok: true, status: 200, body: { taskId: "task-1" } },
      { ok: true, status: 200, body: { taskId: "task-2" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const results = await runBulkShellQueue({
      beaconIds: ["beacon-aaa", "beacon-bbb"],
      cmd:       "whoami",
      serverUrl: "http://c2:8080",
      token:     "tok",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/beacon-aaa/task");
    expect(calls[1]!.url).toContain("/beacon-bbb/task");
    expect(results).toHaveLength(2);
    expect(results[0]!.taskId).toBe("task-1");
    expect(results[1]!.taskId).toBe("task-2");
  });

  it("reports errors per-beacon without aborting others", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: false, status: 404, body: "Not Found" },
      { ok: true,  status: 200, body: { taskId: "task-ok" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const results = await runBulkShellQueue({
      beaconIds: ["beacon-missing", "beacon-ok"],
      cmd:       "id",
      serverUrl: "http://c2:8080",
      token:     "tok",
    });

    expect(results).toHaveLength(2);

    const errResult = results.find((r: BulkShellResult) => r.beaconId === "beacon-missing")!;
    expect(errResult.taskId).toBeNull();
    expect(errResult.error).not.toBeNull();
    expect(errResult.error).toContain("404");

    const okResult = results.find((r: BulkShellResult) => r.beaconId === "beacon-ok")!;
    expect(okResult.taskId).toBe("task-ok");
    expect(okResult.error).toBeNull();
  });

  it("returns error field null for successful beacons", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: true, status: 201, body: { taskId: "task-x" } },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const results = await runBulkShellQueue({
      beaconIds: ["b1"],
      cmd:       "ls",
      serverUrl: "http://c2:8080",
      token:     "tok",
    });

    expect(results[0]!.error).toBeNull();
  });

  it("handles all beacons failing gracefully", async () => {
    const { mockFetch } = makeFetchMock([
      { ok: false, status: 500, body: "Internal Server Error" },
      { ok: false, status: 503, body: "Service Unavailable" },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const results = await runBulkShellQueue({
      beaconIds: ["b1", "b2"],
      cmd:       "die",
      serverUrl: "http://c2:8080",
      token:     "tok",
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.error).not.toBeNull();
    expect(results[1]!.error).not.toBeNull();
  });
});

// ── pollBulkResults ────────────────────────────────────────────────────────────

/** Capture all console.log output from an async function. */
async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(" ")); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

/** A no-op sleepFn so tests don't actually wait. */
const noSleep = () => Promise.resolve();

describe("pollBulkResults", () => {
  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = undefined;
  });

  it("returns completed=1/total=1 when beacon task completes on first poll", async () => {
    const { mockFetch } = makeFetchMock([
      {
        ok: true, status: 200,
        body: [{ taskId: "task-1", status: "completed", result: { output: "root", success: true } }],
      },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-aaa", taskId: "task-1", error: null },
    ];

    const summary = await pollBulkResults(queued, {
      serverUrl:   "http://c2:8080",
      token:       "tok",
      pollTimeout: 10,
      sleepFn:     noSleep,
    });

    expect(summary.completed).toBe(1);
    expect(summary.total).toBe(1);
  });

  it("prints output for each completed beacon", async () => {
    const { mockFetch } = makeFetchMock([
      {
        ok: true, status: 200,
        body: [{ taskId: "task-2", status: "completed", result: { output: "uid=0(root)", success: true } }],
      },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-bbb", taskId: "task-2", error: null },
    ];

    const lines = await captureLog(() =>
      pollBulkResults(queued, {
        serverUrl:   "http://c2:8080",
        token:       "tok",
        pollTimeout: 10,
        sleepFn:     noSleep,
      }),
    );

    const joined = lines.join("\n");
    expect(joined).toContain("uid=0(root)");
  });

  it("marks failed tasks with ✗ in output", async () => {
    const { mockFetch } = makeFetchMock([
      {
        ok: true, status: 200,
        body: [{ taskId: "task-3", status: "failed", result: { output: "permission denied", success: false } }],
      },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-ccc", taskId: "task-3", error: null },
    ];

    const lines = await captureLog(() =>
      pollBulkResults(queued, {
        serverUrl:   "http://c2:8080",
        token:       "tok",
        pollTimeout: 10,
        sleepFn:     noSleep,
      }),
    );

    const joined = lines.join("\n");
    expect(joined).toContain("✗");
    expect(joined).toContain("permission denied");
  });

  it("times out and returns partial when tasks stay pending", async () => {
    // Always returns pending — never completes
    const { mockFetch } = makeFetchMock([
      { ok: true, status: 200, body: [{ taskId: "task-4", status: "pending", result: null }] },
      { ok: true, status: 200, body: [{ taskId: "task-4", status: "pending", result: null }] },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-ddd", taskId: "task-4", error: null },
    ];

    // Use a 0-second timeout so the deadline is immediately exceeded
    const summary = await pollBulkResults(queued, {
      serverUrl:   "http://c2:8080",
      token:       "tok",
      pollTimeout: 0,
      sleepFn:     noSleep,
    });

    expect(summary.completed).toBe(0);
    expect(summary.total).toBe(1);
  });

  it("skips beacons that failed to queue (error !== null)", async () => {
    // fetch should NOT be called for the errored beacon
    const { mockFetch, calls } = makeFetchMock([]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-err", taskId: null, error: "404 Not Found" },
    ];

    const summary = await pollBulkResults(queued, {
      serverUrl:   "http://c2:8080",
      token:       "tok",
      pollTimeout: 10,
      sleepFn:     noSleep,
    });

    expect(calls).toHaveLength(0);
    expect(summary.total).toBe(0);
    expect(summary.completed).toBe(0);
  });

  it("prints summary line with N/N format", async () => {
    const { mockFetch } = makeFetchMock([
      {
        ok: true, status: 200,
        body: [{ taskId: "task-5", status: "completed", result: { output: "done", success: true } }],
      },
    ]);
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const queued: BulkShellResult[] = [
      { beaconId: "beacon-eee", taskId: "task-5", error: null },
    ];

    const lines = await captureLog(() =>
      pollBulkResults(queued, {
        serverUrl:   "http://c2:8080",
        token:       "tok",
        pollTimeout: 10,
        sleepFn:     noSleep,
      }),
    );

    const joined = lines.join("\n");
    expect(joined).toContain("1/1 beacons returned output");
  });
});
