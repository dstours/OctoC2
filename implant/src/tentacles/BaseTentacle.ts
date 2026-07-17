/**
 * OctoC2 — BaseTentacle
 *
 * Abstract base for all tentacle channel implementations.
 * Phase 2 will provide concrete subclasses:
 *   IssuesTentacle, ActionsTentacle, BranchTentacle, GistTentacle, etc.
 *
 * Each tentacle gets a shared Octokit client, the beacon config,
 * and a reference to the libsodium crypto context.
 */

import { Octokit } from "@octokit/rest";
import { GH_UA } from "../lib/constants.ts";
import {
  getSharedGitHubTokenProvider,
  type GitHubTokenProvider,
} from "../lib/GitHubTokenProvider.ts";
import type {
  ITentacle,
  TentacleKind,
  CheckinPayload,
  Task,
  TaskResult,
  BeaconConfig,
  ResultSubmissionOutcome,
} from "../types.ts";

export abstract class BaseTentacle implements ITentacle {
  abstract readonly kind: TentacleKind;

  protected readonly octokit: Octokit;
  protected readonly config: BeaconConfig;
  protected readonly tokenProvider: GitHubTokenProvider;

  constructor(config: BeaconConfig, tokenProvider?: GitHubTokenProvider) {
    this.config = config;
    this.tokenProvider =
      tokenProvider ?? getSharedGitHubTokenProvider(config);

    this.octokit = new Octokit({
      userAgent: process.env.OCTOC2_USER_AGENT ?? GH_UA,
      // Retry on 429 (rate limit) automatically
      throttle: undefined,
    });

    // Every request obtains its credential from the shared provider. A token
    // lease never falls back to config.token when stale, invalid, or expired.
    this.octokit.hook.wrap("request", async (request, options) => {
      const token = await this.tokenProvider.getToken({ channel: this.kind });
      options.headers = {
        ...options.headers,
        authorization: `Bearer ${token}`,
      };
      try {
        return await request(options);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 401 || status === 403) {
          this.tokenProvider.invalidate(`GitHub returned HTTP ${status}`);
        }
        throw error;
      }
    });
  }

  /** Default availability check — verify token works with a lightweight call */
  async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.config.repo.owner,
        repo: this.config.repo.name,
      });
      return true;
    } catch {
      return false;
    }
  }

  abstract checkin(payload: CheckinPayload): Promise<Task[]>;
  abstract submitResult(result: TaskResult): Promise<ResultSubmissionOutcome>;

  async teardown(): Promise<void> {
    // No-op by default — override in tentacles that hold connections
  }
}
