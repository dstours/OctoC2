import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import {
  GITHUB_TOKEN_LEASE_VERSION,
  type GitHubTokenLease,
} from "@octoc2/shared";
import {
  AppTokenManager,
  ExplicitFineGrainedTokenProvider,
  InstallationTokenLeaseProvider,
  buildTokenGetter,
  clearTokenManagerCache,
  getSharedTokenGetter,
} from "../lib/AppTokenManager.ts";

function lease(
  overrides: Partial<GitHubTokenLease> = {},
): GitHubTokenLease {
  return {
    version: GITHUB_TOKEN_LEASE_VERSION,
    leaseId: "lease-1",
    beaconId: "beacon-1",
    installationId: 123,
    token: "ghs_short_lived",
    repository: {
      owner: "owner",
      repo: "repo",
    },
    permissions: {
      metadata: "read",
      issues: "write",
    },
    issuedAt: "2026-07-16T12:00:00.000Z",
    renewAfter: "2026-07-16T12:30:00.000Z",
    expiresAt: "2026-07-16T13:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  clearTokenManagerCache();
});

describe("retired beacon-side AppTokenManager", () => {
  it("fails closed instead of accepting a GitHub App private key", () => {
    expect(() => new AppTokenManager({
      appId: 1,
      installationId: 2,
      appPrivateKey: "private-key-material",
    })).toThrow("server-side installation token lease");
  });
});

describe("GitHub token providers", () => {
  it("returns an explicit fine-grained token and fails after invalidation", async () => {
    const provider = new ExplicitFineGrainedTokenProvider("github-user-token");
    expect(await provider.getToken()).toBe("github-user-token");
    provider.invalidate("revoked");
    await expect(provider.getToken()).rejects.toThrow("revoked");
  });

  it("binds installation leases to the beacon and repository", () => {
    expect(() => new InstallationTokenLeaseProvider(
      "other-beacon",
      { owner: "owner", name: "repo" },
      lease(),
    )).toThrow("different beacon");
    expect(() => new InstallationTokenLeaseProvider(
      "beacon-1",
      { owner: "owner", name: "other-repo" },
      lease(),
    )).toThrow("different repository");
  });

  it("rejects expired leases and channels that do not support App auth", async () => {
    const provider = new InstallationTokenLeaseProvider(
      "beacon-1",
      { owner: "owner", name: "repo" },
      lease(),
      undefined,
      () => new Date("2026-07-16T13:00:00.000Z"),
    );
    await expect(provider.getToken()).rejects.toThrow("expired");

    const current = new InstallationTokenLeaseProvider(
      "beacon-1",
      { owner: "owner", name: "repo" },
      lease(),
      undefined,
      () => new Date("2026-07-16T12:15:00.000Z"),
    );
    await expect(
      current.getToken({ channel: "codespaces" }),
    ).rejects.toThrow("does not support GitHub App");
    await expect(
      current.getToken({ channel: "gist" }),
    ).rejects.toThrow("does not support GitHub App");
  });

  it("renews once and applies the newer bound lease", async () => {
    const renew = mock(async () => lease({
      leaseId: "lease-2",
      token: "ghs_renewed",
      issuedAt: "2026-07-16T12:31:00.000Z",
      renewAfter: "2026-07-16T13:00:00.000Z",
      expiresAt: "2026-07-16T13:30:00.000Z",
    }));
    const provider = new InstallationTokenLeaseProvider(
      "beacon-1",
      { owner: "owner", name: "repo" },
      lease(),
      renew,
      () => new Date("2026-07-16T12:31:00.000Z"),
    );

    expect(await provider.getToken({ channel: "issues" })).toBe(
      "ghs_renewed",
    );
    expect(await provider.getToken({ channel: "issues" })).toBe(
      "ghs_renewed",
    );
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("shares one provider for equivalent config objects", async () => {
    const first = getSharedTokenGetter({
      id: "beacon-1",
      repo: { owner: "Owner", name: "Repo" },
      token: "github-user-token",
    });
    const second = getSharedTokenGetter({
      id: "beacon-1",
      repo: { owner: "owner", name: "repo" },
      token: "ignored-second-token",
    });
    expect(await first()).toBe("github-user-token");
    expect(await second()).toBe("github-user-token");
  });

  it("keeps the compatibility getter on the fail-closed provider path", async () => {
    const getter = buildTokenGetter({
      id: "beacon-1",
      repo: { owner: "owner", name: "repo" },
      githubTokenLease: lease({
        issuedAt: "2000-01-01T00:00:00.000Z",
        renewAfter: "2000-01-01T00:30:00.000Z",
        expiresAt: "2000-01-01T01:00:00.000Z",
      }),
    });
    await expect(getter()).rejects.toThrow("expired");
  });
});
