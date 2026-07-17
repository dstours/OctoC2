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
const ACK_RE = /^INFRA_CFG_([0-9A-F]{8})$/i;
const RESULT_RE = /^INFRA_LOG_([0-9A-F]{8})$/i;

interface SecretsChannelOpts {
  owner: string;
  repo: string;
  token: string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs: number;
  octokit: Octokit;
}

export class SecretsChannel {
  private readonly runner: PollRunner;
  private readonly ackProgress: DurablePollState;
  private readonly resultProgress: DurablePollState;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue: TaskQueue,
    private readonly opts: SecretsChannelOpts,
    private readonly services: SecureChannelServices,
  ) {
    const scope = repositoryPollScope(opts.owner, opts.repo);
    this.ackProgress = new DurablePollState(
      services.store,
      "secrets-ack-poll",
      scope,
    );
    this.resultProgress = new DurablePollState(
      services.store,
      "secrets-result-poll",
      scope,
    );
    this.runner = new PollRunner({
      name: "SecretsChannel",
      intervalMs: opts.pollIntervalMs,
      poll: () => this.poll(),
      onError: (error) => {
        console.error(
          "[SecretsChannel] Poll error:",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  start(): void {
    this.runner.start();
    console.log("[SecretsChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[SecretsChannel] Stopped");
  }

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    const variables = await this.listVariables(owner, repo);
    const deliveryEligible =
      await this.processAckVariables(owner, repo, variables);
    await this.processResultVariables(owner, repo, variables);
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
    _owner: string,
    _repo: string,
    variables: any[],
  ): Promise<Map<string, string>> {
    const deliveryEligible = new Map<string, string>();
    for (const variable of sortArtifacts(variables)) {
      const name = String(variable.name ?? "");
      const match = ACK_RE.exec(name);
      if (!match) continue;
      const id8 = match[1]!;

      try {
        const encoded = String(variable.value ?? "").trim();
        const serialized = Buffer.from(encoded, "base64").toString("utf8");
        const version =
          variable.updated_at ??
          variable.created_at ??
          sha256Hex(encoded);
        const messageId =
          `ack:${name}:${String(version)}:${sha256Hex(encoded)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.ackProgress,
          {
            messageId,
            payload: encoded,
            cursor: artifactTimestamp(variable),
          },
          "malformed Secrets ACK variable",
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
              "7b",
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
          rejectArtifact("conflicting ACK variable");
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
          "[SecretsChannel] ACK processing error:",
          (error as Error).message,
        );
      }
    }
    return deliveryEligible;
  }

  private async processResultVariables(
    owner: string,
    repo: string,
    variables: any[],
  ): Promise<void> {
    for (const variable of sortArtifacts(variables)) {
      const name = String(variable.name ?? "");
      const match = RESULT_RE.exec(name);
      if (!match) continue;
      const taskId8 = match[1]!;

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
          "malformed Secrets result variable",
          async () => {
            if (!sealed) rejectArtifact("result variable is empty");
            const result = parseTaskResult(new TextDecoder().decode(
              await openSealBox(
                sealed,
                operatorPublicKey,
                this.opts.operatorSecretKey,
              ),
            ));
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
                  channel: "secrets",
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
          rejectArtifact("conflicting result variable");
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
          "[SecretsChannel] Result processing error:",
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
      const pending = this.queue.getDeliverableTasks(beaconId, "secrets");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "secrets",
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
        const name = `INFRA_STATE_${id8}`;
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
      } catch (error) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          error,
        );
        console.warn(
          `[SecretsChannel] Task delivery error for ${beaconId}:`,
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
