/**
 * Tests for `octoctl task` — --tentacle flag validation and serialization
 */
import { describe, it, expect } from "bun:test";
import { VALID_TENTACLE_KINDS } from "../commands/task.ts";

describe("VALID_TENTACLE_KINDS", () => {
  it("contains every selectable channel from the shared catalog", () => {
    const expected = [
      "issues", "branch", "actions", "proxy", "codespaces",
      "http", "relay", "gist", "oidc", "notes", "secrets",
      "pages", "stego",
    ];
    for (const kind of expected) {
      expect(VALID_TENTACLE_KINDS.has(kind as any)).toBe(true);
    }
    expect(VALID_TENTACLE_KINDS.size).toBe(13);
  });

  it("does not contain invalid kinds", () => {
    expect(VALID_TENTACLE_KINDS.has("invalid" as any)).toBe(false);
    expect(VALID_TENTACLE_KINDS.has("" as any)).toBe(false);
    expect(VALID_TENTACLE_KINDS.has("pull_request" as any)).toBe(false);
    expect(VALID_TENTACLE_KINDS.has("stego" as any)).toBe(true);
  });
});

describe("--tentacle flag serialization", () => {
  it("valid kind is recognized by VALID_TENTACLE_KINDS check", () => {
    for (const kind of ["issues", "branch", "actions", "proxy", "codespaces",
                        "http", "relay", "gist", "oidc", "notes", "secrets",
                        "pages", "stego"]) {
      expect(VALID_TENTACLE_KINDS.has(kind as any)).toBe(true);
    }
  });

  it("invalid kind fails the VALID_TENTACLE_KINDS check", () => {
    for (const kind of ["notakind", "Issues", "GIST", "deploy"]) {
      expect(VALID_TENTACLE_KINDS.has(kind as any)).toBe(false);
    }
  });
});
