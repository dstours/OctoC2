// octoctl/src/commands/setup/validate.ts
import { Octokit } from "@octokit/rest";

export function parsePATScopes(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(",").map((s) => s.trim()).filter(Boolean);
}

export function validateRepoConfig(input: {
  owner: string;
  repo: string;
  token: string;
}): string[] {
  const errors: string[] = [];
  if (!input.token.trim()) errors.push("Token is required");
  if (!input.owner.trim()) errors.push("Repo owner is required");
  if (!input.repo.trim()) errors.push("Repo name is required");
  return errors;
}

export interface RepoCheckResult {
  exists: boolean;
  private: boolean;
  hasIssues: boolean;
  scopes: string[];
  error?: string;
}

export async function checkRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoCheckResult> {
  const octokit = new Octokit({
    auth: token,
    headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
  });

  let scopes: string[] = [];
  try {
    const resp = await octokit.rest.users.getAuthenticated();
    scopes = parsePATScopes(
      resp.headers["x-oauth-scopes"] as string | undefined,
    );
  } catch {
    return {
      exists: false, private: false, hasIssues: false, scopes: [],
      error: "PAT is invalid or expired",
    };
  }

  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return {
      exists: true,
      private: data.private,
      hasIssues: data.has_issues ?? false,
      scopes,
    };
  } catch (err: any) {
    if (err.status === 404) {
      return {
        exists: false, private: false, hasIssues: false, scopes,
        error: `Repository ${owner}/${repo} not found (or PAT lacks access)`,
      };
    }
    return {
      exists: false, private: false, hasIssues: false, scopes,
      error: err.message,
    };
  }
}
