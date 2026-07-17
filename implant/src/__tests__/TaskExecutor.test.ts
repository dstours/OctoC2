/**
 * OctoC2 — TaskExecutor unit tests
 *
 * Tests shell/exec/ping execution, timeout handling, directive generation,
 * and error paths. All subprocess tests use real Bun.spawn (no mocking).
 */

import { describe, it, expect } from "bun:test";
import { TaskExecutor } from "../tasks/TaskExecutor.ts";
import type { Task } from "../types.ts";
import type { BeaconConfig } from "../types.ts";

const MOCK_CONFIG: BeaconConfig = {
  id: "test-beacon",
  repo: { owner: "owner", name: "repo" },
  token: "test-token",
  tentaclePriority: ["issues"],
  sleepSeconds: 30,
  jitter: 0.1,
  operatorPublicKey: new Uint8Array(32),
  beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
};
const executor  = new TaskExecutor(MOCK_CONFIG);
const BEACON_ID = "test-beacon-id";
const SHELL_MULTILINE =
  process.platform === "win32"
    ? "echo line1 & echo line2 & echo line3"
    : "printf 'line1\\nline2\\nline3\\n'";
const SHELL_TIMEOUT =
  process.platform === "win32"
    ? "ping -n 30 127.0.0.1 >nul"
    : "while :; do :; done";
const SHELL_STDERR =
  process.platform === "win32"
    ? "echo err 1>&2 & echo out"
    : "echo err >&2; echo out";
const SHELL_NONZERO = process.platform === "win32" ? "exit /b 42" : "exit 42";
const SHELL_SUCCESS = process.platform === "win32" ? "ver >nul" : "true";

function makeTask(kind: Task["kind"], args: Record<string, unknown> = {}): Task {
  return { taskId: crypto.randomUUID(), kind, args };
}

// ── shell ──────────────────────────────────────────────────────────────────────

describe("shell tasks", () => {
  it("executes a simple command and captures stdout", async () => {
    const { result, directive } = await executor.execute(
      makeTask("shell", { cmd: "echo hello" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(directive.kind).toBe("none");
  });

  it("captures stderr separately", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: SHELL_STDERR }),
      BEACON_ID
    );
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.output).toContain("[stderr]");
  });

  it("reports non-zero exit codes", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: SHELL_NONZERO }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("[exit: 42]");
  });

  it("includes duration in output", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: "echo timing" }),
      BEACON_ID
    );
    expect(result.output).toMatch(/\[\d+ms\]/);
  });

  it("sets completedAt on result", async () => {
    const before = new Date().toISOString();
    const { result } = await executor.execute(
      makeTask("shell", { cmd: SHELL_SUCCESS }),
      BEACON_ID
    );
    expect(result.completedAt >= before).toBe(true);
    expect(result.beaconId).toBe(BEACON_ID);
  });

  it("captures multiline output", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: SHELL_MULTILINE }),
      BEACON_ID
    );
    expect(result.output).toContain("line1");
    expect(result.output).toContain("line2");
    expect(result.output).toContain("line3");
  });

  it("fails cleanly when cmd is missing", async () => {
    const { result } = await executor.execute(
      makeTask("shell", {}),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("cmd");
  });

  it("times out and kills the process", async () => {
    // Use a shell builtin loop so there's no child process to hold the pipe
    // open after SIGKILL (unlike `sleep 10` which forks a subprocess).
    const { result } = await executor.execute(
      makeTask("shell", { cmd: SHELL_TIMEOUT, timeout: 200 }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
  });

  it("returns taskId and beaconId in result", async () => {
    const task = makeTask("shell", { cmd: "echo check" });
    const { result } = await executor.execute(task, BEACON_ID);
    expect(result.taskId).toBe(task.taskId);
    expect(result.beaconId).toBe(BEACON_ID);
  });

  it("sets shellInvoked metadata on shell tasks", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: "echo meta" }),
      BEACON_ID
    );
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.shellInvoked).toBe(true);
  });
});

// ── sleep directive ───────────────────────────────────────────────────────────

describe("sleep task", () => {
  it("returns update_sleep directive with correct values", async () => {
    const { result, directive } = await executor.execute(
      makeTask("sleep", { seconds: 120, jitter: 0.5 }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(directive.kind).toBe("update_sleep");
    if (directive.kind === "update_sleep") {
      expect(directive.seconds).toBe(120);
      expect(directive.jitter).toBe(0.5);
    }
  });

  it("defaults to 60s jitter 0.3 when args omitted", async () => {
    const { directive } = await executor.execute(
      makeTask("sleep", {}),
      BEACON_ID
    );
    expect(directive.kind).toBe("update_sleep");
    if (directive.kind === "update_sleep") {
      expect(directive.seconds).toBe(60);
      expect(directive.jitter).toBe(0.3);
    }
  });
});

// ── kill directive ────────────────────────────────────────────────────────────

describe("kill task", () => {
  it("returns kill directive", async () => {
    const { result, directive } = await executor.execute(
      makeTask("kill"),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(directive.kind).toBe("kill");
  });
});

// ── exec ──────────────────────────────────────────────────────────────────────

describe("exec tasks", () => {
  it("runs a binary directly without a shell wrapper", async () => {
    const { result, directive } = await executor.execute(
      makeTask("exec", {
        cmd: process.execPath,
        args: ["-e", "console.log('exec-hello')"],
      }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("exec-hello");
    expect(directive.kind).toBe("none");
  });

  it("accepts args as a single string when only one arg", async () => {
    const { result } = await executor.execute(
      makeTask("exec", { cmd: process.execPath, args: "--version" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("[exit: 0]");
  });

  it("reports non-zero exit codes", async () => {
    const { result } = await executor.execute(
      makeTask("exec", {
        cmd: process.execPath,
        args: ["-e", "process.exit(7)"],
      }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/\[exit: [^0]\d*\]/);
  });

  it("fails cleanly when cmd is missing", async () => {
    const { result } = await executor.execute(makeTask("exec", {}), BEACON_ID);
    expect(result.success).toBe(false);
    expect(result.output).toContain("cmd");
  });

  it("includes duration in output", async () => {
    const { result } = await executor.execute(
      makeTask("exec", {
        cmd: process.execPath,
        args: ["-e", "process.exit(0)"],
      }),
      BEACON_ID
    );
    expect(result.output).toMatch(/\[\d+ms\]/);
  });

  it("times out and kills the process", async () => {
    const { result } = await executor.execute(
      makeTask("exec", {
        cmd: process.execPath,
        args: ["-e", "while (true) {}"],
        timeout: 200,
      }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
  });

  it("does not set shellInvoked metadata on exec tasks", async () => {
    const { result } = await executor.execute(
      makeTask("exec", {
        cmd: process.execPath,
        args: ["-e", "console.log('no-shell')"],
      }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.shellInvoked).toBeUndefined();
  });
});

// ── ping ──────────────────────────────────────────────────────────────────────

describe("ping task", () => {
  it("returns success with timestamp and metadata", async () => {
    const { result, directive } = await executor.execute(
      makeTask("ping"),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(directive.kind).toBe("none");

    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(typeof payload["timestamp"]).toBe("string");
    expect(payload["beaconId"]).toBe(BEACON_ID);
    expect(typeof payload["pid"]).toBe("number");
    expect(typeof payload["platform"]).toBe("string");
  });

  it("includes beaconId from the call", async () => {
    const custom = "my-custom-beacon";
    const { result } = await executor.execute(makeTask("ping"), custom);
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    expect(payload["beaconId"]).toBe(custom);
  });
});

// ── not-implemented stubs ─────────────────────────────────────────────────────


// ── load-module tasks ─────────────────────────────────────────────────────────
