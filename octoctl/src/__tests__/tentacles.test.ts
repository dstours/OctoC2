/**
 * Tests for `octoctl tentacles list`
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Stub loadRegistry ─────────────────────────────────────────────────────────

const mockBeacons: Record<string, unknown>[] = [];

mock.module("../lib/registry.ts", () => ({
  loadRegistry: async () => mockBeacons,
  registryPath: () => "/fake/data/registry.json",
  getBeacon: async (id: string) =>
    mockBeacons.find(
      (b: Record<string, unknown>) =>
        b["beaconId"] === id ||
        (typeof b["beaconId"] === "string" && (b["beaconId"] as string).startsWith(id)),
    ),
}));

import {
  runTentaclesList,
  runTentaclesHealth,
  buildChannels,
  computeChannelStats,
  printErrorDetails,
  statusDisplay,
  type TentaclesListResult,
  type TentacleChannel,
} from "../commands/tentacles.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_KINDS = [
  "issues", "gist", "branch", "notes", "actions",
  "secrets", "proxy", "codespaces", "relay", "oidc",
  "pages", "stego",
] as const;

function makeBeacon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    beaconId:    "abc12345-0000-0000-0000-000000000000",
    issueNumber: 42,
    publicKey:   "fakekey",
    hostname:    "target.local",
    username:    "root",
    os:          "linux",
    arch:        "x64",
    firstSeen:   new Date(Date.now() - 3_600_000).toISOString(),
    lastSeen:    new Date(Date.now() - 3 * 60_000).toISOString(), // 3 min ago
    status:      "active",
    lastSeq:     5,
    ...overrides,
  };
}

// Capture console.log output for human-readable tests
function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => String(a)).join(" "));
  };
  return fn().then(() => {
    console.log = orig;
    return lines;
  }).catch(err => {
    console.log = orig;
    throw err;
  });
}

// Capture JSON output from --json flag
async function captureJsonOutput(opts: Parameters<typeof runTentaclesList>[0]): Promise<TentaclesListResult> {
  const parts: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => { parts.push(String(s)); };
  try {
    await runTentaclesList(opts);
  } finally {
    console.log = orig;
  }
  return JSON.parse(parts[parts.length - 1]!) as TentaclesListResult;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runTentaclesList — offline mode", () => {
  beforeEach(() => {
    mockBeacons.length = 0;
  });

  it("returns all 12 channel kinds in JSON output", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    expect(result.channels).toHaveLength(12);
    const kinds = result.channels.map(c => c.kind);
    for (const k of ALL_KINDS) {
      expect(kinds).toContain(k);
    }
  });

  it("marks the activeTentacle channel as active", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    const issuesCh = result.channels.find(c => c.kind === "issues");
    expect(issuesCh?.status).toBe("active");

    const gistCh = result.channels.find(c => c.kind === "gist");
    expect(gistCh?.status).toBe("idle");
  });

  it("marks active channel as error when last seen > 30 min ago", async () => {
    mockBeacons.push(makeBeacon({
      activeTentacle: "branch",
      lastSeen: new Date(Date.now() - 35 * 60_000).toISOString(), // 35 min ago
    }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    const branchCh = result.channels.find(c => c.kind === "branch");
    expect(branchCh?.status).toBe("error");
  });

  it("all channels idle when no activeTentacle is set", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: undefined }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    for (const ch of result.channels) {
      expect(ch.status).toBe("idle");
      expect(ch.lastSeen).toBeNull();
    }
    expect(result.activeTentacle).toBeNull();
  });

  it("resolves beacon by prefix", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "notes" }));

    // Only pass first 4 chars of the beacon UUID
    const result = await captureJsonOutput({
      beacon: "abc1",
      json: true,
    });

    expect(result.beaconId).toBe("abc12345-0000-0000-0000-000000000000");
    const notesCh = result.channels.find(c => c.kind === "notes");
    expect(notesCh?.status).toBe("active");
  });

  it("throws an error when beacon is not found", async () => {
    // registry is empty
    await expect(
      runTentaclesList({ beacon: "notexist", json: true }),
    ).rejects.toThrow(/not found/);
  });

  it("human-readable output contains all 12 kind names", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const lines = await captureLog(() =>
      runTentaclesList({ beacon: "abc12345" }),
    );
    const joined = lines.join("\n");

    for (const k of ALL_KINDS) {
      expect(joined).toContain(k);
    }
  });

  it("human-readable output shows 'primary channel' for active tentacle", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "gist" }));

    const lines = await captureLog(() =>
      runTentaclesList({ beacon: "abc12345" }),
    );
    const joined = lines.join("\n");

    expect(joined).toContain("primary channel");
    expect(joined).toContain("Active channel:");
  });

  it("JSON output includes beaconId, activeTentacle, lastSeen, channels", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "actions" }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    expect(typeof result.beaconId).toBe("string");
    expect(result.activeTentacle).toBe("actions");
    expect(typeof result.lastSeen).toBe("string");
    expect(Array.isArray(result.channels)).toBe(true);
  });

  it("returns exactly 12 channels regardless of activeTentacle value", async () => {
    for (const kind of ALL_KINDS) {
      mockBeacons.length = 0;
      mockBeacons.push(makeBeacon({ activeTentacle: kind }));

      const result = await captureJsonOutput({
        beacon: "abc12345",
        json: true,
      });

      expect(result.channels).toHaveLength(12);
      const active = result.channels.filter(c => c.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0]!.kind).toBe(kind);
    }
  });
});

// ── Helper to build minimal TaskResult fixtures ────────────────────────────────

type TaskStatus = "completed" | "pending" | "delivered" | "failed";

function makeTask(overrides: {
  taskId?: string;
  status?: TaskStatus;
  preferredChannel?: string | null;
  success?: boolean;
  output?: string;
  completedAt?: string | null;
} = {}): Parameters<typeof computeChannelStats>[0][number] {
  const {
    taskId = "task-" + Math.random().toString(36).slice(2),
    status = "completed",
    preferredChannel = null,
    success = true,
    output = "ok",
    completedAt = new Date().toISOString(),
  } = overrides;
  return {
    taskId,
    beaconId: "abc12345-0000-0000-0000-000000000000",
    kind: "shell",
    status,
    completedAt,
    result: { output, success },
    preferredChannel,
  };
}

// ── Tests for computeChannelStats ──────────────────────────────────────────────

describe("computeChannelStats", () => {
  it("returns empty map for empty task list", () => {
    const stats = computeChannelStats([]);
    expect(stats.size).toBe(0);
  });

  it("attributes tasks with null preferredChannel to 'issues'", () => {
    const tasks = [
      makeTask({ preferredChannel: null, success: true }),
      makeTask({ preferredChannel: null, success: true }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.has("issues")).toBe(true);
    expect(stats.get("issues")!.successRate).toBe(100.0);
  });

  it("computes 75% success rate for 3 completed + 1 failed", () => {
    const tasks = [
      makeTask({ preferredChannel: "gist", success: true }),
      makeTask({ preferredChannel: "gist", success: true }),
      makeTask({ preferredChannel: "gist", success: true }),
      makeTask({ preferredChannel: "gist", status: "failed", success: false, output: "err" }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.get("gist")!.successRate).toBe(75.0);
  });

  it("computes 0% success rate when all tasks failed", () => {
    const tasks = [
      makeTask({ preferredChannel: "notes", status: "failed", success: false, output: "boom" }),
      makeTask({ preferredChannel: "notes", status: "failed", success: false, output: "crash" }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.get("notes")!.successRate).toBe(0.0);
  });

  it("does not count pending or delivered tasks in rate", () => {
    const tasks = [
      makeTask({ preferredChannel: "branch", status: "pending" }),
      makeTask({ preferredChannel: "branch", status: "delivered" }),
      makeTask({ preferredChannel: "branch", success: true }),
    ];
    const stats = computeChannelStats(tasks);
    // Only 1 completed task — success rate is 100%
    expect(stats.get("branch")!.successRate).toBe(100.0);
  });

  it("truncates last_error at 60 chars", () => {
    const longOutput = "A".repeat(80);
    const tasks = [
      makeTask({ preferredChannel: "actions", status: "failed", success: false, output: longOutput }),
    ];
    const stats = computeChannelStats(tasks);
    const err = stats.get("actions")!.lastError;
    expect(err).not.toBeNull();
    expect(err!.length).toBe(60);
    expect(err).toBe("A".repeat(60));
  });

  it("sets lastError to null when failed task has empty output", () => {
    const tasks = [
      makeTask({ preferredChannel: "relay", status: "failed", output: "" }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.get("relay")!.successRate).toBe(0.0);
    expect(stats.get("relay")!.lastError).toBeNull();
  });

  it("sets lastError to null when no failed tasks", () => {
    const tasks = [
      makeTask({ preferredChannel: "relay", success: true }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.get("relay")!.lastError).toBeNull();
  });

  it("picks the most recent failed task for lastError", () => {
    const older = makeTask({
      preferredChannel: "oidc",
      status: "failed",
      output: "old error",
      completedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = makeTask({
      preferredChannel: "oidc",
      status: "failed",
      output: "new error",
      completedAt: new Date().toISOString(),
    });
    const stats = computeChannelStats([older, newer]);
    expect(stats.get("oidc")!.lastError).toBe("new error");
  });

  it("handles completed tasks with success=false as failures", () => {
    const tasks = [
      makeTask({ preferredChannel: "proxy", status: "completed", success: false, output: "non-zero exit" }),
      makeTask({ preferredChannel: "proxy", status: "completed", success: true }),
    ];
    const stats = computeChannelStats(tasks);
    expect(stats.get("proxy")!.successRate).toBe(50.0);
    expect(stats.get("proxy")!.lastError).toBe("non-zero exit");
  });
});

// ── Tests for buildChannels with statsMap ──────────────────────────────────────

describe("buildChannels — with stats", () => {
  it("propagates successRate and lastError into channel entries", () => {
    const statsMap = new Map([
      ["gist", { successRate: 80.0, lastError: "timeout" }],
    ]);
    const channels = buildChannels("gist", new Date().toISOString(), statsMap);
    const gistCh = channels.find(c => c.kind === "gist")!;
    expect(gistCh.successRate).toBe(80.0);
    expect(gistCh.lastError).toBe("timeout");
  });

  it("shows null stats for channels not in statsMap", () => {
    const statsMap = new Map([
      ["gist", { successRate: 100.0, lastError: null }],
    ]);
    const channels = buildChannels("gist", new Date().toISOString(), statsMap);
    const notesCh = channels.find(c => c.kind === "notes")!;
    expect(notesCh.successRate).toBeNull();
    expect(notesCh.lastError).toBeNull();
  });

  it("shows null stats for all channels when no statsMap provided (offline)", () => {
    const channels = buildChannels("issues", new Date().toISOString());
    for (const ch of channels) {
      expect(ch.successRate).toBeNull();
      expect(ch.lastError).toBeNull();
    }
  });
});

// ── Tests for JSON output including new fields ─────────────────────────────────

describe("runTentaclesList — JSON output includes health fields", () => {
  beforeEach(() => {
    mockBeacons.length = 0;
  });

  it("offline mode: successRate and lastError are null in JSON", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    for (const ch of result.channels) {
      expect(ch.successRate).toBeNull();
      expect(ch.lastError).toBeNull();
    }
  });

  it("JSON channel objects include successRate and lastError keys", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "notes" }));

    const result = await captureJsonOutput({
      beacon: "abc12345",
      json: true,
    });

    const ch = result.channels[0]!;
    expect("successRate" in ch).toBe(true);
    expect("lastError" in ch).toBe(true);
  });
});

// ── Tests for human-readable output including new columns ──────────────────────

describe("runTentaclesList — human-readable output includes health columns", () => {
  beforeEach(() => {
    mockBeacons.length = 0;
  });

  it("header contains 'Success' and 'Last Error' columns", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const lines = await captureLog(() =>
      runTentaclesList({ beacon: "abc12345" }),
    );
    const header = lines.find(l => l.includes("Success"));
    expect(header).toBeDefined();
    expect(header).toContain("Last Error");
  });
});

// ── Tests for runTentaclesHealth alias ────────────────────────────────────────

describe("runTentaclesHealth — alias for runTentaclesList", () => {
  beforeEach(() => {
    mockBeacons.length = 0;
  });

  it("returns all 12 channels in JSON output (including pages and stego)", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "stego" }));

    // runTentaclesHealth === runTentaclesList; captureJsonOutput is equivalent
    const result = await captureJsonOutput({ beacon: "abc12345", json: true });

    expect(result.channels).toHaveLength(12);
    const kinds = result.channels.map(c => c.kind);
    expect(kinds).toContain("pages");
    expect(kinds).toContain("stego");
  });

  it("marks stego as active when it is the activeTentacle", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "stego" }));

    const result = await captureJsonOutput({ beacon: "abc12345", json: true });

    const stegoCh = result.channels.find(c => c.kind === "stego");
    expect(stegoCh?.status).toBe("active");

    const pagesCh = result.channels.find(c => c.kind === "pages");
    expect(pagesCh?.status).toBe("idle");
  });

  it("marks pages as active when it is the activeTentacle", async () => {
    mockBeacons.push(makeBeacon({ activeTentacle: "pages" }));

    const result = await captureJsonOutput({ beacon: "abc12345", json: true });

    const pagesCh = result.channels.find(c => c.kind === "pages");
    expect(pagesCh?.status).toBe("active");

    const stegoCh = result.channels.find(c => c.kind === "stego");
    expect(stegoCh?.status).toBe("idle");
  });
});

// ── Tests for ANSI color-coded statusDisplay ───────────────────────────────────

describe("statusDisplay — ANSI color codes", () => {
  const GREEN  = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const RED    = "\x1b[31m";
  const GRAY   = "\x1b[90m";
  const RESET  = "\x1b[0m";

  it("active tentacle output contains green ANSI code", () => {
    const out = statusDisplay("active");
    expect(out).toContain(GREEN);
    expect(out).toContain(RESET);
    expect(out).toContain("●");
    expect(out).toContain("active");
  });

  it("live tentacle output contains green ANSI code", () => {
    const out = statusDisplay("live");
    expect(out).toContain(GREEN);
    expect(out).toContain("●");
  });

  it("failed tentacle output contains red ANSI code", () => {
    const out = statusDisplay("failed");
    expect(out).toContain(RED);
    expect(out).toContain(RESET);
    expect(out).toContain("✗");
    expect(out).toContain("failed");
  });

  it("dead tentacle output contains red ANSI code", () => {
    const out = statusDisplay("dead");
    expect(out).toContain(RED);
    expect(out).toContain("✗");
  });

  it("error tentacle output contains red ANSI code", () => {
    const out = statusDisplay("error");
    expect(out).toContain(RED);
    expect(out).toContain("✗");
  });

  it("degraded tentacle output contains yellow ANSI code", () => {
    const out = statusDisplay("degraded");
    expect(out).toContain(YELLOW);
    expect(out).toContain("◐");
    expect(out).toContain("degraded");
  });

  it("slow tentacle output contains yellow ANSI code", () => {
    const out = statusDisplay("slow");
    expect(out).toContain(YELLOW);
    expect(out).toContain("◐");
  });

  it("idle tentacle output contains gray ANSI code", () => {
    const out = statusDisplay("idle");
    expect(out).toContain(GRAY);
    expect(out).toContain("○");
    expect(out).toContain("idle");
  });

  it("unknown tentacle output contains gray ANSI code", () => {
    const out = statusDisplay("unknown");
    expect(out).toContain(GRAY);
    expect(out).toContain("○");
  });

  it("inactive tentacle output contains gray ANSI code", () => {
    const out = statusDisplay("inactive");
    expect(out).toContain(GRAY);
    expect(out).toContain("○");
  });

  it("human-readable output for active tentacle contains green ANSI code", async () => {
    mockBeacons.length = 0;
    mockBeacons.push(makeBeacon({ activeTentacle: "issues" }));

    const lines = await captureLog(() =>
      runTentaclesList({ beacon: "abc12345" }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain(GREEN);
  });

  it("human-readable output for stale (error) tentacle contains red ANSI code", async () => {
    mockBeacons.length = 0;
    mockBeacons.push(makeBeacon({
      activeTentacle: "gist",
      lastSeen: new Date(Date.now() - 35 * 60_000).toISOString(),
    }));

    const lines = await captureLog(() =>
      runTentaclesList({ beacon: "abc12345" }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain(RED);
  });
});

// ── Tests for computeChannelStats verbose mode ─────────────────────────────────

describe("computeChannelStats — verbose mode", () => {
  it("does NOT truncate lastError at 60 chars when verbose=true", () => {
    const longOutput = "X".repeat(120);
    const tasks = [
      makeTask({ preferredChannel: "gist", status: "failed", success: false, output: longOutput }),
    ];
    const stats = computeChannelStats(tasks, true);
    const err = stats.get("gist")!.lastError;
    expect(err).not.toBeNull();
    expect(err!.length).toBe(120);
    expect(err).toBe("X".repeat(120));
  });

  it("still truncates at 60 chars when verbose=false (default)", () => {
    const longOutput = "Y".repeat(100);
    const tasks = [
      makeTask({ preferredChannel: "notes", status: "failed", success: false, output: longOutput }),
    ];
    const stats = computeChannelStats(tasks, false);
    const err = stats.get("notes")!.lastError;
    expect(err).not.toBeNull();
    expect(err!.length).toBe(60);
  });

  it("short errors are not padded and stay intact in verbose mode", () => {
    const tasks = [
      makeTask({ preferredChannel: "relay", status: "failed", success: false, output: "short err" }),
    ];
    const stats = computeChannelStats(tasks, true);
    expect(stats.get("relay")!.lastError).toBe("short err");
  });
});

// ── Tests for printErrorDetails ────────────────────────────────────────────────

describe("printErrorDetails", () => {
  function captureConsole(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(" ")); };
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  function makeChannel(kind: string, lastError: string | null): TentacleChannel {
    return {
      kind:        kind as TentacleChannel["kind"],
      status:      lastError ? "failed" : "idle",
      lastSeen:    null,
      successRate: null,
      lastError,
    };
  }

  it("prints nothing when verbose=false", () => {
    const channels = [makeChannel("issues", "some error")];
    const lines = captureConsole(() => printErrorDetails(channels, false));
    expect(lines).toHaveLength(0);
  });

  it("prints nothing when verbose=true but no channels have errors", () => {
    const channels = [makeChannel("issues", null), makeChannel("gist", null)];
    const lines = captureConsole(() => printErrorDetails(channels, true));
    expect(lines).toHaveLength(0);
  });

  it("prints Last Error Details section when verbose=true and errors exist", () => {
    const channels = [
      makeChannel("issues", "Connection timeout: GET /repos/... returned 503"),
      makeChannel("gist",   "Rate limit exceeded: 429"),
    ];
    const lines = captureConsole(() => printErrorDetails(channels, true));
    const joined = lines.join("\n");
    expect(joined).toContain("Last Error Details");
    expect(joined).toContain("issues");
    expect(joined).toContain("Connection timeout");
    expect(joined).toContain("gist");
    expect(joined).toContain("Rate limit exceeded");
  });

  it("skips channels with null lastError in the details section", () => {
    const channels = [
      makeChannel("issues", "real error"),
      makeChannel("gist",   null),
    ];
    const lines = captureConsole(() => printErrorDetails(channels, true));
    const joined = lines.join("\n");
    expect(joined).toContain("issues");
    // gist should not appear at all
    expect(joined).not.toContain("gist");
  });
});
