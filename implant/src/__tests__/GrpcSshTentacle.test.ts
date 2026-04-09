/**
 * OctoC2 — GrpcSshTentacle unit tests
 *
 * All tests use SVC_GRPC_DIRECT=localhost:<port> — no SSH or Codespace needed.
 * A real grpc-test-server subprocess is spawned in beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer }  from "node:net";
import type { AddressInfo } from "node:net";
import { join }          from "node:path";

import { GrpcSshTentacle }  from "../tentacles/GrpcSshTentacle.ts";
import { ConnectionFactory } from "../factory/ConnectionFactory.ts";
import type {
  BeaconConfig,
  CheckinPayload,
  TaskResult,
  ITentacle,
  Task,
} from "../types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Ask the OS for a free TCP port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "../../..");

function makeConfig(overrides: Partial<BeaconConfig> = {}): BeaconConfig {
  return {
    id:               "test-beacon",
    repo:             { owner: "test", name: "test" },
    token:            "fake-token",
    tentaclePriority: ["codespaces"],
    sleepSeconds:     60,
    jitter:           0.1,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair:    { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    ...overrides,
  };
}

const TEST_PAYLOAD: CheckinPayload = {
  beaconId:  "test-beacon",
  publicKey: "dGVzdA==",
  hostname:  "test-host",
  username:  "test-user",
  os:        "linux",
  arch:      "x64",
  pid:       1,
  checkinAt: new Date().toISOString(),
};

// ── Lifecycle ──────────────────────────────────────────────────────────────────

let testPort: number;
let serverProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  // Clear SSH env vars so they don't interfere
  delete process.env["SVC_GRPC_CODESPACE_NAME"];
  delete process.env["SVC_GITHUB_USER"];

  testPort = await findFreePort();

  serverProc = Bun.spawn({
    cmd: [process.execPath, "run", "scripts/grpc-test-server.ts"],
    cwd: REPO_ROOT,
    env: { ...process.env, GRPC_TEST_PORT: String(testPort) },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give the server time to bind
  await new Promise((r) => setTimeout(r, 2000));

  process.env["SVC_GRPC_DIRECT"] = `localhost:${testPort}`;
});

afterAll(async () => {
  delete process.env["SVC_GRPC_DIRECT"];
  try { serverProc?.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
});

// ── isAvailable() ──────────────────────────────────────────────────────────────

describe("isAvailable()", () => {
  it("returns true in GRPC_DIRECT mode when test server is running", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      expect(await t.isAvailable()).toBe(true);
    } finally {
      await t.teardown();
    }
  });

  it("returns false (no error) when no GRPC env vars are set", async () => {
    const saved = process.env["SVC_GRPC_DIRECT"];
    delete process.env["SVC_GRPC_DIRECT"];
    const t = new GrpcSshTentacle(makeConfig());
    try {
      expect(await t.isAvailable()).toBe(false);
    } finally {
      process.env["SVC_GRPC_DIRECT"] = saved;
      await t.teardown();
    }
  });
});

// ── checkin() ──────────────────────────────────────────────────────────────────

describe("checkin()", () => {
  it("maps proto pendingTasks to Task[]", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const tasks = await t.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      const task = tasks[0]!;
      expect(task.taskId).toBe("test-task-1");
      expect(task.kind).toBe("shell");
      expect(task.args).toEqual({ cmd: "echo grpc-ok" });
    } finally {
      await t.teardown();
    }
  });

  it("returns array when server sends tasks", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      const tasks = await t.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
    } finally {
      await t.teardown();
    }
  });
});

// ── submitResult() ─────────────────────────────────────────────────────────────

describe("submitResult()", () => {
  it("sends result and resolves without throwing", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    try {
      await t.checkin(TEST_PAYLOAD);

      const result: TaskResult = {
        taskId:      "test-task-1",
        beaconId:    "test-beacon",
        success:     true,
        output:      "grpc-ok",
        completedAt: new Date().toISOString(),
      };
      await expect(t.submitResult(result)).resolves.toBeUndefined();
    } finally {
      await t.teardown();
    }
  });
});

// ── teardown() ─────────────────────────────────────────────────────────────────

describe("teardown()", () => {
  it("is idempotent — calling twice does not throw", async () => {
    const t = new GrpcSshTentacle(makeConfig());
    await t.checkin(TEST_PAYLOAD);
    await t.teardown();
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});

// ── ConnectionFactory failover ─────────────────────────────────────────────────

describe("ConnectionFactory failover", () => {
  it("falls over to GrpcSsh when IssuesTentacle is unavailable", async () => {
    class FailingTentacle implements ITentacle {
      readonly kind = "issues" as const;
      async isAvailable(): Promise<boolean> { return false; }
      async checkin(): Promise<Task[]> { throw new Error("should not be called"); }
      async submitResult(): Promise<void> { throw new Error("should not be called"); }
      async teardown(): Promise<void> {}
    }

    const config = makeConfig({ tentaclePriority: ["issues", "codespaces"] });
    const factory = new ConnectionFactory({ config, maxFailures: 3 });
    factory.register(new FailingTentacle());

    const grpcTentacle = new GrpcSshTentacle(config);
    factory.register(grpcTentacle);

    try {
      const tasks = await factory.checkin(TEST_PAYLOAD);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]!.taskId).toBe("test-task-1");

      const health = factory.healthSnapshot();
      expect(health["issues"]!.failures).toBe(1);
      expect(health["codespaces"]!.totalSuccesses).toBe(1);
    } finally {
      await factory.teardown();
    }
  });
});
