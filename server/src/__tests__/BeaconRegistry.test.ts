import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BeaconRegistry } from "../BeaconRegistry.ts";
import { OctoStore } from "../store/index.ts";

const BASE = {
  beaconId: "abc-001",
  issueNumber: 7,
  publicKey: "cHViS2V5",
  hostname: "host1",
  username: "user1",
  os: "linux",
  arch: "x64",
  seq: 1,
};

describe("BeaconRegistry", () => {
  let dataDir: string;
  let registry: BeaconRegistry;
  let store: OctoStore | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "octoc2-registry-"));
    registry = new BeaconRegistry(dataDir);
  });

  afterEach(async () => {
    await registry.shutdown();
    store?.close();
    store = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("activeTentacle", () => {
    it("is undefined when register() is called without tentacleId", () => {
      const record = registry.register(BASE);
      expect(record.activeTentacle).toBeUndefined();
    });

    it("is set when register() is called with tentacleId", () => {
      const record = registry.register({ ...BASE, tentacleId: 1 });
      expect(record.activeTentacle).toBe(1);
    });

    it("updateActiveTentacle() stores the tentacle and returns true", () => {
      registry.register(BASE);
      expect(registry.updateActiveTentacle("abc-001", 4)).toBe(true);
      expect(registry.get("abc-001")?.activeTentacle).toBe(4);
    });

    it("stores the historical Secrets channel ID without aliasing it to OIDC", () => {
      registry.register({ ...BASE, tentacleId: "7b" });
      expect(registry.get("abc-001")?.activeTentacle).toBe("7b");
    });

    it("updateActiveTentacle() returns false for unknown beacon", () => {
      expect(registry.updateActiveTentacle("no-such-id", 4)).toBe(false);
    });

    it("preserves activeTentacle across re-registration when omitted", () => {
      registry.register({ ...BASE, tentacleId: 4 });
      registry.register({ ...BASE, seq: 2 });
      expect(registry.get("abc-001")?.activeTentacle).toBe(4);
    });
  });

  it("retains JSON snapshot compatibility without an OctoStore", async () => {
    for (let i = 0; i < 10; i++) {
      registry.register({
        ...BASE,
        beaconId: `b${i}`,
        issueNumber: i + 1,
      });
    }
    await registry.shutdown();

    const snapshot = JSON.parse(
      await Bun.file(join(dataDir, "registry.json")).text(),
    ) as { beacons: unknown[] };
    expect(snapshot.beacons).toHaveLength(10);
  });

  it("loads OctoStore's backed-up legacy import, including issue-zero beacons", async () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: "2026-07-16T00:00:00.000Z",
      beacons: [
        {
          beaconId: "legacy-a",
          issueNumber: 0,
          publicKey: "legacy-x25519-a",
          hostname: "alpha",
          username: "alice",
          os: "linux",
          arch: "x64",
          firstSeen: "2026-07-15T00:00:00.000Z",
          lastSeen: "2026-07-16T00:00:00.000Z",
          status: "active",
          lastSeq: 3,
        },
        {
          beaconId: "legacy-b",
          issueNumber: 0,
          publicKey: "legacy-x25519-b",
          hostname: "beta",
          username: "bob",
          os: "windows",
          arch: "x64",
          firstSeen: "2026-07-15T00:00:00.000Z",
          lastSeen: "2026-07-16T00:00:00.000Z",
          status: "active",
          lastSeq: 4,
        },
      ],
    });
    writeFileSync(join(dataDir, "registry.json"), raw, "utf8");

    store = OctoStore.open({ dataDir });
    expect(store.legacyImport.status).toBe("imported");
    expect(store.legacyImport.importedCount).toBe(2);
    registry = new BeaconRegistry(store);
    await registry.load();

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get("legacy-a")).toMatchObject({
      issueNumber: 0,
      publicKey: "legacy-x25519-a",
      status: "dormant",
      lastSeq: 3,
    });
    expect(
      existsSync(join(dataDir, "registry.json.pre-sqlite.bak")),
    ).toBe(true);
  });

  it("persists mutations and replay state across an OctoStore restart", async () => {
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    registry = new BeaconRegistry(store);
    registry.register({
      ...BASE,
      issueNumber: 0,
      tentacleId: 2,
    });

    expect(registry.updateActiveTentacle(BASE.beaconId, 7)).toBe(true);
    expect(registry.advanceSeq(BASE.beaconId, 2)).toBe("ok");
    expect(registry.advanceSeq(BASE.beaconId, 2)).toBe("replay");
    expect(registry.advanceSeq(BASE.beaconId, 200)).toBe("gap");
    expect(registry.updateLastSeen(BASE.beaconId, 199)).toBe(true);
    registry.markLost(BASE.beaconId);
    expect(store.getBeacon(BASE.beaconId)).toMatchObject({
      issueNumber: null,
      activeTentacle: 7,
      lastSeq: 200,
      status: "lost",
    });

    await registry.shutdown();
    store.close();
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    registry = new BeaconRegistry(dataDir, store);
    await registry.load();

    expect(registry.get(BASE.beaconId)).toMatchObject({
      issueNumber: 0,
      activeTentacle: 7,
      lastSeq: 200,
      status: "dormant",
    });
    expect(store.getBeacon(BASE.beaconId)?.status).toBe("dormant");
  });

  it("sweeps stale beacons through dormant and lost states durably", async () => {
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    registry = new BeaconRegistry(store);
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const record = registry.register(BASE);

    record.lastSeen = new Date(now - 15 * 60 * 1000).toISOString();
    registry.sweepStatuses(10 * 60 * 1000, 60 * 60 * 1000, now);
    expect(registry.get(BASE.beaconId)?.status).toBe("dormant");
    expect(store.getBeacon(BASE.beaconId)?.status).toBe("dormant");

    record.lastSeen = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    registry.sweepStatuses(10 * 60 * 1000, 60 * 60 * 1000, now);
    expect(registry.get(BASE.beaconId)?.status).toBe("lost");
    expect(store.getBeacon(BASE.beaconId)?.status).toBe("lost");

    expect(() => registry.sweepStatuses(60_000, 60_000, now)).toThrow(
      /lostAfterMs > dormantAfterMs/,
    );
  });
});
