import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const DIM    = "\x1b[2m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";

export interface PidFile {
  server?: number;
  dashboard?: number;
}

const DEFAULT_PID_DIR = join(homedir(), ".config", "octoc2");
const DEFAULT_PID_PATH = join(DEFAULT_PID_DIR, "pids.json");

export function pidFilePath(): string {
  return DEFAULT_PID_PATH;
}

export function loadPids(path?: string): PidFile {
  const p = path ?? DEFAULT_PID_PATH;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PidFile;
  } catch {
    return {};
  }
}

export function savePids(path: string, pids: PidFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(pids, null, 2) + "\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function loadEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

async function probeHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export interface StartOptions {
  component?: "server" | "dashboard";
  env?: string;
}

/**
 * Find the OctoC2 project root by walking up from cwd looking for
 * a directory that contains both server/ and implant/.
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "server", "src", "index.ts")) && existsSync(join(dir, "implant"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd is root
  return process.cwd();
}

export async function runStart(opts: StartOptions): Promise<void> {
  const projectRoot = findProjectRoot();
  const envPath = resolve(opts.env ?? join(projectRoot, ".env"));
  const envVars = loadEnvFile(envPath);
  const mergedEnv = { ...process.env, ...envVars };

  const bunBin = Bun.which("bun") ?? `${homedir()}/.bun/bin/bun`;
  const pidPath = pidFilePath();
  const pids = loadPids(pidPath);

  const startServer = !opts.component || opts.component === "server";
  const startDashboard = !opts.component || opts.component === "dashboard";

  if (startServer) {
    if (pids.server && isAlive(pids.server)) {
      console.log(`  ${YELLOW}Server already running${RESET} (PID ${pids.server})`);
    } else {
      const serverEntry = join(projectRoot, "server", "src", "index.ts");
      if (!existsSync(serverEntry)) {
        console.error(`  ${RED}Server entry not found:${RESET} ${serverEntry}`);
        process.exit(1);
      }

      const httpPort = mergedEnv["OCTOC2_HTTP_PORT"] ?? "8080";
      const logFile = join(projectRoot, "server.log");

      const proc = Bun.spawn([bunBin, "run", serverEntry], {
        env: mergedEnv,
        cwd: join(projectRoot, "server"),
        stdout: Bun.file(logFile),
        stderr: Bun.file(logFile),
      });

      proc.unref();
      pids.server = proc.pid;
      savePids(pidPath, pids);

      await new Promise(r => setTimeout(r, 1500));
      const healthy = await probeHealth(parseInt(httpPort, 10));

      if (healthy) {
        console.log(`  ${GREEN}Server started${RESET} on :${httpPort} (PID ${proc.pid})`);
      } else {
        console.log(`  ${YELLOW}Server spawned${RESET} (PID ${proc.pid}) — waiting for health…`);
        await new Promise(r => setTimeout(r, 2000));
        const retry = await probeHealth(parseInt(httpPort, 10));
        if (retry) {
          console.log(`  ${GREEN}Server healthy${RESET} on :${httpPort}`);
        } else {
          console.log(`  ${YELLOW}Server may still be starting${RESET} — check ${logFile}`);
        }
      }
    }
  }

  if (startDashboard) {
    if (pids.dashboard && isAlive(pids.dashboard)) {
      console.log(`  ${YELLOW}Dashboard already running${RESET} (PID ${pids.dashboard})`);
    } else {
      const dashboardDir = join(projectRoot, "dashboard");
      if (!existsSync(join(dashboardDir, "package.json"))) {
        console.error(`  ${RED}Dashboard not found:${RESET} ${dashboardDir}`);
        process.exit(1);
      }

      const logFile = join(projectRoot, "dashboard.log");

      const proc = Bun.spawn([bunBin, "run", "dev"], {
        env: mergedEnv,
        cwd: dashboardDir,
        stdout: Bun.file(logFile),
        stderr: Bun.file(logFile),
      });

      proc.unref();
      pids.dashboard = proc.pid;
      savePids(pidPath, pids);

      console.log(`  ${GREEN}Dashboard started${RESET} on :3000 (PID ${proc.pid})`);
    }
  }

  console.log(`\n  ${DIM}Logs: server.log, dashboard.log${RESET}`);
  console.log(`  ${DIM}Stop: octoctl stop${RESET}\n`);
}

export interface StopOptions {
  component?: "server" | "dashboard";
}

export async function runStop(opts: StopOptions): Promise<void> {
  const pidPath = pidFilePath();
  const pids = loadPids(pidPath);

  const stopServer = !opts.component || opts.component === "server";
  const stopDashboard = !opts.component || opts.component === "dashboard";

  if (stopServer && pids.server) {
    if (isAlive(pids.server)) {
      process.kill(pids.server, "SIGTERM");
      console.log(`  ${GREEN}Server stopped${RESET} (PID ${pids.server})`);
    } else {
      console.log(`  ${DIM}Server not running${RESET} (stale PID ${pids.server})`);
    }
    pids.server = undefined;
  }

  if (stopDashboard && pids.dashboard) {
    if (isAlive(pids.dashboard)) {
      process.kill(pids.dashboard, "SIGTERM");
      console.log(`  ${GREEN}Dashboard stopped${RESET} (PID ${pids.dashboard})`);
    } else {
      console.log(`  ${DIM}Dashboard not running${RESET} (stale PID ${pids.dashboard})`);
    }
    pids.dashboard = undefined;
  }

  savePids(pidPath, pids);

  if (!pids.server && !pids.dashboard) {
    try { unlinkSync(pidPath); } catch {}
  }
}

export async function runStatus(): Promise<void> {
  const pids = loadPids();
  const httpPort = parseInt(process.env["OCTOC2_HTTP_PORT"] ?? "8080", 10);

  console.log("");

  if (pids.server && isAlive(pids.server)) {
    const healthy = await probeHealth(httpPort);
    const badge = healthy ? `${GREEN}healthy${RESET}` : `${YELLOW}unhealthy${RESET}`;
    console.log(`  Server     ${GREEN}running${RESET}  PID ${pids.server}  ${badge}`);
  } else {
    console.log(`  Server     ${DIM}stopped${RESET}`);
  }

  if (pids.dashboard && isAlive(pids.dashboard)) {
    console.log(`  Dashboard  ${GREEN}running${RESET}  PID ${pids.dashboard}  http://localhost:3000`);
  } else {
    console.log(`  Dashboard  ${DIM}stopped${RESET}`);
  }

  console.log("");
}
