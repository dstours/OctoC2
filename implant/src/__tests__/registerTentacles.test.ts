/**
 * registerTentacles — DRY registration tests.
 *
 * Verifies that registerTentacles() wires up tentacles correctly and that
 * both initial boot and dead-drop rebuild produce identical registry states.
 */
import { describe, it, expect } from "bun:test";
import { ConnectionFactory } from "../factory/ConnectionFactory.ts";
import { registerTentacles } from "../factory/registerTentacles.ts";
import type { BeaconConfig, TentacleKind } from "../types.ts";

function makeConfig(priority: TentacleKind[]): BeaconConfig {
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

describe("registerTentacles", () => {
  it("registers IssuesTentacle when priority includes 'issues'", async () => {
    const factory = new ConnectionFactory({ config: makeConfig(["issues"]) });
    await registerTentacles(factory, makeConfig(["issues"]));
    expect(factory.isFullyExhausted()).toBe(false);
  });

  it("produces identical registry state on rebuild", async () => {
    const config = makeConfig(["issues"]);
    const factory1 = new ConnectionFactory({ config });
    await registerTentacles(factory1, config);

    const factory2 = new ConnectionFactory({ config });
    await registerTentacles(factory2, config, { silent: true });

    // Both should have the same tentacle kinds registered
    const snap1 = factory1.healthSnapshot();
    const snap2 = factory2.healthSnapshot();
    expect(Object.keys(snap1)).toEqual(Object.keys(snap2));
  });

  it("skips silent logging when silent option is true", async () => {
    const config = makeConfig(["issues"]);
    const factory = new ConnectionFactory({ config });
    // Should not throw and should complete without logging
    await registerTentacles(factory, config, { silent: true });
    expect(factory.isFullyExhausted()).toBe(false);
  });
});
