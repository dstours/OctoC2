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
import type { ITentacle, TentacleKind, CheckinPayload, Task, TaskResult, BeaconConfig } from "../types.ts";

export abstract class BaseTentacle implements ITentacle {
  abstract readonly kind: TentacleKind;

  protected readonly octokit: Octokit;
  protected readonly config: BeaconConfig;

  constructor(config: BeaconConfig, getToken?: () => Promise<string>) {
    this.config = config;

    const tokenGetter = getToken ?? (() => Promise.resolve(config.token));
    this.octokit = new Octokit({
      auth: config.token,
      userAgent: process.env.OCTOC2_USER_AGENT ?? GH_UA,
      // Retry on 429 (rate limit) automatically
      throttle: undefined,
    });

    // If GitHub App credentials are present, wrap all Octokit requests to
    // inject short-lived installation tokens (1-hour TTL) transparently.
    // The caller may pass a shared getToken() to avoid redundant JWT signing
    // across multiple tentacle instances.
    if (config.appId && config.installationId && config.appPrivateKey) {
      this.octokit.hook.wrap("request", async (request, options) => {
        const token = await tokenGetter();
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
