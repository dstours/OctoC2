import { describe, expect, it } from "bun:test";
import {
  TASK_KINDS,
  assertTaskArgs,
  computeTaskResultDigest,
  isTaskKind,
  parseResultAcceptanceReceipt,
  validateTaskArgs,
} from "../tasks.ts";

describe("task catalog", () => {
  it("contains only executor-backed public task kinds", () => {
    expect(TASK_KINDS).toEqual([
      "shell",
      "exec",
      "ping",
      "sleep",
      "kill",
      "evasion",
    ]);

    for (const unsupported of [
      "load-module",
      "upload",
      "download",
      "screenshot",
      "keylog",
      "keylog_start",
      "keylog_stop",
      "persist",
      "unpersist",
      "die",
      "pivot",
      "port_forward",
      "custom",
      "openhulud",
      "stego",
    ]) {
      expect(isTaskKind(unsupported)).toBe(false);
    }
  });
});

describe("task argument validation", () => {
  it("normalizes and validates shell arguments", () => {
    expect(
      assertTaskArgs("shell", {
        cmd: "  whoami  ",
        cwd: "  /tmp  ",
        timeout: 5_000,
      }),
    ).toEqual({ cmd: "whoami", cwd: "/tmp", timeout: 5_000 });
  });

  it("normalizes a single exec argument into argv", () => {
    expect(
      assertTaskArgs("exec", { cmd: "printf", args: "%s" }),
    ).toEqual({ cmd: "printf", args: ["%s"] });
  });

  it("rejects missing, unknown, and out-of-range arguments", () => {
    const shell = validateTaskArgs("shell", { timeout: 0, surprise: true });
    expect(shell.ok).toBe(false);
    if (!shell.ok) {
      expect(shell.issues.map((entry) => entry.code)).toContain("missing");
      expect(shell.issues.map((entry) => entry.code)).toContain("unknown-field");
      expect(shell.issues.map((entry) => entry.code)).toContain("out-of-range");
    }

    expect(validateTaskArgs("sleep", { seconds: 0 }).ok).toBe(false);
    expect(validateTaskArgs("ping", { anything: true }).ok).toBe(false);
  });

  it("requires explicit, recognized evasion actions", () => {
    expect(validateTaskArgs("evasion", {}).ok).toBe(false);
    expect(
      validateTaskArgs("evasion", { action: "not-real" }).ok,
    ).toBe(false);
    expect(
      validateTaskArgs("evasion", {
        action: "propagate",
        token: "token-value",
        owner: "owner",
        repoName: "repo",
      }).ok,
    ).toBe(false);
    expect(
      validateTaskArgs("evasion", {
        action: "propagate",
        confirm: "propagate",
        token: "token-value",
        owner: "owner",
        repoName: "repo",
      }).ok,
    ).toBe(true);
  });

  it("fails closed for an unsupported kind", () => {
    const result = validateTaskArgs("load-module", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe("invalid-kind");
    }
  });
});

describe("task-result acceptance receipts", () => {
  const result = {
    taskId: "task-1",
    beaconId: "beacon-1",
    success: true,
    output: "done",
    completedAt: "2026-07-16T12:00:00.000Z",
    signature: "signed-envelope",
  };

  it("binds the exact canonical signed result wire object", async () => {
    const digest = await computeTaskResultDigest(result);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeTaskResultDigest({
      signature: result.signature,
      completedAt: result.completedAt,
      output: result.output,
      success: result.success,
      beaconId: result.beaconId,
      taskId: result.taskId,
    })).toBe(digest);
    expect(await computeTaskResultDigest({
      ...result,
      signature: "different-signature",
    })).not.toBe(digest);
  });

  it("parses only the exact fresh-receipt wire shape", () => {
    const receipt = {
      kind: "result-acceptance" as const,
      beaconId: result.beaconId,
      taskId: result.taskId,
      resultDigest: "a".repeat(64),
      acceptedAt: "2026-07-16T12:00:01.000Z",
    };
    expect(parseResultAcceptanceReceipt(receipt)).toEqual(receipt);
    expect(() => parseResultAcceptanceReceipt({
      ...receipt,
      extra: true,
    })).toThrow("invalid shape");
    expect(() => parseResultAcceptanceReceipt({
      ...receipt,
      resultDigest: "A".repeat(64),
    })).toThrow("invalid resultDigest");
    expect(() => parseResultAcceptanceReceipt({
      ...receipt,
      acceptedAt: "2026-07-16T12:00:01Z",
    })).toThrow("invalid acceptedAt");
  });
});
