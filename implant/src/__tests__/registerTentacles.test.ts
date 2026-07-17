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

  it("registers Pages and Stego from the canonical priority list", async () => {
    const config = makeConfig(["pages", "stego"]);
    const factory = new ConnectionFactory({ config });
    await registerTentacles(factory, config);
    expect(Object.keys(factory.healthSnapshot()).sort()).toEqual([
      "pages",
      "stego",
    ]);
  });

  it("registers Actions with the configured credential outside Actions", async () => {
    const previous = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    const config = makeConfig(["actions"]);
    const factory = new ConnectionFactory({ config });
    try {
      await registerTentacles(factory, config);
      expect(Object.keys(factory.healthSnapshot())).toEqual(["actions"]);
    } finally {
      if (previous === undefined) {
        delete process.env["GITHUB_TOKEN"];
      } else {
        process.env["GITHUB_TOKEN"] = previous;
      }
      await factory.teardown();
    }
  });

  it("registers Gist with its dedicated token alongside an App lease", async () => {
    const config = {
      ...makeConfig(["gist"]),
      gistToken: "dedicated-gist-token",
      githubTokenLease: {
        version: 1 as const,
        leaseId: "lease-id",
        beaconId: "test-beacon",
        installationId: 1,
        repository: { owner: "owner", repo: "repo" },
        token: "installation-token",
        permissions: { metadata: "read" as const },
        issuedAt: "2026-07-17T00:00:00.000Z",
        renewAfter: "2026-07-17T00:30:00.000Z",
        expiresAt: "2026-07-17T01:00:00.000Z",
      },
    };
    const factory = new ConnectionFactory({ config });
    await registerTentacles(factory, config, { silent: true });
    expect(Object.keys(factory.healthSnapshot())).toEqual(["gist"]);
    await factory.teardown();
  });

  it("skips Gist when only an App lease is available", async () => {
    const config = {
      ...makeConfig(["gist"]),
      token: "installation-token",
      githubTokenLease: {
        version: 1 as const,
        leaseId: "lease-id",
        beaconId: "test-beacon",
        installationId: 1,
        repository: { owner: "owner", repo: "repo" },
        token: "installation-token",
        permissions: { metadata: "read" as const },
        issuedAt: "2026-07-17T00:00:00.000Z",
        renewAfter: "2026-07-17T00:30:00.000Z",
        expiresAt: "2026-07-17T01:00:00.000Z",
      },
    };
    const factory = new ConnectionFactory({ config });
    await registerTentacles(factory, config, { silent: true });
    expect(Object.keys(factory.healthSnapshot())).toEqual([]);
    await factory.teardown();
  });

  it("registers direct gRPC without requiring a GitHub credential", async () => {
    const previous = process.env["SVC_GRPC_DIRECT"];
    process.env["SVC_GRPC_DIRECT"] = "localhost:50051";
    const config = {
      ...makeConfig(["codespaces"]),
      token: "",
      controllerToken: "beacon-controller-token",
    };
    const factory = new ConnectionFactory({ config });
    try {
      await registerTentacles(factory, config);
      expect(Object.keys(factory.healthSnapshot())).toEqual(["codespaces"]);
    } finally {
      if (previous === undefined) {
        delete process.env["SVC_GRPC_DIRECT"];
      } else {
        process.env["SVC_GRPC_DIRECT"] = previous;
      }
      await factory.teardown();
    }
  });
});
