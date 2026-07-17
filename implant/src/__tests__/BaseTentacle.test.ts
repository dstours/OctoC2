import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  GITHUB_TOKEN_LEASE_VERSION,
  type GitHubTokenLease,
} from "@octoc2/shared";

let requestHook:
  | ((request: (options: any) => Promise<any>, options: any) => Promise<any>)
  | undefined;

class MockOctokit {
  hook = {
    wrap: (
      name: string,
      fn: (
        request: (options: any) => Promise<any>,
        options: any,
      ) => Promise<any>,
    ) => {
      expect(name).toBe("request");
      requestHook = fn;
    },
  };

  rest = {
    repos: {
      get: mock(async () => ({ data: { full_name: "octo/c2" } })),
    },
  };
}

mock.module("@octokit/rest", () => ({ Octokit: MockOctokit }));

const { registerTentacles } = await import(
  "../factory/registerTentacles.ts"
);
const { getSharedGitHubTokenProvider, clearSharedGitHubTokenProviders } =
  await import("../lib/GitHubTokenProvider.ts");

function lease(): GitHubTokenLease {
  return {
    version: GITHUB_TOKEN_LEASE_VERSION,
    leaseId: "lease-registered",
    beaconId: "beacon-registered",
    installationId: 123,
    token: "ghs_installation_only",
    repository: { owner: "octo", repo: "c2" },
    permissions: { issues: "write", metadata: "read" },
    issuedAt: "2026-07-16T12:00:00.000Z",
    renewAfter: "2099-07-16T12:50:00.000Z",
    expiresAt: "2099-07-16T13:00:00.000Z",
  };
}

function config() {
  return {
    id: "beacon-registered",
    repo: { owner: "octo", name: "c2" },
    token: "github_pat_deliberately_rejected",
    githubTokenLease: lease(),
    tentaclePriority: ["issues"] as const,
    sleepSeconds: 60,
    jitter: 0.2,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    },
  };
}

describe("BaseTentacle token injection", () => {
  beforeEach(() => {
    requestHook = undefined;
    clearSharedGitHubTokenProviders();
  });

  it("uses the installation lease in an actually registered Issues tentacle", async () => {
    const registered: unknown[] = [];
    const factory = {
      register(tentacle: unknown) {
        registered.push(tentacle);
      },
      setProxyTentacles() {},
    };
    const beaconConfig = config();

    await registerTentacles(factory as any, beaconConfig as any);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.constructor.name).toBe("IssuesTentacle");
    expect(requestHook).toBeDefined();

    const response = await requestHook!(
      async (options) => {
        const authorization = options.headers.authorization;
        if (
          authorization ===
          "Bearer github_pat_deliberately_rejected"
        ) {
          throw Object.assign(new Error("PAT rejected"), { status: 401 });
        }
        expect(authorization).toBe("Bearer ghs_installation_only");
        return { data: { ok: true } };
      },
      { headers: { accept: "application/json" } },
    );
    expect(response.data.ok).toBe(true);
  });

  it("invalidates the shared provider after an authentication response", async () => {
    const beaconConfig = config();
    const factory = {
      register() {},
      setProxyTentacles() {},
    };
    await registerTentacles(factory as any, beaconConfig as any);
    const provider = getSharedGitHubTokenProvider(beaconConfig);
    expect(provider.needsRenewal()).toBe(false);

    await expect(requestHook!(
      async () => {
        throw Object.assign(new Error("denied"), { status: 401 });
      },
      { headers: {} },
    )).rejects.toThrow("denied");
    expect(provider.needsRenewal()).toBe(true);
  });
});
