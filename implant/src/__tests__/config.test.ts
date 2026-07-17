// implant/src/__tests__/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// parseProxyRepos is exported from index.ts for testing — see step 3.
import {
  assertEd25519KeyPair,
  assertX25519KeyPair,
  parseCleanupDays,
  parseProxyRepos,
  parseRecoveryPollIntervalMs,
  resolveGistToken,
  parseSleepJitter,
  parseSleepSeconds,
  parseTentaclePriority,
} from "../index.ts";
import { generateKeyPair } from "../crypto/sodium.ts";
import {
  ed25519KeyId,
  generateEd25519KeyPair,
} from "@octoc2/shared";

describe("provisioned identity validation", () => {
  it("accepts matching X25519 and Ed25519 pairs", async () => {
    const encryption = await generateKeyPair();
    await expect(
      assertX25519KeyPair(encryption, "test"),
    ).resolves.toBeUndefined();

    const signing = await generateEd25519KeyPair();
    await expect(assertEd25519KeyPair(
      signing,
      await ed25519KeyId(signing.publicKey),
      "test",
    )).resolves.toBeUndefined();
  });

  it("rejects mismatched key pairs and signing key IDs", async () => {
    const encryption = await generateKeyPair();
    const otherEncryption = await generateKeyPair();
    await expect(assertX25519KeyPair({
      publicKey: encryption.publicKey,
      secretKey: otherEncryption.secretKey,
    }, "test")).rejects.toThrow("do not match");

    const signing = await generateEd25519KeyPair();
    const otherSigning = await generateEd25519KeyPair();
    await expect(assertEd25519KeyPair({
      publicKey: signing.publicKey,
      secretKey: otherSigning.secretKey,
    }, await ed25519KeyId(signing.publicKey), "test"))
      .rejects.toThrow("do not match");
    await expect(assertEd25519KeyPair(
      signing,
      await ed25519KeyId(otherSigning.publicKey),
      "test",
    )).rejects.toThrow("key ID");
  });
});

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

  it("rejects every legacy static proxy declaration", () => {
    process.env["SVC_PROXY_REPOS"] = JSON.stringify([
      {
        owner: "coolcat",
        repo: "my-dotfiles",
        innerKind: "issues",
        token: "persistent-proxy-token",
      },
    ]);
    expect(() => parseProxyRepos()).toThrow(
      "must arrive in a signed recovery record",
    );
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

describe("resolveGistToken", () => {
  it("accepts a dedicated Gist credential", () => {
    expect(resolveGistToken("  gist-token  ", ["repo-token"]))
      .toBe("gist-token");
  });

  it("returns undefined when Gist is not configured", () => {
    expect(resolveGistToken("  ", ["repo-token"])).toBeUndefined();
  });

  it("rejects credential-role collisions", () => {
    expect(() => resolveGistToken("same-token", ["same-token"]))
      .toThrow("SVC_GIST_TOKEN must be distinct");
  });
});

describe("implant timing configuration", () => {
  it("uses conservative defaults", () => {
    expect(parseSleepSeconds(undefined)).toBe(60);
    expect(parseSleepJitter(undefined)).toBe(0.3);
    expect(parseRecoveryPollIntervalMs(undefined)).toBe(60_000);
  });

  it("accepts bounded explicit values", () => {
    expect(parseSleepSeconds("120")).toBe(120);
    expect(parseSleepJitter("0.5")).toBe(0.5);
    expect(parseRecoveryPollIntervalMs("30000")).toBe(30_000);
  });

  it("rejects malformed or unsafe sleep configuration", () => {
    expect(() => parseSleepSeconds("NaN")).toThrow("SVC_SLEEP");
    expect(() => parseSleepSeconds("0")).toThrow("SVC_SLEEP");
    expect(() => parseSleepSeconds("1.5")).toThrow("SVC_SLEEP");
    expect(() => parseSleepSeconds("86401")).toThrow("SVC_SLEEP");
    expect(() => parseSleepJitter("-0.1")).toThrow("SVC_JITTER");
    expect(() => parseSleepJitter("1.1")).toThrow("SVC_JITTER");
  });

  it("rejects recovery polling that is too fast, too slow, or malformed", () => {
    expect(() => parseRecoveryPollIntervalMs("9999")).toThrow(
      "SVC_RECOVERY_POLL_INTERVAL_MS",
    );
    expect(() => parseRecoveryPollIntervalMs("2700001")).toThrow(
      "SVC_RECOVERY_POLL_INTERVAL_MS",
    );
    expect(() => parseRecoveryPollIntervalMs("10000.5")).toThrow(
      "SVC_RECOVERY_POLL_INTERVAL_MS",
    );
  });
});


describe("parseTentaclePriority", () => {
  const orig = process.env["SVC_TENTACLE_PRIORITY"];
  const origGrpcDirect = process.env["SVC_GRPC_DIRECT"];
  const origCodespaceName = process.env["SVC_GRPC_CODESPACE_NAME"];
  const origGitHubUser = process.env["SVC_GITHUB_USER"];
  const origCodespacesToken =
    process.env["SVC_CODESPACES_GITHUB_TOKEN"];
  const origAutoProvision =
    process.env["SVC_AUTO_PROVISION_CODESPACE"];
  const origHttpUrl = process.env["SVC_HTTP_URL"];

  beforeEach(() => {
    delete process.env["SVC_TENTACLE_PRIORITY"];
    delete process.env["SVC_GRPC_DIRECT"];
    delete process.env["SVC_GRPC_CODESPACE_NAME"];
    delete process.env["SVC_GITHUB_USER"];
    delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];
    delete process.env["SVC_AUTO_PROVISION_CODESPACE"];
    delete process.env["SVC_HTTP_URL"];
  });

  afterEach(() => {
    if (orig === undefined) delete process.env["SVC_TENTACLE_PRIORITY"];
    else process.env["SVC_TENTACLE_PRIORITY"] = orig;

    if (origGrpcDirect === undefined) delete process.env["SVC_GRPC_DIRECT"];
    else process.env["SVC_GRPC_DIRECT"] = origGrpcDirect;

    if (origCodespaceName === undefined) {
      delete process.env["SVC_GRPC_CODESPACE_NAME"];
    } else {
      process.env["SVC_GRPC_CODESPACE_NAME"] = origCodespaceName;
    }
    if (origGitHubUser === undefined) {
      delete process.env["SVC_GITHUB_USER"];
    } else {
      process.env["SVC_GITHUB_USER"] = origGitHubUser;
    }
    if (origCodespacesToken === undefined) {
      delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];
    } else {
      process.env["SVC_CODESPACES_GITHUB_TOKEN"] = origCodespacesToken;
    }
    if (origAutoProvision === undefined) {
      delete process.env["SVC_AUTO_PROVISION_CODESPACE"];
    } else {
      process.env["SVC_AUTO_PROVISION_CODESPACE"] = origAutoProvision;
    }

    if (origHttpUrl === undefined) delete process.env["SVC_HTTP_URL"];
    else process.env["SVC_HTTP_URL"] = origHttpUrl;

  });

  it("auto-detects codespaces when SVC_GRPC_DIRECT is set", () => {
    delete process.env["SVC_TENTACLE_PRIORITY"];
    process.env["SVC_GRPC_DIRECT"] = "localhost:50051";
    expect(parseTentaclePriority()).toEqual(["codespaces", "issues"]);
  });

  it("requires a dedicated user credential for Codespaces SSH auto-detection", () => {
    delete process.env["SVC_TENTACLE_PRIORITY"];
    delete process.env["SVC_GRPC_DIRECT"];
    process.env["SVC_GRPC_CODESPACE_NAME"] = "example-codespace";
    process.env["SVC_GITHUB_USER"] = "example-user";
    delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];
    expect(parseTentaclePriority()).toEqual(["issues"]);

    process.env["SVC_CODESPACES_GITHUB_TOKEN"] = "user-token";
    expect(parseTentaclePriority()).toEqual(["codespaces", "issues"]);
  });

  it("auto-detects http when SVC_HTTP_URL is set", () => {
    delete process.env["SVC_TENTACLE_PRIORITY"];
    process.env["SVC_HTTP_URL"] = "http://localhost:8080";
    expect(parseTentaclePriority()).toEqual(["http", "issues"]);
  });

  it("falls back to issues when no env vars are set", () => {
    delete process.env["SVC_TENTACLE_PRIORITY"];
    delete process.env["SVC_GRPC_DIRECT"];
    delete process.env["SVC_GRPC_CODESPACE_NAME"];
    delete process.env["SVC_GITHUB_USER"];
    delete process.env["SVC_CODESPACES_GITHUB_TOKEN"];
    delete process.env["SVC_AUTO_PROVISION_CODESPACE"];
    delete process.env["SVC_HTTP_URL"];
    expect(parseTentaclePriority()).toEqual(["issues"]);
  });

  it("parses a valid comma-separated priority list", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "codespaces,notes,issues";
    expect(parseTentaclePriority()).toEqual(["codespaces", "notes", "issues"]);
  });

  it("accepts pages from the shared selectable channel catalog", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "pages,issues";
    expect(parseTentaclePriority()).toEqual(["pages", "issues"]);
  });

  it("fails closed for cataloged but unavailable legacy channels", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "pull_request";
    expect(parseTentaclePriority()).toEqual(["issues"]);
  });

  it("silently drops invalid entries and warns", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "codesapces,issues";
    const result = parseTentaclePriority();
    expect(result).toEqual(["issues"]);
  });

  it("returns issues when all entries are invalid", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "codesapces,proxyy,stegoo";
    expect(parseTentaclePriority()).toEqual(["issues"]);
  });

  it("trims whitespace around entries", () => {
    process.env["SVC_TENTACLE_PRIORITY"] = "  notes  ,  gist  , issues ";
    expect(parseTentaclePriority()).toEqual(["notes", "gist", "issues"]);
  });
});
