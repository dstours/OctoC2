import { describe, it, expect } from "bun:test";
import { ConnectionFactory } from "../factory/ConnectionFactory.ts";
import type { ITentacle, TentacleKind, CheckinPayload } from "../types.ts";

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
    submitResult: async () => {},
    teardown: async () => {},
  };
}

const DUMMY_PAYLOAD: CheckinPayload = {
  beaconId: "x", publicKey: "", hostname: "", username: "",
  os: "", arch: "", pid: 1, checkinAt: "",
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
  it("creates one OctoProxyTentacle per entry in config.proxyRepos", () => {
    const config = makeConfig({
      tentaclePriority: ["proxy"],
      proxyRepos: [
        { owner: "decoy1", repo: "fake-dots", innerKind: "issues" },
        { owner: "decoy2", repo: "config-dump", innerKind: "notes" },
      ],
    });
    const factory = new ConnectionFactory({ config });
    const tentacles = factory.getTentacles();
    const proxies = tentacles.filter(t => t.kind === "proxy");
    expect(proxies).toHaveLength(2);
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
