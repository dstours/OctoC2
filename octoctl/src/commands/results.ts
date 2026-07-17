/**
 * Fetch task results that the controller has already authenticated, bound to
 * the owning task, and persisted through the central TaskService.
 */

import {
  controllerFetch,
  requireControllerServerUrl,
  requireOperatorApiToken,
} from "../lib/env.ts";
import { getBeacon } from "../lib/registry.ts";

export interface ResultsOptions {
  last?: number | undefined;
  since?: string | undefined;
  json: boolean;
}

interface DisplayResult {
  taskId: string;
  beaconId: string;
  kind?: string;
  completedAt: string;
  output?: string;
  error?: string;
}

interface ServerResult {
  taskId: string;
  beaconId?: string;
  kind?: string;
  status?: string;
  completedAt?: string | null;
  output?: string;
  success?: boolean;
  result?: {
    output?: string;
    success?: boolean;
    completedAt?: string;
  } | null;
}

function parseSince(value: string): Date {
  const relative = /^(\d+)(s|m|h|d)$/.exec(value);
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const units: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return new Date(Date.now() - amount * units[relative[2]!]!);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("--since must be a valid ISO timestamp or duration such as 2h");
  }
  return parsed;
}

export async function runResults(
  beaconIdPrefix: string,
  opts: ResultsOptions,
): Promise<void> {
  const dataDir = process.env["OCTOC2_DATA_DIR"]?.trim() ?? "./data";
  const beacon = await getBeacon(beaconIdPrefix, dataDir);
  if (!beacon) {
    throw new Error(`Beacon '${beaconIdPrefix}' was not found in the registry`);
  }

  const sinceDate = opts.since
    ? parseSince(opts.since)
    : new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const since = sinceDate.toISOString();
  const serverUrl = requireControllerServerUrl();
  const operatorApiToken = requireOperatorApiToken();
  const response = await controllerFetch(
    `${serverUrl}/api/beacon/${encodeURIComponent(beacon.beaconId)}/results`,
    { headers: { Authorization: `Bearer ${operatorApiToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Server returned ${response.status}: ${await response.text()}`,
    );
  }

  const serverResults = await response.json() as ServerResult[];
  let results: DisplayResult[] = serverResults
    .filter((entry) => entry.status === "completed" || entry.result)
    .filter((entry) => {
      const completedAt =
        entry.result?.completedAt ?? entry.completedAt ?? "";
      const completed = new Date(completedAt);
      return Number.isFinite(completed.getTime()) && completed >= sinceDate;
    })
    .map((entry) => {
      const success = entry.result?.success ?? entry.success;
      const output = entry.result?.output ?? entry.output;
      return {
        taskId: entry.taskId,
        beaconId: entry.beaconId ?? beacon.beaconId,
        completedAt:
          entry.result?.completedAt ??
          entry.completedAt ??
          new Date(0).toISOString(),
        ...(entry.kind !== undefined && { kind: entry.kind }),
        ...(output !== undefined && { output }),
        ...(success === false && { error: "task failed" }),
      };
    });

  if (opts.last !== undefined) {
    if (!Number.isSafeInteger(opts.last) || opts.last <= 0) {
      throw new Error("--last must be a positive integer");
    }
    results = results.slice(-opts.last);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const cyan = "\x1b[36m";

  console.log("");
  console.log(
    `  ${bold}Verified results for ${beacon.hostname}${reset}  ` +
      `${dim}(${beacon.beaconId.slice(0, 8)}…)${reset}`,
  );
  if (results.length === 0) {
    console.log(`\n  No verified results in the last ${opts.since ?? "24h"}.\n`);
    return;
  }

  console.log(`  ${dim}Showing ${results.length} result(s) since ${since}${reset}`);
  console.log(`  ${"─".repeat(72)}`);
  for (const result of results) {
    const statusMark = result.error
      ? `${red}✗${reset}`
      : `${green}✓${reset}`;
    console.log("");
    console.log(
      `  ${statusMark}  ${bold}${result.taskId.slice(0, 8)}…${reset}  ` +
        `${dim}${result.completedAt}${reset}`,
    );
    if (result.kind) console.log(`  ${dim}Kind:${reset} ${result.kind}`);
    if (result.output?.trim()) {
      console.log(`  ${cyan}Output:${reset}`);
      const lines = result.output.split("\n");
      for (const line of lines.slice(0, 20)) console.log(`    ${line}`);
      if (lines.length > 20) {
        console.log(
          `    ${dim}… (${lines.length - 20} more lines; use --json)${reset}`,
        );
      }
    }
    if (result.error) console.log(`  ${red}Error:${reset} ${result.error}`);
  }
  console.log("");
}
