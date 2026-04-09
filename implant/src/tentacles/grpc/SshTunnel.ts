/**
 * OctoC2 — SshTunnel
 *
 * Wraps an ssh2 Client and a local net.Server that port-forwards traffic
 * through the SSH channel. Knows nothing about gRPC.
 *
 * Usage:
 *   const t = new SshTunnel();
 *   await t.connect(host, 22, username, token);   // token = GitHub PAT (password auth)
 *   await t.forward(50051, 50051);                 // local 50051 → remote 50051
 *   // ... use localhost:50051 as gRPC target ...
 *   await t.close();
 */

import { Client as SshClient } from "ssh2";
import { createServer }        from "node:net";
import type { Server as NetServer, Socket } from "node:net";

export class SshTunnel {
  private client: SshClient | null = null;
  private server: NetServer | null = null;
  private alive  = false;

  // ── connect ──────────────────────────────────────────────────────────────────

  /**
   * Open an SSH connection.
   * `token` is used as the SSH password — GitHub Codespace SSH gateway accepts
   * a GitHub PAT as the password for `<codespace-name>.github.dev`.
   */
  connect(host: string, port: number, username: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      this.client = client;

      client.on("ready", () => {
        this.alive = true;
        resolve();
      });

      client.on("error", (err) => {
        this.alive = false;
        reject(err);
      });

      client.on("close", () => {
        this.alive = false;
      });

      client.connect({ host, port, username, password: token });
    });
  }

  // ── forward ──────────────────────────────────────────────────────────────────

  /**
   * Start a local TCP server on 127.0.0.1:localPort.
   * Each incoming connection is tunnelled to 127.0.0.1:remotePort on the SSH host.
   */
  forward(localPort: number, remotePort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket: Socket) => {
        this.client!.forwardOut(
          "127.0.0.1", localPort,
          "127.0.0.1", remotePort,
          (err, stream) => {
            if (err) {
              socket.destroy(err);
              return;
            }
            socket.pipe(stream);
            stream.pipe(socket);
            socket.on("close", () => { try { stream.destroy(); } catch {} });
            stream.on("close", () => { try { socket.destroy(); } catch {} });
            socket.on("error", () => { try { stream.destroy(); } catch {} });
            stream.on("error", () => { try { socket.destroy(); } catch {} });
          }
        );
      });

      this.server = server;
      server.listen(localPort, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
  }

  // ── exec ─────────────────────────────────────────────────────────────────────

  /**
   * Execute a command on the remote SSH host and return stdout as a string.
   * Fire-and-forget commands (e.g. `nohup ... &`) return quickly because the
   * shell exits after spawning the background process.
   */
  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) { reject(err); return; }
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.stderr?.on("data", () => {});  // swallow stderr
        stream.on("close", () => resolve(out));
        stream.on("error", (e: Error) => reject(e));
      });
    });
  }

  // ── isAlive ───────────────────────────────────────────────────────────────────

  isAlive(): boolean {
    return this.alive;
  }

  // ── close ─────────────────────────────────────────────────────────────────────

  close(): Promise<void> {
    this.alive = false;
    return new Promise<void>((resolve) => {
      const doClose = () => {
        if (this.client) {
          try { this.client.end(); }    catch {}
          try { this.client.destroy(); } catch {}
          this.client = null;
        }
        resolve();
      };

      if (this.server) {
        this.server.close(() => doClose());
        this.server = null;
      } else {
        doClose();
      }
    });
  }
}
