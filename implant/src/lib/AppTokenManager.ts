/**
 * Compatibility façade for the retired beacon-side AppTokenManager.
 *
 * GitHub App private keys must remain server-side. Beacon code receives only
 * a narrowed, short-lived installation token lease through the signed and
 * sealed recovery channel.
 */

export {
  ExplicitFineGrainedTokenProvider,
  InstallationTokenLeaseProvider,
  buildGitHubTokenProvider,
  clearSharedGitHubTokenProviders,
  getSharedGitHubTokenProvider,
  getSharedGitHubTokenProviderIfPresent,
  replaceSharedGitHubTokenLease,
  type GitHubCredentialMode,
  type GitHubTokenProvider,
  type GitHubTokenProviderConfig,
  type GitHubTokenRequest,
  type LeaseRenewal,
} from "./GitHubTokenProvider.ts";

import {
  buildGitHubTokenProvider,
  clearSharedGitHubTokenProviders,
  getSharedGitHubTokenProvider,
  type GitHubTokenProviderConfig,
} from "./GitHubTokenProvider.ts";

/**
 * Legacy constructor retained solely to provide an explicit fail-closed error
 * to stale integrations. It never imports, parses, or stores an App key.
 */
export class AppTokenManager {
  constructor(_legacyConfig: unknown) {
    throw new Error(
      "AppTokenManager is unavailable on beacons; mint a server-side installation token lease",
    );
  }
}

export function buildTokenGetter(
  config: GitHubTokenProviderConfig,
): () => Promise<string> {
  const provider = buildGitHubTokenProvider(config);
  return () => provider.getToken();
}

export function getSharedTokenGetter(
  config: GitHubTokenProviderConfig,
): () => Promise<string> {
  const provider = getSharedGitHubTokenProvider(config);
  return () => provider.getToken();
}

export function clearTokenManagerCache(): void {
  clearSharedGitHubTokenProviders();
}
