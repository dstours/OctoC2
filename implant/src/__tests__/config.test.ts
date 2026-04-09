// implant/src/__tests__/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// parseProxyRepos is exported from index.ts for testing — see step 3.
import { parseProxyRepos, parseCleanupDays } from "../index.ts";
import type { ProxyConfig } from "../types.ts";

describe("parseProxyRepos", () => {
  const orig = process.env["SVC_PROXY_REPOS"];
  afterEach(() => {
    if (orig === undefined) delete process.env["SVC_PROXY_REPOS"];
    else process.env["SVC_PROXY_REPOS"] = orig;
  });

  it("returns [] when env var is absent", () => {
    delete process.env["SVC_PROXY_REPOS"];
    expect(parseProxyRepos()).toEqual([]);
  });

  it("returns [] for empty string", () => {
    process.env["SVC_PROXY_REPOS"] = "";
    expect(parseProxyRepos()).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    process.env["SVC_PROXY_REPOS"] = "not-json";
    expect(parseProxyRepos()).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    process.env["SVC_PROXY_REPOS"] = '{"owner":"x","repo":"y"}';
    expect(parseProxyRepos()).toEqual([]);
  });

  it("filters out entries missing owner or repo", () => {
    process.env["SVC_PROXY_REPOS"] = JSON.stringify([
      { owner: "a", repo: "b", innerKind: "issues" },
      { repo: "b", innerKind: "issues" },        // missing owner
      { owner: "c", innerKind: "notes" },         // missing repo
    ]);
    const result = parseProxyRepos();
    expect(result).toHaveLength(1);
    expect(result[0]!.owner).toBe("a");
  });

  it("parses a valid array of ProxyConfig objects", () => {
    const configs: ProxyConfig[] = [
      { owner: "coolcat", repo: "my-dotfiles", innerKind: "issues" },
      { owner: "devuser", repo: "config-snippets", innerKind: "notes", token: "tok123" },
    ];
    process.env["SVC_PROXY_REPOS"] = JSON.stringify(configs);
    const result = parseProxyRepos();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ owner: "coolcat", repo: "my-dotfiles", innerKind: "issues" });
    expect(result[1]!.token).toBe("tok123");
  });
});

describe("parseCleanupDays", () => {
  const orig = process.env["SVC_CLEANUP_DAYS"];
  afterEach(() => {
    if (orig === undefined) delete process.env["SVC_CLEANUP_DAYS"];
    else process.env["SVC_CLEANUP_DAYS"] = orig;
  });

  it("returns undefined when env var is absent", () => {
    delete process.env["SVC_CLEANUP_DAYS"];
    expect(parseCleanupDays()).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    process.env["SVC_CLEANUP_DAYS"] = "";
    expect(parseCleanupDays()).toBeUndefined();
  });

  it("returns undefined for non-numeric string", () => {
    process.env["SVC_CLEANUP_DAYS"] = "abc";
    expect(parseCleanupDays()).toBeUndefined();
  });

  it("returns undefined for negative value", () => {
    process.env["SVC_CLEANUP_DAYS"] = "-1";
    expect(parseCleanupDays()).toBeUndefined();
  });

  it("returns 0 for '0'", () => {
    process.env["SVC_CLEANUP_DAYS"] = "0";
    expect(parseCleanupDays()).toBe(0);
  });

  it("returns 3 for '3'", () => {
    process.env["SVC_CLEANUP_DAYS"] = "3";
    expect(parseCleanupDays()).toBe(3);
  });
});
