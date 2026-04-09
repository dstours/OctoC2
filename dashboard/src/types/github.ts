// dashboard/src/types/github.ts

/** A GitHub Issue as returned by GET /repos/:owner/:repo/issues */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: GitHubLabel[];
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  /** URL to the issue on GitHub — used for linking from BeaconDetail. */
  html_url: string;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
}

/** A GitHub Issue comment as returned by GET /repos/:owner/:repo/issues/:id/comments */
export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
}

/** A GitHub Gist as returned by GET /gists/:id */
export interface GitHubGist {
  id: string;
  description: string | null;
  public: boolean;
  files: Record<string, GitHubGistFile>;
  created_at: string;
  updated_at: string;
}

export interface GitHubGistFile {
  filename: string;
  type: string;
  language: string | null;
  raw_url: string;
  size: number;
  content?: string; // only present when fetching a single gist
}
