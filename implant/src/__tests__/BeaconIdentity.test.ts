import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  assertBeaconId,
  discoverPersistedBeaconId,
} from "../state/BeaconIdentity.ts";

const FIRST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_ID = "7f7f6f2e-8c3c-4b4d-8b02-f9a53f6a2921";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directories(): Promise<{
  state: string;
  recovery: string;
  fallback: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "octoc2-identity-"));
  roots.push(root);
  const state = join(root, "state");
  const recovery = join(root, "recovery");
  const fallback = join(root, "fallback");
  await Promise.all([
    mkdir(state),
    mkdir(recovery),
    mkdir(fallback),
  ]);
  return { state, recovery, fallback };
}

async function writeState(
  path: string,
  beaconId: string,
  version = 2,
): Promise<void> {
  await writeFile(path, JSON.stringify({ version, beaconId }), "utf8");
}

describe("beacon identity discovery", () => {
  it("validates baked identity values before they can influence a path", () => {
    expect(assertBeaconId(FIRST_ID)).toBe(FIRST_ID);
    expect(() => assertBeaconId("../../escape")).toThrow(
      "canonical lowercase UUID",
    );
    expect(() => assertBeaconId(FIRST_ID.toUpperCase())).toThrow(
      "canonical lowercase UUID",
    );
    expect(() =>
      assertBeaconId("00000000-0000-0000-0000-000000000000")
    ).toThrow("canonical lowercase UUID");
  });

  it("returns null only when no recognized state artifacts exist", async () => {
    const dirs = await directories();
    await writeFile(join(dirs.state, "unrelated.json"), "not-json", "utf8");
    expect(await discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).toBeNull();
  });

  it("uses one canonical state and permits matching scoped and recovery companions", async () => {
    const dirs = await directories();
    await writeState(join(dirs.state, `${FIRST_ID}.json`), FIRST_ID);
    await writeState(
      join(dirs.state, `${FIRST_ID}.0123456789abcdef01234567.json`),
      FIRST_ID,
    );
    await writeState(
      join(dirs.recovery, `${FIRST_ID}.recovery.json`),
      FIRST_ID,
    );

    expect(await discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).toBe(FIRST_ID);
  });

  it("rejects corrupt or filename-conflicting recognized state", async () => {
    const dirs = await directories();
    await writeFile(
      join(dirs.state, `${FIRST_ID}.json`),
      "{broken",
      "utf8",
    );
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("Could not parse recognized primary state");

    await writeState(join(dirs.state, `${FIRST_ID}.json`), SECOND_ID);
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("filename identity");
  });

  it("rejects multiple canonical identities and canonical/fallback ambiguity", async () => {
    const dirs = await directories();
    await writeState(join(dirs.state, `${FIRST_ID}.json`), FIRST_ID);
    await writeState(join(dirs.state, `${SECOND_ID}.json`), SECOND_ID);
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("Multiple canonical beacon state files");

    await rm(join(dirs.state, `${SECOND_ID}.json`));
    await writeState(join(dirs.fallback, "svc-state.json"), FIRST_ID);
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("identity is ambiguous");
  });

  it("rejects orphaned or conflicting companion artifacts", async () => {
    const dirs = await directories();
    await writeState(
      join(dirs.recovery, `${FIRST_ID}.recovery.json`),
      FIRST_ID,
    );
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("Orphaned scoped or recovery state");

    await writeState(join(dirs.state, `${SECOND_ID}.json`), SECOND_ID);
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("conflicting beacon identities");
  });

  it("accepts a single fallback authority but not scoped fallback alone", async () => {
    const dirs = await directories();
    await writeState(join(dirs.fallback, "svc-state.json"), FIRST_ID);
    expect(await discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).toBe(FIRST_ID);

    await rm(join(dirs.fallback, "svc-state.json"));
    await writeState(
      join(dirs.fallback, "svc-state.0123456789abcdef01234567.json"),
      FIRST_ID,
    );
    await expect(discoverPersistedBeaconId({
      stateDirectory: dirs.state,
      recoveryDirectory: dirs.recovery,
      fallbackDirectory: dirs.fallback,
    })).rejects.toThrow("Orphaned scoped or recovery state");
  });
});
