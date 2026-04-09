/**
 * octoctl build-beacon (simple wrapper)
 *
 * Compiles the implant binary by shelling out to:
 *   bun build implant/src/index.ts --compile --target=bun-<platform> --outfile=<output>
 *
 * This is a thin wrapper around `bun build` intended for CI smoke testing.
 * For full beacon compilation with baked keypairs, use runBuildBeacon.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";

export interface BuildBeaconSimpleOptions {
  output:   string;
  platform: string;
}

export type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit" | "pipe" | "ignore" }
) => SpawnSyncReturns<Buffer>;

/**
 * Runs `bun build` to compile the implant binary.
 *
 * @param opts     build options
 * @param spawnFn  injectable spawn function (defaults to child_process.spawnSync)
 */
export function runBuildBeaconSimple(
  opts: BuildBeaconSimpleOptions,
  spawnFn: SpawnSyncFn = (cmd, args, o) => spawnSync(cmd, args, o)
): void {
  const target   = `bun-${opts.platform}`;
  const outfile  = opts.output;
  const source   = "implant/src/index.ts";

  // Resolve bun binary — prefer ~/.bun/bin/bun as spawnSync doesn't inherit PATH reliably
  const bunBin =
    process.env["BUN_PATH"] ??
    `${process.env["HOME"] ?? "/root"}/.bun/bin/bun`;

  const args = [
    "build",
    "--compile",
    `--target=${target}`,
    "--outfile",
    outfile,
    source,
  ];

  console.log(`  Building beacon…`);
  console.log(`  Target:  ${target}`);
  console.log(`  Outfile: ${outfile}`);

  const result = spawnFn(bunBin, args, { stdio: "inherit" });

  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`\n  Build failed (exit ${code}).\n`);
    process.exit(code);
  }

  console.log(`  Done: ${outfile}`);
}
