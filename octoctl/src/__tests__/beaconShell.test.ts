/**
 * Tests for `octoctl beacon shell` — pure helper functions
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import {
  extractOutput,
  isExitCommand,
  loadHistory,
  saveHistory,
  formatBulkOutput,
  buildHistoryPath,
} from "../commands/beaconShell.ts";

// ── extractOutput ─────────────────────────────────────────────────────────────

describe("extractOutput", () => {
  it("returns empty string for null", () => {
    expect(extractOutput(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    // TypeScript allows calling with undefined via cast
    expect(extractOutput(undefined as unknown as null)).toBe("");
  });

  it("returns the string itself when result is a plain string", () => {
    expect(extractOutput("hello world")).toBe("hello world");
    expect(extractOutput("")).toBe("");
    expect(extractOutput("multi\nline\noutput")).toBe("multi\nline\noutput");
  });

  it("returns result.output when result has an output field", () => {
    expect(extractOutput({ output: "uid=0(root)" })).toBe("uid=0(root)");
    expect(extractOutput({ output: "" })).toBe("");
  });

  it("returns empty string when result has no output field", () => {
    // An object without output resolves to empty (no output key present)
    expect(extractOutput({} as { output?: string; success?: boolean })).toBe("");
  });

  it("returns empty string for { success: false } with no output", () => {
    expect(extractOutput({ success: false })).toBe("");
  });

  it("returns output when result has both output and success fields", () => {
    expect(extractOutput({ output: "done", success: true })).toBe("done");
    expect(extractOutput({ output: "error text", success: false })).toBe("error text");
  });
});

// ── isExitCommand ─────────────────────────────────────────────────────────────

describe("isExitCommand", () => {
  it("returns true for 'exit'", () => {
    expect(isExitCommand("exit")).toBe(true);
  });

  it("returns true for 'quit'", () => {
    expect(isExitCommand("quit")).toBe(true);
  });

  it("returns true for '.exit'", () => {
    expect(isExitCommand(".exit")).toBe(true);
  });

  it("returns true for uppercase EXIT (case-insensitive)", () => {
    expect(isExitCommand("EXIT")).toBe(true);
    expect(isExitCommand("QUIT")).toBe(true);
    expect(isExitCommand(".EXIT")).toBe(true);
  });

  it("returns true for mixed-case variants", () => {
    expect(isExitCommand("Exit")).toBe(true);
    expect(isExitCommand("Quit")).toBe(true);
    expect(isExitCommand(".Exit")).toBe(true);
  });

  it("returns true for commands with surrounding whitespace", () => {
    expect(isExitCommand("  exit  ")).toBe(true);
    expect(isExitCommand("\tquit\t")).toBe(true);
  });

  it("returns false for normal shell commands", () => {
    expect(isExitCommand("id")).toBe(false);
    expect(isExitCommand("whoami")).toBe(false);
    expect(isExitCommand("ls -la")).toBe(false);
    expect(isExitCommand("cat /etc/passwd")).toBe(false);
  });

  it("returns false for partial exit strings", () => {
    expect(isExitCommand("exits")).toBe(false);
    expect(isExitCommand("ex")).toBe(false);
    expect(isExitCommand("quitter")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isExitCommand("")).toBe(false);
    expect(isExitCommand("   ")).toBe(false);
  });
});

// ── loadHistory ───────────────────────────────────────────────────────────────

describe("loadHistory", () => {
  it("returns empty array when file does not exist", async () => {
    const path = join(tmpdir(), `no-such-${Date.now()}.txt`);
    expect(await loadHistory(path)).toEqual([]);
  });

  it("returns lines from an existing history file", async () => {
    const path = join(tmpdir(), `hist-${Date.now()}.txt`);
    await writeFile(path, "ls\nwhoami\nid\n");
    const result = await loadHistory(path);
    expect(result).toEqual(["ls", "whoami", "id"]);
    await unlink(path).catch(() => {});
  });

  it("filters out blank lines", async () => {
    const path = join(tmpdir(), `hist-blank-${Date.now()}.txt`);
    await writeFile(path, "ls\n\n\nwhoami\n  \n");
    const result = await loadHistory(path);
    expect(result).toEqual(["ls", "whoami"]);
    await unlink(path).catch(() => {});
  });

  it("returns empty array for an empty file", async () => {
    const path = join(tmpdir(), `hist-empty-${Date.now()}.txt`);
    await writeFile(path, "");
    expect(await loadHistory(path)).toEqual([]);
    await unlink(path).catch(() => {});
  });
});

// ── saveHistory ───────────────────────────────────────────────────────────────

describe("saveHistory", () => {
  it("round-trips: saved lines are loadable", async () => {
    const path = join(tmpdir(), `hist-save-${Date.now()}.txt`);
    await saveHistory(["id", "whoami", "ls -la"], path);
    const loaded = await loadHistory(path);
    expect(loaded).toEqual(["id", "whoami", "ls -la"]);
    await unlink(path).catch(() => {});
  });

  it("keeps only the last 500 entries when given more", async () => {
    const path = join(tmpdir(), `hist-trunc-${Date.now()}.txt`);
    const lines = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
    await saveHistory(lines, path);
    const loaded = await loadHistory(path);
    expect(loaded.length).toBe(500);
    expect(loaded[0]).toBe("cmd-100");   // first of the tail-500
    expect(loaded[499]).toBe("cmd-599"); // last entry
    await unlink(path).catch(() => {});
  });

  it("saves exactly 500 entries without truncation", async () => {
    const path = join(tmpdir(), `hist-exact-${Date.now()}.txt`);
    const lines = Array.from({ length: 500 }, (_, i) => `cmd-${i}`);
    await saveHistory(lines, path);
    expect((await loadHistory(path)).length).toBe(500);
    await unlink(path).catch(() => {});
  });

  it("does not throw when file path is unwritable (best-effort)", async () => {
    // Saving to a non-existent directory is a write error — should not throw
    await expect(
      saveHistory(["cmd"], "/nonexistent-dir/history.txt")
    ).resolves.toBeUndefined();
  });
});

// ── formatBulkOutput ──────────────────────────────────────────────────────────

describe("formatBulkOutput", () => {
  it("prefixes each line with [hostname|shortId]", () => {
    const out = formatBulkOutput("abcdef1234567890", "target-host", "uid=0\nroot");
    expect(out).toBe("[target-host|abcdef12] uid=0\n[target-host|abcdef12] root");
  });

  it("returns (no output) for empty string", () => {
    const out = formatBulkOutput("abcdef1234567890", "host", "");
    expect(out).toBe("[host|abcdef12] (no output)");
  });

  it("returns (no output) for whitespace-only string", () => {
    const out = formatBulkOutput("abcdef1234567890", "host", "   ");
    expect(out).toBe("[host|abcdef12] (no output)");
  });

  it("truncates beacon ID to 8 chars in prefix", () => {
    const out = formatBulkOutput("0011223344556677", "h", "x");
    expect(out).toContain("[h|00112233]");
  });

  it("handles single-line output without adding extra newlines", () => {
    const out = formatBulkOutput("aabbccdd", "srv", "hello");
    expect(out).toBe("[srv|aabbccdd] hello");
    expect(out.split("\n").length).toBe(1);
  });
});

// ── buildHistoryPath ──────────────────────────────────────────────────────────

describe("buildHistoryPath", () => {
  it("returns a path ending in .svc_shell_history", () => {
    expect(buildHistoryPath()).toMatch(/\.svc_shell_history$/);
  });

  it("returns an absolute path under home directory", () => {
    const p = buildHistoryPath();
    expect(p.startsWith("/")).toBe(true);
  });
});
