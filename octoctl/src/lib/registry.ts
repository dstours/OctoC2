/**
 * Read-only operator view of the controller's durable beacon registry.
 *
 * SQLite is authoritative. The legacy JSON snapshot is read only when no
 * SQLite database exists, which supports explicit pre-migration workflows
 * without silently preferring stale state.
 */

import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BeaconStatus = "active" | "dormant" | "lost";

export interface BeaconRecord {
  beaconId: string;
  issueNumber: number;
  publicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  firstSeen: string;
  lastSeen: string;
  status: BeaconStatus;
  lastSeq: number;
  /** Numeric catalog ID in SQLite; legacy snapshots may contain a kind name. */
  activeTentacle?: number | string;
}

interface RegistrySnapshot {
  version: 1;
  savedAt: string;
  beacons: BeaconRecord[];
}

interface BeaconRow {
  beacon_id: string;
  issue_number: number | null;
  x25519_public_key: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  first_seen: string;
  last_seen: string;
  status: BeaconStatus;
  last_seq: number;
  active_tentacle: number | null;
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env["OCTOC2_DATA_DIR"] ?? "./data";
}

/** Legacy compatibility path. */
export function registryPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "registry.json");
}

export function registryStorePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "octoc2.sqlite");
}

function mapBeacon(row: BeaconRow): BeaconRecord {
  return {
    beaconId: row.beacon_id,
    issueNumber: row.issue_number ?? 0,
    publicKey: row.x25519_public_key,
    hostname: row.hostname,
    username: row.username,
    os: row.os,
    arch: row.arch,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    status: row.status,
    lastSeq: row.last_seq,
    ...(row.active_tentacle !== null
      ? { activeTentacle: row.active_tentacle }
      : {}),
  };
}

function loadSqliteRegistry(path: string): BeaconRecord[] {
  const database = new Database(path, {
    readonly: true,
    strict: true,
  });
  try {
    const version = database
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get();
    if (!version || !Number.isSafeInteger(version.version)) {
      throw new Error("registry database has no valid schema version");
    }
    return database
      .query<BeaconRow, []>(
        `SELECT beacon_id,
                issue_number,
                x25519_public_key,
                hostname,
                username,
                os,
                arch,
                first_seen,
                last_seen,
                status,
                last_seq,
                active_tentacle
         FROM beacons
         ORDER BY beacon_id`,
      )
      .all()
      .map(mapBeacon);
  } finally {
    database.close();
  }
}

export async function loadRegistry(dataDir?: string): Promise<BeaconRecord[]> {
  const storePath = registryStorePath(dataDir);
  if (existsSync(storePath)) {
    return loadSqliteRegistry(storePath);
  }

  const legacyPath = registryPath(dataDir);
  if (!existsSync(legacyPath)) return [];
  try {
    const raw = await readFile(legacyPath, "utf8");
    const snapshot = JSON.parse(raw) as RegistrySnapshot;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.beacons)) {
      throw new Error("legacy registry snapshot has an unsupported format");
    }
    return snapshot.beacons;
  } catch (error) {
    throw new Error(
      `Could not read legacy registry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getBeacon(
  beaconId: string,
  dataDir?: string,
): Promise<BeaconRecord | undefined> {
  const beacons = await loadRegistry(dataDir);
  const exact = beacons.find((beacon) => beacon.beaconId === beaconId);
  if (exact) return exact;
  const prefixes = beacons.filter((beacon) =>
    beacon.beaconId.startsWith(beaconId)
  );
  if (prefixes.length > 1) {
    throw new Error(
      `Beacon ID prefix '${beaconId}' is ambiguous (${prefixes.length} matches)`,
    );
  }
  return prefixes[0];
}
