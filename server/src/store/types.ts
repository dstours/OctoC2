import type { ChannelId } from "@octoc2/shared";

export type BeaconStatus = "active" | "dormant" | "lost";

export interface StoredBeacon {
  beaconId: string;
  issueNumber: number | null;
  x25519PublicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  firstSeen: string;
  lastSeen: string;
  status: BeaconStatus;
  lastSeq: number;
  activeTentacle: ChannelId | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertBeaconInput {
  beaconId: string;
  issueNumber: number | null;
  x25519PublicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  firstSeen?: string;
  lastSeen?: string;
  status?: BeaconStatus;
  lastSeq?: number;
  activeTentacle?: ChannelId | null;
}

export type AdvanceBeaconSequenceResult =
  | { status: "advanced"; previousSeq: number }
  | { status: "gap"; previousSeq: number }
  | { status: "replay"; lastSeq: number }
  | { status: "unknown" };

export interface BeaconSequenceReceipt {
  beaconId: string;
  sequence: number;
  envelopeDigest: string;
  envelopeKind: "checkin" | "task-result";
  acceptedAt: string;
}

export type AdvanceBeaconSequenceWithReceiptResult =
  | { status: "advanced"; previousSeq: number }
  | { status: "gap"; previousSeq: number }
  | { status: "exact_duplicate"; receipt: BeaconSequenceReceipt }
  | { status: "conflict"; receipt: BeaconSequenceReceipt }
  | { status: "replay"; lastSeq: number }
  | { status: "unknown" };

export interface AcceptBeaconCheckinInput {
  beaconId: string;
  sequence: number;
  envelopeDigest: string;
  issueNumber: number | null;
  x25519PublicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  activeTentacle: ChannelId;
  seenAt?: string;
}

export type IdentityKeyStatus = "active" | "retired" | "revoked";

export interface BeaconIdentityKey {
  keyId: string;
  beaconId: string;
  algorithm: "ed25519";
  publicKey: string;
  status: IdentityKeyStatus;
  provisionedAt: string;
  provisionedBy: string;
  retiredAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface ProvisionIdentityKeyInput {
  keyId: string;
  beaconId: string;
  publicKey: string;
  provisionedBy: string;
  provisionedAt?: string;
}

export type ProvisionIdentityKeyResult =
  | { status: "created"; key: BeaconIdentityKey }
  | { status: "existing"; key: BeaconIdentityKey }
  | { status: "conflict"; activeKey: BeaconIdentityKey };

export interface RotateIdentityKeyInput extends ProvisionIdentityKeyInput {
  expectedCurrentKeyId: string;
}

export type PrincipalType = "operator" | "beacon" | "server";
export type CredentialHashAlgorithm = "sha256" | "argon2id" | "scrypt";

export interface StoredCredential {
  credentialId: string;
  principalType: PrincipalType;
  beaconId: string | null;
  tokenHash: string;
  hashAlgorithm: CredentialHashAlgorithm;
  label: string | null;
  scopes: readonly string[];
  issuedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface InsertCredentialHashInput {
  credentialId: string;
  principalType: PrincipalType;
  beaconId: string | null;
  tokenHash: string;
  hashAlgorithm: CredentialHashAlgorithm;
  label?: string | null;
  scopes?: readonly string[];
  issuedAt?: string;
  expiresAt?: string | null;
}

export type StoredTaskState =
  | "pending"
  | "delivered"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface StoredTask {
  taskId: string;
  beaconId: string;
  kind: string;
  args: Readonly<Record<string, unknown>>;
  state: StoredTaskState;
  createdAt: string;
  availableAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  ref: string;
  preferredChannel: string | null;
  failureReason: string | null;
}

export interface CreateTaskInput {
  taskId?: string;
  beaconId: string;
  kind: string;
  args?: Readonly<Record<string, unknown>>;
  ref?: string;
  preferredChannel?: string | null;
  createdAt?: string;
  availableAt?: string;
  expiresAt?: string | null;
}

export interface StoredTaskResult {
  resultId: string;
  taskId: string;
  beaconId: string;
  canonicalDigest: string;
  canonicalResult: string;
  signature: string;
  signatureKeyId: string;
  signatureVerified: true;
  receivedAt: string;
  sourceChannel: string | null;
  sourceMessageId: string | null;
}

export interface TaskResultSource {
  channel: string;
  messageId: string;
  /**
   * SHA-256 of the immutable transport artifact. When omitted, the canonical
   * result digest is used.
   */
  payloadDigest?: string;
}

export interface CompleteTaskResultInput {
  taskId: string;
  beaconId: string;
  canonicalResult: string;
  signature: string;
  signatureKeyId: string;
  /**
   * The identity service must perform cryptographic verification before
   * calling the store. The store persists only successful verification.
   */
  signatureVerified: boolean;
  /**
   * Monotonic signer sequence. When supplied, replay validation and task
   * completion occur in the same SQLite transaction.
   */
  sequence?: number;
  sequenceDigest?: string;
  resultId?: string;
  receivedAt?: string;
  source?: TaskResultSource;
}

export type CompleteTaskResultResult =
  | { status: "completed"; result: StoredTaskResult }
  | { status: "exact_duplicate"; result: StoredTaskResult }
  | { status: "conflicting_duplicate"; result: StoredTaskResult }
  | { status: "conflicting_message" }
  | { status: "replayed_message" }
  | { status: "task_not_found" }
  | { status: "owner_mismatch" }
  | { status: "invalid_signature" }
  | { status: "identity_key_mismatch" }
  | { status: "invalid_state"; state: StoredTaskState };

export interface DeliveryLease {
  taskId: string;
  beaconId: string;
  leaseToken: string;
  channel: string;
  workerId: string;
  leasedAt: string;
  expiresAt: string;
  attemptNumber: number;
}

export interface DeliveryAttempt {
  attemptId: string;
  taskId: string;
  beaconId: string;
  channel: string;
  workerId: string;
  leaseToken: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: "leased" | DeliveryOutcome;
  error: string | null;
}

export interface ClaimDeliveryInput {
  taskId: string;
  beaconId: string;
  channel: string;
  workerId: string;
  leaseDurationMs: number;
  now?: string;
  oidcRequestGuard?: OidcRequestGuard;
}

export type ClaimDeliveryResult =
  | { status: "claimed"; lease: DeliveryLease }
  | { status: "task_not_found" }
  | { status: "owner_mismatch" }
  | { status: "not_deliverable"; state: StoredTaskState }
  | { status: "already_leased"; lease: DeliveryLease }
  | { status: "oidc_request_ownership_lost" };

export type DeliveryOutcome =
  | "delivered"
  | "transient_failure"
  | "permanent_failure";

export interface FinishDeliveryInput {
  leaseToken: string;
  outcome: DeliveryOutcome;
  finishedAt?: string;
  error?: string | null;
}

export interface ProcessedChannelMessage {
  channel: string;
  messageId: string;
  payloadDigest: string;
  beaconId: string | null;
  taskId: string | null;
  outcome: "accepted" | "duplicate" | "rejected";
  processedAt: string;
}

export interface CommitChannelProgressInput {
  channel: string;
  scope: string;
  messageId: string;
  payloadDigest: string;
  cursor: string;
  beaconId?: string | null;
  taskId?: string | null;
  outcome?: ProcessedChannelMessage["outcome"];
  processedAt?: string;
}

export type CommitChannelProgressResult =
  | { status: "committed" }
  | { status: "exact_duplicate" }
  | { status: "conflicting_duplicate" };

export interface OidcRequestGuard {
  jti: string;
  ownerToken: string;
}

export interface StoredOidcRequest {
  jti: string;
  repository: string;
  payloadDigest: string;
  beaconId: string;
  tokenExpiresAt: string;
  state: "processing" | "completed";
  ownerToken: string | null;
  workerId: string;
  processingLeaseExpiresAt: string | null;
  responseStatus: number | null;
  responseHeaders: Readonly<Record<string, string>> | null;
  responseBody: string | null;
  outcome: "accepted" | "rejected" | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompletedOidcRequest extends StoredOidcRequest {
  state: "completed";
  ownerToken: null;
  processingLeaseExpiresAt: null;
  responseStatus: number;
  responseHeaders: Readonly<Record<string, string>>;
  responseBody: string;
  outcome: "accepted" | "rejected";
}

export interface BeginOidcRequestInput {
  jti: string;
  repository: string;
  payloadDigest: string;
  beaconId: string;
  tokenExpiresAt: string;
  processingLeaseMs: number;
  replayChannel: string;
  now?: string;
}

export type BeginOidcRequestResult =
  | {
      status: "acquired";
      ownerToken: string;
      workerId: string;
      recovered: boolean;
      releasedTaskIds: readonly string[];
    }
  | { status: "cached"; request: CompletedOidcRequest }
  | { status: "in_progress"; leaseExpiresAt: string }
  | { status: "legacy_replay" }
  | { status: "conflicting_replay" };

export interface CompleteOidcRequestInput {
  jti: string;
  repository: string;
  payloadDigest: string;
  beaconId: string;
  ownerToken: string;
  responseStatus: number;
  responseHeaders: Readonly<Record<string, string>>;
  responseBody: string;
  outcome: "accepted" | "rejected";
  deliveryLeaseTokens?: readonly string[];
  replayChannel: string;
  replayScope: string;
  replayCursor: string;
  completedAt?: string;
}

export type CompleteOidcRequestResult =
  | {
      status: "completed";
      request: CompletedOidcRequest;
      deliveredTaskIds: readonly string[];
    }
  | { status: "cached"; request: CompletedOidcRequest }
  | { status: "legacy_replay" }
  | { status: "conflicting_replay" }
  | { status: "ownership_lost" }
  | { status: "delivery_conflict"; leaseToken: string }
  | { status: "missing" };

export interface AbortOidcRequestInput {
  jti: string;
  ownerToken: string;
  workerId: string;
  error?: string | null;
  abortedAt?: string;
}

export interface SweepOidcRequestsResult {
  completedDeleted: number;
  processingDeleted: number;
  releasedTaskIds: readonly string[];
}

export interface PollCursor {
  channel: string;
  scope: string;
  cursor: string;
  updatedAt: string;
}

export type LegacyRegistryImportResult =
  | {
      status: "disabled" | "not_found" | "already_imported";
      importedCount: 0;
      backupPath: string | null;
    }
  | {
      status: "imported";
      importedCount: number;
      backupPath: string;
    };

export interface StorePragmas {
  foreignKeys: boolean;
  journalMode: string;
  busyTimeoutMs: number;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}
