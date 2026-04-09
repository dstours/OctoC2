import { describe, test, expect } from "bun:test";
import { maskToken } from "../commands/setup/prompts.ts";
import { parsePATScopes, validateRepoConfig } from "../commands/setup/validate.ts";

describe("maskToken", () => {
  test("masks middle of a PAT, showing prefix and last 4", () => {
    expect(maskToken("github_pat_11ABCDEF1234567890abcdef"))
      .toBe("github_pat_11ABC…cdef");
  });

  test("returns full string if shorter than 8 chars", () => {
    expect(maskToken("short")).toBe("short");
  });
});

describe("parsePATScopes", () => {
  test("extracts scopes from x-oauth-scopes header", () => {
    expect(parsePATScopes("repo, gist, read:org")).toEqual(["repo", "gist", "read:org"]);
  });

  test("returns empty array for missing header", () => {
    expect(parsePATScopes("")).toEqual([]);
    expect(parsePATScopes(undefined)).toEqual([]);
  });
});

describe("validateRepoConfig", () => {
  test("returns errors for missing fields", () => {
    const result = validateRepoConfig({ owner: "", repo: "", token: "" });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Token is required");
    expect(result).toContain("Repo owner is required");
    expect(result).toContain("Repo name is required");
  });

  test("returns empty array for valid fields", () => {
    const result = validateRepoConfig({ owner: "org", repo: "c2", token: "ghp_abc" });
    expect(result).toEqual([]);
  });
});
