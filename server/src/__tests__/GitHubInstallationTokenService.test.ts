import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubInstallationTokenService,
  parseGitHubInstallationPolicies,
} from "../services/GitHubInstallationTokenService.ts";

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

const NOW = new Date("2026-07-16T12:00:00.000Z");

describe("GitHubInstallationTokenService", () => {
  it("rejects multiple proxy repositories for one beacon policy", () => {
    const proxy = {
      installationId: 55,
      repository: { owner: "decoy", repo: "one" },
      permissions: {
        metadata: "read",
        issues: "write",
        variables: "read",
      },
    };
    expect(() => parseGitHubInstallationPolicies(JSON.stringify({
      beacon: {
        installationId: 44,
        repository: { owner: "octo", repo: "primary" },
        permissions: {
          metadata: "read",
          issues: "write",
          variables: "read",
        },
        proxyRepositories: [
          proxy,
          {
            ...proxy,
            repository: { owner: "decoy", repo: "two" },
          },
        ],
      },
    }))).toThrow("at most one entry");
  });

  it("mints only the preconfigured repository and permissions", async () => {
    let request: Request | undefined;
    const service = new GitHubInstallationTokenService({
      appId: 12345,
      appPrivateKeyPem: testPrivateKey(),
      policies: {
        "beacon-1": {
          installationId: 98765,
          repository: { owner: "octo", repo: "c2-one" },
          permissions: { contents: "write", issues: "write" },
        },
      },
      apiBase: "https://github.test",
      now: () => NOW,
      fetchImpl: async (input, init) => {
        request = new Request(input.toString(), init);
        return Response.json({
          token: "ghs_ephemeral_lease",
          expires_at: "2026-07-16T13:00:00.000Z",
        });
      },
    });

    const lease = await service.mintLease("beacon-1");

    expect(request?.url).toBe(
      "https://github.test/app/installations/98765/access_tokens",
    );
    expect(request?.headers.get("authorization")).toStartWith("Bearer ");
    expect(await request?.json()).toEqual({
      repositories: ["c2-one"],
      permissions: { contents: "write", issues: "write" },
    });
    expect(lease.beaconId).toBe("beacon-1");
    expect(lease.repository).toEqual({ owner: "octo", repo: "c2-one" });
    expect(lease.token).toBe("ghs_ephemeral_lease");
    expect(lease.issuedAt).toBe("2026-07-16T12:00:00.000Z");
    expect(lease.renewAfter).toBe("2026-07-16T12:50:00.000Z");
    expect(lease.expiresAt).toBe("2026-07-16T13:00:00.000Z");
  });

  it("rejects an unconfigured beacon without making a request", async () => {
    let requests = 0;
    const service = new GitHubInstallationTokenService({
      appId: 12345,
      appPrivateKeyPem: testPrivateKey(),
      policies: {},
      fetchImpl: async () => {
        requests += 1;
        return new Response();
      },
    });

    await expect(service.mintLease("unknown")).rejects.toThrow(
      "No GitHub installation-token policy",
    );
    expect(requests).toBe(0);
  });

  it("mints a distinct policy-bound lease for a configured proxy repository", async () => {
    const requests: Request[] = [];
    const service = new GitHubInstallationTokenService({
      appId: 12345,
      appPrivateKeyPem: testPrivateKey(),
      policies: {
        beacon: {
          installationId: 44,
          repository: { owner: "octo", repo: "primary" },
          permissions: {
            metadata: "read",
            issues: "write",
            variables: "read",
          },
          proxyRepositories: [
            {
              installationId: 55,
              repository: { owner: "decoy", repo: "proxy-repo" },
              permissions: {
                metadata: "read",
                issues: "write",
                variables: "read",
              },
            },
          ],
        },
      },
      apiBase: "https://github.test",
      now: () => NOW,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input.toString(), init));
        return Response.json({
          token: "ghs_proxy_lease",
          expires_at: "2026-07-16T13:00:00.000Z",
        });
      },
    });

    const proxyLease = await service.mintLease("beacon", {
      owner: "decoy",
      repo: "proxy-repo",
    });
    expect(requests[0]?.url).toBe(
      "https://github.test/app/installations/55/access_tokens",
    );
    expect(await requests[0]?.json()).toEqual({
      repositories: ["proxy-repo"],
      permissions: {
        metadata: "read",
        issues: "write",
        actions_variables: "read",
      },
    });
    expect(proxyLease.permissions).toEqual({
      metadata: "read",
      issues: "write",
      variables: "read",
    });
    expect(proxyLease.repository).toEqual({
      owner: "decoy",
      repo: "proxy-repo",
    });

    await expect(service.mintLease("beacon", {
      owner: "decoy",
      repo: "not-configured",
    })).rejects.toThrow("No GitHub installation-token policy");
    expect(requests).toHaveLength(1);
  });

  it("does not expose the App private key in the returned lease", async () => {
    const pem = testPrivateKey();
    const service = new GitHubInstallationTokenService({
      appId: 12345,
      appPrivateKeyPem: pem,
      policies: {
        beacon: {
          installationId: 44,
          repository: { owner: "octo", repo: "repo" },
          permissions: { contents: "read" },
        },
      },
      now: () => NOW,
      fetchImpl: async () => Response.json({
        token: "ghs_short_lived",
        expires_at: "2026-07-16T13:00:00.000Z",
      }),
    });

    const serialized = JSON.stringify(await service.mintLease("beacon"));
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(pem.slice(0, 40));
  });

  it("rejects overlong or malformed expiry values", async () => {
    const service = new GitHubInstallationTokenService({
      appId: 12345,
      appPrivateKeyPem: testPrivateKey(),
      policies: {
        beacon: {
          installationId: 44,
          repository: { owner: "octo", repo: "repo" },
          permissions: { contents: "read" },
        },
      },
      now: () => NOW,
      fetchImpl: async () => Response.json({
        token: "ghs_bad_expiry",
        expires_at: "2026-07-17T12:00:00.000Z",
      }),
    });

    await expect(service.mintLease("beacon")).rejects.toThrow(
      "expiry is outside safe bounds",
    );
  });
});
