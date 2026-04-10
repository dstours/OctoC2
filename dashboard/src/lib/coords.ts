// dashboard/src/lib/coords.ts
// Derives the GitHub owner/repo for this deployment.

const FALLBACK = { owner: '(not connected)', repo: '(not connected)' };

// Cache coords from server health response so all components see the same values.
let _cached: { owner: string; repo: string } | null = null;

/** Call after a successful health probe to cache the server's repo coords. */
export function setGitHubCoords(owner: string, repo: string): void {
  _cached = { owner, repo };
}

/**
 * Derive the GitHub owner and repo for this deployment.
 *
 * Resolution order:
 *   1. Cached from server health response (set after login)
 *   2. VITE_GITHUB_OWNER / VITE_GITHUB_REPO environment variables
 *   3. GitHub Pages URL pattern: https://{owner}.github.io/{repo}/
 *   4. Fallback: "(not connected)"
 */
export function getGitHubCoords(): { owner: string; repo: string } {
  // 1. Cached from server
  if (_cached) return _cached;

  // 2. Explicit env vars (set at build time via Vite)
  const envOwner = import.meta.env['VITE_GITHUB_OWNER'] as string | undefined;
  const envRepo = import.meta.env['VITE_GITHUB_REPO'] as string | undefined;
  if (envOwner && envRepo) {
    return { owner: envOwner, repo: envRepo };
  }

  // 3. Parse GitHub Pages URL: https://{owner}.github.io/{repo}/
  if (typeof window !== 'undefined') {
    const { hostname, pathname } = window.location;
    const pagesMatch = hostname.match(/^([^.]+)\.github\.io$/);
    if (pagesMatch) {
      const owner = pagesMatch[1]!;
      const repoSegment = pathname.split('/').filter(Boolean)[0];
      if (repoSegment) {
        return { owner, repo: repoSegment };
      }
    }
  }

  // 4. Fallback
  return FALLBACK;
}
