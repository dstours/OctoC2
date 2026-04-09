#!/usr/bin/env bun
/**
 * OctoC2 — Self-contained BeaconService gRPC echo server for testing.
 *
 * Usage:
 *   bun run scripts/grpc-test-server.ts            # port 50051
 *   GRPC_TEST_PORT=50052 bun run scripts/grpc-test-server.ts
 *
 * Behavior:
 *   Checkin      → returns one hardcoded shell task
 *   SubmitResult → logs the result and returns { accepted: true, message: "ok" }
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join } from "node:path";

const PROTO_PATH = join(import.meta.dir, "../proto/svc.proto");
const port = process.env["GRPC_TEST_PORT"] ?? "50051";

const packageDef = await protoLoader.load(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as Record<string, any>;
const BeaconService = (proto["svc"] as Record<string, any>)["BeaconService"] as grpc.ServiceClientConstructor;

const server = new grpc.Server();

server.addService(BeaconService.service, {
  checkin: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    callback(null, {
      pendingTasks: [
        {
          id:        "test-task-1",
          kind:      "shell",
          argsJson:  JSON.stringify({ cmd: "echo grpc-ok" }),
          issuedAt:  new Date().toISOString(),
        },
      ],
    });
  },

  submitResult: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    console.log("[grpc-test-server] SubmitResult:", JSON.stringify((call as any).request, null, 2));
    callback(null, { accepted: true, message: "ok" });
  },
});

server.bindAsync(
  `localhost:${port}`,
  grpc.ServerCredentials.createInsecure(),
  (err, boundPort) => {
    if (err) {
      console.error("[grpc-test-server] Failed to bind:", err.message);
      process.exit(1);
    }
    console.log(`[grpc-test-server] Listening on port ${boundPort}`);
  }
);

function shutdown(): void {
  server.forceShutdown();
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
