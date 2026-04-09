/**
 * OctoC2 — CodespaceProvisioner
 *
 * Ensures a GitHub Codespace is available for the C2 server gRPC listener.
 * Used by GrpcSshTentacle when SVC_AUTO_PROVISION_CODESPACE=true.
 *
 * Flow:
 *   1. Resolve GitHub username (SVC_GITHUB_USER or GET /user).
 *   2. List user's codespaces for the C2 repo.
 *   3. If one exists → start it if stopped, wait for Available state.
 *   4. If none exists → create one, wait for Available state.
 *   5. Return { name, user } so GrpcSshTentacle can open the SSH tunnel.
 *
 * Environment variables read:
 *   SVC_GRPC_CODESPACE_NAME  — skip provisioning if already set (use existing)
 *   SVC_GITHUB_USER          — skip /user lookup if already set
 *   SVC_CODESPACE_WAIT_MS    — max ms to wait for Available state (default: 120 000)
 */

import { Octokit } from "@octokit/rest";
import { createLogger } from "../../logger.ts";

const log = createLogger("CodespaceProvisioner");

const DEFAULT_WAIT_MS  = 120_000;  // 2 minutes
const POLL_INTERVAL_MS =   5_000;  // poll every 5 s

export interface ProvisionResult {
  name: string;
  user: string;
}

export class CodespaceProvisioner {
  private readonly octokit: Octokit;
  private readonly owner:   string;
  private readonly repo:    string;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner   = owner;
    this.repo    = repo;
  }

  /**
   * Ensure a Codespace is running for the C2 repo.
   * Returns the Codespace name and the authenticated GitHub username.
   */
  async ensureRunning(): Promise<ProvisionResult> {
    // Resolve GitHub username
    const user = await this.resolveUser();
    log.info(`[bootstrap] provisioning Codespace for ${this.owner}/${this.repo} (user: ${user})`);

    // Find an existing Codespace for this repo
    const existing = await this.findCodespace();

    if (existing) {
      log.info(`[bootstrap] found existing Codespace '${existing.name}' (state: ${existing.state})`);
      if (existing.state !== "Available") {
        await this.startCodespace(existing.name);
        await this.waitForState(existing.name, "Available");
      }
      return { name: existing.name, user };
    }

    // No Codespace found — create one
    log.info(`[bootstrap] spinning up Codespace for initial registration`);
    const name = await this.createCodespace();
    await this.waitForState(name, "Available");
    log.info(`[bootstrap] Codespace '${name}' ready`);
    return { name, user };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async resolveUser(): Promise<string> {
    const cached = process.env["SVC_GITHUB_USER"]?.trim();
    if (cached) return cached;
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  private async findCodespace(): Promise<{ name: string; state: string } | null> {
    try {
      const { data } = await this.octokit.codespaces.listForAuthenticatedUser({ per_page: 100 });
      const match = (data.codespaces ?? []).find(
        (cs) => cs.repository?.full_name === `${this.owner}/${this.repo}` &&
                cs.state !== "Deleted"
      );
      if (!match) return null;
      return { name: match.name, state: match.state ?? "Unknown" };
    } catch (err) {
      log.warn(`listForAuthenticatedUser failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async startCodespace(name: string): Promise<void> {
    log.info(`[bootstrap] starting stopped Codespace '${name}'`);
    await this.octokit.codespaces.startForAuthenticatedUser({ codespace_name: name });
  }

  private async createCodespace(): Promise<string> {
    const { data } = await this.octokit.codespaces.createWithRepoForAuthenticatedUser({
      owner: this.owner,
      repo:  this.repo,
    });
    log.info(`[bootstrap] created Codespace '${data.name}'`);
    return data.name;
  }

  private async waitForState(name: string, target: string): Promise<void> {
    const maxMs = parseInt(process.env["SVC_CODESPACE_WAIT_MS"] ?? String(DEFAULT_WAIT_MS), 10);
    const start = Date.now();

    log.info(`[bootstrap] waiting for Codespace '${name}' → ${target} (up to ${Math.round(maxMs / 1000)}s)`);

    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const { data } = await this.octokit.codespaces.getForAuthenticatedUser({
          codespace_name: name,
        });
        const state = data.state ?? "Unknown";
        log.debug(`[bootstrap] Codespace '${name}' state: ${state}`);
        if (state === target) return;
        if (state === "Failed" || state === "Deleted") {
          throw new Error(`Codespace '${name}' entered terminal state: ${state}`);
        }
      } catch (err) {
        if ((err as Error).message.includes("terminal state")) throw err;
        log.warn(`[bootstrap] state poll failed: ${(err as Error).message}`);
      }
    }

    throw new Error(
      `Codespace '${name}' did not reach state '${target}' within ${Math.round(maxMs / 1000)}s`
    );
  }
}
