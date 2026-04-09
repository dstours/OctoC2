// dashboard/src/lib/__tests__/GitHubApiClient.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubApiClient } from '../GitHubApiClient';
import type { GitHubIssue, GitHubComment } from '@/types/github';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAT = 'ghp_testtoken';
const OWNER = 'example-owner';
const REPO = 'OctoC2';

function makeClient() {
  return new GitHubApiClient(PAT, OWNER, REPO);
}

function mockFetchJson(data: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

function mockFetchError(status: number) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ message: 'Unauthorized' }),
  } as Response);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHubApiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── getBeacons ─────────────────────────────────────────────────────────────

  describe('getBeacons()', () => {
    it('sends correct URL with query params and Bearer header', async () => {
      const issues: Partial<GitHubIssue>[] = [];
      mockFetchJson(issues);
      const client = makeClient();

      await client.getBeacons();

      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/issues?labels=infra-node&state=open&per_page=100`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${PAT}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('returns the parsed issues array', async () => {
      const issues = [{ number: 1, title: 'test' }] as GitHubIssue[];
      mockFetchJson(issues);
      const result = await makeClient().getBeacons();
      expect(result).toEqual(issues);
    });

    it('throws GitHub API error on 401', async () => {
      mockFetchError(401);
      await expect(makeClient().getBeacons()).rejects.toThrow('GitHub API error: 401');
    });
  });

  // ── getBeaconDetail ────────────────────────────────────────────────────────

  describe('getBeaconDetail()', () => {
    it('sends correct URL for a specific issue number', async () => {
      const issue = { number: 42, title: 'beacon' } as GitHubIssue;
      mockFetchJson(issue);
      const client = makeClient();

      await client.getBeaconDetail(42);

      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/issues/42`,
        expect.anything(),
      );
    });

    it('returns the issue object', async () => {
      const issue = { number: 5, title: 'detail' } as GitHubIssue;
      mockFetchJson(issue);
      const result = await makeClient().getBeaconDetail(5);
      expect(result).toEqual(issue);
    });
  });

  // ── getComments ────────────────────────────────────────────────────────────

  describe('getComments()', () => {
    it('sends correct URL for issue comments', async () => {
      const comments: GitHubComment[] = [];
      mockFetchJson(comments);
      const client = makeClient();

      await client.getComments(7);

      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/issues/7/comments`,
        expect.anything(),
      );
    });

    it('returns the comments array', async () => {
      const comments = [{ id: 1, body: 'hello' }] as GitHubComment[];
      mockFetchJson(comments);
      const result = await makeClient().getComments(7);
      expect(result).toEqual(comments);
    });
  });

  // ── postComment ────────────────────────────────────────────────────────────

  describe('postComment()', () => {
    it('sends POST with correct URL and JSON body', async () => {
      mockFetchJson({ id: 99, body: 'cmd: whoami' });
      const client = makeClient();

      await client.postComment(3, 'cmd: whoami');

      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/issues/3/comments`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'cmd: whoami' }),
          headers: expect.objectContaining({
            Authorization: `Bearer ${PAT}`,
          }),
        }),
      );
    });

    it('resolves without a value on success', async () => {
      mockFetchJson({ id: 1, body: 'task' });
      const result = await makeClient().postComment(1, 'task');
      expect(result).toBeUndefined();
    });
  });

  // ── getVariables ───────────────────────────────────────────────────────────

  describe('getVariables()', () => {
    it('sends correct URL for Actions variables', async () => {
      mockFetchJson({ variables: [] });
      const client = makeClient();

      await client.getVariables();

      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/actions/variables`,
        expect.anything(),
      );
    });

    it('returns the variables array from the response', async () => {
      const vars = [{ name: 'OPERATOR_KEY', value: 'abc123' }];
      mockFetchJson({ variables: vars, total_count: 1 });
      const result = await makeClient().getVariables();
      expect(result).toEqual(vars);
    });

    it('throws on non-ok response', async () => {
      mockFetchError(403);
      await expect(makeClient().getVariables()).rejects.toThrow('GitHub API error: 403');
    });
  });
});
