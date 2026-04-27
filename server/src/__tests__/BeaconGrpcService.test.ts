/**
 * OctoC2 Server — BeaconGrpcService unit tests
 *
 * Tests invoke gRPC handlers directly (no network).
 * The grpc ServerUnaryCall is stubbed with a minimal object.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { BeaconGrpcService } from "../grpc/BeaconGrpcService.ts";
import { BeaconRegistry }    from "../BeaconRegistry.ts";
import { TaskQueue }         from "../TaskQueue.ts";

// ── Minimal stub for grpc ServerUnaryCall ─────────────────────────────────────

function makeCall<T>(request: T): { request: T } {
  return { request };
}

// ── Helper: call handler as a Promise ─────────────────────────────────────────

function callHandler<Req, Res>(
  // Use `any` for both call and callback to stay compatible with gRPC's
  // ServerUnaryCall / sendUnaryData types without importing them here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (call: any, cb: any) => void,
  req: Req
): Promise<Res> {
  return new Promise((resolve, reject) => {
    handler(makeCall(req), (err: unknown, res: Res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface CheckinReq {
  beaconId: string; publicKey: string; hostname: string;
  username: string; os: string; arch: string;
  pid: number; checkinAt: string;
}

interface SubmitResultReq {
  result: {
    taskId: string; beaconId: string; success: boolean;
    output: string; data: string; completedAt: string; signature: string;
  };
}

const BASE_CHECKIN: CheckinReq = {
  beaconId:  "test-beacon-001",
  publicKey: "dGVzdC1wdWJsaWMta2V5",
  hostname:  "test-host",
  username:  "test-user",
  os:        "linux",
  arch:      "x64",
  pid:       1234,
  checkinAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BeaconGrpcService", () => {
  let registry: BeaconRegistry;
  let queue:    TaskQueue;
  let svc:      BeaconGrpcService;

  beforeEach(() => {
    registry = new BeaconRegistry("/tmp/svc-grpc-test");
    queue    = new TaskQueue();
    svc      = new BeaconGrpcService(registry, queue);
  });

  // ── Checkin ────────────────────────────────────────────────────────────────

  describe("Checkin", () => {
    it("registers a new beacon in the registry", async () => {
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);
      const record = registry.get("test-beacon-001");
      expect(record).toBeDefined();
      expect(record!.hostname).toBe("test-host");
      expect(record!.publicKey).toBe("dGVzdC1wdWJsaWMta2V5");
      expect(record!.status).toBe("active");
    });

    it("returns an empty pendingTasks list when no tasks are queued", async () => {
      const res = await callHandler<CheckinReq, { pendingTasks: unknown[] }>(
        (c, cb) => svc.checkin(c as any, cb),
        BASE_CHECKIN
      );
      expect(Array.isArray(res.pendingTasks)).toBe(true);
      expect(res.pendingTasks.length).toBe(0);
    });

    it("returns queued tasks and marks them delivered", async () => {
      // Pre-register so queue can hold the task
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);

      // Queue a task
      const task = queue.queueTask("test-beacon-001", "shell", { cmd: "echo hello" });
      expect(task.state).toBe("pending");

      // Second checkin picks up the task
      const res = await callHandler<CheckinReq, { pendingTasks: Array<{ id: string; kind: string; argsJson: string }> }>(
        (c, cb) => svc.checkin(c as any, cb),
        BASE_CHECKIN
      );

      expect(res.pendingTasks.length).toBe(1);
      expect(res.pendingTasks[0]!.id).toBe(task.taskId);
      expect(res.pendingTasks[0]!.kind).toBe("shell");
      expect(JSON.parse(res.pendingTasks[0]!.argsJson)).toEqual({ cmd: "echo hello" });

      // Task should now be delivered, not pending
      const updated = queue.getTask(task.taskId);
      expect(updated!.state).toBe("delivered");
    });

    it("preserves issueNumber when beacon is already registered via Issues channel", async () => {
      // Simulate prior Issues channel registration
      registry.register({
        beaconId:    "test-beacon-001",
        issueNumber: 42,
        publicKey:   "old-key",
        hostname:    "old-host",
        username:    "user",
        os:          "linux",
        arch:        "x64",
        seq:         5,
      });

      // gRPC checkin should NOT wipe issueNumber=42
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);

      const record = registry.get("test-beacon-001");
      expect(record!.issueNumber).toBe(42);
      // But should update hostname/publicKey from the new checkin
      expect(record!.hostname).toBe("test-host");
    });

    it("returns tasks from a second beacon independently", async () => {
      const second: CheckinReq = { ...BASE_CHECKIN, beaconId: "test-beacon-002", hostname: "host-2" };

      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);
      await callHandler((c, cb) => svc.checkin(c as any, cb), second);

      // Queue one task per beacon
      queue.queueTask("test-beacon-001", "shell", { cmd: "echo a" });
      queue.queueTask("test-beacon-002", "shell", { cmd: "echo b" });

      const res1 = await callHandler<CheckinReq, { pendingTasks: Array<{ argsJson: string }> }>(
        (c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN
      );
      const res2 = await callHandler<CheckinReq, { pendingTasks: Array<{ argsJson: string }> }>(
        (c, cb) => svc.checkin(c as any, cb), second
      );

      expect(JSON.parse(res1.pendingTasks[0]!.argsJson)).toEqual({ cmd: "echo a" });
      expect(JSON.parse(res2.pendingTasks[0]!.argsJson)).toEqual({ cmd: "echo b" });
    });
  });

  // ── SubmitResult ───────────────────────────────────────────────────────────

  describe("SubmitResult", () => {
    it("marks a delivered task as completed", async () => {
      // Register beacon and queue + deliver a task
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);
      const task = queue.queueTask("test-beacon-001", "shell", { cmd: "echo hi" });
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN); // delivers task

      const submitReq: SubmitResultReq = {
        result: {
          taskId:      task.taskId,
          beaconId:    "test-beacon-001",
          success:     true,
          output:      "hi",
          data:        "",
          completedAt: new Date().toISOString(),
          signature:   "",
        },
      };

      const res = await callHandler<SubmitResultReq, { accepted: boolean; message: string }>(
        (c, cb) => svc.submitResult(c as any, cb),
        submitReq
      );

      expect(res.accepted).toBe(true);
      expect(res.message).toBe("ok");

      const updated = queue.getTask(task.taskId);
      expect(updated!.state).toBe("completed");
      expect(updated!.result).toContain("hi");
    });

    it("returns accepted:false for an unknown taskId", async () => {
      const submitReq: SubmitResultReq = {
        result: {
          taskId:      "non-existent-task-id",
          beaconId:    "test-beacon-001",
          success:     true,
          output:      "whatever",
          data:        "",
          completedAt: new Date().toISOString(),
          signature:   "",
        },
      };

      const res = await callHandler<SubmitResultReq, { accepted: boolean; message: string }>(
        (c, cb) => svc.submitResult(c as any, cb),
        submitReq
      );

      expect(res.accepted).toBe(false);
    });

    it("is idempotent — submitting the same result twice does not throw", async () => {
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);
      const task = queue.queueTask("test-beacon-001", "shell", {});
      await callHandler((c, cb) => svc.checkin(c as any, cb), BASE_CHECKIN);

      const submitReq: SubmitResultReq = {
        result: {
          taskId: task.taskId, beaconId: "test-beacon-001",
          success: true, output: "done", data: "",
          completedAt: new Date().toISOString(), signature: "",
        },
      };

      await callHandler((c, cb) => svc.submitResult(c as any, cb), submitReq);
      // Second submission should not throw
      const res = await callHandler<SubmitResultReq, { accepted: boolean }>(
        (c, cb) => svc.submitResult(c as any, cb), submitReq
      );
      // Task already completed → accepted:false (markCompleted rejects completed state)
      expect(res.accepted).toBe(false);
    });
  });

  // ── start() / stop() ───────────────────────────────────────────────────────

  describe("activeTentacle tracking", () => {
    let registry: BeaconRegistry;
    let queue:    TaskQueue;
    let svc:      BeaconGrpcService;

    beforeEach(() => {
      registry = new BeaconRegistry("/tmp/grpc-svc-test");
      queue    = new TaskQueue();
      svc      = new BeaconGrpcService(registry, queue);
    });

    it("registers beacon with activeTentacle 4 (gRPC)", async () => {
      await callHandler(svc.checkin, BASE_CHECKIN);
      const record = registry.get("test-beacon-001");
      expect(record).toBeDefined();
      expect(record!.activeTentacle).toBe(4);
    });

    it("preserves existing issueNumber when beacon re-checks in via gRPC", async () => {
      registry.register({
        beaconId: "test-beacon-001", issueNumber: 99,
        publicKey: "pk", hostname: "h", username: "u",
        os: "linux", arch: "x64", seq: 0, tentacleId: 1,
      });
      await callHandler(svc.checkin, BASE_CHECKIN);
      expect(registry.get("test-beacon-001")!.issueNumber).toBe(99);
      expect(registry.get("test-beacon-001")!.activeTentacle).toBe(4);
    });
  });

  describe("start() / stop()", () => {
    it("binds and releases a TCP port", async () => {
      const { createServer, createConnection } = await import("node:net");
      // Find a free port
      const port = await new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
          const p = (srv.address() as { port: number }).port;
          srv.close(() => resolve(p));
        });
        srv.on("error", reject);
      });

      // Bind to 127.0.0.1 so the collision test is consistent across platforms
      // (macOS allows 127.0.0.1 bind when 0.0.0.0 is already bound)
      await svc.start(port, "127.0.0.1");
      try {
        // Port should be listening now — a connection should succeed
        await expect(
          new Promise<void>((resolve, reject) => {
            const c = createConnection(port, "127.0.0.1", () => {
              c.destroy();
              resolve();
            });
            c.on("error", reject);
          })
        ).resolves.toBeUndefined();
      } finally {
        await svc.stop();
      }

      // After stop(), the port should be released — binding should succeed
      await expect(
        new Promise<void>((resolve, reject) => {
          const s = createServer();
          s.listen(port, "127.0.0.1", () => { s.close(); resolve(); });
          s.on("error", reject);
        })
      ).resolves.toBeUndefined();
    });
  });
});
