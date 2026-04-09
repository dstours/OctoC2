/**
 * OctoC2 — BeaconState unit tests
 *
 * Covers: createState, loadState, atomic writes, path resolution,
 * nextSeq(), field mutability, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createState, loadState, type BeaconStateData } from "../state/BeaconState.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

const TEST_BEACON_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_KEY_PAIR  = {
  publicKey: "dGVzdHB1YmxpY2tleWJ5dGVzMTIzNDU2Nzg5MDEyMzQ",
  secretKey: "dGVzdHNlY3JldGtleWJ5dGVzMTIzNDU2Nzg5MDEyMzQ",
};

// Each test gets its own isolated temp directory via XDG_CONFIG_HOME override
let testDir: string;
let originalXdg: string | undefined;

beforeEach(async () => {
  testDir    = join(tmpdir(), `svc-test-${crypto.randomUUID()}`);
  originalXdg = process.env["XDG_CONFIG_HOME"];
  // Override XDG so state files land in our test dir, not ~/.config
  process.env["XDG_CONFIG_HOME"] = testDir;
  await mkdir(join(testDir, "svc"), { recursive: true });
});

afterEach(async () => {
  // Restore env and clean up
  if (originalXdg !== undefined) {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  } else {
    delete process.env["XDG_CONFIG_HOME"];
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── createState ───────────────────────────────────────────────────────────────

describe("createState", () => {
  it("creates a state file with correct initial values", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);

    expect(state.beaconId).toBe(TEST_BEACON_ID);
    expect(state.issueNumber).toBeNull();
    expect(state.seq).toBe(0);
    expect(state.lastTaskCommentId).toBeNull();
    expect(state.registrationStatus).toBe("pending");
    expect(state.keyPair).toEqual(TEST_KEY_PAIR);
  });

  it("writes the file to disk immediately", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    expect(existsSync(state.filePath)).toBe(true);
  });

  it("creates valid JSON on disk", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    const raw   = await readFile(state.filePath, "utf8");
    const data  = JSON.parse(raw) as BeaconStateData;

    expect(data.version).toBe(1);
    expect(data.beaconId).toBe(TEST_BEACON_ID);
  });

  it("file path is inside the XDG config dir (Linux/macOS)", async () => {
    if (process.platform === "win32") return; // skip on Windows
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    expect(state.filePath).toContain(testDir);
    expect(state.filePath).toContain("svc");
    expect(state.filePath).toContain(TEST_BEACON_ID);
  });

  it("falls back to ./svc-state.json when directory cannot be created", async () => {
    // Point XDG at a path we can't write to (a file, not a dir)
    const blockingFile = join(testDir, "blocking-file");
    await writeFile(blockingFile, "not a dir");
    process.env["XDG_CONFIG_HOME"] = blockingFile; // mkdir will fail

    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    expect(state.filePath).toBe("./svc-state.json");

    // Clean up fallback file
    await rm("./svc-state.json", { force: true });
  });
});

// ── loadState ─────────────────────────────────────────────────────────────────

describe("loadState", () => {
  it("returns null when no state file exists (first run)", async () => {
    const state = await loadState(TEST_BEACON_ID);
    expect(state).toBeNull();
  });

  it("loads a previously created state", async () => {
    await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    const loaded = await loadState(TEST_BEACON_ID);

    expect(loaded).not.toBeNull();
    expect(loaded!.beaconId).toBe(TEST_BEACON_ID);
    expect(loaded!.keyPair).toEqual(TEST_KEY_PAIR);
    expect(loaded!.registrationStatus).toBe("pending");
  });

  it("round-trips all fields correctly", async () => {
    const created = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);

    // Mutate and persist
    created.issueNumber       = 42;
    created.lastTaskCommentId = 987654321;
    created.registrationStatus = "registered";
    created.nextSeq(); // seq → 1
    await created.persist();

    const loaded = await loadState(TEST_BEACON_ID);
    expect(loaded!.issueNumber).toBe(42);
    expect(loaded!.lastTaskCommentId).toBe(987654321);
    expect(loaded!.registrationStatus).toBe("registered");
    expect(loaded!.seq).toBe(1);
  });

  it("persists and round-trips issueTitle correctly", async () => {
    const created = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    expect(created.issueTitle).toBeNull();

    created.issueTitle = "Fix: rotate stale tokens on beacon-host";
    await created.persist();

    const loaded = await loadState(TEST_BEACON_ID);
    expect(loaded!.issueTitle).toBe("Fix: rotate stale tokens on beacon-host");
  });

  it("returns null for a state file belonging to a different beacon", async () => {
    await createState(TEST_BEACON_ID, TEST_KEY_PAIR);

    // Ask for a different beaconId
    const other = await loadState("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(other).toBeNull();
  });

  it("returns null for a state file with unknown version", async () => {
    const path = join(testDir, "svc", `${TEST_BEACON_ID}.json`);
    await writeFile(path, JSON.stringify({ version: 99, beaconId: TEST_BEACON_ID }));

    const state = await loadState(TEST_BEACON_ID);
    expect(state).toBeNull();
  });

  it("returns null for a corrupted (non-JSON) state file", async () => {
    const path = join(testDir, "svc", `${TEST_BEACON_ID}.json`);
    await writeFile(path, "not valid json {{{{");

    const state = await loadState(TEST_BEACON_ID);
    expect(state).toBeNull();
  });
});

// ── persist (atomic write) ────────────────────────────────────────────────────

describe("persist / atomic write", () => {
  it("does not leave a .tmp file behind after a successful write", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    state.issueNumber = 99;
    await state.persist();

    expect(existsSync(`${state.filePath}.tmp`)).toBe(false);
    expect(existsSync(state.filePath)).toBe(true);
  });

  it("updates the file on disk when called again", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);

    state.issueNumber = 1;
    await state.persist();
    const snap1 = JSON.parse(await readFile(state.filePath, "utf8")) as BeaconStateData;
    expect(snap1.issueNumber).toBe(1);

    state.issueNumber = 2;
    await state.persist();
    const snap2 = JSON.parse(await readFile(state.filePath, "utf8")) as BeaconStateData;
    expect(snap2.issueNumber).toBe(2);
  });

  it("file permissions are 0600 (owner read/write only)", async () => {
    if (process.platform === "win32") return; // chmod is no-op on Windows
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    const info  = await stat(state.filePath);
    // stat.mode & 0o777 gives the permission bits
    expect(info.mode & 0o777).toBe(0o600);
  });
});

// ── maintenance session fields ────────────────────────────────────────────────

it("state created with createState() includes maintenance session defaults", async () => {
  const dir = join(tmpdir(), `bs-maint-${crypto.randomUUID()}`);
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "svc"), { recursive: true });

  const beaconId = crypto.randomUUID();
  const kp = { publicKey: "pubkey-b64", secretKey: "seckey-b64" };

  const state = await createState(beaconId, kp);

  expect(state.maintenanceCommentId).toBeNull();
  expect(state.maintenanceSessionId).toBeNull();
  expect(state.maintenanceSessionOpenedAt).toBeNull();
  expect(state.lastMaintenanceUpdateMs).toBe(0);
  expect(state.initialMaintenancePosted).toBe(false);
  expect(state.regCommentId).toBeNull();
  expect(state.issueTitle).toBeNull();

  await rm(dir, { recursive: true, force: true });
  delete process.env["XDG_CONFIG_HOME"];
});

it("loadState() back-fills maintenance defaults for legacy state file (missing fields)", async () => {
  const dir = join(tmpdir(), `bs-maint-legacy-${crypto.randomUUID()}`);
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "svc"), { recursive: true });

  const beaconId = crypto.randomUUID();
  // Write a legacy-style state file that lacks the new fields
  const legacyData = {
    version: 1,
    beaconId,
    issueNumber: null,
    seq: 5,
    lastTaskCommentId: null,
    registrationStatus: "registered",
    ciCommentId: 42,
    keyPair: { publicKey: "pub", secretKey: "sec" },
    // Note: NO maintenance fields
  };
  await writeFile(
    join(dir, "svc", `${beaconId}.json`),
    JSON.stringify(legacyData),
    "utf8"
  );

  const state = await loadState(beaconId);
  expect(state).not.toBeNull();
  expect(state!.maintenanceCommentId).toBeNull();
  expect(state!.maintenanceSessionId).toBeNull();
  expect(state!.maintenanceSessionOpenedAt).toBeNull();
  expect(state!.lastMaintenanceUpdateMs).toBe(0);
  expect(state!.initialMaintenancePosted).toBe(false);
  expect(state!.regCommentId).toBeNull();
  expect(state!.issueTitle).toBeNull();

  await rm(dir, { recursive: true, force: true });
  delete process.env["XDG_CONFIG_HOME"];
});

// ── nextSeq ───────────────────────────────────────────────────────────────────

describe("nextSeq", () => {
  it("starts at 0 and increments to 1 on first call", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    expect(state.seq).toBe(0);
    expect(state.nextSeq()).toBe(1);
    expect(state.seq).toBe(1);
  });

  it("increments monotonically across multiple calls", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    for (let i = 1; i <= 10; i++) {
      expect(state.nextSeq()).toBe(i);
    }
    expect(state.seq).toBe(10);
  });

  it("seq is persisted correctly", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR);
    state.nextSeq();
    state.nextSeq();
    state.nextSeq(); // seq = 3
    await state.persist();

    const loaded = await loadState(TEST_BEACON_ID);
    expect(loaded!.seq).toBe(3);
  });
});
