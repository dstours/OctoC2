import {
  canonicalJson,
  parseSignedEnvelope,
  type TaskResult,
} from "@octoc2/shared";
import type {
  BeaconStateData,
  RuntimeSleepOverride,
  SigningKeyPairData,
  TaskLedgerEntry,
} from "./BeaconState.ts";
import { assertBeaconId } from "./BeaconIdentity.ts";
import {
  SeenTaskFilter,
  type SeenTaskFilterData,
} from "./SeenTaskFilter.ts";
import type { ExecutorDirective } from "../tasks/TaskDirective.ts";

const MAX_TASK_LEDGER_ENTRIES = 256;
const ROOT_FIELDS = new Set([
  "version",
  "beaconId",
  "issueNumber",
  "seq",
  "lastTaskCommentId",
  "registrationStatus",
  "ciCommentId",
  "maintenanceCommentId",
  "maintenanceSessionId",
  "maintenanceSessionOpenedAt",
  "lastMaintenanceUpdateMs",
  "initialMaintenancePosted",
  "regCommentId",
  "issueTitle",
  "keyPair",
  "signingKeyPair",
  "identitySeq",
  "sleepOverride",
  "terminationRequested",
  "taskLedger",
  "seenTaskFilter",
]);
const REQUIRED_ROOT_FIELDS = [
  "version",
  "beaconId",
  "issueNumber",
  "seq",
  "lastTaskCommentId",
  "registrationStatus",
  "ciCommentId",
  "keyPair",
  "signingKeyPair",
  "identitySeq",
  "taskLedger",
] as const;

export interface ValidatedBeaconState {
  data: BeaconStateData & { seenTaskFilter: SeenTaskFilterData };
  seenTaskFilter: SeenTaskFilter;
  filterMigrationRequired: boolean;
}

export class BeaconStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeaconStateValidationError";
  }
}

export function validateBeaconStateV2(
  value: unknown,
  expectedBeaconId: string,
): ValidatedBeaconState {
  const state = requireRecord(value, "state");
  rejectUnknownFields(state, ROOT_FIELDS, "state");
  for (const field of REQUIRED_ROOT_FIELDS) {
    if (!hasOwn(state, field)) {
      fail(`state is missing required field ${field}`);
    }
  }
  if (state["version"] !== 2) fail("state version must be 2");
  const normalizedExpectedId = requireBeaconId(
    expectedBeaconId,
    "expected beaconId",
  );
  const beaconId = requireBeaconId(state["beaconId"], "state beaconId");
  if (beaconId !== normalizedExpectedId) {
    fail(
      `state belongs to beacon ${beaconId}, not ${normalizedExpectedId}`,
    );
  }

  const keyPair = validateKeyPair(state["keyPair"]);
  const signingKeyPair = validateSigningKeyPair(state["signingKeyPair"]);
  const identitySeq = requireNonNegativeInteger(
    state["identitySeq"],
    "identitySeq",
  );
  const taskLedger = validateTaskLedger(
    state["taskLedger"],
    beaconId,
    signingKeyPair.keyId,
    identitySeq,
  );
  let seenTaskFilter: SeenTaskFilter;
  let filterMigrationRequired = false;
  if (hasOwn(state, "seenTaskFilter")) {
    try {
      seenTaskFilter = SeenTaskFilter.fromJSON(state["seenTaskFilter"]);
    } catch (error) {
      fail(`invalid seenTaskFilter: ${errorMessage(error)}`);
    }
  } else {
    if (taskLedger.length >= MAX_TASK_LEDGER_ENTRIES) {
      fail(
        "state lacks seenTaskFilter at full ledger capacity; prior evictions cannot be ruled out",
      );
    }
    seenTaskFilter = SeenTaskFilter.empty();
    for (const entry of taskLedger) seenTaskFilter.add(entry.taskId);
    filterMigrationRequired = true;
  }
  for (const entry of taskLedger) {
    if (!seenTaskFilter.has(entry.taskId)) {
      fail(`seenTaskFilter is missing ledger task ${entry.taskId}`);
    }
  }

  const sleepOverride = hasOwn(state, "sleepOverride")
    ? validateSleepOverride(state["sleepOverride"])
    : null;
  const terminationRequested = hasOwn(state, "terminationRequested")
    ? requireBoolean(state["terminationRequested"], "terminationRequested")
    : false;

  return {
    data: {
      version: 2,
      beaconId,
      issueNumber: requireNullablePositiveInteger(
        state["issueNumber"],
        "issueNumber",
      ),
      seq: requireNonNegativeInteger(state["seq"], "seq"),
      lastTaskCommentId: requireNullableNonNegativeInteger(
        state["lastTaskCommentId"],
        "lastTaskCommentId",
      ),
      registrationStatus: requireRegistrationStatus(
        state["registrationStatus"],
      ),
      ciCommentId: requireNullablePositiveInteger(
        state["ciCommentId"],
        "ciCommentId",
      ),
      maintenanceCommentId: hasOwn(state, "maintenanceCommentId")
        ? requireNullablePositiveInteger(
            state["maintenanceCommentId"],
            "maintenanceCommentId",
          )
        : null,
      maintenanceSessionId: hasOwn(state, "maintenanceSessionId")
        ? requireNullableUuid(
            state["maintenanceSessionId"],
            "maintenanceSessionId",
          )
        : null,
      maintenanceSessionOpenedAt: hasOwn(
          state,
          "maintenanceSessionOpenedAt",
        )
        ? requireNullableIsoTimestamp(
            state["maintenanceSessionOpenedAt"],
            "maintenanceSessionOpenedAt",
          )
        : null,
      lastMaintenanceUpdateMs: hasOwn(state, "lastMaintenanceUpdateMs")
        ? requireNonNegativeInteger(
            state["lastMaintenanceUpdateMs"],
            "lastMaintenanceUpdateMs",
          )
        : 0,
      initialMaintenancePosted: hasOwn(state, "initialMaintenancePosted")
        ? requireBoolean(
            state["initialMaintenancePosted"],
            "initialMaintenancePosted",
          )
        : false,
      regCommentId: hasOwn(state, "regCommentId")
        ? requireNullablePositiveInteger(
            state["regCommentId"],
            "regCommentId",
          )
        : null,
      issueTitle: hasOwn(state, "issueTitle")
        ? requireNullableString(state["issueTitle"], "issueTitle", 1024)
        : null,
      keyPair,
      signingKeyPair,
      identitySeq,
      sleepOverride,
      terminationRequested,
      taskLedger,
      seenTaskFilter: seenTaskFilter.toJSON(),
    },
    seenTaskFilter,
    filterMigrationRequired,
  };
}

function validateKeyPair(value: unknown): {
  publicKey: string;
  secretKey: string;
} {
  const pair = requireExactRecord(
    value,
    ["publicKey", "secretKey"],
    "keyPair",
  );
  return {
    publicKey: requireCanonicalBase64Url(
      pair["publicKey"],
      32,
      "keyPair.publicKey",
    ),
    secretKey: requireCanonicalBase64Url(
      pair["secretKey"],
      32,
      "keyPair.secretKey",
    ),
  };
}

function validateSigningKeyPair(value: unknown): SigningKeyPairData {
  const pair = requireExactRecord(
    value,
    ["keyId", "publicKey", "secretKey"],
    "signingKeyPair",
  );
  return {
    publicKey: requireCanonicalBase64Url(
      pair["publicKey"],
      32,
      "signingKeyPair.publicKey",
    ),
    secretKey: requireCanonicalBase64Url(
      pair["secretKey"],
      64,
      "signingKeyPair.secretKey",
    ),
    keyId: requireNonEmptyString(
      pair["keyId"],
      "signingKeyPair.keyId",
      256,
    ),
  };
}

function validateSleepOverride(
  value: unknown,
): RuntimeSleepOverride | null {
  if (value === null) return null;
  const sleep = requireExactRecord(
    value,
    ["jitter", "seconds"],
    "sleepOverride",
  );
  const seconds = requirePositiveInteger(
    sleep["seconds"],
    "sleepOverride.seconds",
  );
  if (seconds > 24 * 60 * 60) {
    fail("sleepOverride.seconds exceeds 86400");
  }
  const jitter = sleep["jitter"];
  if (
    typeof jitter !== "number" ||
    !Number.isFinite(jitter) ||
    jitter < 0 ||
    jitter > 1
  ) {
    fail("sleepOverride.jitter must be a finite number from 0 through 1");
  }
  return { seconds, jitter };
}

function validateTaskLedger(
  value: unknown,
  beaconId: string,
  signingKeyId: string,
  identitySeq: number,
): TaskLedgerEntry[] {
  if (!Array.isArray(value)) fail("taskLedger must be an array");
  if (value.length > MAX_TASK_LEDGER_ENTRIES) {
    fail(`taskLedger exceeds ${MAX_TASK_LEDGER_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  const resultSequences = new Set<number>();
  return value.map((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `taskLedger[${index}]`);
    rejectUnknownFields(
      entry,
      new Set([
        "taskId",
        "status",
        "startedAt",
        "result",
        "directive",
        "resultSubmittedAt",
        "directiveAppliedAt",
      ]),
      `taskLedger[${index}]`,
    );
    for (const field of ["taskId", "status", "startedAt", "result"]) {
      if (!hasOwn(entry, field)) {
        fail(`taskLedger[${index}] is missing ${field}`);
      }
    }
    const taskId = requireNonEmptyString(
      entry["taskId"],
      `taskLedger[${index}].taskId`,
      1024,
    );
    if (seen.has(taskId)) fail(`taskLedger contains duplicate task ${taskId}`);
    seen.add(taskId);
    const startedAt = requireIsoTimestamp(
      entry["startedAt"],
      `taskLedger[${index}].startedAt`,
    );
    const directive = hasOwn(entry, "directive")
      ? validateDirective(entry["directive"], `taskLedger[${index}].directive`)
      : { kind: "none" } as const;
    const resultSubmittedAt = hasOwn(entry, "resultSubmittedAt")
      ? requireNullableIsoTimestamp(
          entry["resultSubmittedAt"],
          `taskLedger[${index}].resultSubmittedAt`,
        )
      : null;
    const directiveAppliedAt = hasOwn(entry, "directiveAppliedAt")
      ? requireNullableIsoTimestamp(
          entry["directiveAppliedAt"],
          `taskLedger[${index}].directiveAppliedAt`,
        )
      : null;

    if (entry["status"] === "started") {
      if (
        entry["result"] !== null ||
        directive.kind !== "none" ||
        resultSubmittedAt !== null ||
        directiveAppliedAt !== null
      ) {
        fail(
          `started task ${taskId} cannot contain a result, directive, or acceptance markers`,
        );
      }
      return {
        taskId,
        status: "started",
        startedAt,
        result: null,
        directive,
        resultSubmittedAt: null,
        directiveAppliedAt: null,
      };
    }
    if (entry["status"] !== "completed") {
      fail(`task ${taskId} has invalid status`);
    }
    const result = validateTaskResult(
      entry["result"],
      taskId,
      beaconId,
      signingKeyId,
      identitySeq,
      resultSequences,
      `taskLedger[${index}].result`,
    );
    if (Date.parse(result.completedAt) < Date.parse(startedAt)) {
      fail(`task ${taskId} completed before it started`);
    }
    if (
      resultSubmittedAt !== null &&
      Date.parse(resultSubmittedAt) < Date.parse(result.completedAt)
    ) {
      fail(`task ${taskId} was accepted before it completed`);
    }
    if (directiveAppliedAt !== null && resultSubmittedAt === null) {
      fail(`task ${taskId} applied a directive before result acceptance`);
    }
    if (
      directiveAppliedAt !== null &&
      resultSubmittedAt !== null &&
      Date.parse(directiveAppliedAt) < Date.parse(resultSubmittedAt)
    ) {
      fail(`task ${taskId} applied a directive before its acceptance time`);
    }
    if (directive.kind === "none" && directiveAppliedAt !== null) {
      fail(`task ${taskId} records a directive effect without a directive`);
    }
    return {
      taskId,
      status: "completed",
      startedAt,
      result,
      directive,
      resultSubmittedAt,
      directiveAppliedAt,
    };
  });
}

function validateTaskResult(
  value: unknown,
  expectedTaskId: string,
  expectedBeaconId: string,
  expectedSigningKeyId: string,
  maximumIdentitySequence: number,
  resultSequences: Set<number>,
  name: string,
): TaskResult {
  const result = requireRecord(value, name);
  rejectUnknownFields(
    result,
    new Set([
      "taskId",
      "beaconId",
      "success",
      "output",
      "data",
      "completedAt",
      "signature",
      "metadata",
    ]),
    name,
  );
  for (const field of [
    "taskId",
    "beaconId",
    "success",
    "output",
    "completedAt",
    "signature",
  ]) {
    if (!hasOwn(result, field)) fail(`${name} is missing ${field}`);
  }
  const taskId = requireNonEmptyString(result["taskId"], `${name}.taskId`, 1024);
  if (taskId !== expectedTaskId) {
    fail(`${name}.taskId does not match its ledger entry`);
  }
  const beaconId = requireBeaconId(result["beaconId"], `${name}.beaconId`);
  if (beaconId !== expectedBeaconId) {
    fail(`${name}.beaconId does not match state identity`);
  }
  const success = requireBoolean(result["success"], `${name}.success`);
  const output = requireString(result["output"], `${name}.output`);
  const completedAt = requireIsoTimestamp(
    result["completedAt"],
    `${name}.completedAt`,
  );
  const signature = requireNonEmptyString(
    result["signature"],
    `${name}.signature`,
    65_536,
  );
  let data: string | undefined;
  if (hasOwn(result, "data")) {
    data = requireString(result["data"], `${name}.data`);
  }
  let metadata: Record<string, unknown> | undefined;
  if (hasOwn(result, "metadata")) {
    metadata = requireRecord(result["metadata"], `${name}.metadata`);
    try {
      canonicalJson(metadata);
    } catch (error) {
      fail(`${name}.metadata is not canonical JSON data: ${errorMessage(error)}`);
    }
    metadata = structuredClone(metadata);
  }
  validateStoredResultEnvelope({
    signature,
    taskId,
    beaconId,
    success,
    completedAt,
    expectedSigningKeyId,
    maximumIdentitySequence,
    resultSequences,
    dataPresent: data !== undefined,
    metadataPresent: metadata !== undefined,
    name,
  });
  return {
    taskId,
    beaconId,
    success,
    output,
    ...(data !== undefined && { data }),
    completedAt,
    signature,
    ...(metadata !== undefined && { metadata }),
  };
}

function validateStoredResultEnvelope(input: {
  signature: string;
  taskId: string;
  beaconId: string;
  success: boolean;
  completedAt: string;
  expectedSigningKeyId: string;
  maximumIdentitySequence: number;
  resultSequences: Set<number>;
  dataPresent: boolean;
  metadataPresent: boolean;
  name: string;
}): void {
  let envelope: ReturnType<typeof parseSignedEnvelope>;
  try {
    envelope = parseSignedEnvelope(input.signature);
  } catch (error) {
    fail(`${input.name}.signature is not a signed envelope: ${errorMessage(error)}`);
  }
  if (canonicalJson(envelope) !== input.signature) {
    fail(`${input.name}.signature must use canonical envelope serialization`);
  }
  if (
    envelope.kind !== "task-result" ||
    envelope.signerId !== input.beaconId ||
    envelope.keyId !== input.expectedSigningKeyId ||
    envelope.issuedAt !== input.completedAt
  ) {
    fail(`${input.name}.signature envelope binding is invalid`);
  }
  if (
    envelope.sequence <= 0 ||
    envelope.sequence > input.maximumIdentitySequence
  ) {
    fail(`${input.name}.signature sequence is outside persisted identity state`);
  }
  if (input.resultSequences.has(envelope.sequence)) {
    fail(`${input.name}.signature reuses result sequence ${envelope.sequence}`);
  }
  input.resultSequences.add(envelope.sequence);
  requireCanonicalBase64Url(
    envelope.signature,
    64,
    `${input.name}.signature.signature`,
  );

  const payload = requireExactRecord(
    envelope.payload,
    [
      "beaconId",
      "completedAt",
      "dataHash",
      "metadataHash",
      "outputHash",
      "success",
      "taskId",
    ],
    `${input.name}.signature.payload`,
  );
  if (
    payload["taskId"] !== input.taskId ||
    payload["beaconId"] !== input.beaconId ||
    payload["success"] !== input.success ||
    payload["completedAt"] !== input.completedAt
  ) {
    fail(`${input.name}.signature payload binding is invalid`);
  }
  requireCanonicalBase64Url(
    payload["outputHash"],
    32,
    `${input.name}.signature.payload.outputHash`,
  );
  validateOptionalHash(
    payload["dataHash"],
    input.dataPresent,
    `${input.name}.signature.payload.dataHash`,
  );
  validateOptionalHash(
    payload["metadataHash"],
    input.metadataPresent,
    `${input.name}.signature.payload.metadataHash`,
  );
}

function validateOptionalHash(
  value: unknown,
  present: boolean,
  name: string,
): void {
  if (!present) {
    if (value !== null) fail(`${name} must be null when the field is absent`);
    return;
  }
  requireCanonicalBase64Url(value, 32, name);
}

function validateDirective(
  value: unknown,
  name: string,
): ExecutorDirective {
  const directive = requireRecord(value, name);
  const kind = directive["kind"];
  if (kind === "none" || kind === "kill" || kind === "self_delete") {
    rejectUnknownFields(directive, new Set(["kind"]), name);
    return { kind };
  }
  if (kind === "update_sleep") {
    const exact = requireExactRecord(
      directive,
      ["jitter", "kind", "seconds"],
      name,
    );
    const seconds = requirePositiveInteger(
      exact["seconds"],
      `${name}.seconds`,
    );
    const jitter = exact["jitter"];
    if (
      seconds > 24 * 60 * 60 ||
      typeof jitter !== "number" ||
      !Number.isFinite(jitter) ||
      jitter < 0 ||
      jitter > 1
    ) {
      fail(`${name} contains an invalid update_sleep value`);
    }
    return { kind: "update_sleep", seconds, jitter };
  }
  fail(`${name}.kind is invalid`);
}

function requireRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  const record = requireRecord(value, name);
  const expected = new Set(fields);
  rejectUnknownFields(record, expected, name);
  for (const field of fields) {
    if (!hasOwn(record, field)) fail(`${name} is missing ${field}`);
  }
  return record;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${name} contains unknown fields: ${unknown.sort().join(", ")}`);
  }
}

function requireRegistrationStatus(
  value: unknown,
): "pending" | "registered" {
  if (value !== "pending" && value !== "registered") {
    fail("registrationStatus is invalid");
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function requireNonEmptyString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  const text = requireString(value, name);
  if (text.trim().length === 0 || text.length > maximumLength) {
    fail(`${name} must contain 1-${maximumLength} characters`);
  }
  return text;
}

function requireNullableString(
  value: unknown,
  name: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  const text = requireString(value, name);
  if (text.length > maximumLength) {
    fail(`${name} exceeds ${maximumLength} characters`);
  }
  return text;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const integer = requireNonNegativeInteger(value, name);
  if (integer === 0) fail(`${name} must be positive`);
  return integer;
}

function requireNullableNonNegativeInteger(
  value: unknown,
  name: string,
): number | null {
  return value === null ? null : requireNonNegativeInteger(value, name);
}

function requireNullablePositiveInteger(
  value: unknown,
  name: string,
): number | null {
  return value === null ? null : requirePositiveInteger(value, name);
}

function requireIsoTimestamp(value: unknown, name: string): string {
  const text = requireNonEmptyString(value, name, 128);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    fail(`${name} must be a canonical ISO-8601 timestamp`);
  }
  return text;
}

function requireNullableIsoTimestamp(
  value: unknown,
  name: string,
): string | null {
  return value === null ? null : requireIsoTimestamp(value, name);
}

function requireNullableUuid(
  value: unknown,
  name: string,
): string | null {
  return value === null ? null : requireBeaconId(value, name);
}

function requireBeaconId(value: unknown, name: string): string {
  try {
    return assertBeaconId(value, name);
  } catch (error) {
    fail(errorMessage(error));
  }
}

function requireCanonicalBase64Url(
  value: unknown,
  byteLength: number,
  name: string,
): string {
  const encoded = requireNonEmptyString(value, name, byteLength * 2);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    fail(`${name} must be canonical base64url`);
  }
  if (
    decoded.length !== byteLength ||
    decoded.toString("base64url") !== encoded
  ) {
    fail(`${name} must encode exactly ${byteLength} bytes`);
  }
  return encoded;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function fail(message: string): never {
  throw new BeaconStateValidationError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
