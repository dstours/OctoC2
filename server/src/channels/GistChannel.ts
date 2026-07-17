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

interface GistChannelOpts {
  owner: string;
  repo: string;
  token: string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs: number;
  octokit: Octokit;
}

export class GistChannel {
  private readonly runner: PollRunner;
  private readonly ackProgress: DurablePollState;
  private readonly resultProgress: DurablePollState;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly opts: GistChannelOpts,
    private readonly services: SecureChannelServices,
  ) {
    const scope = repositoryPollScope(opts.owner, opts.repo);
    this.ackProgress = new DurablePollState(
      services.store,
      "gist-ack-poll",
      scope,
    );
    this.resultProgress = new DurablePollState(
      services.store,
      "gist-result-poll",
      scope,
    );
    this.runner = new PollRunner({
      name: "GistChannel",
      intervalMs: opts.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.error(
          "[GistChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log("[GistChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[GistChannel] Stopped");
  }

  private async poll(): Promise<void> {
    const listed = await collectGitHubPages(
      (page, per_page) =>
        this.opts.octokit.rest.gists.list({ page, per_page }),
      (response) => response.data as any[],
    );
    const gists = listed.sort((left: any, right: any) =>
      artifactTimestamp(left).localeCompare(artifactTimestamp(right))
    );
    const deliveryEligible = await this.processAckGists(gists);
    await this.processResultGists(gists);
    await this.deliverPendingTasks(deliveryEligible);
  }

  private async processAckGists(gists: any[]): Promise<Set<string>> {
    const deliveryEligible = new Set<string>();
    for (const gist of gists) {
      const files = (gist.files ?? {}) as Record<string, any>;
      const filename = Object.keys(files).find((name) =>
        name.startsWith("svc-a-") && name.endsWith(".json")
      );
      if (!filename) continue;

      try {
        const response = await this.opts.octokit.rest.gists.get({
          gist_id: gist.id,
        });
        const serialized = String(
          (response.data as any).files?.[filename]?.content ?? "",
        );
        const id8 = filename.slice("svc-a-".length, -".json".length);
        const version =
          gist.updated_at ??
          gist.created_at ??
          sha256Hex(serialized);
        const messageId =
          `ack:${String(gist.id)}:${String(version)}:${sha256Hex(serialized)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.ackProgress,
          {
            messageId,
            payload: serialized,
            cursor: artifactTimestamp(gist),
          },
          "malformed ACK gist",
          () => {
            const checkin = parseCheckinPayload(serialized);
            if (!checkin.beaconId.startsWith(id8)) {
              rejectArtifact(
                "ACK gist filename does not match signed beaconId",
              );
            }
            return checkin;
          },
          async (checkin) => {
            const status =
              await this.services.identities.verifyAndRegisterCheckin(
              checkin,
              checkin.beaconId,
              6,
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
          rejectArtifact("conflicting ACK gist");
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
          "[GistChannel] ACK processing error:",
          (error as Error).message,
        );
      }
    }
    return deliveryEligible;
  }

  private async processResultGists(gists: any[]): Promise<void> {
    for (const gist of gists) {
      const files = (gist.files ?? {}) as Record<string, any>;
      const filename = Object.keys(files).find((name) =>
        name.startsWith("svc-r-") && name.endsWith(".json")
      );
      if (!filename) continue;

      try {
        const response = await this.opts.octokit.rest.gists.get({
          gist_id: gist.id,
        });
        const sealed = String(
          (response.data as any).files?.[filename]?.content ?? "",
        ).trim();
        await sodium.ready;
        const operatorPublicKey = sodium.crypto_scalarmult_base(
          this.opts.operatorSecretKey,
        );
        const id8 = filename.slice("svc-r-".length, -".json".length);
        const version =
          gist.updated_at ??
          gist.created_at ??
          sha256Hex(sealed);
        const messageId = `result:${String(gist.id)}:${String(version)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.resultProgress,
          {
            messageId,
            payload: sealed,
            cursor: artifactTimestamp(gist),
          },
          "malformed result gist",
          async () => {
            if (!sealed) rejectArtifact("result gist is empty");
            const result = parseTaskResult(new TextDecoder().decode(
              await openSealBox(
                sealed,
                operatorPublicKey,
                this.opts.operatorSecretKey,
              ),
            ));
            if (
              !result.beaconId.toLowerCase().startsWith(id8.toLowerCase())
            ) {
              rejectArtifact(
                "result gist filename does not match signed beaconId",
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
                  channel: "gist",
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
          rejectArtifact("conflicting result gist");
        }
        if (processed.outcome !== "rejected") {
          await this.opts.octokit.rest.gists.delete({ gist_id: gist.id });
        }
      } catch (error) {
        console.warn(
          "[GistChannel] Result processing error:",
          (error as Error).message,
        );
      }
    }
  }

  private async deliverPendingTasks(
    deliveryEligible: ReadonlySet<string>,
  ): Promise<void> {
    for (const beaconId of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "gist");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "gist",
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
        await this.opts.octokit.rest.gists.create({
          public: false,
          files: {
            [`svc-t-${beaconId.slice(0, 8)}.json`]: {
              content: JSON.stringify(encrypted),
            },
          },
        } as any);
        finishDeliveries(this.services, deliveries, "delivered");
        this.registry.updateActiveTentacle(beaconId, 6);
      } catch (error) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          error,
        );
        console.warn(
          `[GistChannel] Task delivery error for ${beaconId}:`,
          (error as Error).message,
        );
      }
    }
  }
}

function artifactTimestamp(artifact: any): string {
  const candidate = artifact.updated_at ?? artifact.created_at;
  const timestamp = typeof candidate === "string"
    ? new Date(candidate).getTime()
    : Number.NaN;
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}
