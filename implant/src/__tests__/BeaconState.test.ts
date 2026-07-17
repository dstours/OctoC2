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
  publicKey: Buffer.alloc(32, 1).toString("base64url"),
  secretKey: Buffer.alloc(32, 2).toString("base64url"),
};
const TEST_SIGNING_KEY_PAIR = {
  publicKey: Buffer.alloc(32, 3).toString("base64url"),
  secretKey: Buffer.alloc(64, 4).toString("base64url"),
  keyId: "ed25519:test",
};

// Each test gets its own isolated temp directory via XDG_CONFIG_HOME override
let testDir: string;
let originalXdg: string | undefined;
let originalAppData: string | undefined;

beforeEach(async () => {
  testDir    = join(tmpdir(), `svc-test-${crypto.randomUUID()}`);
  originalXdg = process.env["XDG_CONFIG_HOME"];
  originalAppData = process.env["APPDATA"];
  // Override XDG so state files land in our test dir, not ~/.config
  process.env["XDG_CONFIG_HOME"] = testDir;
  // Windows resolves state below APPDATA rather than XDG_CONFIG_HOME.
  process.env["APPDATA"] = testDir;
  await mkdir(join(testDir, "svc"), { recursive: true });
});

afterEach(async () => {
  // Restore env and clean up
  if (originalXdg !== undefined) {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  } else {
    delete process.env["XDG_CONFIG_HOME"];
  }
  if (originalAppData !== undefined) {
    process.env["APPDATA"] = originalAppData;
  } else {
    delete process.env["APPDATA"];
  }
  await rm("./svc-state.json", { force: true });
  await rm(testDir, { recursive: true, force: true });
});

// ── createState ───────────────────────────────────────────────────────────────

describe("createState", () => {
  it("creates a state file with correct initial values", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);

    expect(state.beaconId).toBe(TEST_BEACON_ID);
    expect(state.issueNumber).toBeNull();
    expect(state.seq).toBe(0);
    expect(state.lastTaskCommentId).toBeNull();
    expect(state.registrationStatus).toBe("pending");
    expect(state.keyPair).toEqual(TEST_KEY_PAIR);
  });

  it("writes the file to disk immediately", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    expect(existsSync(state.filePath)).toBe(true);
  });

  it("creates valid JSON on disk", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    const raw   = await readFile(state.filePath, "utf8");
    const data  = JSON.parse(raw) as BeaconStateData;

    expect(data.version).toBe(2);
    expect(data.beaconId).toBe(TEST_BEACON_ID);
    expect(data.seenTaskFilter.version).toBe(1);
  });

  it("file path is inside the XDG config dir (Linux/macOS)", async () => {
    if (process.platform === "win32") return; // skip on Windows
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    expect(state.filePath).toContain(testDir);
    expect(state.filePath).toContain("svc");
    expect(state.filePath).toContain(TEST_BEACON_ID);
  });

  it("falls back to ./svc-state.json when directory cannot be created", async () => {
    // Point XDG at a path we can't write to (a file, not a dir)
    const blockingFile = join(testDir, "blocking-file");
    await writeFile(blockingFile, "not a dir");
    process.env["XDG_CONFIG_HOME"] = blockingFile; // mkdir will fail
    process.env["APPDATA"] = blockingFile;

    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    expect(state.filePath).toBe("./svc-state.json");

    // Clean up fallback file
    await rm("./svc-state.json", { force: true });
  });

  it("uses beacon-specific scoped fallback files for a shared proxy route", async () => {
    const blockingFile = join(testDir, "blocking-scoped");
    await writeFile(blockingFile, "not a dir");
    process.env["XDG_CONFIG_HOME"] = blockingFile;
    process.env["APPDATA"] = blockingFile;
    const scope = "proxy:acme/shared-decoy";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    const first = await createState(
      firstId,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
      { scope, issueNumber: 7 },
    );
    const second = await createState(
      secondId,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
      { scope, issueNumber: 8 },
    );
    try {
      expect(first.filePath).not.toBe(second.filePath);
      expect(first.filePath).toMatch(/^\.\/svc-state\.[0-9a-f]{24}\.json$/);
      expect(second.filePath).toMatch(/^\.\/svc-state\.[0-9a-f]{24}\.json$/);
      expect((await loadState(firstId, undefined, scope))?.issueNumber).toBe(7);
      expect((await loadState(secondId, undefined, scope))?.issueNumber).toBe(8);
    } finally {
      await rm(first.filePath, { force: true });
      await rm(second.filePath, { force: true });
    }
  });
});

// ── loadState ─────────────────────────────────────────────────────────────────

describe("loadState", () => {
  it("returns null when no state file exists (first run)", async () => {
    const state = await loadState(TEST_BEACON_ID);
    expect(state).toBeNull();
  });

  it("loads a previously created state", async () => {
    await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    const loaded = await loadState(TEST_BEACON_ID);

    expect(loaded).not.toBeNull();
    expect(loaded!.beaconId).toBe(TEST_BEACON_ID);
    expect(loaded!.keyPair).toEqual(TEST_KEY_PAIR);
    expect(loaded!.registrationStatus).toBe("pending");
  });

  it("round-trips all fields correctly", async () => {
    const created = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);

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

  it("keeps proxy Issues state independent and persistent across restarts", async () => {
    const scope = "proxy:acme/decoy";
    const primary = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    primary.issueNumber = 42;
    primary.lastTaskCommentId = 100;
    primary.registrationStatus = "registered";
    primary.nextSeq();
    await primary.persist();

    const proxy = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
      { scope, issueNumber: 7 },
    );
    proxy.lastTaskCommentId = 900;
    proxy.registrationStatus = "registered";
    proxy.nextSeq();
    proxy.nextSeq();
    await proxy.persist();

    const reloadedPrimary = await loadState(TEST_BEACON_ID);
    const reloadedProxy = await loadState(
      TEST_BEACON_ID,
      undefined,
      scope,
    );
    expect(reloadedPrimary?.filePath).not.toBe(reloadedProxy?.filePath);
    expect(reloadedPrimary?.issueNumber).toBe(42);
    expect(reloadedPrimary?.lastTaskCommentId).toBe(100);
    expect(reloadedPrimary?.registrationStatus).toBe("registered");
    expect(reloadedPrimary?.seq).toBe(1);
    expect(reloadedProxy?.issueNumber).toBe(7);
    expect(reloadedProxy?.lastTaskCommentId).toBe(900);
    expect(reloadedProxy?.registrationStatus).toBe("registered");
    expect(reloadedProxy?.seq).toBe(2);
  });

  it("persists and round-trips issueTitle correctly", async () => {
    const created = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    expect(created.issueTitle).toBeNull();

    created.issueTitle = "Fix: rotate stale tokens on beacon-host";
    await created.persist();

    const loaded = await loadState(TEST_BEACON_ID);
    expect(loaded!.issueTitle).toBe("Fix: rotate stale tokens on beacon-host");
  });

  it("rejects a state file belonging to a different beacon", async () => {
    const path = join(testDir, "svc", `${TEST_BEACON_ID}.json`);
    const created = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const data = created.toJSON();
    data.beaconId = "7f7f6f2e-8c3c-4b4d-8b02-f9a53f6a2921";
    await writeFile(path, JSON.stringify(data));

    await expect(loadState(TEST_BEACON_ID)).rejects.toThrow(
      "state belongs to beacon",
    );
  });

  it("rejects a state file with unknown version", async () => {
    const path = join(testDir, "svc", `${TEST_BEACON_ID}.json`);
    await writeFile(path, JSON.stringify({ version: 99, beaconId: TEST_BEACON_ID }));

    await expect(loadState(TEST_BEACON_ID)).rejects.toThrow(
      "unsupported version 99",
    );
  });

  it("rejects a corrupted (non-JSON) state file", async () => {
    const path = join(testDir, "svc", `${TEST_BEACON_ID}.json`);
    await writeFile(path, "not valid json {{{{");

    await expect(loadState(TEST_BEACON_ID)).rejects.toThrow(
      "Could not parse beacon state",
    );
  });

  it("rejects simultaneous primary and fallback state", async () => {
    const primary = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    await writeFile("./svc-state.json", await readFile(primary.filePath, "utf8"));

    await expect(loadState(TEST_BEACON_ID)).rejects.toThrow(
      "Primary and fallback beacon state both exist",
    );
  });
});

// ── persist (atomic write) ────────────────────────────────────────────────────

describe("persist / atomic write", () => {
  it("does not leave a .tmp file behind after a successful write", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    state.issueNumber = 99;
    await state.persist();

    expect(existsSync(`${state.filePath}.tmp`)).toBe(false);
    expect(existsSync(state.filePath)).toBe(true);
  });

  it("updates the file on disk when called again", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);

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
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    const info  = await stat(state.filePath);
    // stat.mode & 0o777 gives the permission bits
    expect(info.mode & 0o777).toBe(0o600);
  });
});

// ── maintenance session fields ────────────────────────────────────────────────

it("state created with createState() includes maintenance session defaults", async () => {
  const dir = join(tmpdir(), `bs-maint-${crypto.randomUUID()}`);
  process.env["XDG_CONFIG_HOME"] = dir;
  process.env["APPDATA"] = dir;
  await mkdir(join(dir, "svc"), { recursive: true });

  const beaconId = crypto.randomUUID();
  const state = await createState(
    beaconId,
    TEST_KEY_PAIR,
    TEST_SIGNING_KEY_PAIR,
  );

  expect(state.maintenanceCommentId).toBeNull();
  expect(state.maintenanceSessionId).toBeNull();
  expect(state.maintenanceSessionOpenedAt).toBeNull();
  expect(state.lastMaintenanceUpdateMs).toBe(0);
  expect(state.initialMaintenancePosted).toBe(false);
  expect(state.regCommentId).toBeNull();
  expect(state.issueTitle).toBeNull();

  await rm(dir, { recursive: true, force: true });
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["APPDATA"];
});

it("loadState() requires provisioned signing identity and backs up state-v1 migration", async () => {
  const dir = join(tmpdir(), `bs-maint-legacy-${crypto.randomUUID()}`);
  process.env["XDG_CONFIG_HOME"] = dir;
  process.env["APPDATA"] = dir;
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
    keyPair: TEST_KEY_PAIR,
    // Note: NO maintenance fields
  };
  await writeFile(
    join(dir, "svc", `${beaconId}.json`),
    JSON.stringify(legacyData),
    "utf8"
  );

  await expect(loadState(beaconId)).rejects.toThrow(
    "requires an explicitly provisioned Ed25519 signing identity",
  );
  const state = await loadState(beaconId, {
    signingKeyPair: TEST_SIGNING_KEY_PAIR,
  });
  expect(state).not.toBeNull();
  expect(state!.toJSON().version).toBe(2);
  expect(state!.signingKeyPair).toEqual(TEST_SIGNING_KEY_PAIR);
  expect(state!.maintenanceCommentId).toBeNull();
  expect(state!.maintenanceSessionId).toBeNull();
  expect(state!.maintenanceSessionOpenedAt).toBeNull();
  expect(state!.lastMaintenanceUpdateMs).toBe(0);
  expect(state!.initialMaintenancePosted).toBe(false);
  expect(state!.regCommentId).toBeNull();
  expect(state!.issueTitle).toBeNull();
  expect(existsSync(join(dir, "svc", `${beaconId}.json.v1.bak`))).toBe(true);

  await rm(dir, { recursive: true, force: true });
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["APPDATA"];
});

// ── nextSeq ───────────────────────────────────────────────────────────────────

describe("nextSeq", () => {
  it("starts at 0 and increments to 1 on first call", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    expect(state.seq).toBe(0);
    expect(state.nextSeq()).toBe(1);
    expect(state.seq).toBe(1);
  });

  it("increments monotonically across multiple calls", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    for (let i = 1; i <= 10; i++) {
      expect(state.nextSeq()).toBe(i);
    }
    expect(state.seq).toBe(10);
  });

  it("seq is persisted correctly", async () => {
    const state = await createState(TEST_BEACON_ID, TEST_KEY_PAIR, TEST_SIGNING_KEY_PAIR);
    state.nextSeq();
    state.nextSeq();
    state.nextSeq(); // seq = 3
    await state.persist();

    const loaded = await loadState(TEST_BEACON_ID);
    expect(loaded!.seq).toBe(3);
  });
});

describe("bounded task ledger safety", () => {
  it("backpressures at capacity instead of evicting active entries", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    for (let index = 0; index < 256; index += 1) {
      expect(state.beginTask(`active-${index}`)).toBe(true);
    }

    expect(() => state.beginTask("active-256")).toThrow(
      "no safely evictable entries",
    );
    expect(state.toJSON().taskLedger).toHaveLength(256);
    expect(state.beginTask("active-0")).toBe(false);
    expect(state.getTaskLedgerEntry("active-0")?.status).toBe("started");
  });

  it("evicts only a controller-accepted terminal entry to admit new work", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const terminalTaskId = "terminal-task";
    expect(state.beginTask(terminalTaskId)).toBe(true);
    state.completeTask({
      taskId: terminalTaskId,
      beaconId: TEST_BEACON_ID,
      success: true,
      output: "done",
      completedAt: new Date().toISOString(),
      signature: "signed",
    });
    await state.persistResultSubmitted(terminalTaskId);

    for (let index = 0; index < 255; index += 1) {
      expect(state.beginTask(`pending-${index}`)).toBe(true);
    }
    expect(state.toJSON().taskLedger).toHaveLength(256);

    expect(state.beginTask("new-task")).toBe(true);
    expect(state.getTaskLedgerEntry(terminalTaskId)).toBeUndefined();
    expect(state.getTaskLedgerEntry("pending-0")?.status).toBe("started");
    expect(state.getTaskLedgerEntry("new-task")?.status).toBe("started");
    expect(state.toJSON().taskLedger).toHaveLength(256);
  });

  it("never evicts a controller-accepted task with a pending directive", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const directiveTaskId = "pending-kill";
    expect(state.beginTask(directiveTaskId)).toBe(true);
    state.completeTask({
      taskId: directiveTaskId,
      beaconId: TEST_BEACON_ID,
      success: true,
      output: "pending",
      completedAt: new Date().toISOString(),
      signature: "signed",
    }, { kind: "kill" });
    await state.persistResultSubmitted(directiveTaskId);

    for (let index = 0; index < 255; index += 1) {
      expect(state.beginTask(`blocked-${index}`)).toBe(true);
    }
    expect(() => state.beginTask("overflow")).toThrow(
      "no safely evictable entries",
    );
    expect(state.getTaskLedgerEntry(directiveTaskId)?.directive).toEqual({
      kind: "kill",
    });
  });

  it("retains evicted task membership across persistence and restart", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const evictedTaskId = "accepted-and-evicted";
    expect(state.beginTask(evictedTaskId)).toBe(true);
    state.completeTask({
      taskId: evictedTaskId,
      beaconId: TEST_BEACON_ID,
      success: true,
      output: "done",
      completedAt: new Date().toISOString(),
      signature: "signed",
    });
    await state.persistResultSubmitted(evictedTaskId);
    for (let index = 0; index < 255; index += 1) {
      expect(state.beginTask(`retained-${index}`)).toBe(true);
    }
    expect(state.beginTask("replacement")).toBe(true);
    expect(state.getTaskLedgerEntry(evictedTaskId)).toBeUndefined();
    await state.persist();

    const reloaded = await loadState(TEST_BEACON_ID);
    expect(reloaded?.hasSeenTask(evictedTaskId)).toBe(true);
    expect(reloaded?.beginTask(evictedTaskId)).toBe(false);
    expect(reloaded?.getTaskLedgerEntry(evictedTaskId)).toBeUndefined();
  });

  it("fails closed on a persisted probabilistic filter match", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const data = state.toJSON();
    data.seenTaskFilter.bits = Buffer.alloc(262_144 / 8, 0xff)
      .toString("base64url");
    await writeFile(state.filePath, JSON.stringify(data));

    const reloaded = await loadState(TEST_BEACON_ID);
    expect(reloaded?.beginTask("false-positive-task")).toBe(false);
    expect(reloaded?.getTaskLedgerEntry("false-positive-task")).toBeUndefined();
  });

  it("migrates a safe pre-filter state and persists the filter immediately", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    expect(state.beginTask("pre-filter-task")).toBe(true);
    await state.persist();
    const legacyV2 = state.toJSON() as unknown as Record<string, unknown>;
    delete legacyV2["seenTaskFilter"];
    await writeFile(state.filePath, JSON.stringify(legacyV2));

    const reloaded = await loadState(TEST_BEACON_ID);
    expect(reloaded?.hasSeenTask("pre-filter-task")).toBe(true);
    const persisted = JSON.parse(
      await readFile(state.filePath, "utf8"),
    ) as BeaconStateData;
    expect(persisted.seenTaskFilter.version).toBe(1);
  });

  it("keeps acceptance markers on exact completion and rejects conflicts", async () => {
    const state = await createState(
      TEST_BEACON_ID,
      TEST_KEY_PAIR,
      TEST_SIGNING_KEY_PAIR,
    );
    const completedAt = new Date().toISOString();
    const result = {
      taskId: "idempotent-completion",
      beaconId: TEST_BEACON_ID,
      success: true,
      output: "done",
      completedAt,
      signature: "signed",
    };
    expect(state.beginTask(result.taskId, completedAt)).toBe(true);
    state.completeTask(result);
    await state.persistResultSubmitted(result.taskId);
    const acceptedAt = state.getTaskLedgerEntry(result.taskId)
      ?.resultSubmittedAt;

    state.completeTask(structuredClone(result));
    expect(state.getTaskLedgerEntry(result.taskId)?.resultSubmittedAt)
      .toBe(acceptedAt);
    expect(() =>
      state.completeTask({ ...result, output: "conflict" })
    ).toThrow("conflicting completed result");
  });
});
