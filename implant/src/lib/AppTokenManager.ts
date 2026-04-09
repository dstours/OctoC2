/**
 * AppTokenManager — GitHub App installation token lifecycle.
 *
 * Replaces static PAT usage in tentacles with short-lived (1-hour)
 * installation tokens issued against a registered GitHub App.
 *
 * Token flow:
 *   App private key (PEM)
 *     → sign RS256 JWT  { iss: appId, iat, exp: +5m }
 *     → POST /app/installations/{id}/access_tokens  (Authorization: Bearer {jwt})
 *     → { token: "ghs_...", expires_at: "...+1h" }
 *
 * The token is cached and reused until 5 minutes before expiry, then
 * transparently refreshed on the next `getToken()` call.
 *
 * When appId / installationId / appPrivateKey are absent the module falls
 * back to returning the plain PAT — no behaviour change for existing setups.
 */

import { SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";

const GH_UA = "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0";
const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Config ────────────────────────────────────────────────────────────────────

export interface AppAuthConfig {
  /** Numeric GitHub App ID (shown on the app's settings page) */
  appId: number;
  /** Installation ID for the target repository */
  installationId: number;
  /** App private key as a PEM string (RSA-2048+) */
  appPrivateKey: string;
}

// ── AppTokenManager ───────────────────────────────────────────────────────────

export class AppTokenManager {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly auth: AppAuthConfig) {}

  /**
   * Return a valid installation token, refreshing transparently when needed.
   */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() + BUFFER_MS < this.cached.expiresAt) {
      return this.cached.token;
    }
    const jwt = await this.signJwt();
    const resp = await fetch(
      `https://api.github.com/app/installations/${this.auth.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": GH_UA,
        },
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "(no body)");
      throw new Error(
        `GitHub App token exchange failed (${resp.status}): ${body}`,
      );
    }
    const { token, expires_at } = (await resp.json()) as {
      token: string;
      expires_at: string;
    };
    this.cached = { token, expiresAt: new Date(expires_at).getTime() };
    return token;
  }

  /** Evict the cached token (e.g. after a 401 from the API). */
  invalidate(): void {
    this.cached = null;
  }

  private async signJwt(): Promise<string> {
    const privateKey = createPrivateKey(this.auth.appPrivateKey);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setIssuer(String(this.auth.appId))
      .setExpirationTime("5m")
      .sign(privateKey);
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Return an async token getter suitable for Octokit's `auth` option.
 *
 * If the config contains GitHub App credentials (`appId`, `installationId`,
 * `appPrivateKey`) an `AppTokenManager` is created and its `getToken()` is
 * returned.  Otherwise the static PAT is returned as a resolved promise,
 * preserving backward compatibility.
 *
 * Usage:
 *   const getToken = buildTokenGetter(config);
 *   new Octokit({ auth: await getToken() });
 *   // or, if using Octokit's authStrategy, pass getToken directly
 */
export function buildTokenGetter(config: {
  token: string;
  appId?: number;
  installationId?: number;
  appPrivateKey?: string;
}): () => Promise<string> {
  if (config.appId && config.installationId && config.appPrivateKey) {
    const manager = new AppTokenManager({
      appId: config.appId,
      installationId: config.installationId,
      appPrivateKey: config.appPrivateKey,
    });
    return () => manager.getToken();
  }
  // PAT fallback — static, no refresh needed
  return () => Promise.resolve(config.token);
}
