/**
 * octoctl tentacles list --beacon <id>
 *
 * Show tentacle (channel) health status for all registered channels on a beacon.
 *
 * Usage:
 *   octoctl tentacles list --beacon <beaconId>
 *   octoctl tentacles list --beacon <beaconId> --json
 *   octoctl tentacles list --beacon <beaconId> --server-url <url>
 */

import { loadRegistry } from "../lib/registry.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

/** The 13 canonical tentacle kinds shown in the health table. */
const ALL_KINDS = [
  "issues",
  "gist",
  "branch",
  "notes",
  "actions",
  "secrets",
  "proxy",
  "codespaces",
  "http",
  "relay",
  "oidc",
  "pages",
  "stego",
] as const;

export type TentacleKind = (typeof ALL_KINDS)[number];

export type TentacleStatus = "active" | "live" | "degraded" | "slow" | "failed" | "dead" | "idle" | "unknown" | "inactive" | "error";

export interface TentacleChannel {
  kind:        TentacleKind;
  status:      TentacleStatus;
  lastSeen:    string | null;
  successRate: number | null;
  lastError:   string | null;
}

export interface TentaclesListOptions {
  beacon:     string;
  json?:      boolean;
  serverUrl?: string;
  dataDir?:   string;
  verbose?:   boolean;
}

export interface TentaclesListResult {
  beaconId:       string;
  activeTentacle: string | null;
  lastSeen:       string | null;
  channels:       Array<{
    kind:        string;
    status:      TentacleStatus;
    lastSeen:    string | null;
    successRate: number | null;
    lastError:   string | null;
  }>;
}

// ── Task result types ──────────────────────────────────────────────────────────

interface TaskResult {
  taskId:            string;
  beaconId:          string;
  kind:              string;
  status:            "completed" | "pending" | "delivered" | "failed";
  completedAt:       string | null;
  result:            { output?: string; success?: boolean } | string | null;
  preferredChannel:  string | null;
}

// ── ANSI helpers ───────────────────────────────────────────────────────────────

const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const GRAY   = "\x1b[90m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffS  = Math.floor(diffMs / 1000);
  if (diffS <  60)   return `${diffS}s ago`;
  if (diffS < 3600)  return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

/** Return true when the timestamp is older than 30 minutes. */
function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > 30 * 60 * 1000;
}

export function statusDisplay(status: TentacleStatus): string {
  switch (status) {
    case "active":
    case "live":
      return `${GREEN}● ${status}${RESET}`;
    case "degraded":
    case "slow":
      return `${YELLOW}◐ ${status}${RESET}`;
    case "failed":
    case "dead":
    case "error":
      return `${RED}✗ ${status}${RESET}`;
    case "idle":
    case "unknown":
    case "inactive":
    default:
      return `${GRAY}○ ${status}${RESET}`;
  }
}

// ── Per-channel stats computation ──────────────────────────────────────────────

interface ChannelStats {
  successRate: number | null;
  lastError:   string | null;
}

/**
 * Extract the error output string from a task result payload.
 * The result field may be an object with `output`, a raw string, or null.
 */
function extractOutput(result: TaskResult["result"]): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "output" in result) {
    return String(result.output ?? "");
  }
  return "";
}

/**
 * Determine whether a task result counts as a success.
 * - status === "completed" AND result.success === true  → success
 * - status === "failed" OR result.success === false     → failure
 * - anything else (pending / delivered)                → not counted
 */
function isSuccessfulTask(t: TaskResult): boolean {
  if (t.status === "failed") return false;
  if (t.status !== "completed") return false; // pending / delivered — skip
  if (typeof t.result === "object" && t.result !== null && "success" in t.result) {
    return t.result.success === true;
  }
  // completed with no explicit success field → treat as success
  return true;
}

function isCountedTask(t: TaskResult): boolean {
  return t.status === "completed" || t.status === "failed";
}

/**
 * Compute per-channel health stats from a flat list of task results.
 *
 * Tasks are attributed to a channel via `preferredChannel`; tasks without a
 * `preferredChannel` go to the "issues" channel (the default).
 *
 * When `verbose` is true, `lastError` is NOT truncated at 60 chars.
 */
export function computeChannelStats(
  tasks: TaskResult[],
  verbose = false,
): Map<string, ChannelStats> {
  // Group tasks by channel
  const byChannel = new Map<string, TaskResult[]>();

  for (const t of tasks) {
    const ch = t.preferredChannel ?? "issues";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(t);
  }

  const out = new Map<string, ChannelStats>();

  for (const [ch, chTasks] of byChannel) {
    const counted = chTasks.filter(isCountedTask);

    let successRate: number | null = null;
    if (counted.length > 0) {
      const successes = counted.filter(isSuccessfulTask).length;
      successRate = Math.round((successes / counted.length) * 1000) / 10; // 1 decimal
    }

    // Most-recent failed task (by completedAt, fallback to array order)
    const failed = chTasks.filter(
      t => t.status === "failed" || (t.status === "completed" &&
        typeof t.result === "object" && t.result !== null &&
        "success" in t.result && t.result.success === false),
    );

    let lastError: string | null = null;
    if (failed.length > 0) {
      // Sort descending by completedAt (nulls last)
      failed.sort((a, b) => {
        if (!a.completedAt && !b.completedAt) return 0;
        if (!a.completedAt) return 1;
        if (!b.completedAt) return -1;
        return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
      });
      const raw = extractOutput(failed[0]!.result);
      if (raw.length === 0) {
        lastError = null;
      } else if (!verbose && raw.length > 60) {
        lastError = raw.slice(0, 60);
      } else {
        lastError = raw;
      }
    }

    out.set(ch, { successRate, lastError });
  }

  return out;
}

// ── Core logic ─────────────────────────────────────────────────────────────────

/**
 * Build the channel list given the active tentacle name, last-seen timestamp,
 * and optional per-channel stats map.
 */
export function buildChannels(
  activeTentacle: string | null | undefined,
  lastSeen: string | null | undefined,
  statsMap?: Map<string, ChannelStats>,
): Array<TentacleChannel> {
  return ALL_KINDS.map(kind => {
    const stats = statsMap?.get(kind) ?? { successRate: null, lastError: null };

    if (kind === activeTentacle && lastSeen) {
      const status: TentacleStatus = isStale(lastSeen) ? "error" : "active";
      return { kind, status, lastSeen, ...stats };
    }
    return { kind, status: "idle" as TentacleStatus, lastSeen: null, ...stats };
  });
}

// ── Server-mode fetch ──────────────────────────────────────────────────────────

interface ServerBeacon {
  id:             string;
  activeTentacle?: string | number;
  lastSeen:       string;
  [k: string]: unknown;
}

interface MaintenanceResponse {
  pendingCount?: number;
  completedCount?: number;
  [k: string]: unknown;
}

async function fetchFromServer(
  serverUrl: string,
  beaconPrefix: string,
  token: string,
): Promise<{ beacon: ServerBeacon; maintenance: MaintenanceResponse; tasks: TaskResult[] }> {
  const headers = { Authorization: `Bearer ${token}` };

  // GET /api/beacons
  const beaconsResp = await fetch(`${serverUrl}/api/beacons`, { headers });
  if (!beaconsResp.ok) {
    throw new Error(`GET /api/beacons returned ${beaconsResp.status}`);
  }
  const beacons = (await beaconsResp.json()) as ServerBeacon[];

  const beacon = beacons.find(
    b => b.id === beaconPrefix || b.id.startsWith(beaconPrefix),
  );
  if (!beacon) {
    throw new Error(`Beacon '${beaconPrefix}' not found on server`);
  }

  // GET /api/beacon/:id/maintenance
  const maintResp = await fetch(
    `${serverUrl}/api/beacon/${beacon.id}/maintenance`,
    { headers },
  );
  let maintenance: MaintenanceResponse = {};
  if (maintResp.ok) {
    maintenance = (await maintResp.json()) as MaintenanceResponse;
  }

  // GET /api/beacon/:id/results
  let tasks: TaskResult[] = [];
  const resultsResp = await fetch(
    `${serverUrl}/api/beacon/${beacon.id}/results`,
    { headers },
  );
  if (resultsResp.ok) {
    tasks = (await resultsResp.json()) as TaskResult[];
  }

  return { beacon, maintenance, tasks };
}

// ── Verbose error details section ──────────────────────────────────────────────

/**
 * Print a "Last Error Details" section after the main table when verbose=true
 * and there are channels with a non-null lastError.
 *
 * Only called from the human-readable output path.
 */
export function printErrorDetails(
  channels: Array<TentacleChannel>,
  verbose: boolean,
): void {
  if (!verbose) return;
  const withErrors = channels.filter(c => c.lastError !== null);
  if (withErrors.length === 0) return;

  console.log(`  ${BOLD}Last Error Details:${RESET}`);
  console.log("  " + "─".repeat(77));
  for (const ch of withErrors) {
    const kindCol = ch.kind.padEnd(10);
    console.log(`  ${kindCol}| ${ch.lastError}`);
  }
  console.log("");
}

// ── Main entrypoint ────────────────────────────────────────────────────────────

export async function runTentaclesList(opts: TentaclesListOptions): Promise<void> {
  const token = process.env["OCTOC2_DASHBOARD_TOKEN"] ?? "dev-token";

  let activeTentacle: string | null = null;
  let lastSeen:       string | null = null;
  let beaconId:       string        = opts.beacon;
  let statsMap:       Map<string, ChannelStats> | undefined;

  if (opts.serverUrl) {
    // ── Online mode ────────────────────────────────────────────────────────────
    const { beacon, tasks } = await fetchFromServer(opts.serverUrl, opts.beacon, token);
    beaconId = beacon.id;
    lastSeen = beacon.lastSeen ?? null;
    // activeTentacle from server may be a number (legacy) or string kind name
    const raw = beacon.activeTentacle;
    if (typeof raw === "string" && raw.length > 0) {
      activeTentacle = raw;
    }
    // If it's a number (legacy API) we can't map it without more context — leave null
    if (tasks.length > 0) {
      statsMap = computeChannelStats(tasks, opts.verbose ?? false);
    }
  } else {
    // ── Offline mode ───────────────────────────────────────────────────────────
    const registry = await loadRegistry(opts.dataDir);
    const record = registry.find(
      b => b.beaconId === opts.beacon || b.beaconId.startsWith(opts.beacon),
    );
    if (!record) {
      throw new Error(`Beacon '${opts.beacon}' not found in registry`);
    }
    beaconId       = record.beaconId;
    lastSeen       = record.lastSeen ?? null;
    activeTentacle = record.activeTentacle ?? null;
    // No results available offline — statsMap stays undefined
  }

  const channels = buildChannels(activeTentacle, lastSeen, statsMap);

  // ── JSON output ──────────────────────────────────────────────────────────────
  if (opts.json) {
    const out: TentaclesListResult = {
      beaconId,
      activeTentacle,
      lastSeen,
      channels: channels.map(c => ({
        kind:        c.kind,
        status:      c.status,
        lastSeen:    c.lastSeen ? relativeTime(c.lastSeen) : null,
        successRate: c.successRate,
        lastError:   c.lastError,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // ── Human-readable output ────────────────────────────────────────────────────
  const shortId = beaconId.slice(0, 8);
  console.log(`\n  ${BOLD}Tentacle Health${RESET} — beacon ${shortId}…\n`);
  console.log(
    `  ${"Channel".padEnd(12)}  ${"Status".padEnd(17)}  ${"Last Seen".padEnd(12)}  ${"Success".padEnd(8)}  Last Error`,
  );
  console.log("  " + "─".repeat(80));

  for (const ch of channels) {
    const kindCol    = ch.kind.padEnd(10);
    const statusCol  = statusDisplay(ch.status);
    const seenCol    = ch.lastSeen ? relativeTime(ch.lastSeen).padEnd(12) : "—".padEnd(12);
    const notes      = ch.kind === activeTentacle ? "primary channel" : "not seen";
    const successCol = ch.successRate !== null
      ? `${ch.successRate.toFixed(1)}%`.padEnd(8)
      : "—".padEnd(8);
    const errorCol   = ch.lastError ?? "—";
    // statusDisplay already includes colour codes so we pad the visible portion
    const statusPad  = " ".repeat(Math.max(0, 9 - ch.status.length));
    console.log(
      `  ${kindCol}  ${statusCol}${statusPad}  ${seenCol}  ${successCol}  ${errorCol}  ${notes}`,
    );
  }

  console.log("");

  if (activeTentacle && lastSeen) {
    const ago = relativeTime(lastSeen);
    const activeStatus = isStale(lastSeen) ? "error" : "active";
    console.log(
      `  Active channel: ${BOLD}${activeTentacle}${RESET}  |  Last seen: ${ago}  |  Status: ${activeStatus}`,
    );
  } else {
    console.log(`  ${GRAY}No active channel recorded${RESET}`);
  }

  console.log("");

  printErrorDetails(channels, opts.verbose ?? false);
}

export const runTentaclesHealth = runTentaclesList;
