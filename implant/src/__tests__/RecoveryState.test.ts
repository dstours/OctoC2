import {
  afterEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRecoveryRecord,
  GITHUB_TOKEN_LEASE_VERSION,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  verifyRecoveryRecord,
  type RecoveryConfigurationV2,
} from "@octoc2/shared";
import { generateKeyPair } from "../crypto/sodium.ts";
import {
  applyAcceptedRecoveryTrust,
  loadAcceptedRecoveryState,
  loadRecoveryStateSnapshot,
  recoveryStatePath,
  saveAcceptedRecoveryState,
} from "../recovery/RecoveryState.ts";
import { applyRecoveryConfiguration } from "../recovery/applyRecovery.ts";
import type { BeaconConfig } from "../types.ts";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env["OCTOC2_STATE_DIR"];
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(beaconId: string): Promise<{
  config: BeaconConfig;
  recovered: RecoveryConfigurationV2;
}> {
  const beaconKeys = await generateKeyPair();
  const operatorKeys = await generateKeyPair();
  const nextOperatorKeys = await generateKeyPair();
  const recoveryKeys = await generateEd25519KeyPair();
  const recoveryKeyId = await ed25519KeyId(recoveryKeys.publicKey);
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const renewAfter = new Date(Date.now() + 30 * 60_000).toISOString();
  const proxyRenewAfter = new Date(Date.now() + 25 * 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const proxyExpiresAt = new Date(Date.now() + 55 * 60_000).toISOString();
  const config: BeaconConfig = {
    id: beaconId,
    repo: { owner: "old", name: "old" },
    token: "github_pat_old",
    controllerToken: "controller-old",
    tentaclePriority: ["issues"],
    sleepSeconds: 60,
    jitter: 0.1,
    operatorPublicKey: operatorKeys.publicKey,
    beaconKeyPair: beaconKeys,
    recoverySigningPublicKey: recoveryKeys.publicKey,
    recoverySigningKeyId: recoveryKeyId,
    recoveryGeneration: 0,
  };
  const recovered: RecoveryConfigurationV2 = {
    serverUrl: "https://controller.example.test",
    controllerToken: "controller-new",
    monitoringPublicKey: encodeBase64Url(nextOperatorKeys.publicKey),
    recoverySigningPublicKey: encodeBase64Url(recoveryKeys.publicKey),
    recoverySigningKeyId: recoveryKeyId,
    github: {
      owner: "new-owner",
      repo: "new-repo",
      tokenLease: {
        version: GITHUB_TOKEN_LEASE_VERSION,
        leaseId: "lease-new",
        beaconId,
        installationId: 42,
        token: "ghs_new",
        repository: { owner: "new-owner", repo: "new-repo" },
        permissions: {
          metadata: "read",
          contents: "write",
          issues: "write",
          variables: "read",
        },
        issuedAt,
        renewAfter,
        expiresAt,
      },
    },
    tentaclePriority: ["proxy", "branch", "issues"],
    relayConsortium: [{ account: "relay", repo: "relay-repo" }],
    proxyRepos: [
      {
        owner: "proxy",
        repo: "proxy-repo",
        innerKind: "issues",
        decoyIssue: 7,
        tokenLease: {
          version: GITHUB_TOKEN_LEASE_VERSION,
          leaseId: "lease-proxy",
          beaconId,
          installationId: 43,
          token: "ghs_proxy",
          repository: { owner: "proxy", repo: "proxy-repo" },
          permissions: {
            metadata: "read",
            issues: "write",
            variables: "read",
          },
          issuedAt,
          renewAfter: proxyRenewAfter,
          expiresAt: proxyExpiresAt,
        },
      },
    ],
    sleepSeconds: 90,
    jitter: 0.25,
  };
  return { config, recovered };
}

describe("accepted recovery state", () => {
  it("persists generation/config and restores every authenticated field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-recovery-"));
    cleanup.push(directory);
    process.env["OCTOC2_STATE_DIR"] = directory;
    const beaconId = "beacon-recovery-state";
    const { config, recovered } = await fixture(beaconId);
    const acceptedAt = new Date().toISOString();
    const outerExpiresAt = new Date(Date.now() + 50 * 60_000).toISOString();

    await saveAcceptedRecoveryState({
      version: 2,
      beaconId,
      generation: 12,
      acceptedAt,
      expiresAt: outerExpiresAt,
      configuration: recovered,
    });
    const saved = await loadAcceptedRecoveryState(beaconId);
    expect(saved?.generation).toBe(12);
    await applyRecoveryConfiguration(
      config,
      saved!.generation,
      saved!.configuration,
    );

    expect(config.repo).toEqual({ owner: "new-owner", name: "new-repo" });
    expect(config.token).toBe("ghs_new");
    expect(config.githubTokenLease?.leaseId).toBe("lease-new");
    expect(config.controllerToken).toBe("controller-new");
    expect(config.serverUrl).toBe("https://controller.example.test");
    expect(config.tentaclePriority).toEqual(["proxy", "branch", "issues"]);
    expect(config.relayConsortium).toEqual([
      { account: "relay", repo: "relay-repo" },
    ]);
    expect(config.proxyRepos).toEqual([
      {
        owner: "proxy",
        repo: "proxy-repo",
        innerKind: "issues",
        decoyIssue: 7,
        githubTokenLease: expect.objectContaining({
          leaseId: "lease-proxy",
          token: "ghs_proxy",
          repository: { owner: "proxy", repo: "proxy-repo" },
        }),
      },
    ]);
    expect(config.sleepSeconds).toBe(90);
    expect(config.jitter).toBe(0.25);
    expect(config.recoveryGeneration).toBe(12);
  });

  it("does not restore expired or legacy runtime credentials but retains accepted trust", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-recovery-expired-"));
    cleanup.push(directory);
    process.env["OCTOC2_STATE_DIR"] = directory;
    const beaconId = "beacon-expired-recovery";
    const { recovered } = await fixture(beaconId);
    const acceptedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

    await saveAcceptedRecoveryState({
      version: 2,
      beaconId,
      generation: 4,
      acceptedAt,
      expiresAt,
      configuration: recovered,
    });
    const expiredSnapshot = await loadRecoveryStateSnapshot(
      beaconId,
      Date.parse(expiresAt) + 1,
    );
    expect(expiredSnapshot?.activeState).toBeNull();
    expect(expiredSnapshot?.trust.generation).toBe(4);
    expect(await loadAcceptedRecoveryState(
      beaconId,
      Date.parse(expiresAt) + 1,
    )).toBeNull();

    await writeFile(recoveryStatePath(beaconId), JSON.stringify({
      version: 1,
      beaconId,
      generation: 4,
      acceptedAt,
      configuration: recovered,
    }), "utf8");
    expect(await loadAcceptedRecoveryState(beaconId)).toBeNull();
    const legacySnapshot = await loadRecoveryStateSnapshot(beaconId);
    expect(legacySnapshot?.activeState).toBeNull();
    expect(legacySnapshot?.trust.generation).toBe(4);
    expect(legacySnapshot?.trust.signingKeyId)
      .toBe(recovered.recoverySigningKeyId);
  });

  it("restores an expired state's rotated signer before verifying the next generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-recovery-rotate-"));
    cleanup.push(directory);
    process.env["OCTOC2_STATE_DIR"] = directory;
    const beaconId = "beacon-rotated-recovery";
    const { config, recovered } = await fixture(beaconId);
    const rotatedSigner = await generateEd25519KeyPair();
    const rotatedKeyId = await ed25519KeyId(rotatedSigner.publicKey);
    recovered.recoverySigningPublicKey =
      encodeBase64Url(rotatedSigner.publicKey);
    recovered.recoverySigningKeyId = rotatedKeyId;
    const acceptedAt = new Date().toISOString();
    const expiredAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const restartAt = Date.parse(expiredAt) + 1;

    await saveAcceptedRecoveryState({
      version: 2,
      beaconId,
      generation: 4,
      acceptedAt,
      expiresAt: expiredAt,
      configuration: recovered,
    });
    const snapshot = await loadRecoveryStateSnapshot(beaconId, restartAt);
    expect(snapshot?.activeState).toBeNull();
    applyAcceptedRecoveryTrust(config, snapshot!.trust);

    expect(config.recoveryGeneration).toBe(4);
    expect(config.recoverySigningPublicKey).toEqual(rotatedSigner.publicKey);
    expect(config.recoverySigningKeyId).toBe(rotatedKeyId);
    expect(config.repo).toEqual({ owner: "old", name: "old" });
    expect(config.token).toBe("github_pat_old");

    const nextRecord = await createRecoveryRecord({
      beaconId,
      generation: 5,
      issuedAt: new Date(restartAt).toISOString(),
      expiresAt: new Date(restartAt + 10 * 60_000).toISOString(),
      signingKeyId: rotatedKeyId,
      signingSecretKey: rotatedSigner.secretKey,
      configuration: recovered,
    });
    expect(await verifyRecoveryRecord(nextRecord, {
      beaconId,
      minimumGenerationExclusive: config.recoveryGeneration!,
      signingPublicKey: config.recoverySigningPublicKey!,
      expectedSigningKeyId: config.recoverySigningKeyId!,
      now: new Date(restartAt),
    })).toMatchObject({
      valid: true,
      generation: 5,
    });
  });

  it("seeds the resolver generation floor from expired accepted state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-recovery-floor-"));
    cleanup.push(directory);
    process.env["OCTOC2_STATE_DIR"] = directory;
    const beaconId = "beacon-recovery-floor";
    const { config, recovered } = await fixture(beaconId);
    const rotatedSigner = await generateEd25519KeyPair();
    const rotatedKeyId = await ed25519KeyId(rotatedSigner.publicKey);
    recovered.recoverySigningPublicKey =
      encodeBase64Url(rotatedSigner.publicKey);
    recovered.recoverySigningKeyId = rotatedKeyId;
    const acceptedAt = new Date().toISOString();
    const expiredAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const restartAt = Date.parse(expiredAt) + 1;

    await saveAcceptedRecoveryState({
      version: 2,
      beaconId,
      generation: 12,
      acceptedAt,
      expiresAt: expiredAt,
      configuration: recovered,
    });
    const snapshot = await loadRecoveryStateSnapshot(beaconId, restartAt);
    applyAcceptedRecoveryTrust(config, snapshot!.trust);

    const rollbackRecord = await createRecoveryRecord({
      beaconId,
      generation: 11,
      issuedAt: new Date(restartAt).toISOString(),
      expiresAt: new Date(restartAt + 10 * 60_000).toISOString(),
      signingKeyId: rotatedKeyId,
      signingSecretKey: rotatedSigner.secretKey,
      configuration: recovered,
    });
    expect(await verifyRecoveryRecord(rollbackRecord, {
      beaconId,
      minimumGenerationExclusive: config.recoveryGeneration!,
      signingPublicKey: config.recoverySigningPublicKey!,
      expectedSigningKeyId: config.recoverySigningKeyId!,
      now: new Date(restartAt),
    })).toEqual({
      valid: false,
      reason: "stale_generation",
    });
  });

  it("refuses a replay before mutating live configuration", async () => {
    const { config, recovered } = await fixture("beacon-replay");
    config.recoveryGeneration = 20;
    const before = structuredClone({
      repo: config.repo,
      token: config.token,
      controllerToken: config.controllerToken,
    });

    await expect(
      applyRecoveryConfiguration(config, 20, recovered),
    ).rejects.toThrow("stale");
    expect({
      repo: config.repo,
      token: config.token,
      controllerToken: config.controllerToken,
    }).toEqual(before);
  });
});
