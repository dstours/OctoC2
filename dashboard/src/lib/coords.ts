// dashboard/src/lib/coords.ts
// Derives the GitHub owner/repo for this deployment.

const FALLBACK = { owner: 'dstours', repo: 'OctoC2' };

/**
 * Derive the GitHub owner and repo for this deployment.
 *
 * Resolution order:
 *   1. VITE_GITHUB_OWNER / VITE_GITHUB_REPO environment variables
 *   2. GitHub Pages URL pattern: https://{owner}.github.io/{repo}/
 *   3. Hardcoded fallback (local dev only): dstours / OctoC2
 */
export function getGitHubCoords(): { owner: string; repo: string } {
  // 1. Explicit env vars (set at build time via Vite)
  const envOwner = import.meta.env['VITE_GITHUB_OWNER'] as string | undefined;
  const envRepo = import.meta.env['VITE_GITHUB_REPO'] as string | undefined;
  if (envOwner && envRepo) {
    return { owner: envOwner, repo: envRepo };
  }

  // 2. Parse GitHub Pages URL: https://{owner}.github.io/{repo}/
  if (typeof window !== 'undefined') {
    const { hostname, pathname } = window.location;
    const pagesMatch = hostname.match(/^([^.]+)\.github\.io$/);
    if (pagesMatch) {
      const owner = pagesMatch[1]!;
      // pathname is "/{repo}/..." — grab the first segment
      const repoSegment = pathname.split('/').filter(Boolean)[0];
      if (repoSegment) {
        return { owner, repo: repoSegment };
      }
    }
  }

  // 3. Fallback
  return FALLBACK;
}
