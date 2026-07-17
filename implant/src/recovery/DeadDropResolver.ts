/**
 * Anonymous deterministic recovery reader.
 *
 * The server writes one sealed record to:
 *   drops/<sha256(beaconId)>.bin
 * in a dedicated public recovery repository. The beacon needs no GitHub
 * credential to read it. After opening the X25519 sealed box, the complete
 * configuration is verified with a pre-provisioned recovery Ed25519 key.
 */

import {
  recoveryDropPath,
  verifyRecoveryRecord,
  type RecoveryConfigurationV2,
  type RecoveryRecordV2,
  type RecoveryVerificationResult,
} from "@octoc2/shared";
import {
  derivePublicKey,
  openSealBox,
} from "../crypto/sodium.ts";
import { GH_UA } from "../lib/constants.ts";

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DeadDropSource {
  owner: string;
  repo: string;
  ref: string;
}

export interface DeadDropVerification {
  minimumGenerationExclusive: number;
  signingPublicKey: Uint8Array;
  expectedSigningKeyId: string;
  now?: Date;
}

export interface ResolvedDeadDrop {
  record: RecoveryRecordV2;
  generation: number;
  expiresAt: string;
  configuration: RecoveryConfigurationV2;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type VerificationFailureReason = Exclude<
  RecoveryVerificationResult,
  { valid: true }
>["reason"];

export type DeadDropFailureReason =
  | VerificationFailureReason
  | "not_found"
  | "network"
  | "decrypt_failed";

interface GitHubContentsResponse {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
}

function validateSource(source: DeadDropSource): void {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(source.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(source.repo)
  ) {
    throw new Error("Recovery repository coordinates are invalid");
  }
  if (
    source.ref.trim().length === 0 ||
    source.ref.includes("\\") ||
    source.ref.includes("..") ||
    !/^[A-Za-z0-9_./-]+$/.test(source.ref)
  ) {
    throw new Error("Recovery repository ref is invalid");
  }
}

export class DeadDropResolver {
  readonly source: DeadDropSource;
  lastFailureReason: DeadDropFailureReason | null = null;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    source: DeadDropSource,
    options: {
      apiBase?: string;
      fetchImpl?: FetchLike;
      timeoutMs?: number;
    } = {},
  ) {
    validateSource(source);
    this.source = { ...source };
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Dead-drop timeout must be a positive safe integer");
    }
  }

  async resolve(
    beaconId: string,
    secretKey: Uint8Array,
    verification: DeadDropVerification,
  ): Promise<ResolvedDeadDrop | null> {
    this.lastFailureReason = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const path = await recoveryDropPath(beaconId);
      const { owner, repo, ref } = this.source;
      const response = await this.fetchImpl(
        `${this.apiBase}/repos/${encodeURIComponent(owner)}` +
        `/${encodeURIComponent(repo)}/contents/${path}` +
        `?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": GH_UA,
            "Cache-Control": "no-cache",
          },
          signal: controller.signal,
        },
      );
      if (response.status === 404) {
        this.lastFailureReason = "not_found";
        return null;
      }
      if (!response.ok) {
        this.lastFailureReason = "network";
        return null;
      }
      const contents = await response.json() as GitHubContentsResponse;
      if (
        contents.type !== "file" ||
        contents.encoding !== "base64" ||
        typeof contents.content !== "string"
      ) {
        this.lastFailureReason = "network";
        return null;
      }
      const sealed = Buffer.from(
        contents.content.replace(/\s+/g, ""),
        "base64",
      ).toString("utf8").trim();
      if (!sealed) {
        this.lastFailureReason = "decrypt_failed";
        return null;
      }

      let record: RecoveryRecordV2;
      try {
        const publicKey = await derivePublicKey(secretKey);
        const plaintext = await openSealBox(sealed, publicKey, secretKey);
        record = JSON.parse(
          new TextDecoder().decode(plaintext),
        ) as RecoveryRecordV2;
      } catch {
        this.lastFailureReason = "decrypt_failed";
        return null;
      }

      const verified = await verifyRecoveryRecord(record, {
        beaconId,
        minimumGenerationExclusive:
          verification.minimumGenerationExclusive,
        signingPublicKey: verification.signingPublicKey,
        expectedSigningKeyId: verification.expectedSigningKeyId,
        ...(verification.now !== undefined && { now: verification.now }),
      });
      if (!verified.valid) {
        this.lastFailureReason = verified.reason;
        return null;
      }
      return {
        record,
        generation: verified.generation,
        expiresAt: verified.expiresAt,
        configuration: verified.configuration,
      };
    } catch {
      this.lastFailureReason = "network";
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
