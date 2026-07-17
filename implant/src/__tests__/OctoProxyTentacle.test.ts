import { describe, expect, it, mock } from "bun:test";
import { OctoProxyTentacle } from "../tentacles/OctoProxyTentacle.ts";
import type {
  BeaconConfig,
  ITentacle,
  ProxyConfig,
  TentacleKind,
} from "../types.ts";
import type { GitHubTokenLease } from "@octoc2/shared";

function makeConfig(): BeaconConfig {
  return {
    id: "b-test",
    repo: { owner: "real-owner", name: "real-c2" },
    token: "real-token",
    tentaclePriority: ["proxy"],
    sleepSeconds: 60,
    jitter: 0.1,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    },
  };
}

function proxyLease(
  repo: string,
  permissions: GitHubTokenLease["permissions"],
): GitHubTokenLease {
  return {
    version: 1,
    leaseId: `lease-${repo}`,
    beaconId: "b-test",
    installationId: 99,
    token: `ghs-${repo}`,
    repository: { owner: "decoy-owner", repo },
    permissions,
    issuedAt: "2026-07-16T12:00:00.000Z",
    renewAfter: "2026-07-16T12:50:00.000Z",
    expiresAt: "2026-07-16T13:00:00.000Z",
  };
}

const issuesProxy: ProxyConfig = {
  owner: "decoy-owner",
  repo: "my-dotfiles",
  innerKind: "issues",
  decoyIssue: 7,
  githubTokenLease: proxyLease("my-dotfiles", {
    metadata: "read",
    issues: "write",
    variables: "read",
  }),
};

function makeMockInner(tasks: unknown[] = [], available = true): ITentacle {
  return {
    kind: "issues" as TentacleKind,
    isAvailable: mock(async () => available),
    checkin: mock(async () => tasks as any),
    submitResult: mock(async () => ({
      artifactWritten: true,
      controllerAccepted: true,
      channel: "issues" as const,
      acceptance: "channel-receipt" as const,
    })),
    teardown: mock(async () => {}),
  };
}

function makeProxyWithMock(
  proxy: ProxyConfig,
  inner: ITentacle,
): OctoProxyTentacle {
  const tentacle = new OctoProxyTentacle(makeConfig(), proxy);
  (tentacle as any).inner = inner;
  return tentacle;
}

describe("OctoProxyTentacle", () => {
  it("uses only the scoped proxy repository and credential", () => {
    const tentacle = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(tentacle.kind).toBe("proxy");
    expect(tentacle.innerConfig.repo).toEqual({
      owner: "decoy-owner",
      name: "my-dotfiles",
    });
    expect(tentacle.innerConfig.token).toBe("ghs-my-dotfiles");
    expect(tentacle.innerConfig.githubTokenLease?.token).toBe(
      "ghs-my-dotfiles",
    );
    expect(tentacle.innerConfig.id).toBe("b-test");
    expect(tentacle.innerConfig.sleepSeconds).toBe(60);
    expect(tentacle.innerConfig.state).toBeUndefined();
    expect(tentacle.innerConfig.issuesIssueNumber).toBe(7);
    expect(tentacle.innerConfig.issuesStateScope)
      .toBe("proxy:decoy-owner/my-dotfiles");
    expect(tentacle.innerConfig.issuesRequireOperatorKeyMatch).toBe(true);
    expect(tentacle.innerConfig.issuesRegistrationAckTimeoutMs).toBe(120_000);
  });

  it("rejects a proxy without its own scoped credential", () => {
    expect(() => new OctoProxyTentacle(makeConfig(), {
      owner: "decoy-owner",
      repo: "unsafe",
      innerKind: "issues",
      decoyIssue: 7,
    } as any)).toThrow("requires a signed, repository-bound token lease");
  });

  it("selects Issues and rejects removed Notes proxy routes", () => {
    expect(new OctoProxyTentacle(makeConfig(), issuesProxy).innerKindName)
      .toBe("IssuesTentacle");
    expect(() => new OctoProxyTentacle(makeConfig(), {
      ...issuesProxy,
      innerKind: "notes",
    } as any)).toThrow("only the Issues relay transport");
  });

  it("delegates lifecycle without deleting durable proxy artifacts", async () => {
    const inner = makeMockInner([], true);
    const tentacle = makeProxyWithMock(issuesProxy, inner);
    const payload = {
      beaconId: "b-test",
      publicKey: "",
      hostname: "h",
      username: "u",
      os: "linux",
      arch: "x64",
      pid: 1,
      checkinAt: new Date().toISOString(),
    };
    const result = {
      taskId: "task-1",
      beaconId: "b-test",
      success: true,
      output: "ok",
      completedAt: new Date().toISOString(),
    };

    await expect(tentacle.isAvailable()).resolves.toBe(true);
    await expect(tentacle.checkin(payload)).resolves.toEqual([]);
    await expect(tentacle.submitResult(result)).resolves.toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      channel: "proxy",
      acceptance: "channel-receipt",
    });
    await expect(tentacle.teardown()).resolves.toBeUndefined();
    expect((inner.isAvailable as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((inner.checkin as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((inner.submitResult as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((inner.teardown as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});
