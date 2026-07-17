import { createHash, timingSafeEqual } from "node:crypto";
import type { OctoStore, PrincipalType } from "../store/index.ts";

interface CredentialRecord {
  principal: string;
  hash: Buffer;
  hashHex: string;
}

export interface CredentialSession {
  readonly principal: string;
  readonly tokenHash: string;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class CredentialVerifier {
  private readonly records: CredentialRecord[];
  private store: OctoStore | null = null;
  private principalType: PrincipalType | null = null;

  constructor(tokensByPrincipal: Readonly<Record<string, string>>) {
    const seen = new Set<string>();
    this.records = Object.entries(tokensByPrincipal).map(([principal, token]) => {
      const normalizedPrincipal = principal.trim();
      const normalizedToken = token.trim();
      if (!normalizedPrincipal || !normalizedToken) {
        throw new Error("credential principals and tokens must be non-empty");
      }
      const tokenHash = hashToken(normalizedToken).toString("hex");
      if (seen.has(tokenHash)) throw new Error("credentials must be unique per principal");
      seen.add(tokenHash);
      return {
        principal: normalizedPrincipal,
        hash: hashToken(normalizedToken),
        hashHex: tokenHash,
      };
    });
    if (this.records.length === 0) throw new Error("at least one credential is required");
  }

  private isRecordActive(
    record: CredentialRecord,
    markUsed: boolean,
  ): boolean {
    if (!this.store || !this.principalType) return true;
    const credential = this.store.findActiveCredentialByHash(
      "sha256",
      record.hashHex,
    );
    if (!credential || credential.principalType !== this.principalType) {
      return false;
    }
    if (
      this.principalType === "beacon" &&
      credential.beaconId !== record.principal
    ) {
      return false;
    }
    if (markUsed) {
      this.store.markCredentialUsed(credential.credentialId);
    }
    return true;
  }

  authenticateAuthorizationSession(
    authorization: string | null | undefined,
  ): CredentialSession | null {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7);
    if (!token) return null;
    const candidate = hashToken(token);
    for (const record of this.records) {
      if (!timingSafeEqual(candidate, record.hash)) continue;
      if (!this.isRecordActive(record, true)) return null;
      return {
        principal: record.principal,
        tokenHash: record.hashHex,
      };
    }
    return null;
  }

  authenticateAuthorization(authorization: string | null | undefined): string | null {
    return this.authenticateAuthorizationSession(authorization)?.principal ?? null;
  }

  attachStore(store: OctoStore, principalType: "operator" | "beacon"): void {
    this.store = store;
    this.principalType = principalType;
  }

  authenticateHeadersSession(headers: Headers): CredentialSession | null {
    return this.authenticateAuthorizationSession(headers.get("Authorization"));
  }

  authenticateHeaders(headers: Headers): string | null {
    return this.authenticateHeadersSession(headers)?.principal ?? null;
  }

  authenticateGrpcMetadata(values: readonly (string | Buffer)[]): string | null {
    const value = values[0];
    if (typeof value !== "string") return null;
    return this.authenticateAuthorization(value);
  }

  hasPrincipal(principal: string): boolean {
    return this.records.some(record => record.principal === principal);
  }

  /**
   * Revalidate a previously authenticated long-lived transport without
   * retaining the plaintext bearer token in memory.
   */
  isSessionActive(session: CredentialSession): boolean {
    if (
      !session.principal ||
      !/^[0-9a-f]{64}$/.test(session.tokenHash)
    ) {
      return false;
    }
    const candidate = Buffer.from(session.tokenHash, "hex");
    const record = this.records.find(
      (entry) =>
        entry.principal === session.principal &&
        timingSafeEqual(candidate, entry.hash),
    );
    return record ? this.isRecordActive(record, true) : false;
  }
}

export function parseCredentialMap(raw: string, variableName: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} must be a JSON object mapping principal IDs to tokens`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be a JSON object mapping principal IDs to tokens`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== "string")) {
    throw new Error(`${variableName} must contain at least one string token`);
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value as string]));
}
