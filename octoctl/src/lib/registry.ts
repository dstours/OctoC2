/**
 * octoctl — registry reader
 *
 * Reads the server's persisted registry.json from disk.
 * The server writes this file on each auto-save and shutdown.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BeaconStatus = "active" | "dormant" | "lost";

export interface BeaconRecord {
  beaconId:       string;
  issueNumber:    number;
  publicKey:      string;  // base64url X25519
  hostname:       string;
  username:       string;
  os:             string;
  arch:           string;
  firstSeen:      string;
  lastSeen:       string;
  status:         BeaconStatus;
  lastSeq:        number;
  activeTentacle?: string;  // most-recently-used channel kind (may be absent offline)
}

interface RegistrySnapshot {
  version: 1;
  savedAt: string;
  beacons: BeaconRecord[];
}

export function registryPath(dataDir?: string): string {
  return join(dataDir ?? process.env["OCTOC2_DATA_DIR"] ?? "./data", "registry.json");
}

export async function loadRegistry(dataDir?: string): Promise<BeaconRecord[]> {
  const path = registryPath(dataDir);
  if (!existsSync(path)) return [];

  try {
    const raw  = await readFile(path, "utf8");
    const snap = JSON.parse(raw) as RegistrySnapshot;
    if (snap.version !== 1) return [];
    return snap.beacons;
  } catch {
    return [];
  }
}

export async function getBeacon(
  beaconId: string,
  dataDir?: string
): Promise<BeaconRecord | undefined> {
  const beacons = await loadRegistry(dataDir);
  return beacons.find(b => b.beaconId === beaconId || b.beaconId.startsWith(beaconId));
}
