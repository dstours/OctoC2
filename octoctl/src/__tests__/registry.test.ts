import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBeacon,
  loadRegistry,
  registryStorePath,
} from "../lib/registry.ts";

function createStore(dataDir: string): Database {
  const database = new Database(registryStorePath(dataDir), {
    create: true,
    strict: true,
  });
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES (
      1,
      'initial',
      '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE beacons (
      beacon_id TEXT PRIMARY KEY,
      issue_number INTEGER,
      x25519_public_key TEXT NOT NULL,
      hostname TEXT NOT NULL,
      username TEXT NOT NULL,
      os TEXT NOT NULL,
      arch TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      active_tentacle INTEGER
    );
  `);
  return database;
}

function insertBeacon(database: Database, id: string, issue: number): void {
  database
    .query(
      `INSERT INTO beacons (
         beacon_id, issue_number, x25519_public_key, hostname, username,
         os, arch, first_seen, last_seen, status, last_seq, active_tentacle
       ) VALUES (?, ?, 'x-key', 'host', 'user', 'linux', 'x64',
                 '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
                 'active', 7, 3)`,
    )
    .run(id, issue);
}

describe("operator registry reader", () => {
  it("prefers authoritative SQLite over a stale legacy snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "octoctl-registry-"));
    await writeFile(
      join(dataDir, "registry.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        beacons: [{ beaconId: "stale-json" }],
      }),
    );
    const database = createStore(dataDir);
    insertBeacon(database, "sqlite-beacon", 42);
    database.close();

    const beacons = await loadRegistry(dataDir);
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toMatchObject({
      beaconId: "sqlite-beacon",
      issueNumber: 42,
      publicKey: "x-key",
      activeTentacle: 3,
      lastSeq: 7,
    });
  });

  it("uses JSON only when no SQLite database exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "octoctl-legacy-"));
    await writeFile(
      join(dataDir, "registry.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        beacons: [
          {
            beaconId: "legacy-beacon",
            issueNumber: 4,
            publicKey: "x",
            hostname: "host",
            username: "user",
            os: "linux",
            arch: "x64",
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
            status: "dormant",
            lastSeq: 1,
          },
        ],
      }),
    );
    expect((await loadRegistry(dataDir))[0]?.beaconId).toBe("legacy-beacon");
  });

  it("rejects ambiguous prefixes while allowing exact IDs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "octoctl-prefix-"));
    const database = createStore(dataDir);
    insertBeacon(database, "abc-one", 1);
    insertBeacon(database, "abc-two", 2);
    database.close();

    await expect(getBeacon("abc", dataDir)).rejects.toThrow(/ambiguous/);
    expect((await getBeacon("abc-one", dataDir))?.issueNumber).toBe(1);
  });
});
