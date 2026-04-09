// dashboard/src/lib/GitHubApiClient.ts

import type { GitHubIssue, GitHubComment } from '@/types/github';

const BASE = 'https://api.github.com';

export class GitHubApiClient {
  private readonly headers: Record<string, string>;
  private readonly base: string;

  constructor(
    private readonly pat: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    this.base = `${BASE}/repos/${owner}/${repo}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * GET /repos/{owner}/{repo}/issues?labels=infra-node&state=open&per_page=100
   * Note: capped at 100 results (GitHub max per page). Pagination not yet implemented.
   */
  async getBeacons(): Promise<GitHubIssue[]> {
    const url = `${this.base}/issues?labels=infra-node&state=open&per_page=100`;
    return this.request<GitHubIssue[]>(url);
  }

  /** GET /repos/{owner}/{repo}/issues/{issueNumber} */
  async getBeaconDetail(issueNumber: number): Promise<GitHubIssue> {
    const url = `${this.base}/issues/${issueNumber}`;
    return this.request<GitHubIssue>(url);
  }

  /** GET /repos/{owner}/{repo}/issues/{issueNumber}/comments */
  async getComments(issueNumber: number): Promise<GitHubComment[]> {
    const url = `${this.base}/issues/${issueNumber}/comments`;
    return this.request<GitHubComment[]>(url);
  }

  /** POST /repos/{owner}/{repo}/issues/{issueNumber}/comments */
  async postComment(issueNumber: number, body: string): Promise<void> {
    const url = `${this.base}/issues/${issueNumber}/comments`;
    await this.request<unknown>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /**
   * GET /repos/{owner}/{repo}/actions/variables
   * Returns the variables array from the GitHub Actions variables API.
   */
  async getVariables(): Promise<Array<{ name: string; value: string }>> {
    const url = `${this.base}/actions/variables`;
    const data = await this.request<{ variables: Array<{ name: string; value: string }> }>(url);
    return data.variables;
  }
}
