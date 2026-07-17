import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { CHANNEL_BY_ID, type ChannelId } from "@octoc2/shared";

import {
  CURRENT_SCHEMA_VERSION,
  migrateStore,
} from "./migrations.ts";
import type {
  AbortOidcRequestInput,
  AdvanceBeaconSequenceResult,
  AdvanceBeaconSequenceWithReceiptResult,
  AcceptBeaconCheckinInput,
  AppliedMigration,
  BeaconIdentityKey,
  BeaconSequenceReceipt,
  BeginOidcRequestInput,
  BeginOidcRequestResult,
  ClaimDeliveryInput,
  ClaimDeliveryResult,
  CommitChannelProgressInput,
  CommitChannelProgressResult,
  CompleteOidcRequestInput,
  CompleteOidcRequestResult,
  CompletedOidcRequest,
  CompleteTaskResultInput,
  CompleteTaskResultResult,
  CreateTaskInput,
  DeliveryAttempt,
  DeliveryLease,
  FinishDeliveryInput,
  InsertCredentialHashInput,
  LegacyRegistryImportResult,
  PollCursor,
  ProcessedChannelMessage,
  ProvisionIdentityKeyInput,
  ProvisionIdentityKeyResult,
  RotateIdentityKeyInput,
  StorePragmas,
  StoredBeacon,
  StoredCredential,
  StoredOidcRequest,
  StoredTask,
  StoredTaskResult,
  StoredTaskState,
  SweepOidcRequestsResult,
  UpsertBeaconInput,
} from "./types.ts";

const DEFAULT_DATABASE_NAME = "octoc2.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const LEGACY_IMPORT_KEY = "registry-json-v1";
const LEGACY_BACKUP_NAME = "registry.json.pre-sqlite.bak";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OIDC_REPLAY_CHANNEL = "oidc-jti";

export interface OctoStoreOptions {
  dataDir?: string;
  databaseName?: string;
  busyTimeoutMs?: number;
  importLegacyRegistry?: boolean;
  legacyRegistryPath?: string;
  now?: () => Date;
}

interface BeaconRow {
  beacon_id: string;
  issue_number: number | null;
  x25519_public_key: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  first_seen: string;
  last_seen: string;
  status: StoredBeacon["status"];
  last_seq: number;
  active_tentacle: string | null;
  created_at: string;
  updated_at: string;
}

interface IdentityKeyRow {
  key_id: string;
  beacon_id: string;
  algorithm: "ed25519";
  public_key: string;
  status: BeaconIdentityKey["status"];
  provisioned_at: string;
  provisioned_by: string;
  retired_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface CredentialRow {
  credential_id: string;
  principal_type: StoredCredential["principalType"];
  beacon_id: string | null;
  token_hash: string;
  hash_algorithm: StoredCredential["hashAlgorithm"];
  label: string | null;
  scopes_json: string;
  issued_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface TaskRow {
  task_id: string;
  beacon_id: string;
  kind: string;
  args_json: string;
  state: StoredTaskState;
  created_at: string;
  available_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  ref: string;
  preferred_channel: string | null;
  failure_reason: string | null;
}

interface TaskResultRow {
  result_id: string;
  task_id: string;
  beacon_id: string;
  canonical_digest: string;
  canonical_result: string;
  signature: string;
  signature_key_id: string;
  signature_verified: 1;
  received_at: string;
  source_channel: string | null;
  source_message_id: string | null;
}

interface LeaseRow {
  task_id: string;
  beacon_id: string;
  lease_token: string;
  channel: string;
  worker_id: string;
  leased_at: string;
  expires_at: string;
  attempt_number: number;
}

interface DeliveryAttemptRow {
  attempt_id: string;
  task_id: string;
  beacon_id: string;
  channel: string;
  worker_id: string;
  lease_token: string;
  attempt_number: number;
  started_at: string;
  finished_at: string | null;
  outcome: DeliveryAttempt["outcome"];
  error: string | null;
}

interface ProcessedMessageRow {
  channel: string;
  message_id: string;
  payload_digest: string;
  beacon_id: string | null;
  task_id: string | null;
  outcome: ProcessedChannelMessage["outcome"];
  processed_at: string;
}

interface PollCursorRow {
  channel: string;
  scope: string;
  cursor: string;
  updated_at: string;
}

interface LegacyImportRow {
  backup_path: string;
}

interface SequenceReceiptRow {
  beacon_id: string;
  sequence: number;
  envelope_digest: string;
  envelope_kind: BeaconSequenceReceipt["envelopeKind"];
  accepted_at: string;
}

interface OidcRequestRow {
  jti: string;
  repository: string;
  payload_digest: string;
  beacon_id: string;
  token_expires_at: string;
  state: StoredOidcRequest["state"];
  owner_token: string | null;
  worker_id: string;
  processing_lease_expires_at: string | null;
  response_status: number | null;
  response_headers_json: string | null;
  response_body: string | null;
  outcome: StoredOidcRequest["outcome"];
  created_at: string;
  updated_at: string;
}

interface CountRow {
  count: number;
}

interface ForeignKeysPragmaRow {
  foreign_keys: number;
}

interface JournalModePragmaRow {
  journal_mode: string;
}

interface BusyTimeoutPragmaRow {
  timeout: number;
}

interface LegacyRegistrySnapshot {
  version: 1;
  savedAt: string;
  beacons: LegacyBeaconRecord[];
}

interface LegacyBeaconRecord {
  beaconId: string;
  issueNumber: number;
  publicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  firstSeen: string;
  lastSeen: string;
  status: StoredBeacon["status"];
  lastSeq: number;
  activeTentacle?: ChannelId;
}

export class OctoStore {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly currentSchemaVersion = CURRENT_SCHEMA_VERSION;
  readonly legacyImport: LegacyRegistryImportResult;

  private readonly database: Database;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: OctoStoreOptions = {}) {
    const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    if (
      databaseName !== ":memory:" &&
      (basename(databaseName) !== databaseName || databaseName.trim().length === 0)
    ) {
      throw new Error("databaseName must be a filename, not a path");
    }

    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error("busyTimeoutMs must be a non-negative safe integer");
    }

    this.now = options.now ?? (() => new Date());
    this.dataDir = resolve(
      options.dataDir ?? process.env["OCTOC2_DATA_DIR"] ?? "./data",
    );
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });

    this.databasePath =
      databaseName === ":memory:" ? databaseName : join(this.dataDir, databaseName);
    this.database = new Database(this.databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });

    try {
      this.configureDatabase(busyTimeoutMs);
      migrateStore(this.database, () => this.timestamp());
      this.legacyImport =
        options.importLegacyRegistry === false
          ? { status: "disabled", importedCount: 0, backupPath: null }
          : this.importLegacyRegistry(
              options.legacyRegistryPath ?? join(this.dataDir, "registry.json"),
            );
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  static open(options: OctoStoreOptions = {}): OctoStore {
    return new OctoStore(options);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  getPragmas(): StorePragmas {
    this.assertOpen();

    const foreignKeys = this.database
      .query<ForeignKeysPragmaRow, []>("PRAGMA foreign_keys")
      .get();
    const journalMode = this.database
      .query<JournalModePragmaRow, []>("PRAGMA journal_mode")
      .get();
    const busyTimeout = this.database
      .query<BusyTimeoutPragmaRow, []>("PRAGMA busy_timeout")
      .get();

    return {
      foreignKeys: foreignKeys?.foreign_keys === 1,
      journalMode: journalMode?.journal_mode ?? "",
      busyTimeoutMs: busyTimeout?.timeout ?? 0,
    };
  }

  getAppliedMigrations(): AppliedMigration[] {
    this.assertOpen();
    return this.database
      .query<
        { version: number; name: string; applied_at: string },
        []
      >(
        `SELECT version, name, applied_at
         FROM schema_migrations
         ORDER BY version`,
      )
      .all()
      .map((row) => ({
        version: row.version,
        name: row.name,
        appliedAt: row.applied_at,
      }));
  }

  upsertBeacon(input: UpsertBeaconInput): StoredBeacon {
    this.assertOpen();
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.x25519PublicKey, "x25519PublicKey");
    this.requireNonNegativeInteger(input.lastSeq ?? 0, "lastSeq");
    if (
      input.issueNumber !== null &&
      (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
    ) {
      throw new Error("issueNumber must be null or a positive safe integer");
    }
    if (
      input.activeTentacle !== undefined &&
      input.activeTentacle !== null &&
      !Object.prototype.hasOwnProperty.call(
        CHANNEL_BY_ID,
        String(input.activeTentacle),
      )
    ) {
      throw new Error("activeTentacle must be null or a canonical channel ID");
    }

    const existing = this.getBeacon(input.beaconId);
    const now = this.timestamp();
    const firstSeen = input.firstSeen ?? existing?.firstSeen ?? now;
    const lastSeen = input.lastSeen ?? now;
    const status = input.status ?? "active";
    const activeTentacle =
      input.activeTentacle === undefined
        ? (existing?.activeTentacle ?? null)
        : input.activeTentacle;

    this.database
      .query<
        never,
        [
          string,
          number | null,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          StoredBeacon["status"],
          number,
          string | null,
          string,
          string,
        ]
      >(
        `INSERT INTO beacons (
           beacon_id,
           issue_number,
           x25519_public_key,
           hostname,
           username,
           os,
           arch,
           first_seen,
           last_seen,
           status,
           last_seq,
           active_tentacle,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(beacon_id) DO UPDATE SET
           issue_number = excluded.issue_number,
           x25519_public_key = excluded.x25519_public_key,
           hostname = excluded.hostname,
           username = excluded.username,
           os = excluded.os,
           arch = excluded.arch,
           last_seen = excluded.last_seen,
           status = excluded.status,
           last_seq = excluded.last_seq,
           active_tentacle = excluded.active_tentacle,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.beaconId,
        input.issueNumber,
        input.x25519PublicKey,
        input.hostname,
        input.username,
        input.os,
        input.arch,
        firstSeen,
        lastSeen,
        status,
        input.lastSeq ?? 0,
        activeTentacle === null ? null : String(activeTentacle),
        existing?.createdAt ?? now,
        now,
      );

    const stored = this.getBeacon(input.beaconId);
    if (!stored) throw new Error("Failed to persist beacon");
    return stored;
  }

  getBeacon(beaconId: string): StoredBeacon | undefined {
    this.assertOpen();
    const row = this.database
      .query<BeaconRow, [string]>(
        `SELECT *
         FROM beacons
         WHERE beacon_id = ?`,
      )
      .get(beaconId);
    return row ? this.mapBeacon(row) : undefined;
  }

  listBeacons(): StoredBeacon[] {
    this.assertOpen();
    return this.database
      .query<BeaconRow, []>("SELECT * FROM beacons ORDER BY first_seen, beacon_id")
      .all()
      .map((row) => this.mapBeacon(row));
  }

  advanceBeaconSequence(
    beaconId: string,
    sequence: number,
    seenAt = this.timestamp(),
  ): AdvanceBeaconSequenceResult {
    this.assertOpen();
    this.requireNonNegativeInteger(sequence, "sequence");

    const advance = this.database.transaction(
      (): AdvanceBeaconSequenceResult => {
        const beacon = this.getBeacon(beaconId);
        if (!beacon) return { status: "unknown" };
        if (sequence <= beacon.lastSeq) {
          return { status: "replay", lastSeq: beacon.lastSeq };
        }

        const updated = this.database
          .query<never, [number, string, string, string, number]>(
            `UPDATE beacons
             SET last_seq = ?,
                 last_seen = ?,
                 status = 'active',
                 updated_at = ?
             WHERE beacon_id = ? AND last_seq = ?`,
          )
          .run(sequence, seenAt, seenAt, beaconId, beacon.lastSeq);
        if (updated.changes !== 1) {
          throw new Error("Beacon sequence changed during replay transaction");
        }

        return sequence > beacon.lastSeq + 100
          ? { status: "gap", previousSeq: beacon.lastSeq }
          : { status: "advanced", previousSeq: beacon.lastSeq };
      },
    );

    return advance.immediate();
  }

  advanceBeaconSequenceWithReceipt(
    beaconId: string,
    sequence: number,
    envelopeDigest: string,
    envelopeKind: BeaconSequenceReceipt["envelopeKind"],
    seenAt = this.timestamp(),
  ): AdvanceBeaconSequenceWithReceiptResult {
    this.assertOpen();
    this.requireNonNegativeInteger(sequence, "sequence");
    this.validateSha256(envelopeDigest, "envelopeDigest");

    const advance = this.database.transaction(
      (): AdvanceBeaconSequenceWithReceiptResult => {
        const receipt = this.getBeaconSequenceReceipt(beaconId, sequence);
        if (receipt) {
          return receipt.envelopeDigest === envelopeDigest &&
              receipt.envelopeKind === envelopeKind
            ? { status: "exact_duplicate", receipt }
            : { status: "conflict", receipt };
        }
        const beacon = this.getBeacon(beaconId);
        if (!beacon) return { status: "unknown" };
        if (sequence <= beacon.lastSeq) {
          return { status: "replay", lastSeq: beacon.lastSeq };
        }
        const updated = this.database
          .query<never, [number, string, string, string, number]>(
            `UPDATE beacons
             SET last_seq = ?,
                 last_seen = ?,
                 status = 'active',
                 updated_at = ?
             WHERE beacon_id = ? AND last_seq = ?`,
          )
          .run(sequence, seenAt, seenAt, beaconId, beacon.lastSeq);
        if (updated.changes !== 1) {
          throw new Error(
            "Beacon sequence changed during receipt transaction",
          );
        }
        this.insertBeaconSequenceReceipt({
          beaconId,
          sequence,
          envelopeDigest,
          envelopeKind,
          acceptedAt: seenAt,
        });
        return sequence > beacon.lastSeq + 100
          ? { status: "gap", previousSeq: beacon.lastSeq }
          : { status: "advanced", previousSeq: beacon.lastSeq };
      },
    );
    return advance.immediate();
  }

  acceptBeaconCheckin(
    input: AcceptBeaconCheckinInput,
  ): AdvanceBeaconSequenceWithReceiptResult {
    this.assertOpen();
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.x25519PublicKey, "x25519PublicKey");
    this.requireNonNegativeInteger(input.sequence, "sequence");
    this.validateSha256(input.envelopeDigest, "envelopeDigest");
    if (
      input.issueNumber !== null &&
      (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
    ) {
      throw new Error("issueNumber must be null or a positive safe integer");
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        CHANNEL_BY_ID,
        String(input.activeTentacle),
      )
    ) {
      throw new Error("activeTentacle must be a canonical channel ID");
    }

    const accept = this.database.transaction(
      (): AdvanceBeaconSequenceWithReceiptResult => {
        const receipt = this.getBeaconSequenceReceipt(
          input.beaconId,
          input.sequence,
        );
        if (receipt) {
          return receipt.envelopeDigest === input.envelopeDigest &&
              receipt.envelopeKind === "checkin"
            ? { status: "exact_duplicate", receipt }
            : { status: "conflict", receipt };
        }
        const beacon = this.getBeacon(input.beaconId);
        if (!beacon) return { status: "unknown" };
        if (input.sequence <= beacon.lastSeq) {
          return { status: "replay", lastSeq: beacon.lastSeq };
        }

        const seenAt = input.seenAt ?? this.timestamp();
        const updated = this.database
          .query<
            never,
            [
              number,
              string,
              number | null,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              number,
            ]
          >(
            `UPDATE beacons
             SET last_seq = ?,
                 last_seen = ?,
                 status = 'active',
                 issue_number = ?,
                 x25519_public_key = ?,
                 hostname = ?,
                 username = ?,
                 os = ?,
                 arch = ?,
                 active_tentacle = ?,
                 updated_at = ?
             WHERE beacon_id = ? AND last_seq = ?`,
          )
          .run(
            input.sequence,
            seenAt,
            input.issueNumber,
            input.x25519PublicKey,
            input.hostname,
            input.username,
            input.os,
            input.arch,
            String(input.activeTentacle),
            seenAt,
            input.beaconId,
            beacon.lastSeq,
          );
        if (updated.changes !== 1) {
          throw new Error(
            "Beacon changed during atomic check-in acceptance",
          );
        }
        this.insertBeaconSequenceReceipt({
          beaconId: input.beaconId,
          sequence: input.sequence,
          envelopeDigest: input.envelopeDigest,
          envelopeKind: "checkin",
          acceptedAt: seenAt,
        });
        return input.sequence > beacon.lastSeq + 100
          ? { status: "gap", previousSeq: beacon.lastSeq }
          : { status: "advanced", previousSeq: beacon.lastSeq };
      },
    );
    return accept.immediate();
  }

  getBeaconSequenceReceipt(
    beaconId: string,
    sequence: number,
  ): BeaconSequenceReceipt | undefined {
    this.assertOpen();
    const row = this.database
      .query<SequenceReceiptRow, [string, number]>(
        `SELECT *
         FROM beacon_sequence_receipts
         WHERE beacon_id = ? AND sequence = ?`,
      )
      .get(beaconId, sequence);
    return row ? {
      beaconId: row.beacon_id,
      sequence: row.sequence,
      envelopeDigest: row.envelope_digest,
      envelopeKind: row.envelope_kind,
      acceptedAt: row.accepted_at,
    } : undefined;
  }

  provisionIdentityKey(
    input: ProvisionIdentityKeyInput,
  ): ProvisionIdentityKeyResult {
    this.assertOpen();
    this.requireNonEmpty(input.keyId, "keyId");
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.publicKey, "publicKey");
    this.requireNonEmpty(input.provisionedBy, "provisionedBy");
    if (!this.getBeacon(input.beaconId)) {
      throw new Error(`Cannot provision identity for unknown beacon ${input.beaconId}`);
    }

    const provision = this.database.transaction((): ProvisionIdentityKeyResult => {
      const active = this.getActiveIdentityKey(input.beaconId);
      if (active) {
        if (active.keyId === input.keyId && active.publicKey === input.publicKey) {
          return { status: "existing", key: active };
        }
        return { status: "conflict", activeKey: active };
      }

      this.insertIdentityKey(input);
      const key = this.getIdentityKey(input.keyId);
      if (!key) throw new Error("Failed to persist identity key");
      return { status: "created", key };
    });

    return provision.immediate();
  }

  rotateIdentityKey(
    input: RotateIdentityKeyInput,
  ): ProvisionIdentityKeyResult {
    this.assertOpen();
    const rotate = this.database.transaction((): ProvisionIdentityKeyResult => {
      const active = this.getActiveIdentityKey(input.beaconId);
      if (!active || active.keyId !== input.expectedCurrentKeyId) {
        if (active) return { status: "conflict", activeKey: active };
        throw new Error(`Beacon ${input.beaconId} has no active identity key`);
      }

      if (active.keyId === input.keyId && active.publicKey === input.publicKey) {
        return { status: "existing", key: active };
      }

      const retiredAt = input.provisionedAt ?? this.timestamp();
      this.database
        .query<never, [string, string]>(
          `UPDATE beacon_identity_keys
           SET status = 'retired', retired_at = ?
           WHERE key_id = ? AND status = 'active'`,
        )
        .run(retiredAt, active.keyId);
      this.insertIdentityKey(input);

      const key = this.getIdentityKey(input.keyId);
      if (!key) throw new Error("Failed to persist rotated identity key");
      return { status: "created", key };
    });

    return rotate.immediate();
  }

  revokeIdentityKey(
    keyId: string,
    reason: string,
    revokedAt = this.timestamp(),
  ): boolean {
    this.assertOpen();
    this.requireNonEmpty(reason, "reason");
    const result = this.database
      .query<never, [string, string, string]>(
        `UPDATE beacon_identity_keys
         SET status = 'revoked',
             revoked_at = ?,
             revocation_reason = ?
         WHERE key_id = ? AND status <> 'revoked'`,
      )
      .run(revokedAt, reason, keyId);
    return result.changes === 1;
  }

  getIdentityKey(keyId: string): BeaconIdentityKey | undefined {
    this.assertOpen();
    const row = this.database
      .query<IdentityKeyRow, [string]>(
        "SELECT * FROM beacon_identity_keys WHERE key_id = ?",
      )
      .get(keyId);
    return row ? this.mapIdentityKey(row) : undefined;
  }

  getActiveIdentityKey(beaconId: string): BeaconIdentityKey | undefined {
    this.assertOpen();
    const row = this.database
      .query<IdentityKeyRow, [string]>(
        `SELECT *
         FROM beacon_identity_keys
         WHERE beacon_id = ? AND status = 'active'`,
      )
      .get(beaconId);
    return row ? this.mapIdentityKey(row) : undefined;
  }

  insertCredentialHash(input: InsertCredentialHashInput): StoredCredential {
    this.assertOpen();
    this.requireNonEmpty(input.credentialId, "credentialId");
    this.validateCredentialHash(input.hashAlgorithm, input.tokenHash);
    if (
      (input.principalType === "beacon" && input.beaconId === null) ||
      (input.principalType !== "beacon" && input.beaconId !== null)
    ) {
      throw new Error("Credential principal and beaconId binding are inconsistent");
    }
    if (input.beaconId !== null && !this.getBeacon(input.beaconId)) {
      throw new Error(`Cannot bind credential to unknown beacon ${input.beaconId}`);
    }

    const scopes = [...(input.scopes ?? [])];
    if (!scopes.every((scope) => typeof scope === "string" && scope.length > 0)) {
      throw new Error("Credential scopes must be non-empty strings");
    }

    this.database
      .query<
        never,
        [
          string,
          StoredCredential["principalType"],
          string | null,
          string,
          StoredCredential["hashAlgorithm"],
          string | null,
          string,
          string,
          string | null,
        ]
      >(
        `INSERT INTO credentials (
           credential_id,
           principal_type,
           beacon_id,
           token_hash,
           hash_algorithm,
           label,
           scopes_json,
           issued_at,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.credentialId,
        input.principalType,
        input.beaconId,
        input.tokenHash,
        input.hashAlgorithm,
        input.label ?? null,
        JSON.stringify(scopes),
        input.issuedAt ?? this.timestamp(),
        input.expiresAt ?? null,
      );

    const credential = this.getCredential(input.credentialId);
    if (!credential) throw new Error("Failed to persist credential hash");
    return credential;
  }

  getCredential(credentialId: string): StoredCredential | undefined {
    this.assertOpen();
    const row = this.database
      .query<CredentialRow, [string]>(
        "SELECT * FROM credentials WHERE credential_id = ?",
      )
      .get(credentialId);
    return row ? this.mapCredential(row) : undefined;
  }

  findActiveCredentialByHash(
    hashAlgorithm: StoredCredential["hashAlgorithm"],
    tokenHash: string,
    at = this.timestamp(),
  ): StoredCredential | undefined {
    this.assertOpen();
    this.validateCredentialHash(hashAlgorithm, tokenHash);
    const row = this.database
      .query<CredentialRow, [StoredCredential["hashAlgorithm"], string, string]>(
        `SELECT *
         FROM credentials
         WHERE hash_algorithm = ?
           AND token_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(hashAlgorithm, tokenHash, at);
    return row ? this.mapCredential(row) : undefined;
  }

  markCredentialUsed(
    credentialId: string,
    usedAt = this.timestamp(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .query<never, [string, string]>(
          `UPDATE credentials
           SET last_used_at = ?
           WHERE credential_id = ? AND revoked_at IS NULL`,
        )
        .run(usedAt, credentialId).changes === 1
    );
  }

  revokeCredential(
    credentialId: string,
    reason: string,
    revokedAt = this.timestamp(),
  ): boolean {
    this.assertOpen();
    this.requireNonEmpty(reason, "reason");
    return (
      this.database
        .query<never, [string, string, string]>(
          `UPDATE credentials
           SET revoked_at = ?, revocation_reason = ?
           WHERE credential_id = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, reason, credentialId).changes === 1
    );
  }

  revokeExpiredCredentials(at = this.timestamp()): number {
    this.assertOpen();
    return this.database
      .query<never, [string, string, string]>(
        `UPDATE credentials
         SET revoked_at = ?, revocation_reason = ?
         WHERE revoked_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .run(at, "expired", at).changes;
  }

  createTask(input: CreateTaskInput): StoredTask {
    this.assertOpen();
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.kind, "kind");
    if (!this.getBeacon(input.beaconId)) {
      throw new Error(`Cannot create task for unknown beacon ${input.beaconId}`);
    }

    const taskId = input.taskId ?? randomUUID();
    const ref = input.ref ?? taskId.replaceAll("-", "").slice(0, 12);
    const createdAt = input.createdAt ?? this.timestamp();
    const availableAt = input.availableAt ?? createdAt;
    this.requireNonEmpty(taskId, "taskId");
    this.requireNonEmpty(ref, "ref");

    const argsJson = JSON.stringify(input.args ?? {});
    if (argsJson === undefined) throw new Error("Task args must be JSON serializable");

    this.database
      .query<
        never,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
        ]
      >(
        `INSERT INTO tasks (
           task_id,
           beacon_id,
           kind,
           args_json,
           state,
           created_at,
           available_at,
           expires_at,
           ref,
           preferred_channel
         )
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        input.beaconId,
        input.kind,
        argsJson,
        createdAt,
        availableAt,
        input.expiresAt ?? null,
        ref,
        input.preferredChannel ?? null,
      );

    const task = this.getTask(taskId);
    if (!task) throw new Error("Failed to persist task");
    return task;
  }

  getTask(taskId: string): StoredTask | undefined {
    this.assertOpen();
    const row = this.getTaskRow(taskId);
    return row ? this.mapTask(row) : undefined;
  }

  getTaskByRef(ref: string): StoredTask | undefined {
    this.assertOpen();
    const row = this.database
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE ref = ?")
      .get(ref);
    return row ? this.mapTask(row) : undefined;
  }

  markTaskDelivered(
    taskId: string,
    deliveredAt = this.timestamp(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .query<never, [string, string]>(
          `UPDATE tasks
           SET state = 'delivered',
               delivered_at = ?
           WHERE task_id = ? AND state = 'pending'`,
        )
        .run(deliveredAt, taskId).changes === 1
    );
  }

  markTaskFailed(
    taskId: string,
    reason: string,
    failedAt = this.timestamp(),
  ): boolean {
    this.assertOpen();
    this.requireNonEmpty(reason, "reason");
    return (
      this.database
        .query<never, [string, string, string]>(
          `UPDATE tasks
           SET state = 'failed',
               completed_at = ?,
               failure_reason = ?
           WHERE task_id = ? AND state IN ('pending', 'delivered')`,
        )
        .run(failedAt, reason, taskId).changes === 1
    );
  }

  listTasksForBeacon(beaconId: string): StoredTask[] {
    this.assertOpen();
    return this.database
      .query<TaskRow, [string]>(
        `SELECT *
         FROM tasks
         WHERE beacon_id = ?
         ORDER BY created_at, task_id`,
      )
      .all(beaconId)
      .map((row) => this.mapTask(row));
  }

  listDeliverableTasks(
    beaconId: string,
    channel: string,
    at = this.timestamp(),
  ): StoredTask[] {
    this.assertOpen();
    return this.database
      .query<TaskRow, [string, string, string, string, string]>(
        `SELECT t.*
         FROM tasks t
         LEFT JOIN delivery_leases l
           ON l.task_id = t.task_id AND l.expires_at > ?
         WHERE t.beacon_id = ?
           AND t.state IN ('pending', 'delivered')
           AND t.available_at <= ?
           AND (t.expires_at IS NULL OR t.expires_at > ?)
           AND (t.preferred_channel IS NULL OR t.preferred_channel = ?)
           AND l.task_id IS NULL
         ORDER BY t.created_at, t.task_id`,
      )
      .all(at, beaconId, at, at, channel)
      .map((row) => this.mapTask(row));
  }

  getTaskResult(taskId: string): StoredTaskResult | undefined {
    this.assertOpen();
    const row = this.getTaskResultRow(taskId);
    return row ? this.mapTaskResult(row) : undefined;
  }

  completeTaskResult(
    input: CompleteTaskResultInput,
  ): CompleteTaskResultResult {
    this.assertOpen();
    this.requireNonEmpty(input.taskId, "taskId");
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.signatureKeyId, "signatureKeyId");
    if (input.sequence !== undefined) {
      this.requireNonNegativeInteger(input.sequence, "sequence");
      if (!input.sequenceDigest) {
        throw new Error("sequenceDigest is required with sequence");
      }
      this.validateSha256(input.sequenceDigest, "sequenceDigest");
    } else if (input.sequenceDigest !== undefined) {
      throw new Error("sequence is required with sequenceDigest");
    }
    if (input.source) {
      this.requireNonEmpty(input.source.channel, "source.channel");
      this.requireNonEmpty(input.source.messageId, "source.messageId");
    }
    try {
      JSON.parse(input.canonicalResult);
    } catch {
      throw new Error("canonicalResult must be valid JSON");
    }
    const canonicalDigest = sha256Hex(input.canonicalResult);
    const sourceDigest = input.source?.payloadDigest ?? canonicalDigest;
    this.validateSha256(sourceDigest, "source.payloadDigest");

    const complete = this.database.transaction(
      (): CompleteTaskResultResult => {
        const taskRow = this.getTaskRow(input.taskId);
        if (!taskRow) return { status: "task_not_found" };
        if (taskRow.beacon_id !== input.beaconId) {
          return { status: "owner_mismatch" };
        }
        if (!input.signatureVerified || input.signature.trim().length === 0) {
          return { status: "invalid_signature" };
        }

        const existingResultRow = this.getTaskResultRow(input.taskId);
        if (existingResultRow) {
          const existing = this.mapTaskResult(existingResultRow);
          const exact =
            existing.canonicalDigest === canonicalDigest &&
            existing.canonicalResult === input.canonicalResult &&
            existing.signature === input.signature &&
            existing.signatureKeyId === input.signatureKeyId;
          return exact
            ? { status: "exact_duplicate", result: existing }
            : { status: "conflicting_duplicate", result: existing };
        }

        if (taskRow.state !== "pending" && taskRow.state !== "delivered") {
          return { status: "invalid_state", state: taskRow.state };
        }

        const identity = this.getIdentityKey(input.signatureKeyId);
        if (
          !identity ||
          identity.beaconId !== input.beaconId ||
          identity.status !== "active"
        ) {
          return { status: "identity_key_mismatch" };
        }

        if (input.source) {
          const existingMessage = this.getProcessedMessage(
            input.source.channel,
            input.source.messageId,
          );
          if (existingMessage) {
            return existingMessage.payloadDigest === sourceDigest
              ? { status: "replayed_message" }
              : { status: "conflicting_message" };
          }
        }

        const receivedAt = input.receivedAt ?? this.timestamp();
        const resultId = input.resultId ?? randomUUID();

        if (input.sequence !== undefined) {
          const existingReceipt = this.getBeaconSequenceReceipt(
            input.beaconId,
            input.sequence,
          );
          if (existingReceipt) {
            return { status: "invalid_signature" };
          }
          const beacon = this.getBeacon(input.beaconId);
          if (!beacon) {
            return { status: "invalid_signature" };
          }
          // Results may arrive after a newer check-in because the implant
          // persists signed completions and retries them across transports.
          // An unseen lower sequence is safe to accept: the per-sequence
          // receipt below still makes exact replay/conflict detection durable,
          // and task ownership/state binds the envelope to one task.
          if (input.sequence > beacon.lastSeq) {
            const advanced = this.database
              .query<never, [number, string, string, string, number]>(
                `UPDATE beacons
                 SET last_seq = ?,
                     last_seen = ?,
                     status = 'active',
                     updated_at = ?
                 WHERE beacon_id = ? AND last_seq = ?`,
              )
              .run(
                input.sequence,
                receivedAt,
                receivedAt,
                input.beaconId,
                beacon.lastSeq,
              );
            if (advanced.changes !== 1) {
              throw new Error(
                "Beacon sequence changed during result completion transaction",
              );
            }
          }
          this.insertBeaconSequenceReceipt({
            beaconId: input.beaconId,
            sequence: input.sequence,
            envelopeDigest: input.sequenceDigest!,
            envelopeKind: "task-result",
            acceptedAt: receivedAt,
          });
        }

        if (input.source) {
          this.insertProcessedMessage({
            channel: input.source.channel,
            messageId: input.source.messageId,
            payloadDigest: sourceDigest,
            beaconId: input.beaconId,
            taskId: input.taskId,
            outcome: "accepted",
            processedAt: receivedAt,
          });
        }

        this.database
          .query<
            never,
            [
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string | null,
              string | null,
            ]
          >(
            `INSERT INTO task_results (
               result_id,
               task_id,
               beacon_id,
               canonical_digest,
               canonical_result,
               signature,
               signature_key_id,
               signature_verified,
               received_at,
               source_channel,
               source_message_id
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            resultId,
            input.taskId,
            input.beaconId,
            canonicalDigest,
            input.canonicalResult,
            input.signature,
            input.signatureKeyId,
            receivedAt,
            input.source?.channel ?? null,
            input.source?.messageId ?? null,
          );

        const updated = this.database
          .query<never, [string, string]>(
            `UPDATE tasks
             SET state = 'completed', completed_at = ?, failure_reason = NULL
             WHERE task_id = ? AND state IN ('pending', 'delivered')`,
          )
          .run(receivedAt, input.taskId);
        if (updated.changes !== 1) {
          throw new Error("Task state changed during result transaction");
        }
        this.database
          .query<never, [string]>(
            "DELETE FROM delivery_leases WHERE task_id = ?",
          )
          .run(input.taskId);

        const stored = this.getTaskResult(input.taskId);
        if (!stored) throw new Error("Failed to persist task result");
        return { status: "completed", result: stored };
      },
    );

    return complete.immediate();
  }

  claimDelivery(input: ClaimDeliveryInput): ClaimDeliveryResult {
    this.assertOpen();
    this.requireNonEmpty(input.channel, "channel");
    this.requireNonEmpty(input.workerId, "workerId");
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new Error("leaseDurationMs must be a positive safe integer");
    }

    const claim = this.database.transaction((): ClaimDeliveryResult => {
      if (input.oidcRequestGuard) {
        const request = this.getOidcRequestRow(input.oidcRequestGuard.jti);
        if (
          !request ||
          request.state !== "processing" ||
          request.owner_token !== input.oidcRequestGuard.ownerToken ||
          request.worker_id !== input.workerId
        ) {
          return { status: "oidc_request_ownership_lost" };
        }
      }

      const taskRow = this.getTaskRow(input.taskId);
      if (!taskRow) return { status: "task_not_found" };
      if (taskRow.beacon_id !== input.beaconId) {
        return { status: "owner_mismatch" };
      }
      if (taskRow.state !== "pending" && taskRow.state !== "delivered") {
        return { status: "not_deliverable", state: taskRow.state };
      }

      const now = input.now ?? this.timestamp();
      const existing = this.getDeliveryLease(input.taskId);
      if (existing && existing.expiresAt > now) {
        return { status: "already_leased", lease: existing };
      }
      if (existing) {
        this.database
          .query<never, [string, string, string]>(
            `UPDATE delivery_attempts
             SET finished_at = ?,
                 outcome = 'transient_failure',
                 error = ?
             WHERE lease_token = ? AND outcome = 'leased'`,
          )
          .run(now, "lease expired", existing.leaseToken);
        this.database
          .query<never, [string]>(
            "DELETE FROM delivery_leases WHERE task_id = ?",
          )
          .run(input.taskId);
      }

      const count = this.database
        .query<CountRow, [string]>(
          `SELECT COUNT(*) AS count
           FROM delivery_attempts
           WHERE task_id = ?`,
        )
        .get(input.taskId)?.count ?? 0;
      const attemptNumber = count + 1;
      const leaseToken = randomUUID();
      const expiresAt = new Date(
        new Date(now).getTime() + input.leaseDurationMs,
      ).toISOString();
      const attemptId = randomUUID();

      this.database
        .query<
          never,
          [
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
          ]
        >(
          `INSERT INTO delivery_attempts (
             attempt_id,
             task_id,
             beacon_id,
             channel,
             worker_id,
             lease_token,
             attempt_number,
             started_at,
             outcome
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'leased')`,
        )
        .run(
          attemptId,
          input.taskId,
          input.beaconId,
          input.channel,
          input.workerId,
          leaseToken,
          attemptNumber,
          now,
        );

      this.database
        .query<
          never,
          [string, string, string, string, string, string, string, number]
        >(
          `INSERT INTO delivery_leases (
             task_id,
             beacon_id,
             lease_token,
             channel,
             worker_id,
             leased_at,
             expires_at,
             attempt_number
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.beaconId,
          leaseToken,
          input.channel,
          input.workerId,
          now,
          expiresAt,
          attemptNumber,
        );

      const lease = this.getDeliveryLease(input.taskId);
      if (!lease) throw new Error("Failed to persist delivery lease");
      return { status: "claimed", lease };
    });

    return claim.immediate();
  }

  finishDelivery(input: FinishDeliveryInput): boolean {
    this.assertOpen();
    const finish = this.database.transaction((): boolean => {
      const row = this.database
        .query<LeaseRow, [string]>(
          "SELECT * FROM delivery_leases WHERE lease_token = ?",
        )
        .get(input.leaseToken);
      if (!row) return false;

      const finishedAt = input.finishedAt ?? this.timestamp();
      this.database
        .query<
          never,
          [
            string,
            FinishDeliveryInput["outcome"],
            string | null,
            string,
          ]
        >(
          `UPDATE delivery_attempts
           SET finished_at = ?, outcome = ?, error = ?
           WHERE lease_token = ? AND outcome = 'leased'`,
        )
        .run(
          finishedAt,
          input.outcome,
          input.error ?? null,
          input.leaseToken,
        );

      if (input.outcome === "delivered") {
        this.database
          .query<never, [string, string]>(
            `UPDATE tasks
             SET state = 'delivered',
                 delivered_at = COALESCE(delivered_at, ?)
             WHERE task_id = ? AND state = 'pending'`,
          )
          .run(finishedAt, row.task_id);
      } else if (input.outcome === "permanent_failure") {
        this.database
          .query<never, [string, string | null, string]>(
            `UPDATE tasks
             SET state = 'failed',
                 completed_at = ?,
                 failure_reason = ?
             WHERE task_id = ? AND state IN ('pending', 'delivered')`,
          )
          .run(finishedAt, input.error ?? "delivery failed", row.task_id);
      }

      if (input.outcome !== "delivered") {
        this.database
          .query<never, [string]>(
            "DELETE FROM delivery_leases WHERE lease_token = ?",
          )
          .run(input.leaseToken);
      }
      return true;
    });

    return finish.immediate();
  }

  getDeliveryLease(taskId: string): DeliveryLease | undefined {
    this.assertOpen();
    const row = this.database
      .query<LeaseRow, [string]>(
        "SELECT * FROM delivery_leases WHERE task_id = ?",
      )
      .get(taskId);
    return row ? this.mapLease(row) : undefined;
  }

  listDeliveryAttempts(taskId: string): DeliveryAttempt[] {
    this.assertOpen();
    return this.database
      .query<DeliveryAttemptRow, [string]>(
        `SELECT *
         FROM delivery_attempts
         WHERE task_id = ?
         ORDER BY attempt_number`,
      )
      .all(taskId)
      .map((row) => ({
        attemptId: row.attempt_id,
        taskId: row.task_id,
        beaconId: row.beacon_id,
        channel: row.channel,
        workerId: row.worker_id,
        leaseToken: row.lease_token,
        attemptNumber: row.attempt_number,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        outcome: row.outcome,
        error: row.error,
      }));
  }

  getProcessedMessage(
    channel: string,
    messageId: string,
  ): ProcessedChannelMessage | undefined {
    this.assertOpen();
    const row = this.database
      .query<ProcessedMessageRow, [string, string]>(
        `SELECT *
         FROM processed_channel_messages
         WHERE channel = ? AND message_id = ?`,
      )
      .get(channel, messageId);
    return row ? this.mapProcessedMessage(row) : undefined;
  }

  commitChannelProgress(
    input: CommitChannelProgressInput,
  ): CommitChannelProgressResult {
    this.assertOpen();
    this.validateSha256(input.payloadDigest, "payloadDigest");
    this.requireNonEmpty(input.channel, "channel");
    this.requireNonEmpty(input.scope, "scope");
    this.requireNonEmpty(input.messageId, "messageId");
    this.requireNonEmpty(input.cursor, "cursor");

    const commit = this.database.transaction(
      (): CommitChannelProgressResult => {
        const existing = this.getProcessedMessage(
          input.channel,
          input.messageId,
        );
        if (existing) {
          return existing.payloadDigest === input.payloadDigest
            ? { status: "exact_duplicate" }
            : { status: "conflicting_duplicate" };
        }

        const processedAt = input.processedAt ?? this.timestamp();
        this.insertProcessedMessage({
          channel: input.channel,
          messageId: input.messageId,
          payloadDigest: input.payloadDigest,
          beaconId: input.beaconId ?? null,
          taskId: input.taskId ?? null,
          outcome: input.outcome ?? "accepted",
          processedAt,
        });
        this.database
          .query<never, [string, string, string, string]>(
            `INSERT INTO poll_cursors (channel, scope, cursor, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(channel, scope) DO UPDATE SET
               cursor = excluded.cursor,
               updated_at = excluded.updated_at`,
          )
          .run(input.channel, input.scope, input.cursor, processedAt);
        return { status: "committed" };
      },
    );

    return commit.immediate();
  }

  getOidcRequest(jti: string): StoredOidcRequest | undefined {
    this.assertOpen();
    this.requireNonEmpty(jti, "jti");
    const row = this.getOidcRequestRow(jti);
    return row ? this.mapOidcRequest(row) : undefined;
  }

  beginOidcRequest(input: BeginOidcRequestInput): BeginOidcRequestResult {
    this.assertOpen();
    this.requireNonEmpty(input.jti, "jti");
    this.requireNonEmpty(input.repository, "repository");
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.tokenExpiresAt, "tokenExpiresAt");
    this.requireNonEmpty(input.replayChannel, "replayChannel");
    this.validateSha256(input.payloadDigest, "payloadDigest");
    if (
      !Number.isSafeInteger(input.processingLeaseMs) ||
      input.processingLeaseMs <= 0
    ) {
      throw new Error("processingLeaseMs must be a positive safe integer");
    }

    const begin = this.database.transaction((): BeginOidcRequestResult => {
      const now = input.now ?? this.timestamp();
      const existing = this.getOidcRequestRow(input.jti);
      if (existing) {
        if (
          existing.repository !== input.repository ||
          existing.payload_digest !== input.payloadDigest ||
          existing.beacon_id !== input.beaconId ||
          existing.token_expires_at !== input.tokenExpiresAt
        ) {
          return { status: "conflicting_replay" };
        }
        if (existing.state === "completed") {
          return {
            status: "cached",
            request: this.mapCompletedOidcRequest(existing),
          };
        }
        if (
          existing.processing_lease_expires_at !== null &&
          existing.processing_lease_expires_at > now
        ) {
          return {
            status: "in_progress",
            leaseExpiresAt: existing.processing_lease_expires_at,
          };
        }

        const releasedTaskIds = this.releaseDeliveryLeasesForWorker(
          existing.worker_id,
          now,
          "OIDC request processing lease expired",
        );
        const ownerToken = randomUUID();
        const workerId = `oidc:${randomUUID()}`;
        const leaseExpiresAt = new Date(
          new Date(now).getTime() + input.processingLeaseMs,
        ).toISOString();
        this.database
          .query<never, [string, string, string, string, string, string]>(
            `UPDATE oidc_requests
             SET owner_token = ?,
                 worker_id = ?,
                 processing_lease_expires_at = ?,
                 token_expires_at = ?,
                 updated_at = ?
             WHERE jti = ?`,
          )
          .run(
            ownerToken,
            workerId,
            leaseExpiresAt,
            input.tokenExpiresAt,
            now,
            input.jti,
          );
        return {
          status: "acquired",
          ownerToken,
          workerId,
          recovered: true,
          releasedTaskIds,
        };
      }

      const legacy = this.getProcessedMessage(
        input.replayChannel,
        input.jti,
      );
      if (legacy) {
        return legacy.payloadDigest === input.payloadDigest
          ? { status: "legacy_replay" }
          : { status: "conflicting_replay" };
      }

      const ownerToken = randomUUID();
      const workerId = `oidc:${randomUUID()}`;
      const leaseExpiresAt = new Date(
        new Date(now).getTime() + input.processingLeaseMs,
      ).toISOString();
      this.database
        .query<
          never,
          [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        >(
          `INSERT INTO oidc_requests (
             jti,
             repository,
             payload_digest,
             beacon_id,
             token_expires_at,
             state,
             owner_token,
             worker_id,
             processing_lease_expires_at,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.jti,
          input.repository,
          input.payloadDigest,
          input.beaconId,
          input.tokenExpiresAt,
          ownerToken,
          workerId,
          leaseExpiresAt,
          now,
          now,
        );
      return {
        status: "acquired",
        ownerToken,
        workerId,
        recovered: false,
        releasedTaskIds: [],
      };
    });

    return begin.immediate();
  }

  completeOidcRequest(
    input: CompleteOidcRequestInput,
  ): CompleteOidcRequestResult {
    this.assertOpen();
    this.requireNonEmpty(input.jti, "jti");
    this.requireNonEmpty(input.repository, "repository");
    this.requireNonEmpty(input.beaconId, "beaconId");
    this.requireNonEmpty(input.ownerToken, "ownerToken");
    this.requireNonEmpty(input.replayChannel, "replayChannel");
    this.requireNonEmpty(input.replayScope, "replayScope");
    this.requireNonEmpty(input.replayCursor, "replayCursor");
    this.validateSha256(input.payloadDigest, "payloadDigest");
    if (
      !Number.isSafeInteger(input.responseStatus) ||
      input.responseStatus < 100 ||
      input.responseStatus > 599
    ) {
      throw new Error("responseStatus must be an HTTP status code");
    }
    const responseHeadersJson = this.serializeStringRecord(
      input.responseHeaders,
      "responseHeaders",
    );
    const deliveryLeaseTokens = [...(input.deliveryLeaseTokens ?? [])];
    if (new Set(deliveryLeaseTokens).size !== deliveryLeaseTokens.length) {
      throw new Error("deliveryLeaseTokens must be unique");
    }

    const complete = this.database.transaction(
      (): CompleteOidcRequestResult => {
        const request = this.getOidcRequestRow(input.jti);
        if (!request) return { status: "missing" };
        if (
          request.repository !== input.repository ||
          request.payload_digest !== input.payloadDigest ||
          request.beacon_id !== input.beaconId
        ) {
          return { status: "conflicting_replay" };
        }
        if (request.state === "completed") {
          return {
            status: "cached",
            request: this.mapCompletedOidcRequest(request),
          };
        }
        if (request.owner_token !== input.ownerToken) {
          return { status: "ownership_lost" };
        }

        const existingMessage = this.getProcessedMessage(
          input.replayChannel,
          input.jti,
        );
        if (existingMessage) {
          return existingMessage.payloadDigest === input.payloadDigest
            ? { status: "legacy_replay" }
            : { status: "conflicting_replay" };
        }

        const leases: LeaseRow[] = [];
        for (const leaseToken of deliveryLeaseTokens) {
          const lease = this.database
            .query<LeaseRow, [string]>(
              "SELECT * FROM delivery_leases WHERE lease_token = ?",
            )
            .get(leaseToken);
          if (
            !lease ||
            lease.worker_id !== request.worker_id ||
            lease.beacon_id !== input.beaconId ||
            lease.channel !== "oidc"
          ) {
            return { status: "delivery_conflict", leaseToken };
          }
          const task = this.getTaskRow(lease.task_id);
          if (
            !task ||
            task.beacon_id !== input.beaconId ||
            (task.state !== "pending" && task.state !== "delivered")
          ) {
            return { status: "delivery_conflict", leaseToken };
          }
          leases.push(lease);
        }

        const completedAt = input.completedAt ?? this.timestamp();
        const deliveredTaskIds: string[] = [];
        for (const lease of leases) {
          this.database
            .query<never, [string, string]>(
              `UPDATE delivery_attempts
               SET finished_at = ?, outcome = 'delivered', error = NULL
               WHERE lease_token = ? AND outcome = 'leased'`,
            )
            .run(completedAt, lease.lease_token);
          this.database
            .query<never, [string, string]>(
              `UPDATE tasks
               SET state = 'delivered',
                   delivered_at = COALESCE(delivered_at, ?)
               WHERE task_id = ? AND state = 'pending'`,
            )
            .run(completedAt, lease.task_id);
          deliveredTaskIds.push(lease.task_id);
        }

        this.insertProcessedMessage({
          channel: input.replayChannel,
          messageId: input.jti,
          payloadDigest: input.payloadDigest,
          beaconId: input.beaconId,
          taskId: null,
          outcome: input.outcome,
          processedAt: completedAt,
        });
        this.database
          .query<never, [string, string, string, string]>(
            `INSERT INTO poll_cursors (channel, scope, cursor, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(channel, scope) DO UPDATE SET
               cursor = excluded.cursor,
               updated_at = excluded.updated_at`,
          )
          .run(
            input.replayChannel,
            input.replayScope,
            input.replayCursor,
            completedAt,
          );
        this.database
          .query<
            never,
            [
              number,
              string,
              string,
              CompleteOidcRequestInput["outcome"],
              string,
              string,
            ]
          >(
            `UPDATE oidc_requests
             SET state = 'completed',
                 owner_token = NULL,
                 processing_lease_expires_at = NULL,
                 response_status = ?,
                 response_headers_json = ?,
                 response_body = ?,
                 outcome = ?,
                 updated_at = ?
             WHERE jti = ?`,
          )
          .run(
            input.responseStatus,
            responseHeadersJson,
            input.responseBody,
            input.outcome,
            completedAt,
            input.jti,
          );

        const stored = this.getOidcRequestRow(input.jti);
        if (!stored || stored.state !== "completed") {
          throw new Error("Failed to persist completed OIDC request");
        }
        return {
          status: "completed",
          request: this.mapCompletedOidcRequest(stored),
          deliveredTaskIds,
        };
      },
    );

    return complete.immediate();
  }

  abortOidcRequest(input: AbortOidcRequestInput): readonly string[] {
    this.assertOpen();
    this.requireNonEmpty(input.jti, "jti");
    this.requireNonEmpty(input.ownerToken, "ownerToken");
    this.requireNonEmpty(input.workerId, "workerId");

    const abort = this.database.transaction((): readonly string[] => {
      const abortedAt = input.abortedAt ?? this.timestamp();
      const request = this.getOidcRequestRow(input.jti);
      if (
        request?.state === "completed" &&
        request.worker_id === input.workerId
      ) {
        return [];
      }
      const releasedTaskIds = this.releaseDeliveryLeasesForWorker(
        input.workerId,
        abortedAt,
        input.error ?? "OIDC request aborted",
      );
      if (
        request?.state === "processing" &&
        request.owner_token === input.ownerToken &&
        request.worker_id === input.workerId
      ) {
        // Preserve the immutable JTI-to-payload binding through operational
        // retries. Rotate the owner token and expire the processing lease so
        // the failed owner is fenced while the same payload may immediately
        // reacquire the request. A different payload remains a conflict.
        const fencedOwnerToken = randomUUID();
        const fenced = this.database
          .query<never, [string, string, string, string, string, string]>(
            `UPDATE oidc_requests
             SET owner_token = ?,
                 processing_lease_expires_at = ?,
                 updated_at = ?
             WHERE jti = ?
               AND state = 'processing'
               AND owner_token = ?
               AND worker_id = ?`,
          )
          .run(
            fencedOwnerToken,
            abortedAt,
            abortedAt,
            input.jti,
            input.ownerToken,
            input.workerId,
          );
        if (fenced.changes !== 1) {
          throw new Error("OIDC request ownership changed during abort");
        }
      }
      return releasedTaskIds;
    });

    return abort.immediate();
  }

  getPollCursor(channel: string, scope: string): PollCursor | undefined {
    this.assertOpen();
    const row = this.database
      .query<PollCursorRow, [string, string]>(
        `SELECT *
         FROM poll_cursors
         WHERE channel = ? AND scope = ?`,
      )
      .get(channel, scope);
    return row
      ? {
          channel: row.channel,
          scope: row.scope,
          cursor: row.cursor,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  expireTasks(at = this.timestamp()): number {
    this.assertOpen();
    return this.database
      .query<never, [string, string]>(
        `UPDATE tasks
         SET state = 'expired',
             completed_at = ?,
             failure_reason = 'expired'
         WHERE state IN ('pending', 'delivered')
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .run(at, at).changes;
  }

  deleteProcessedMessagesBefore(cutoff: string): number {
    this.assertOpen();
    this.requireNonEmpty(cutoff, "cutoff");
    return this.database
      .query<never, [string, string]>(
        `DELETE FROM processed_channel_messages
         WHERE processed_at < ? AND channel <> ?`,
      )
      .run(cutoff, OIDC_REPLAY_CHANNEL).changes;
  }

  /**
   * Prune OIDC idempotency state without reopening a still-valid JWT.
   *
   * Completed responses are removed only after both the configured retention
   * cutoff and the token's own expiry. Processing rows are removed only after
   * both their ownership lease and JWT have expired; any task leases owned by
   * the crashed worker are released in the same transaction.
   *
   * Legacy OIDC replay receipts have no persisted token expiry and are
   * intentionally retained fail-closed by deleteProcessedMessagesBefore().
   */
  sweepOidcRequests(
    retentionCutoff: string,
    at = this.timestamp(),
  ): SweepOidcRequestsResult {
    this.assertOpen();
    this.requireNonEmpty(retentionCutoff, "retentionCutoff");
    this.requireNonEmpty(at, "at");

    const sweep = this.database.transaction((): SweepOidcRequestsResult => {
      const completed = this.database
        .query<OidcRequestRow, [string, string]>(
          `SELECT *
           FROM oidc_requests
           WHERE state = 'completed'
             AND updated_at < ?
             AND token_expires_at <= ?`,
        )
        .all(retentionCutoff, at);
      let completedDeleted = 0;
      for (const request of completed) {
        this.database
          .query<never, [string, string]>(
            `DELETE FROM processed_channel_messages
             WHERE channel = ? AND message_id = ?`,
          )
          .run(OIDC_REPLAY_CHANNEL, request.jti);
        completedDeleted += this.database
          .query<never, [string]>(
            `DELETE FROM oidc_requests
             WHERE jti = ? AND state = 'completed'`,
          )
          .run(request.jti).changes;
      }

      const expiredProcessing = this.database
        .query<OidcRequestRow, [string, string]>(
          `SELECT *
           FROM oidc_requests
           WHERE state = 'processing'
             AND token_expires_at <= ?
             AND processing_lease_expires_at <= ?`,
        )
        .all(at, at);
      const releasedTaskIds: string[] = [];
      let processingDeleted = 0;
      for (const request of expiredProcessing) {
        releasedTaskIds.push(...this.releaseDeliveryLeasesForWorker(
          request.worker_id,
          at,
          "OIDC token and processing lease expired",
        ));
        processingDeleted += this.database
          .query<never, [string, string, string]>(
            `DELETE FROM oidc_requests
             WHERE jti = ?
               AND state = 'processing'
               AND owner_token = ?
               AND worker_id = ?`,
          )
          .run(request.jti, request.owner_token!, request.worker_id).changes;
      }

      return {
        completedDeleted,
        processingDeleted,
        releasedTaskIds: [...new Set(releasedTaskIds)],
      };
    });
    return sweep.immediate();
  }

  private getOidcRequestRow(jti: string): OidcRequestRow | undefined {
    return this.database
      .query<OidcRequestRow, [string]>(
        "SELECT * FROM oidc_requests WHERE jti = ?",
      )
      .get(jti) ?? undefined;
  }

  private mapOidcRequest(row: OidcRequestRow): StoredOidcRequest {
    return {
      jti: row.jti,
      repository: row.repository,
      payloadDigest: row.payload_digest,
      beaconId: row.beacon_id,
      tokenExpiresAt: row.token_expires_at,
      state: row.state,
      ownerToken: row.owner_token,
      workerId: row.worker_id,
      processingLeaseExpiresAt: row.processing_lease_expires_at,
      responseStatus: row.response_status,
      responseHeaders: row.response_headers_json === null
        ? null
        : this.parseStringRecord(
            row.response_headers_json,
            "OIDC response headers",
          ),
      responseBody: row.response_body,
      outcome: row.outcome,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCompletedOidcRequest(row: OidcRequestRow): CompletedOidcRequest {
    const request = this.mapOidcRequest(row);
    if (
      request.state !== "completed" ||
      request.ownerToken !== null ||
      request.processingLeaseExpiresAt !== null ||
      request.responseStatus === null ||
      request.responseHeaders === null ||
      request.responseBody === null ||
      request.outcome === null
    ) {
      throw new Error(`OIDC request ${row.jti} has invalid completed state`);
    }
    return {
      ...request,
      state: "completed",
      ownerToken: null,
      processingLeaseExpiresAt: null,
      responseStatus: request.responseStatus,
      responseHeaders: request.responseHeaders,
      responseBody: request.responseBody,
      outcome: request.outcome,
    };
  }

  private releaseDeliveryLeasesForWorker(
    workerId: string,
    finishedAt: string,
    error: string,
  ): string[] {
    const leases = this.database
      .query<LeaseRow, [string]>(
        "SELECT * FROM delivery_leases WHERE worker_id = ?",
      )
      .all(workerId);
    for (const lease of leases) {
      this.database
        .query<never, [string, string, string]>(
          `UPDATE delivery_attempts
           SET finished_at = ?,
               outcome = 'transient_failure',
               error = ?
           WHERE lease_token = ? AND outcome = 'leased'`,
        )
        .run(finishedAt, error, lease.lease_token);
      this.database
        .query<never, [string]>(
          "DELETE FROM delivery_leases WHERE lease_token = ?",
        )
        .run(lease.lease_token);
    }
    return leases.map((lease) => lease.task_id);
  }

  private serializeStringRecord(
    value: Readonly<Record<string, string>>,
    name: string,
  ): string {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((entry) => typeof entry === "string")
    ) {
      throw new Error(`${name} must be a string record`);
    }
    return JSON.stringify(value);
  }

  private parseStringRecord(
    value: string,
    name: string,
  ): Readonly<Record<string, string>> {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((entry) => typeof entry === "string")
    ) {
      throw new Error(`${name} is invalid`);
    }
    return parsed as Record<string, string>;
  }

  private configureDatabase(busyTimeoutMs: number): void {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");

    const pragmas = this.getPragmas();
    if (!pragmas.foreignKeys) {
      throw new Error("SQLite foreign key enforcement could not be enabled");
    }
    if (
      this.databasePath !== ":memory:" &&
      pragmas.journalMode.toLowerCase() !== "wal"
    ) {
      throw new Error(
        `SQLite WAL mode could not be enabled (got ${pragmas.journalMode})`,
      );
    }
  }

  private importLegacyRegistry(sourcePath: string): LegacyRegistryImportResult {
    const imported = this.database
      .query<LegacyImportRow, [string]>(
        "SELECT backup_path FROM legacy_imports WHERE import_key = ?",
      )
      .get(LEGACY_IMPORT_KEY);
    if (imported) {
      return {
        status: "already_imported",
        importedCount: 0,
        backupPath: imported.backup_path,
      };
    }

    if (!existsSync(sourcePath)) {
      return { status: "not_found", importedCount: 0, backupPath: null };
    }

    const raw = readFileSync(sourcePath, "utf8");
    const snapshot = this.parseLegacyRegistry(raw);
    const sourceDigest = sha256Hex(raw);
    const backupPath = join(this.dataDir, LEGACY_BACKUP_NAME);

    if (existsSync(backupPath)) {
      const existingBackupDigest = sha256Hex(readFileSync(backupPath));
      if (existingBackupDigest !== sourceDigest) {
        throw new Error(
          `Legacy registry backup ${backupPath} does not match ${sourcePath}`,
        );
      }
    } else {
      copyFileSync(sourcePath, backupPath, fsConstants.COPYFILE_EXCL);
    }

    const importSnapshot = this.database.transaction((): number => {
      let importedCount = 0;
      for (const beacon of snapshot.beacons) {
        const inserted = this.database
          .query<
            never,
            [
              string,
              number | null,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              string | null,
              string,
              string,
            ]
          >(
            `INSERT INTO beacons (
               beacon_id,
               issue_number,
               x25519_public_key,
               hostname,
               username,
               os,
               arch,
               first_seen,
               last_seen,
               status,
               last_seq,
               active_tentacle,
               created_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dormant', ?, ?, ?, ?)
             ON CONFLICT(beacon_id) DO NOTHING`,
          )
          .run(
            beacon.beaconId,
            beacon.issueNumber === 0 ? null : beacon.issueNumber,
            beacon.publicKey,
            beacon.hostname,
            beacon.username,
            beacon.os,
            beacon.arch,
            beacon.firstSeen,
            beacon.lastSeen,
            beacon.lastSeq,
            beacon.activeTentacle === undefined
              ? null
              : String(beacon.activeTentacle),
            beacon.firstSeen,
            this.timestamp(),
          );
        importedCount += inserted.changes;
      }

      this.database
        .query<
          never,
          [string, string, string, string, number, string]
        >(
          `INSERT INTO legacy_imports (
             import_key,
             source_path,
             source_digest,
             backup_path,
             imported_count,
             imported_at
           )
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          LEGACY_IMPORT_KEY,
          resolve(sourcePath),
          sourceDigest,
          backupPath,
          importedCount,
          this.timestamp(),
        );
      return importedCount;
    });

    return {
      status: "imported",
      importedCount: importSnapshot.immediate(),
      backupPath,
    };
  }

  private parseLegacyRegistry(raw: string): LegacyRegistrySnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Legacy registry.json is not valid JSON");
    }

    if (!this.isRecord(parsed) || parsed["version"] !== 1) {
      throw new Error("Legacy registry.json must use schema version 1");
    }
    if (typeof parsed["savedAt"] !== "string") {
      throw new Error("Legacy registry.json is missing savedAt");
    }
    if (!Array.isArray(parsed["beacons"])) {
      throw new Error("Legacy registry.json is missing beacons");
    }

    const beacons = parsed["beacons"].map((value, index) =>
      this.parseLegacyBeacon(value, index),
    );
    const ids = new Set<string>();
    const issues = new Set<number>();
    for (const beacon of beacons) {
      if (ids.has(beacon.beaconId)) {
        throw new Error(`Legacy registry contains duplicate beacon ${beacon.beaconId}`);
      }
      if (beacon.issueNumber > 0 && issues.has(beacon.issueNumber)) {
        throw new Error(
          `Legacy registry contains duplicate issue ${beacon.issueNumber}`,
        );
      }
      ids.add(beacon.beaconId);
      if (beacon.issueNumber > 0) issues.add(beacon.issueNumber);
    }

    return {
      version: 1,
      savedAt: parsed["savedAt"],
      beacons,
    };
  }

  private parseLegacyBeacon(value: unknown, index: number): LegacyBeaconRecord {
    if (!this.isRecord(value)) {
      throw new Error(`Legacy beacon at index ${index} is not an object`);
    }

    const requiredStrings = [
      "beaconId",
      "publicKey",
      "hostname",
      "username",
      "os",
      "arch",
      "firstSeen",
      "lastSeen",
    ] as const;
    for (const field of requiredStrings) {
      if (typeof value[field] !== "string" || value[field].trim().length === 0) {
        throw new Error(`Legacy beacon at index ${index} has invalid ${field}`);
      }
    }

    if (
      typeof value["issueNumber"] !== "number" ||
      !Number.isSafeInteger(value["issueNumber"]) ||
      value["issueNumber"] < 0
    ) {
      throw new Error(`Legacy beacon at index ${index} has invalid issueNumber`);
    }
    if (
      typeof value["lastSeq"] !== "number" ||
      !Number.isSafeInteger(value["lastSeq"]) ||
      value["lastSeq"] < 0
    ) {
      throw new Error(`Legacy beacon at index ${index} has invalid lastSeq`);
    }
    if (
      value["status"] !== "active" &&
      value["status"] !== "dormant" &&
      value["status"] !== "lost"
    ) {
      throw new Error(`Legacy beacon at index ${index} has invalid status`);
    }

    const activeTentacle = value["activeTentacle"];
    if (
      activeTentacle !== undefined &&
      (
        (typeof activeTentacle !== "number" &&
          typeof activeTentacle !== "string") ||
        !Object.prototype.hasOwnProperty.call(
          CHANNEL_BY_ID,
          String(activeTentacle),
        )
      )
    ) {
      throw new Error(`Legacy beacon at index ${index} has invalid activeTentacle`);
    }

    const beaconId = value["beaconId"] as string;
    const publicKey = value["publicKey"] as string;
    const hostname = value["hostname"] as string;
    const username = value["username"] as string;
    const os = value["os"] as string;
    const arch = value["arch"] as string;
    const firstSeen = value["firstSeen"] as string;
    const lastSeen = value["lastSeen"] as string;

    return {
      beaconId,
      issueNumber: value["issueNumber"],
      publicKey,
      hostname,
      username,
      os,
      arch,
      firstSeen,
      lastSeen,
      status: value["status"],
      lastSeq: value["lastSeq"],
      ...(activeTentacle !== undefined
        ? { activeTentacle: this.parseChannelId(activeTentacle) }
        : {}),
    };
  }

  private insertIdentityKey(input: ProvisionIdentityKeyInput): void {
    this.database
      .query<never, [string, string, string, string, string]>(
        `INSERT INTO beacon_identity_keys (
           key_id,
           beacon_id,
           algorithm,
           public_key,
           status,
           provisioned_at,
           provisioned_by
         )
         VALUES (?, ?, 'ed25519', ?, 'active', ?, ?)`,
      )
      .run(
        input.keyId,
        input.beaconId,
        input.publicKey,
        input.provisionedAt ?? this.timestamp(),
        input.provisionedBy,
      );
  }

  private insertBeaconSequenceReceipt(
    receipt: BeaconSequenceReceipt,
  ): void {
    this.database
      .query<never, [string, number, string, string, string]>(
        `INSERT INTO beacon_sequence_receipts (
           beacon_id,
           sequence,
           envelope_digest,
           envelope_kind,
           accepted_at
         )
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.beaconId,
        receipt.sequence,
        receipt.envelopeDigest,
        receipt.envelopeKind,
        receipt.acceptedAt,
      );
  }

  private insertProcessedMessage(input: ProcessedChannelMessage): void {
    this.database
      .query<
        never,
        [
          string,
          string,
          string,
          string | null,
          string | null,
          ProcessedChannelMessage["outcome"],
          string,
        ]
      >(
        `INSERT INTO processed_channel_messages (
           channel,
           message_id,
           payload_digest,
           beacon_id,
           task_id,
           outcome,
           processed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        input.messageId,
        input.payloadDigest,
        input.beaconId,
        input.taskId,
        input.outcome,
        input.processedAt,
      );
  }

  private getTaskRow(taskId: string): TaskRow | null {
    return this.database
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId);
  }

  private getTaskResultRow(taskId: string): TaskResultRow | null {
    return this.database
      .query<TaskResultRow, [string]>(
        "SELECT * FROM task_results WHERE task_id = ?",
      )
      .get(taskId);
  }

  private parseChannelId(value: string | number): ChannelId {
    const definition = CHANNEL_BY_ID[String(value)];
    if (!definition) {
      throw new Error(`Stored beacon has invalid active channel ID '${value}'`);
    }
    return definition.id;
  }

  private mapBeacon(row: BeaconRow): StoredBeacon {
    return {
      beaconId: row.beacon_id,
      issueNumber: row.issue_number,
      x25519PublicKey: row.x25519_public_key,
      hostname: row.hostname,
      username: row.username,
      os: row.os,
      arch: row.arch,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      status: row.status,
      lastSeq: row.last_seq,
      activeTentacle: row.active_tentacle === null
        ? null
        : this.parseChannelId(row.active_tentacle),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapIdentityKey(row: IdentityKeyRow): BeaconIdentityKey {
    return {
      keyId: row.key_id,
      beaconId: row.beacon_id,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      status: row.status,
      provisionedAt: row.provisioned_at,
      provisionedBy: row.provisioned_by,
      retiredAt: row.retired_at,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
    };
  }

  private mapCredential(row: CredentialRow): StoredCredential {
    const scopes: unknown = JSON.parse(row.scopes_json);
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
      throw new Error(`Credential ${row.credential_id} has corrupt scopes`);
    }
    return {
      credentialId: row.credential_id,
      principalType: row.principal_type,
      beaconId: row.beacon_id,
      tokenHash: row.token_hash,
      hashAlgorithm: row.hash_algorithm,
      label: row.label,
      scopes,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
    };
  }

  private mapTask(row: TaskRow): StoredTask {
    const args: unknown = JSON.parse(row.args_json);
    if (!this.isRecord(args)) {
      throw new Error(`Task ${row.task_id} has corrupt args`);
    }
    return {
      taskId: row.task_id,
      beaconId: row.beacon_id,
      kind: row.kind,
      args,
      state: row.state,
      createdAt: row.created_at,
      availableAt: row.available_at,
      deliveredAt: row.delivered_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
      ref: row.ref,
      preferredChannel: row.preferred_channel,
      failureReason: row.failure_reason,
    };
  }

  private mapTaskResult(row: TaskResultRow): StoredTaskResult {
    return {
      resultId: row.result_id,
      taskId: row.task_id,
      beaconId: row.beacon_id,
      canonicalDigest: row.canonical_digest,
      canonicalResult: row.canonical_result,
      signature: row.signature,
      signatureKeyId: row.signature_key_id,
      signatureVerified: true,
      receivedAt: row.received_at,
      sourceChannel: row.source_channel,
      sourceMessageId: row.source_message_id,
    };
  }

  private mapLease(row: LeaseRow): DeliveryLease {
    return {
      taskId: row.task_id,
      beaconId: row.beacon_id,
      leaseToken: row.lease_token,
      channel: row.channel,
      workerId: row.worker_id,
      leasedAt: row.leased_at,
      expiresAt: row.expires_at,
      attemptNumber: row.attempt_number,
    };
  }

  private mapProcessedMessage(
    row: ProcessedMessageRow,
  ): ProcessedChannelMessage {
    return {
      channel: row.channel,
      messageId: row.message_id,
      payloadDigest: row.payload_digest,
      beaconId: row.beacon_id,
      taskId: row.task_id,
      outcome: row.outcome,
      processedAt: row.processed_at,
    };
  }

  private validateCredentialHash(
    algorithm: StoredCredential["hashAlgorithm"],
    tokenHash: string,
  ): void {
    this.requireNonEmpty(tokenHash, "tokenHash");
    if (algorithm === "sha256" && !SHA256_HEX.test(tokenHash)) {
      throw new Error("sha256 credential hashes must be 64 lowercase hex characters");
    }
    if (tokenHash.length < 32) {
      throw new Error("Credential hash is too short");
    }
  }

  private validateSha256(value: string, field: string): void {
    if (!SHA256_HEX.test(value)) {
      throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
    }
  }

  private requireNonEmpty(value: string, field: string): void {
    if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
  }

  private requireNonNegativeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("OctoStore is closed");
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
