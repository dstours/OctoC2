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
      makeTask("shell", { cmd: "echo err >&2; echo out" }),
      BEACON_ID
    );
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.output).toContain("[stderr]");
  });

  it("reports non-zero exit codes", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: "exit 42" }),
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
      makeTask("shell", { cmd: "true" }),
      BEACON_ID
    );
    expect(result.completedAt >= before).toBe(true);
    expect(result.beaconId).toBe(BEACON_ID);
  });

  it("captures multiline output", async () => {
    const { result } = await executor.execute(
      makeTask("shell", { cmd: "printf 'line1\\nline2\\nline3\\n'" }),
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
      makeTask("shell", { cmd: "while :; do :; done", timeout: 200 }),
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
      makeTask("exec", { cmd: "/usr/bin/env", args: ["echo", "exec-hello"] }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("exec-hello");
    expect(directive.kind).toBe("none");
  });

  it("accepts args as a single string when only one arg", async () => {
    const { result } = await executor.execute(
      makeTask("exec", { cmd: "uname", args: "-a" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("[exit: 0]");
  });

  it("reports non-zero exit codes", async () => {
    const { result } = await executor.execute(
      makeTask("exec", { cmd: "/usr/bin/false" }),
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
      makeTask("exec", { cmd: "true" }),
      BEACON_ID
    );
    expect(result.output).toMatch(/\[\d+ms\]/);
  });

  it("times out and kills the process", async () => {
    const { result } = await executor.execute(
      makeTask("exec", { cmd: "/bin/sh", args: ["-c", "while :; do :; done"], timeout: 200 }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
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

describe("unimplemented task kinds", () => {
  const stubs: Task["kind"][] = [
    "upload", "download", "screenshot",
    "keylog_start", "keylog_stop",
  ];

  for (const kind of stubs) {
    it(`returns failure for ${kind}`, async () => {
      const { result } = await executor.execute(makeTask(kind), BEACON_ID);
      expect(result.success).toBe(false);
      expect(result.output).toContain("not yet implemented");
    });
  }
});

// ── load-module tasks ─────────────────────────────────────────────────────────

describe("load-module tasks", () => {
  it("returns failure when neither serverUrl nor payload is provided", async () => {
    const { result } = await executor.execute(
      makeTask("load-module", { name: "recon" }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("serverUrl");
  });

  it("returns failure when name is missing", async () => {
    const { result } = await executor.execute(
      makeTask("load-module", { serverUrl: "http://localhost:8080" }),
      BEACON_ID
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("name");
  });
});
