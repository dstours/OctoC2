import type { Database } from "bun:sqlite";

export interface StoreMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: Database) => void;
}

const migration001: StoreMigration = {
  version: 1,
  name: "identity_credentials_tasks",
  up(database): void {
    database.exec(`
      CREATE TABLE beacons (
        beacon_id TEXT PRIMARY KEY
          CHECK (length(trim(beacon_id)) > 0),
        issue_number INTEGER,
        x25519_public_key TEXT NOT NULL
          CHECK (length(trim(x25519_public_key)) > 0),
        hostname TEXT NOT NULL,
        username TEXT NOT NULL,
        os TEXT NOT NULL,
        arch TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('active', 'dormant', 'lost')),
        last_seq INTEGER NOT NULL DEFAULT 0
          CHECK (last_seq >= 0),
        active_tentacle INTEGER
          CHECK (active_tentacle IS NULL OR active_tentacle > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX beacons_issue_number_unique
        ON beacons(issue_number)
        WHERE issue_number IS NOT NULL;

      CREATE TABLE beacon_identity_keys (
        key_id TEXT PRIMARY KEY
          CHECK (length(trim(key_id)) > 0),
        beacon_id TEXT NOT NULL
          REFERENCES beacons(beacon_id) ON DELETE CASCADE,
        algorithm TEXT NOT NULL DEFAULT 'ed25519'
          CHECK (algorithm = 'ed25519'),
        public_key TEXT NOT NULL
          CHECK (length(trim(public_key)) > 0),
        status TEXT NOT NULL
          CHECK (status IN ('active', 'retired', 'revoked')),
        provisioned_at TEXT NOT NULL,
        provisioned_by TEXT NOT NULL
          CHECK (length(trim(provisioned_by)) > 0),
        retired_at TEXT,
        revoked_at TEXT,
        revocation_reason TEXT,
        UNIQUE (beacon_id, public_key),
        UNIQUE (key_id, beacon_id)
      );

      CREATE UNIQUE INDEX beacon_identity_one_active
        ON beacon_identity_keys(beacon_id)
        WHERE status = 'active';

      CREATE TABLE credentials (
        credential_id TEXT PRIMARY KEY
          CHECK (length(trim(credential_id)) > 0),
        principal_type TEXT NOT NULL
          CHECK (principal_type IN ('operator', 'beacon', 'server')),
        beacon_id TEXT
          REFERENCES beacons(beacon_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL
          CHECK (length(trim(token_hash)) > 0),
        hash_algorithm TEXT NOT NULL
          CHECK (hash_algorithm IN ('sha256', 'argon2id', 'scrypt')),
        label TEXT,
        scopes_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        revocation_reason TEXT,
        CHECK (
          (principal_type = 'beacon' AND beacon_id IS NOT NULL)
          OR
          (principal_type IN ('operator', 'server') AND beacon_id IS NULL)
        ),
        UNIQUE (hash_algorithm, token_hash)
      );

      CREATE INDEX credentials_beacon_active
        ON credentials(beacon_id, revoked_at, expires_at);

      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY
          CHECK (length(trim(task_id)) > 0),
        beacon_id TEXT NOT NULL
          REFERENCES beacons(beacon_id) ON DELETE CASCADE,
        kind TEXT NOT NULL
          CHECK (length(trim(kind)) > 0),
        args_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(args_json) AND json_type(args_json) = 'object'),
        state TEXT NOT NULL
          CHECK (state IN (
            'pending',
            'delivered',
            'completed',
            'failed',
            'cancelled',
            'expired'
          )),
        created_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        delivered_at TEXT,
        completed_at TEXT,
        expires_at TEXT,
        ref TEXT NOT NULL UNIQUE
          CHECK (length(trim(ref)) > 0),
        preferred_channel TEXT,
        failure_reason TEXT,
        UNIQUE (task_id, beacon_id)
      );

      CREATE INDEX tasks_delivery_scan
        ON tasks(beacon_id, state, available_at, expires_at, created_at);

      CREATE TABLE task_results (
        result_id TEXT PRIMARY KEY
          CHECK (length(trim(result_id)) > 0),
        task_id TEXT NOT NULL UNIQUE,
        beacon_id TEXT NOT NULL,
        canonical_digest TEXT NOT NULL
          CHECK (
            length(canonical_digest) = 64
            AND canonical_digest NOT GLOB '*[^0-9a-f]*'
          ),
        canonical_result TEXT NOT NULL
          CHECK (json_valid(canonical_result)),
        signature TEXT NOT NULL
          CHECK (length(trim(signature)) > 0),
        signature_key_id TEXT NOT NULL
          REFERENCES beacon_identity_keys(key_id) ON DELETE RESTRICT,
        signature_verified INTEGER NOT NULL
          CHECK (signature_verified = 1),
        received_at TEXT NOT NULL,
        source_channel TEXT,
        source_message_id TEXT,
        CHECK (
          (source_channel IS NULL AND source_message_id IS NULL)
          OR
          (source_channel IS NOT NULL AND source_message_id IS NOT NULL)
        ),
        FOREIGN KEY (task_id, beacon_id)
          REFERENCES tasks(task_id, beacon_id) ON DELETE CASCADE,
        FOREIGN KEY (signature_key_id, beacon_id)
          REFERENCES beacon_identity_keys(key_id, beacon_id) ON DELETE RESTRICT
      );
    `);
  },
};

const migration002: StoreMigration = {
  version: 2,
  name: "delivery_dedup_cursors_legacy_import",
  up(database): void {
    database.exec(`
      CREATE TABLE delivery_attempts (
        attempt_id TEXT PRIMARY KEY
          CHECK (length(trim(attempt_id)) > 0),
        task_id TEXT NOT NULL,
        beacon_id TEXT NOT NULL,
        channel TEXT NOT NULL
          CHECK (length(trim(channel)) > 0),
        worker_id TEXT NOT NULL
          CHECK (length(trim(worker_id)) > 0),
        lease_token TEXT NOT NULL UNIQUE,
        attempt_number INTEGER NOT NULL
          CHECK (attempt_number > 0),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT NOT NULL
          CHECK (outcome IN (
            'leased',
            'delivered',
            'transient_failure',
            'permanent_failure'
          )),
        error TEXT,
        FOREIGN KEY (task_id, beacon_id)
          REFERENCES tasks(task_id, beacon_id) ON DELETE CASCADE,
        UNIQUE (task_id, attempt_number),
        UNIQUE (task_id, beacon_id, lease_token, attempt_number)
      );

      CREATE INDEX delivery_attempts_task_started
        ON delivery_attempts(task_id, started_at);

      CREATE TABLE delivery_leases (
        task_id TEXT PRIMARY KEY,
        beacon_id TEXT NOT NULL,
        lease_token TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        leased_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        FOREIGN KEY (task_id, beacon_id)
          REFERENCES tasks(task_id, beacon_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id, beacon_id, lease_token, attempt_number)
          REFERENCES delivery_attempts(
            task_id,
            beacon_id,
            lease_token,
            attempt_number
          ) ON DELETE CASCADE
      );

      CREATE INDEX delivery_leases_expiry
        ON delivery_leases(expires_at);

      CREATE TABLE processed_channel_messages (
        channel TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL
          CHECK (
            length(payload_digest) = 64
            AND payload_digest NOT GLOB '*[^0-9a-f]*'
          ),
        beacon_id TEXT
          REFERENCES beacons(beacon_id) ON DELETE SET NULL,
        task_id TEXT
          REFERENCES tasks(task_id) ON DELETE SET NULL,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('accepted', 'duplicate', 'rejected')),
        processed_at TEXT NOT NULL,
        PRIMARY KEY (channel, message_id),
        CHECK (task_id IS NULL OR beacon_id IS NOT NULL),
        FOREIGN KEY (task_id, beacon_id)
          REFERENCES tasks(task_id, beacon_id) ON DELETE SET NULL
      );

      CREATE INDEX processed_channel_messages_retention
        ON processed_channel_messages(processed_at);

      CREATE TABLE poll_cursors (
        channel TEXT NOT NULL,
        scope TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel, scope)
      );

      CREATE TABLE legacy_imports (
        import_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        imported_count INTEGER NOT NULL
          CHECK (imported_count >= 0),
        imported_at TEXT NOT NULL
      );
    `);
  },
};

const migration003: StoreMigration = {
  version: 3,
  name: "signed_sequence_receipts",
  up(database): void {
    database.exec(`
      CREATE TABLE beacon_sequence_receipts (
        beacon_id TEXT NOT NULL
          REFERENCES beacons(beacon_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL
          CHECK (sequence >= 0),
        envelope_digest TEXT NOT NULL
          CHECK (
            length(envelope_digest) = 64
            AND envelope_digest NOT GLOB '*[^0-9a-f]*'
          ),
        envelope_kind TEXT NOT NULL
          CHECK (envelope_kind IN ('checkin', 'task-result')),
        accepted_at TEXT NOT NULL,
        PRIMARY KEY (beacon_id, sequence)
      );
    `);
  },
};

const migration004: StoreMigration = {
  version: 4,
  name: "canonical_channel_identifiers",
  up(database): void {
    database.exec(`
      ALTER TABLE beacons
        ADD COLUMN active_tentacle_v4 TEXT
          CHECK (
            active_tentacle_v4 IS NULL
            OR active_tentacle_v4 IN (
              '1', '2', '3', '4', '5', '6', '7', '7b',
              '8', '9', '10', '11', '12', '13'
            )
          );

      UPDATE beacons
      SET active_tentacle_v4 = CAST(active_tentacle AS TEXT)
      WHERE active_tentacle IS NOT NULL;

      ALTER TABLE beacons DROP COLUMN active_tentacle;
      ALTER TABLE beacons
        RENAME COLUMN active_tentacle_v4 TO active_tentacle;
    `);
  },
};

const migration005: StoreMigration = {
  version: 5,
  name: "oidc_idempotency_responses",
  up(database): void {
    database.exec(`
      CREATE TABLE oidc_requests (
        jti TEXT PRIMARY KEY
          CHECK (length(trim(jti)) > 0),
        repository TEXT NOT NULL
          CHECK (length(trim(repository)) > 0),
        payload_digest TEXT NOT NULL
          CHECK (
            length(payload_digest) = 64
            AND payload_digest NOT GLOB '*[^0-9a-f]*'
          ),
        beacon_id TEXT NOT NULL
          REFERENCES beacons(beacon_id) ON DELETE CASCADE,
        token_expires_at TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('processing', 'completed')),
        owner_token TEXT,
        worker_id TEXT NOT NULL
          CHECK (length(trim(worker_id)) > 0),
        processing_lease_expires_at TEXT,
        response_status INTEGER
          CHECK (
            response_status IS NULL
            OR response_status BETWEEN 100 AND 599
          ),
        response_headers_json TEXT
          CHECK (
            response_headers_json IS NULL
            OR (
              json_valid(response_headers_json)
              AND json_type(response_headers_json) = 'object'
            )
          ),
        response_body TEXT,
        outcome TEXT
          CHECK (
            outcome IS NULL
            OR outcome IN ('accepted', 'rejected')
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            state = 'processing'
            AND owner_token IS NOT NULL
            AND processing_lease_expires_at IS NOT NULL
            AND response_status IS NULL
            AND response_headers_json IS NULL
            AND response_body IS NULL
            AND outcome IS NULL
          )
          OR
          (
            state = 'completed'
            AND owner_token IS NULL
            AND processing_lease_expires_at IS NULL
            AND response_status IS NOT NULL
            AND response_headers_json IS NOT NULL
            AND response_body IS NOT NULL
            AND outcome IS NOT NULL
          )
        )
      );

      CREATE INDEX oidc_requests_retention
        ON oidc_requests(updated_at);

      CREATE INDEX oidc_requests_processing_lease
        ON oidc_requests(state, processing_lease_expires_at);
    `);
  },
};

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
];

export const CURRENT_SCHEMA_VERSION =
  STORE_MIGRATIONS[STORE_MIGRATIONS.length - 1]?.version ?? 0;

interface AppliedMigrationRow {
  version: number;
  name: string;
}

export function migrateStore(database: Database, now: () => string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .query<AppliedMigrationRow, []>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    )
    .all();
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));

  for (const [index, row] of appliedRows.entries()) {
    const expected = STORE_MIGRATIONS[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name) {
      throw new Error(
        `Store migrations are not a valid prefix at version ${row.version} (${row.name})`,
      );
    }
  }

  for (const [version, name] of applied) {
    const known = STORE_MIGRATIONS.find((migration) => migration.version === version);
    if (!known || known.name !== name) {
      throw new Error(
        `Unsupported or altered store migration ${version} (${name})`,
      );
    }
  }

  const newestApplied = appliedRows.at(-1)?.version ?? 0;
  if (newestApplied > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Store schema ${newestApplied} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  for (const migration of STORE_MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const runMigration = database.transaction((): void => {
      migration.up(database);
      database
        .query<never, [number, string, string]>(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, now());
    });

    runMigration.immediate();
  }
}
