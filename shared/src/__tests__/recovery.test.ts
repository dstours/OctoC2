import { describe, expect, it } from "bun:test";
import {
  GITHUB_TOKEN_LEASE_VERSION,
  assertRecoveryConfiguration,
  type RecoveryConfigurationV2,
} from "../recovery.ts";

function configuration(
  serverUrl = "https://controller.example.test",
): RecoveryConfigurationV2 {
  return {
    serverUrl,
    controllerToken: "beacon-controller-token",
    monitoringPublicKey: "monitoring-key",
    recoverySigningPublicKey: "recovery-key",
    recoverySigningKeyId: "recovery-key-id",
    github: {
      owner: "owner",
      repo: "primary",
      tokenLease: {
        version: GITHUB_TOKEN_LEASE_VERSION,
        leaseId: "lease-primary",
        beaconId: "beacon-a",
        installationId: 42,
        token: "ghs_primary",
        repository: { owner: "owner", repo: "primary" },
        permissions: {
          metadata: "read",
          issues: "write",
          variables: "read",
        },
        issuedAt: "2026-07-16T12:00:00.000Z",
        renewAfter: "2026-07-16T12:30:00.000Z",
        expiresAt: "2026-07-16T13:00:00.000Z",
      },
    },
    tentaclePriority: ["issues"],
    relayConsortium: [],
    proxyRepos: [],
    sleepSeconds: 60,
    jitter: 0.2,
  };
}

describe("recovery controller URL policy", () => {
  it("accepts a pathless HTTPS controller origin", () => {
    expect(() => assertRecoveryConfiguration(configuration())).not.toThrow();
  });

  it("rejects plaintext, embedded credentials, paths, queries, and fragments", () => {
    for (const serverUrl of [
      "http://127.0.0.1:8080",
      "https://user:password@controller.example.test",
      "https://controller.example.test/api",
      "https://controller.example.test?token=secret",
      "https://controller.example.test#fragment",
    ]) {
      expect(() => assertRecoveryConfiguration(configuration(serverUrl)))
        .toThrow();
    }
  });
});

describe("recovery proxy policy", () => {
  function withProxy(): RecoveryConfigurationV2 {
    const value = configuration();
    return {
      ...value,
      tentaclePriority: ["proxy", "issues"],
      proxyRepos: [{
        owner: "decoy",
        repo: "relay",
        innerKind: "issues",
        decoyIssue: 7,
        tokenLease: {
          version: GITHUB_TOKEN_LEASE_VERSION,
          leaseId: "lease-proxy",
          beaconId: "beacon-a",
          installationId: 43,
          token: "ghs_proxy",
          repository: { owner: "decoy", repo: "relay" },
          permissions: {
            metadata: "read",
            issues: "write",
            variables: "read",
          },
          issuedAt: "2026-07-16T12:00:00.000Z",
          renewAfter: "2026-07-16T12:30:00.000Z",
          expiresAt: "2026-07-16T13:00:00.000Z",
        },
      }],
    };
  }

  it("accepts one provisioned Issues route with read-only variables access", () => {
    expect(() => assertRecoveryConfiguration(withProxy())).not.toThrow();
  });

  it("rejects multiple routes for one beacon", () => {
    const value = withProxy();
    const second = structuredClone(value.proxyRepos[0]!);
    second.repo = "other";
    second.decoyIssue = 8;
    second.tokenLease.repository.repo = "other";
    expect(() => assertRecoveryConfiguration({
      ...value,
      proxyRepos: [...value.proxyRepos, second],
    })).toThrow("at most one route");
  });

  it("rejects a proxy lease that cannot read MONITORING_PUBKEY", () => {
    const value = withProxy();
    const proxy = structuredClone(value.proxyRepos[0]!);
    delete (proxy.tokenLease.permissions as Record<string, string>)["variables"];
    expect(() => assertRecoveryConfiguration({
      ...value,
      proxyRepos: [proxy],
    })).toThrow("variables:read");
  });
});
