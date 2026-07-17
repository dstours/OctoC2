import { describe, expect, it } from "bun:test";
import {
  BeaconStateValidationError,
  validateBeaconStateV2,
} from "../state/BeaconStateValidation.ts";
import { SeenTaskFilter } from "../state/SeenTaskFilter.ts";
import { canonicalJson } from "@octoc2/shared";

const BEACON_ID = "550e8400-e29b-41d4-a716-446655440000";
const NOW = "2026-07-16T12:00:00.000Z";

function baseState(): Record<string, unknown> {
  return {
    version: 2,
    beaconId: BEACON_ID,
    issueNumber: null,
    seq: 0,
    lastTaskCommentId: null,
    registrationStatus: "pending",
    ciCommentId: null,
    keyPair: {
      publicKey: Buffer.alloc(32, 1).toString("base64url"),
      secretKey: Buffer.alloc(32, 2).toString("base64url"),
    },
    signingKeyPair: {
      publicKey: Buffer.alloc(32, 3).toString("base64url"),
      secretKey: Buffer.alloc(64, 4).toString("base64url"),
      keyId: "ed25519:test",
    },
    identitySeq: 0,
    taskLedger: [],
  };
}

function startedEntry(taskId: string): Record<string, unknown> {
  return {
    taskId,
    status: "started",
    startedAt: NOW,
    result: null,
  };
}

function storedResultSignature(
  taskId: string,
  sequence = 1,
): string {
  return canonicalJson({
    protocol: "octoc2",
    version: 1,
    kind: "task-result",
    signerId: BEACON_ID,
    keyId: "ed25519:test",
    issuedAt: NOW,
    sequence,
    payload: {
      taskId,
      beaconId: BEACON_ID,
      success: true,
      outputHash: Buffer.alloc(32, 5).toString("base64url"),
      dataHash: null,
      metadataHash: null,
      completedAt: NOW,
    },
    signature: Buffer.alloc(64, 6).toString("base64url"),
  });
}

describe("strict beacon state validation", () => {
  it("migrates a pre-filter state only when all prior IDs remain detailed", () => {
    const state = baseState();
    state["taskLedger"] = [startedEntry("task-1")];
    const validated = validateBeaconStateV2(state, BEACON_ID);

    expect(validated.filterMigrationRequired).toBe(true);
    expect(validated.seenTaskFilter.has("task-1")).toBe(true);
    expect(validated.data.sleepOverride).toBeNull();
    expect(validated.data.terminationRequested).toBe(false);
  });

  it("rejects a full pre-filter ledger because prior eviction is unknowable", () => {
    const state = baseState();
    state["taskLedger"] = Array.from(
      { length: 256 },
      (_, index) => startedEntry(`task-${index}`),
    );
    expect(() => validateBeaconStateV2(state, BEACON_ID)).toThrow(
      "prior evictions cannot be ruled out",
    );
  });

  it("rejects malformed present security fields instead of defaulting them", () => {
    const state = baseState();
    state["identitySeq"] = "0";
    expect(() => validateBeaconStateV2(state, BEACON_ID)).toThrow(
      "identitySeq",
    );

    const sleep = baseState();
    sleep["sleepOverride"] = { seconds: 10, jitter: 2 };
    expect(() => validateBeaconStateV2(sleep, BEACON_ID)).toThrow(
      "sleepOverride.jitter",
    );

    const unknown = baseState();
    unknown["unrecognized"] = true;
    expect(() => validateBeaconStateV2(unknown, BEACON_ID)).toThrow(
      "unknown fields",
    );
  });

  it("rejects task/filter mismatches and invalid lifecycle ordering", () => {
    const state = baseState();
    state["taskLedger"] = [startedEntry("task-1")];
    state["seenTaskFilter"] = SeenTaskFilter.empty().toJSON();
    expect(() => validateBeaconStateV2(state, BEACON_ID)).toThrow(
      "missing ledger task task-1",
    );

    const appliedBeforeAcceptance = baseState();
    appliedBeforeAcceptance["identitySeq"] = 1;
    const filter = SeenTaskFilter.empty();
    filter.add("task-2");
    appliedBeforeAcceptance["seenTaskFilter"] = filter.toJSON();
    appliedBeforeAcceptance["taskLedger"] = [{
      taskId: "task-2",
      status: "completed",
      startedAt: NOW,
      result: {
        taskId: "task-2",
        beaconId: BEACON_ID,
        success: true,
        output: "done",
        completedAt: NOW,
        signature: storedResultSignature("task-2"),
      },
      directive: { kind: "kill" },
      resultSubmittedAt: null,
      directiveAppliedAt: NOW,
    }];
    expect(() =>
      validateBeaconStateV2(appliedBeforeAcceptance, BEACON_ID)
    ).toThrow("before result acceptance");
  });

  it("rejects malformed stored result envelopes and reversed timestamps", () => {
    const state = baseState();
    state["identitySeq"] = 1;
    const filter = SeenTaskFilter.empty();
    filter.add("task-3");
    state["seenTaskFilter"] = filter.toJSON();
    state["taskLedger"] = [{
      taskId: "task-3",
      status: "completed",
      startedAt: "2026-07-16T12:00:01.000Z",
      result: {
        taskId: "task-3",
        beaconId: BEACON_ID,
        success: true,
        output: "done",
        completedAt: NOW,
        signature: storedResultSignature("task-3"),
      },
    }];
    expect(() => validateBeaconStateV2(state, BEACON_ID)).toThrow(
      "completed before it started",
    );

    const malformed = structuredClone(state);
    (malformed["taskLedger"] as Array<Record<string, unknown>>)[0]![
      "startedAt"
    ] = NOW;
    (
      (malformed["taskLedger"] as Array<Record<string, unknown>>)[0]![
        "result"
      ] as Record<string, unknown>
    )["signature"] = "not-an-envelope";
    expect(() => validateBeaconStateV2(malformed, BEACON_ID)).toThrow(
      "not a signed envelope",
    );
  });

  it("accepts conservative false positives in a persisted append-only filter", () => {
    const state = baseState();
    state["seenTaskFilter"] = {
      version: 1,
      bitCount: 262_144,
      hashCount: 7,
      bits: Buffer.alloc(262_144 / 8, 0xff).toString("base64url"),
    };
    const validated = validateBeaconStateV2(state, BEACON_ID);
    expect(validated.seenTaskFilter.has("never-seen-in-detail")).toBe(true);
  });

  it("wraps state corruption in a dedicated validation error", () => {
    try {
      validateBeaconStateV2({ version: 2 }, BEACON_ID);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BeaconStateValidationError);
    }
  });
});
