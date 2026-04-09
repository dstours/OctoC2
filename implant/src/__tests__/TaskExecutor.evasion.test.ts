/**
 * OctoC2 — TaskExecutor evasion task tests
 *
 * Verifies that the "evasion" task kind dispatches correctly for all
 * supported actions and returns success=true with valid JSON output.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TaskExecutor } from "../tasks/TaskExecutor.ts";
import type { Task, BeaconConfig } from "../types.ts";

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

function makeEvasionTask(action: string, extra: Record<string, unknown> = {}): Task {
  return {
    taskId: crypto.randomUUID(),
    kind:   "evasion",
    args:   { action, ...extra },
  };
}

describe("evasion task — status", () => {
  it("returns success=true and valid JSON output", async () => {
    const { result, directive } = await executor.execute(
      makeEvasionTask("status"),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(directive.kind).toBe("none");

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("status");
    expect(parsed["state"]).toBeDefined();
  });
});

describe("evasion task — hide", () => {
  it("returns success=true", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("hide"),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("hide");
  });
});

describe("evasion task — anti_debug", () => {
  it("returns success=true and output contains 'debugger'", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("anti_debug"),
      BEACON_ID
    );
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain("debugger");
  });
});

describe("evasion task — unknown action", () => {
  it("returns success=true and output mentions the unknown action", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("totally_unknown_action"),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(String(parsed["result"] ?? "")).toContain("unknown evasion action");
    expect(String(parsed["result"] ?? "")).toContain("totally_unknown_action");
  });
});

describe("evasion task — sleep", () => {
  it("returns success=true and completes", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("sleep", { baseMs: 50, jitter: 0 }),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("sleep");
  });
});

describe("evasion task — persist", () => {
  it("returns JSON payload with 'method' field", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("persist", { method: "gh-runner" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("persist");
    expect(typeof parsed["method"]).toBe("string");
    expect(typeof parsed["success"]).toBe("boolean");
    expect(typeof parsed["detail"]).toBe("string");
  });
});

describe("evasion task — propagate (missing token)", () => {
  it("returns error payload when token is absent", async () => {
    const { result } = await executor.execute(
      makeEvasionTask("propagate", { confirm: "propagate", owner: "x", repoName: "y" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("propagate");
    expect(typeof parsed["error"]).toBe("string");
    expect(String(parsed["error"])).toContain("token");
  });
});

describe("evasion task — propagate (missing confirm)", () => {
  it('requires confirm:"propagate" in args', async () => {
    const { result } = await executor.execute(
      makeEvasionTask("propagate", { token: "ghp_fake", owner: "x", repoName: "y" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("propagate");
    expect(typeof parsed["error"]).toBe("string");
    expect(String(parsed["error"])).toContain("explicit operator confirmation required");
  });
});

describe("evasion task — propagate (confirm guard passes)", () => {
  it('confirm:"propagate" allows execution (dry-run — no real network)', async () => {
    // With a non-empty token and confirm="propagate" the guard passes.
    // The propagate function will attempt network calls but fail gracefully
    // returning tokensFound: 0 / exfilRef: "dry-run" or "exfil-failed"
    const { result } = await executor.execute(
      makeEvasionTask("propagate", { confirm: "propagate", token: "ghp_fake_test_token_no_secrets", owner: "x", repoName: "y" }),
      BEACON_ID
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed["action"]).toBe("propagate");
    // Should not have the confirm-guard error
    expect(String(parsed["error"] ?? "")).not.toContain("explicit operator confirmation required");
    // Should have propagate result fields (tokensFound present or error from network)
    const hasResultFields = "tokensFound" in parsed || "error" in parsed;
    expect(hasResultFields).toBe(true);
  });
});

describe("logEvasionAction — in-memory audit log", () => {
  it("logs action to evasionState.evasionLog", async () => {
    const { logEvasionAction, getEvasionState } = await import("../evasion/OpenHulud.ts");
    logEvasionAction("test-action", "test-summary");
    const st = getEvasionState();
    const entry = st.evasionLog.find((e) => e.action === "test-action" && e.summary === "test-summary");
    expect(entry).toBeDefined();
    expect(typeof entry!.ts).toBe("string");
  });
});
