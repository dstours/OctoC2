import {
  decodeBase64Url,
  type RecoveryConfigurationV2,
} from "@octoc2/shared";
import { clearSharedGitHubTokenProviders } from "../lib/GitHubTokenProvider.ts";
import type { BeaconConfig, ProxyConfig, RelayConfig } from "../types.ts";

export async function applyRecoveryConfiguration(
  config: BeaconConfig,
  generation: number,
  recovered: RecoveryConfigurationV2,
): Promise<void> {
  if (
    !Number.isSafeInteger(generation) ||
    generation <= (config.recoveryGeneration ?? 0)
  ) {
    throw new Error("Recovery generation is stale");
  }
  if (recovered.github.tokenLease.beaconId !== config.id) {
    throw new Error("Recovery token lease belongs to another beacon");
  }

  const monitoringPublicKey = await decodeBase64Url(
    recovered.monitoringPublicKey,
  );
  const recoverySigningPublicKey = await decodeBase64Url(
    recovered.recoverySigningPublicKey,
  );
  if (
    monitoringPublicKey.length !== 32 ||
    recoverySigningPublicKey.length !== 32
  ) {
    throw new Error("Recovery configuration contains invalid key material");
  }

  const relayConsortium: RelayConfig[] = recovered.relayConsortium.map(
    (entry) => ({ ...entry }),
  );
  const proxyRepos: ProxyConfig[] = recovered.proxyRepos.map(
    (entry) => ({
      owner: entry.owner,
      repo: entry.repo,
      innerKind: entry.innerKind,
      decoyIssue: entry.decoyIssue,
      githubTokenLease: {
        ...entry.tokenLease,
        repository: { ...entry.tokenLease.repository },
        permissions: { ...entry.tokenLease.permissions },
      },
    }),
  );
  const tokenLease = {
    ...recovered.github.tokenLease,
    repository: { ...recovered.github.tokenLease.repository },
    permissions: { ...recovered.github.tokenLease.permissions },
  };

  // Every conversion/validation above completes before live state is changed.
  // Object.assign then replaces the entire authenticated configuration in one
  // synchronous operation, and tentacles are rebuilt immediately afterwards.
  Object.assign(config, {
    repo: {
      owner: recovered.github.owner,
      name: recovered.github.repo,
    },
    token: tokenLease.token,
    githubTokenLease: tokenLease,
    tentaclePriority: [...recovered.tentaclePriority],
    sleepSeconds: recovered.sleepSeconds,
    jitter: recovered.jitter,
    operatorPublicKey: monitoringPublicKey,
    serverUrl: recovered.serverUrl,
    recoverySigningPublicKey,
    recoverySigningKeyId: recovered.recoverySigningKeyId,
    recoveryGeneration: generation,
    relayConsortium,
    proxyRepos,
  });
  if (recovered.controllerToken === null) {
    delete config.controllerToken;
  } else {
    config.controllerToken = recovered.controllerToken;
  }
  clearSharedGitHubTokenProviders();
}
