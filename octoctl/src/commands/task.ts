/**
 * Queue a task through the authenticated controller API.
 *
 * The server's durable TaskService is the only task authority, including for
 * the Issues channel. It validates the shared contract, persists the task, and
 * lets the selected channel claim it under a delivery lease.
 */

import {
  SELECTABLE_CHANNEL_KINDS,
  assertTaskArgs,
  isTaskKind,
  type ChannelKind,
  type TaskArgs,
  type TaskKind as ProtocolTaskKind,
} from "@octoc2/shared";
import {
  controllerFetch,
  requireControllerServerUrl,
  requireOperatorApiToken,
} from "../lib/env.ts";
import { getBeacon } from "../lib/registry.ts";

export type TaskKind = ProtocolTaskKind;

export const VALID_TENTACLE_KINDS = new Set<ChannelKind>(
  SELECTABLE_CHANNEL_KINDS,
);

export type TentacleKind = ChannelKind;

export interface TaskOptions {
  kind: TaskKind;
  cmd?: string | undefined;
  seconds?: number | undefined;
  argsJson?: string | undefined;
  /** If set, only deliver via this channel. */
  tentacle?: string | undefined;
}

function buildTaskArgs(opts: TaskOptions): TaskArgs {
  if (opts.argsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.argsJson);
    } catch (error) {
      throw new Error(
        `--args-json must be valid JSON: ${(error as Error).message}`,
      );
    }
    return assertTaskArgs(opts.kind, parsed);
  }

  switch (opts.kind) {
    case "shell":
      if (!opts.cmd) throw new Error("--kind shell requires --cmd");
      return assertTaskArgs("shell", { cmd: opts.cmd });
    case "exec":
      if (!opts.cmd) {
        throw new Error("--kind exec requires --cmd or --args-json");
      }
      return assertTaskArgs("exec", { cmd: opts.cmd });
    case "sleep":
      if (opts.seconds === undefined) {
        throw new Error("--kind sleep requires --seconds");
      }
      return assertTaskArgs("sleep", { seconds: opts.seconds });
    case "ping":
      return assertTaskArgs("ping", {});
    case "kill":
      return assertTaskArgs("kill", {});
    case "evasion":
      throw new Error(
        "--kind evasion requires --args-json with an explicit action",
      );
  }
}

export async function runTask(
  beaconIdPrefix: string,
  opts: TaskOptions,
): Promise<void> {
  if (!isTaskKind(opts.kind)) {
    throw new Error(`Unsupported task kind '${String(opts.kind)}'`);
  }

  if (
    opts.tentacle !== undefined &&
    !VALID_TENTACLE_KINDS.has(opts.tentacle as TentacleKind)
  ) {
    throw new Error(
      `--tentacle '${opts.tentacle}' is invalid; valid channels: ` +
        [...VALID_TENTACLE_KINDS].join(", "),
    );
  }
  const preferredChannel = opts.tentacle as ChannelKind | undefined;

  const dataDir = process.env["OCTOC2_DATA_DIR"]?.trim() ?? "./data";
  const beacon = await getBeacon(beaconIdPrefix, dataDir);
  if (!beacon) {
    throw new Error(
      `Beacon '${beaconIdPrefix}' was not found in ${dataDir}/octoc2.sqlite`,
    );
  }

  const args = buildTaskArgs(opts);
  const serverUrl = requireControllerServerUrl();
  const operatorApiToken = requireOperatorApiToken();
  const response = await controllerFetch(
    `${serverUrl}/api/beacon/${encodeURIComponent(beacon.beaconId)}/task`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operatorApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: opts.kind,
        args,
        ...(preferredChannel !== undefined && { preferredChannel }),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Server returned ${response.status}: ${await response.text()}`,
    );
  }
  const queued = await response.json() as { taskId?: unknown };
  if (typeof queued.taskId !== "string" || queued.taskId.length === 0) {
    throw new Error("Server response did not include a taskId");
  }

  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  console.log("");
  console.log(`  ${green}✓${reset} Task queued via durable server API`);
  console.log(`  ${dim}Task ID:${reset}  ${queued.taskId}`);
  console.log(`  ${dim}Kind:${reset}     ${opts.kind}`);
  console.log(`  ${dim}Args:${reset}     ${JSON.stringify(args)}`);
  if (preferredChannel !== undefined) {
    console.log(`  ${dim}Channel:${reset}  ${preferredChannel}`);
  }
  console.log(`  ${dim}Beacon:${reset}   ${beacon.beaconId}`);
  console.log("");
  console.log(`  ${bold}Waiting for beacon to check in…${reset}`);
  console.log(
    `  Run: octoctl results ${beaconIdPrefix}  to see verified output`,
  );
  console.log("");
}
