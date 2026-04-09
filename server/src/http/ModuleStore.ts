/**
 * OctoC2 Server — ModuleStore
 *
 * Per-beacon disk storage for compiled module binaries.
 * Storage layout: <dataDir>/modules/<beaconId>/<name>  (raw binary, no extension)
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

export class ModuleStore {
  constructor(private readonly dataDir: string) {}

  private beaconDir(beaconId: string): string {
    return join(this.dataDir, "modules", beaconId);
  }

  private modulePath(beaconId: string, name: string): string {
    return join(this.beaconDir(beaconId), name);
  }

  /** Store a module binary. Creates parent directories. Uses atomic write. */
  async store(beaconId: string, name: string, data: Uint8Array): Promise<void> {
    const dir  = this.beaconDir(beaconId);
    const dest = this.modulePath(beaconId, name);
    const tmp  = `${dest}.tmp`;

    await mkdir(dir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, dest);
  }

  /** Fetch a module binary. Returns null if not found. */
  async fetch(beaconId: string, name: string): Promise<Uint8Array | null> {
    const path = this.modulePath(beaconId, name);
    if (!existsSync(path)) return null;
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /** List module names for a beacon. Returns sorted array. */
  async list(beaconId: string): Promise<string[]> {
    const dir = this.beaconDir(beaconId);
    if (!existsSync(dir)) return [];
    try {
      const entries = await readdir(dir);
      return entries.sort();
    } catch {
      return [];
    }
  }
}
