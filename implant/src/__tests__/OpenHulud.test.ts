/**
 * OctoC2 — OpenHulud evasion module unit tests
 *
 * Verifies that all primitives resolve without throwing and return the correct
 * types. Platform-specific behaviour (e.g. /proc writes) is not asserted so
 * tests pass on any OS.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEvasionState,
  hideProcess,
  antiDebug,
  jitteredSleep,
  isStandaloneExecutableEntry,
  selfDelete,
  installPersistence,
  propagate,
} from "../evasion/OpenHulud.ts";

describe("getEvasionState", () => {
  it("returns the correct initial shape", () => {
    const s = getEvasionState();
    expect(typeof s.hidden).toBe("boolean");
    expect(typeof s.debugDetected).toBe("boolean");
    expect(typeof s.selfDeleted).toBe("boolean");
  });
});

describe("jitteredSleep", () => {
  it("resolves within ~150ms for 100ms base, 0 jitter", async () => {
    const start = Date.now();
    await jitteredSleep(100, 0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("antiDebug", () => {
  it("returns a boolean without throwing", async () => {
    const result = await antiDebug();
    expect(typeof result).toBe("boolean");
  });
});

describe("hideProcess", () => {
  it("returns a non-empty string without throwing", async () => {
    const result = await hideProcess();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("selfDelete", () => {
  it("returns a structured outcome without throwing", async () => {
    const result = await selfDelete();
    expect(typeof result.success).toBe("boolean");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("never deletes argv[1] while running under an interpreter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octoc2-self-delete-"));
    const sourcePath = join(dir, "beacon-source.ts");
    await writeFile(sourcePath, "export {};\n");
    const origArgv1 = process.argv[1];
    try {
      process.argv[1] = sourcePath;
      const result = await selfDelete();
      expect(result).toMatchObject({ success: false });
      expect(result.detail).toContain("skipped");
      expect(await Bun.file(sourcePath).exists()).toBe(true);
    } finally {
      process.argv[1] = origArgv1 as string;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses entry/executable identity rather than interpreter basenames", () => {
    expect(
      isStandaloneExecutableEntry(
        "C:\\tools\\svc-host.exe",
        "C:\\work\\entry.ts",
        "win32",
      ),
    ).toBe(false);
    expect(
      isStandaloneExecutableEntry(
        "C:\\tools\\bun.exe",
        "c:\\TOOLS\\BUN.EXE",
        "win32",
      ),
    ).toBe(true);
  });
});

describe("propagate", () => {
  it("returns dry-run result when token is empty", async () => {
    const result = await propagate("", "owner", "repo");
    expect(result.exfilRef).toBe("dry-run");
    expect(result.tokensFound).toBe(0);
  });

  it("returns a PropagateResult shape", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const result = await propagate("ghp_fake", "testowner", "testrepo");
    (globalThis as any).fetch = origFetch;
    expect(typeof result.tokensFound).toBe("number");
    expect(typeof result.exfilRef).toBe("string");
    expect(Array.isArray(result.techniques)).toBe(true);
  });
});

describe("installPersistence", () => {
  it("gh-runner returns PersistenceResult", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 403 });
    const result = await installPersistence("gh-runner");
    (globalThis as any).fetch = origFetch;
    expect(typeof result.method).toBe("string");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.detail).toBe("string");
  });

  it("gh-runner-register is an alias for gh-runner", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 403 });
    const result = await installPersistence("gh-runner-register");
    (globalThis as any).fetch = origFetch;
    expect(result.method).toBe("gh-runner");
    expect(typeof result.success).toBe("boolean");
  });
});
