/**
 * GitHub Codespaces tunnel backed by the supported GitHub CLI connection
 * service. Codespaces are not ordinary SSH hosts: a PAT is used by `gh` for
 * the Codespaces control plane and is never treated as an SSH password.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";

const MAX_OUTPUT_BYTES = 64 * 1024;
const FORWARD_START_TIMEOUT_MS = 330_000;
const CODESPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function assertCodespaceName(name: string): void {
  if (!CODESPACE_NAME.test(name)) {
    throw new Error("Codespace name contains unsupported characters");
  }
}

export function codespaceForwardArgs(
  name: string,
  localPort: number,
  remotePort: number,
): string[] {
  assertCodespaceName(name);
  assertPort(localPort, "localPort");
  assertPort(remotePort, "remotePort");
  return [
    "codespace",
    "ports",
    "forward",
    `${remotePort}:${localPort}`,
    "--codespace",
    name,
  ];
}

function assertPort(port: number, label: string): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
}

export class SshTunnel {
  private codespaceName: string | null = null;
  private token: string | null = null;
  private forwarder: ChildProcessWithoutNullStreams | null = null;
  private alive = false;

  constructor(
    private readonly ghExecutable =
      process.env["SVC_GITHUB_CLI"]?.trim() || "gh",
  ) {}

  async connect(codespaceName: string, token: string): Promise<void> {
    assertCodespaceName(codespaceName);
    if (!token.trim()) {
      throw new Error("A dedicated Codespaces GitHub token is required");
    }
    if (token.trim().startsWith("github_pat_")) {
      throw new Error(
        "GitHub CLI Codespaces tunnels require a classic PAT with the codespace scope",
      );
    }
    this.codespaceName = codespaceName;
    this.token = token.trim();
    const state = (await this.runGh([
      "codespace",
      "view",
      "--codespace",
      codespaceName,
      "--json",
      "state",
      "--jq",
      ".state",
    ])).trim();
    if (state !== "Available") {
      throw new Error(`Codespace is not available (state: ${state || "unknown"})`);
    }
    this.alive = true;
  }

  async forward(localPort: number, remotePort: number): Promise<void> {
    const name = this.requireConnected();
    if (this.forwarder) {
      throw new Error("Codespaces port forwarding is already active");
    }
    const child = spawn(
      this.ghExecutable,
      codespaceForwardArgs(name, localPort, remotePort),
      {
        env: this.ghEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    this.forwarder = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.once("exit", () => {
      this.alive = false;
    });
    child.once("error", () => {
      this.alive = false;
    });

    const deadline = Date.now() + FORWARD_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.forwarder = null;
        throw new Error(
          `GitHub Codespaces port forwarding exited early: ${stderr.trim() || `exit ${child.exitCode}`}`,
        );
      }
      if (await canConnect(localPort)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.stopForwarder();
    throw new Error(
      `Timed out waiting for the local Codespaces port forward${
        stderr.trim() ? `: ${stderr.trim()}` : ""
      }`,
    );
  }

  isAlive(): boolean {
    return this.alive && this.forwarder?.exitCode === null;
  }

  async close(): Promise<void> {
    this.alive = false;
    await this.stopForwarder();
    this.codespaceName = null;
    this.token = null;
  }

  private requireConnected(): string {
    if (!this.codespaceName || !this.token || !this.alive) {
      throw new Error("Codespaces tunnel is not connected");
    }
    return this.codespaceName;
  }

  private ghEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GH_TOKEN: this.token!,
      GH_PROMPT_DISABLED: "1",
    };
  }

  private runGh(args: string[]): Promise<string> {
    return runProcess(this.ghExecutable, args, this.ghEnvironment());
  }

  private async stopForwarder(): Promise<void> {
    const child = this.forwarder;
    this.forwarder = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "localhost", port });
    const done = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function runProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) =>
      current.length >= MAX_OUTPUT_BYTES
        ? current
        : (current + chunk.toString()).slice(0, MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Process timed out: ${executable}`)));
    }, timeoutMs);
    child.once("error", (error) => {
      finish(() => reject(new Error(`Unable to start ${executable}: ${error.message}`)));
    });
    child.once("exit", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`));
      });
    });
  });
}
