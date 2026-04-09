/**
 * octoctl beacons
 *
 * List all registered beacons from the server registry.
 *
 * Usage:
 *   octoctl beacons
 *   octoctl beacons --json
 *   octoctl beacons --status active
 */

import { loadRegistry, registryPath, type BeaconStatus } from "../lib/registry.ts";

export interface BeaconsOptions {
  json:     boolean;
  status?:  BeaconStatus | undefined;
  dataDir?: string | undefined;
}

// Status colours (ANSI codes; no chalk dep needed for this)
const STATUS_COLOR: Record<BeaconStatus, string> = {
  active:  "\x1b[32m",  // green
  dormant: "\x1b[33m",  // yellow
  lost:    "\x1b[31m",  // red
};
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";

function colorStatus(s: BeaconStatus): string {
  return `${STATUS_COLOR[s]}${s}${RESET}`;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffS  = Math.floor(diffMs / 1000);
  if (diffS <  60)  return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

export async function runBeacons(opts: BeaconsOptions): Promise<void> {
  const beacons = await loadRegistry(opts.dataDir);

  const filtered = opts.status
    ? beacons.filter(b => b.status === opts.status)
    : beacons;

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const path = registryPath(opts.dataDir);
  if (beacons.length === 0) {
    console.log(`\n  No beacons registered yet. (registry: ${path})`);
    console.log("  Start the server and let a beacon check in first.\n");
    return;
  }

  if (filtered.length === 0) {
    console.log(`\n  No beacons with status '${opts.status}'.\n`);
    return;
  }

  console.log(`\n  ${BOLD}Registered Beacons${RESET}  ${DIM}(${path})${RESET}`);
  console.log("  " + "─".repeat(72));

  for (const b of filtered) {
    const shortId = b.beaconId.slice(0, 8);
    console.log(
      `\n  ${BOLD}${shortId}…${RESET}  ${colorStatus(b.status)}`
    );
    console.log(`  ${DIM}Full ID:${RESET}   ${b.beaconId}`);
    console.log(`  ${DIM}Host:${RESET}      ${b.username}@${b.hostname}  ${DIM}(${b.os}/${b.arch})${RESET}`);
    console.log(`  ${DIM}Issue:${RESET}     #${b.issueNumber}`);
    console.log(`  ${DIM}Last seen:${RESET} ${relativeTime(b.lastSeen)}  ${DIM}(seq ${b.lastSeq})${RESET}`);
    console.log(`  ${DIM}First seen:${RESET} ${b.firstSeen}`);
  }

  console.log("");
  console.log(`  ${filtered.length} of ${beacons.length} beacon(s) shown.`);
  console.log("");
}
