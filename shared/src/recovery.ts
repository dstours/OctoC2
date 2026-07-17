import {
  createUnsignedEnvelope,
  ed25519KeyId,
  signEnvelope,
  verifyEnvelope,
  type SignedEnvelope,
} from "./envelopes.ts";
import {
  canonicalJson,
  decodeBase64Url,
  hashCanonical,
} from "./canonical.ts";
import {
  CHANNEL_BY_KIND,
  isChannelKind,
  type ChannelKind,
} from "./channels.ts";

export const GITHUB_TOKEN_LEASE_VERSION = 1 as const;
export const RECOVERY_RECORD_VERSION = 2 as const;
export const RECOVERY_SIGNER_ID = "octoc2-recovery" as const;

export type GitHubRepositoryPermission = "read" | "write";

export interface GitHubTokenLease {
  version: typeof GITHUB_TOKEN_LEASE_VERSION;
  leaseId: string;
  beaconId: string;
  installationId: number;
  token: string;
  repository: {
    owner: string;
    repo: string;
  };
  permissions: Readonly<Record<string, GitHubRepositoryPermission>>;
  issuedAt: string;
  renewAfter: string;
  expiresAt: string;
}

export interface RecoveryRelayConfig {
  account: string;
  repo: string;
}

export interface RecoveryProxyConfig {
  owner: string;
  repo: string;
  innerKind: "issues";
  decoyIssue: number;
  tokenLease: GitHubTokenLease;
}

/**
 * Full replacement configuration carried by a recovery record.
 *
 * Fields are deliberately required (using null/empty arrays where needed) so
 * consumers never merge a partially authenticated update into live state.
 */
export interface RecoveryConfigurationV2 {
  serverUrl: string;
  controllerToken: string | null;
  monitoringPublicKey: string;
  recoverySigningPublicKey: string;
  recoverySigningKeyId: string;
  github: {
    owner: string;
    repo: string;
    tokenLease: GitHubTokenLease;
  };
  tentaclePriority: readonly ChannelKind[];
  relayConsortium: readonly RecoveryRelayConfig[];
  proxyRepos: readonly RecoveryProxyConfig[];
  sleepSeconds: number;
  jitter: number;
}

export interface RecoveryRecordV2 {
  version: typeof RECOVERY_RECORD_VERSION;
  envelope: SignedEnvelope<"recovery">;
  configuration: RecoveryConfigurationV2;
}

export interface CreateRecoveryRecordInput {
  beaconId: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  signerId?: string;
  signingKeyId: string;
  signingSecretKey: Uint8Array;
  configuration: RecoveryConfigurationV2;
}

export interface VerifyRecoveryRecordOptions {
  beaconId: string;
  minimumGenerationExclusive: number;
  signingPublicKey: Uint8Array;
  expectedSigningKeyId: string;
  expectedSignerId?: string;
  now?: Date;
  maxClockSkewMs?: number;
}

export type RecoveryVerificationResult =
  | {
      valid: true;
      generation: number;
      expiresAt: string;
      configuration: RecoveryConfigurationV2;
    }
  | {
      valid: false;
      reason:
        | "malformed"
        | "wrong_signer"
        | "wrong_key"
        | "invalid_signature"
        | "wrong_beacon"
        | "stale_generation"
        | "issued_in_future"
        | "expired"
        | "configuration_mismatch"
        | "lease_mismatch"
        | "invalid_key_material";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (
    actual.length !== normalizedExpected.length ||
    actual.some((key, index) => key !== normalizedExpected[index])
  ) {
    throw new TypeError(
      `${name} fields must be exactly: ${normalizedExpected.join(", ")}`,
    );
  }
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireCanonicalTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  requireString(value, name);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO-8601 timestamp`);
  }
}

function requireSafePositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function requireRepositoryCoordinate(value: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new TypeError(`${name} contains unsupported characters`);
  }
}

function recoveryTokenLeases(
  configuration: RecoveryConfigurationV2,
): readonly GitHubTokenLease[] {
  return [
    configuration.github.tokenLease,
    ...configuration.proxyRepos.map((proxy) => proxy.tokenLease),
  ];
}

const INSTALLATION_TOKEN_WRITE_PERMISSION = {
  issues: "issues",
  branch: "contents",
  actions: "actions",
  pages: "deployments",
  secrets: "variables",
  stego: "contents",
  notes: "contents",
} as const satisfies Partial<Record<ChannelKind, string>>;

export function assertGitHubTokenLease(
  value: unknown,
): asserts value is GitHubTokenLease {
  if (!isRecord(value)) throw new TypeError("tokenLease must be an object");
  assertExactKeys(
    value,
    [
      "version",
      "leaseId",
      "beaconId",
      "installationId",
      "token",
      "repository",
      "permissions",
      "issuedAt",
      "renewAfter",
      "expiresAt",
    ],
    "tokenLease",
  );
  if (value["version"] !== GITHUB_TOKEN_LEASE_VERSION) {
    throw new TypeError("unsupported GitHub token lease version");
  }
  requireString(value["leaseId"], "tokenLease.leaseId");
  requireString(value["beaconId"], "tokenLease.beaconId");
  requireSafePositiveInteger(
    value["installationId"],
    "tokenLease.installationId",
  );
  requireString(value["token"], "tokenLease.token");
  if (!isRecord(value["repository"])) {
    throw new TypeError("tokenLease.repository must be an object");
  }
  assertExactKeys(
    value["repository"],
    ["owner", "repo"],
    "tokenLease.repository",
  );
  requireString(value["repository"]["owner"], "tokenLease.repository.owner");
  requireString(value["repository"]["repo"], "tokenLease.repository.repo");
  requireRepositoryCoordinate(
    value["repository"]["owner"],
    "tokenLease.repository.owner",
  );
  requireRepositoryCoordinate(
    value["repository"]["repo"],
    "tokenLease.repository.repo",
  );
  if (!isRecord(value["permissions"])) {
    throw new TypeError("tokenLease.permissions must be an object");
  }
  const permissionEntries = Object.entries(value["permissions"]);
  if (permissionEntries.length === 0) {
    throw new TypeError("tokenLease.permissions must not be empty");
  }
  for (const [permission, access] of permissionEntries) {
    if (!/^[a-z][a-z_]*$/.test(permission)) {
      throw new TypeError(`invalid GitHub permission '${permission}'`);
    }
    if (access !== "read" && access !== "write") {
      throw new TypeError(
        `GitHub permission '${permission}' must be read or write`,
      );
    }
  }
  requireCanonicalTimestamp(value["issuedAt"], "tokenLease.issuedAt");
  requireCanonicalTimestamp(value["renewAfter"], "tokenLease.renewAfter");
  requireCanonicalTimestamp(value["expiresAt"], "tokenLease.expiresAt");
  const issuedAt = Date.parse(value["issuedAt"]);
  const renewAfter = Date.parse(value["renewAfter"]);
  const expiresAt = Date.parse(value["expiresAt"]);
  if (!(issuedAt < renewAfter && renewAfter < expiresAt)) {
    throw new TypeError(
      "tokenLease timestamps must satisfy issuedAt < renewAfter < expiresAt",
    );
  }
}

export function assertRecoveryConfiguration(
  value: unknown,
): asserts value is RecoveryConfigurationV2 {
  if (!isRecord(value)) {
    throw new TypeError("recovery configuration must be an object");
  }
  assertExactKeys(
    value,
    [
      "serverUrl",
      "controllerToken",
      "monitoringPublicKey",
      "recoverySigningPublicKey",
      "recoverySigningKeyId",
      "github",
      "tentaclePriority",
      "relayConsortium",
      "proxyRepos",
      "sleepSeconds",
      "jitter",
    ],
    "recovery configuration",
  );

  requireString(value["serverUrl"], "serverUrl");
  const serverUrl = new URL(value["serverUrl"]);
  if (serverUrl.protocol !== "https:") {
    throw new TypeError("serverUrl must use HTTPS");
  }
  if (serverUrl.username || serverUrl.password) {
    throw new TypeError("serverUrl must not contain credentials");
  }
  if (serverUrl.search || serverUrl.hash) {
    throw new TypeError("serverUrl must not contain a query or fragment");
  }
  if (serverUrl.pathname !== "/" && serverUrl.pathname !== "") {
    throw new TypeError("serverUrl must not contain a path");
  }
  if (
    value["controllerToken"] !== null &&
    (typeof value["controllerToken"] !== "string" ||
      value["controllerToken"].trim().length === 0)
  ) {
    throw new TypeError("controllerToken must be null or a non-empty string");
  }
  requireString(value["monitoringPublicKey"], "monitoringPublicKey");
  requireString(value["recoverySigningPublicKey"], "recoverySigningPublicKey");
  requireString(value["recoverySigningKeyId"], "recoverySigningKeyId");

  if (!isRecord(value["github"])) {
    throw new TypeError("github must be an object");
  }
  assertExactKeys(value["github"], ["owner", "repo", "tokenLease"], "github");
  requireString(value["github"]["owner"], "github.owner");
  requireString(value["github"]["repo"], "github.repo");
  requireRepositoryCoordinate(value["github"]["owner"], "github.owner");
  requireRepositoryCoordinate(value["github"]["repo"], "github.repo");
  assertGitHubTokenLease(value["github"]["tokenLease"]);
  if (
    value["github"]["tokenLease"].repository.owner !==
      value["github"]["owner"] ||
    value["github"]["tokenLease"].repository.repo !== value["github"]["repo"]
  ) {
    throw new TypeError("GitHub token lease repository does not match github");
  }
  const primaryVariablesPermission =
    value["github"]["tokenLease"].permissions["variables"];
  if (
    primaryVariablesPermission !== "read" &&
    primaryVariablesPermission !== "write"
  ) {
    throw new TypeError(
      "primary GitHub lease requires variables:read for MONITORING_PUBKEY",
    );
  }
  if (value["github"]["tokenLease"].permissions["metadata"] !== "read") {
    throw new TypeError("primary GitHub lease requires metadata:read");
  }

  if (
    !Array.isArray(value["tentaclePriority"]) ||
    value["tentaclePriority"].length === 0
  ) {
    throw new TypeError("tentaclePriority must be a non-empty array");
  }
  const channels = new Set<string>();
  for (const channel of value["tentaclePriority"]) {
    if (!isChannelKind(channel)) {
      throw new TypeError(`unsupported recovery channel '${String(channel)}'`);
    }
    if (CHANNEL_BY_KIND[channel].implementationStatus === "unavailable") {
      throw new TypeError(`recovery channel '${channel}' is unavailable`);
    }
    if (
      channel !== "proxy" &&
      CHANNEL_BY_KIND[channel].transport === "github" &&
      !CHANNEL_BY_KIND[channel].authModes.some(
        (mode) => mode === "github-app-installation-token",
      )
    ) {
      throw new TypeError(
        `recovery channel '${channel}' does not support installation-token auth`,
      );
    }
    const requiredPermission =
      INSTALLATION_TOKEN_WRITE_PERMISSION[
        channel as keyof typeof INSTALLATION_TOKEN_WRITE_PERMISSION
      ];
    if (
      requiredPermission !== undefined &&
      value["github"]["tokenLease"].permissions[requiredPermission] !== "write"
    ) {
      throw new TypeError(
        `recovery channel '${channel}' requires ${requiredPermission}:write`,
      );
    }
    if (channels.has(channel)) {
      throw new TypeError(`duplicate recovery channel '${channel}'`);
    }
    channels.add(channel);
  }

  if (!Array.isArray(value["relayConsortium"])) {
    throw new TypeError("relayConsortium must be an array");
  }
  for (const relay of value["relayConsortium"]) {
    if (!isRecord(relay)) throw new TypeError("relay entry must be an object");
    assertExactKeys(relay, ["account", "repo"], "relay entry");
    requireString(relay["account"], "relay.account");
    requireString(relay["repo"], "relay.repo");
    requireRepositoryCoordinate(relay["account"], "relay.account");
    requireRepositoryCoordinate(relay["repo"], "relay.repo");
  }

  if (!Array.isArray(value["proxyRepos"])) {
    throw new TypeError("proxyRepos must be an array");
  }
  if (value["proxyRepos"].length > 1) {
    throw new TypeError(
      "proxyRepos supports at most one route per beacon",
    );
  }
  const proxyRepositories = new Set<string>();
  const primaryRepository =
    `${value["github"]["owner"]}/${value["github"]["repo"]}`.toLowerCase();
  for (const proxy of value["proxyRepos"]) {
    if (!isRecord(proxy)) throw new TypeError("proxy entry must be an object");
    assertExactKeys(
      proxy,
      ["owner", "repo", "innerKind", "decoyIssue", "tokenLease"],
      "proxy entry",
    );
    requireString(proxy["owner"], "proxy.owner");
    requireString(proxy["repo"], "proxy.repo");
    requireRepositoryCoordinate(proxy["owner"], "proxy.owner");
    requireRepositoryCoordinate(proxy["repo"], "proxy.repo");
    if (proxy["innerKind"] !== "issues") {
      throw new TypeError("proxy.innerKind must be issues");
    }
    requireSafePositiveInteger(proxy["decoyIssue"], "proxy.decoyIssue");
    assertGitHubTokenLease(proxy["tokenLease"]);
    if (
      proxy["tokenLease"].beaconId !==
        value["github"]["tokenLease"].beaconId ||
      proxy["tokenLease"].repository.owner !== proxy["owner"] ||
      proxy["tokenLease"].repository.repo !== proxy["repo"]
    ) {
      throw new TypeError(
        "proxy token lease identity/repository does not match its proxy",
      );
    }
    const repository =
      `${proxy["owner"]}/${proxy["repo"]}`.toLowerCase();
    if (repository === primaryRepository) {
      throw new TypeError(
        "proxy repository must be distinct from the primary repository",
      );
    }
    if (proxyRepositories.has(repository)) {
      throw new TypeError("duplicate proxy repository");
    }
    proxyRepositories.add(repository);
    if (proxy["tokenLease"].permissions["issues"] !== "write") {
      throw new TypeError(
        "proxy issues lease requires issues:write",
      );
    }
    if (proxy["tokenLease"].permissions["variables"] !== "read") {
      throw new TypeError(
        "proxy issues lease requires variables:read",
      );
    }
    if (proxy["tokenLease"].permissions["metadata"] !== "read") {
      throw new TypeError(
        "proxy issues lease requires metadata:read",
      );
    }
  }
  if (channels.has("proxy") !== (value["proxyRepos"].length > 0)) {
    throw new TypeError(
      "proxy channel priority and proxyRepos must be configured together",
    );
  }

  if (
    !Number.isSafeInteger(value["sleepSeconds"]) ||
    (value["sleepSeconds"] as number) <= 0
  ) {
    throw new TypeError("sleepSeconds must be a positive safe integer");
  }
  if (
    typeof value["jitter"] !== "number" ||
    !Number.isFinite(value["jitter"]) ||
    value["jitter"] < 0 ||
    value["jitter"] > 1
  ) {
    throw new TypeError("jitter must be between 0 and 1");
  }

  canonicalJson(value);
}

export function assertRecoveryRecord(
  value: unknown,
): asserts value is RecoveryRecordV2 {
  if (!isRecord(value)) throw new TypeError("recovery record must be an object");
  assertExactKeys(
    value,
    ["version", "envelope", "configuration"],
    "recovery record",
  );
  if (value["version"] !== RECOVERY_RECORD_VERSION) {
    throw new TypeError("unsupported recovery record version");
  }
  assertRecoveryConfiguration(value["configuration"]);
  if (!isRecord(value["envelope"]) || value["envelope"]["kind"] !== "recovery") {
    throw new TypeError("recovery record must contain a recovery envelope");
  }
}

export async function recoveryDropPath(beaconId: string): Promise<string> {
  requireString(beaconId, "beaconId");
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(beaconId),
    ),
  );
  return `drops/${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")).join("")}.bin`;
}

export async function createRecoveryRecord(
  input: CreateRecoveryRecordInput,
): Promise<RecoveryRecordV2> {
  requireString(input.beaconId, "beaconId");
  requireSafePositiveInteger(input.generation, "generation");
  requireCanonicalTimestamp(input.issuedAt, "issuedAt");
  requireCanonicalTimestamp(input.expiresAt, "expiresAt");
  assertRecoveryConfiguration(input.configuration);
  if (input.configuration.github.tokenLease.beaconId !== input.beaconId) {
    throw new TypeError("GitHub token lease belongs to a different beacon");
  }
  if (
    recoveryTokenLeases(input.configuration).some(
      (lease) => Date.parse(input.expiresAt) > Date.parse(lease.expiresAt),
    )
  ) {
    throw new TypeError(
      "recovery record cannot outlive any GitHub token lease",
    );
  }
  const unsigned = createUnsignedEnvelope({
    kind: "recovery",
    signerId: input.signerId ?? RECOVERY_SIGNER_ID,
    keyId: input.signingKeyId,
    issuedAt: input.issuedAt,
    sequence: input.generation,
    payload: {
      beaconId: input.beaconId,
      generation: input.generation,
      expiresAt: input.expiresAt,
      configurationHash: await hashCanonical(input.configuration),
    },
  });
  const record: RecoveryRecordV2 = {
    version: RECOVERY_RECORD_VERSION,
    envelope: await signEnvelope(unsigned, input.signingSecretKey),
    configuration: input.configuration,
  };
  assertRecoveryRecord(record);
  return record;
}

export async function verifyRecoveryRecord(
  value: unknown,
  options: VerifyRecoveryRecordOptions,
): Promise<RecoveryVerificationResult> {
  try {
    assertRecoveryRecord(value);
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const record = value;
  const envelope = record.envelope;
  const expectedSignerId = options.expectedSignerId ?? RECOVERY_SIGNER_ID;
  if (envelope.signerId !== expectedSignerId) {
    return { valid: false, reason: "wrong_signer" };
  }
  if (envelope.keyId !== options.expectedSigningKeyId) {
    return { valid: false, reason: "wrong_key" };
  }
  try {
    if (
      (await ed25519KeyId(options.signingPublicKey)) !==
      options.expectedSigningKeyId
    ) {
      return { valid: false, reason: "invalid_key_material" };
    }
  } catch {
    return { valid: false, reason: "invalid_key_material" };
  }
  if (!(await verifyEnvelope(envelope, options.signingPublicKey))) {
    return { valid: false, reason: "invalid_signature" };
  }
  if (
    envelope.payload.beaconId !== options.beaconId ||
    record.configuration.github.tokenLease.beaconId !== options.beaconId
  ) {
    return { valid: false, reason: "wrong_beacon" };
  }
  if (
    envelope.sequence !== envelope.payload.generation ||
    envelope.sequence <= options.minimumGenerationExclusive
  ) {
    return { valid: false, reason: "stale_generation" };
  }

  const now = (options.now ?? new Date()).getTime();
  const clockSkewMs = options.maxClockSkewMs ?? 30_000;
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    return { valid: false, reason: "malformed" };
  }
  if (Date.parse(envelope.issuedAt) > now + clockSkewMs) {
    return { valid: false, reason: "issued_in_future" };
  }
  if (
    Date.parse(envelope.payload.expiresAt) <= now ||
    recoveryTokenLeases(record.configuration).some(
      (lease) => Date.parse(lease.expiresAt) <= now,
    )
  ) {
    return { valid: false, reason: "expired" };
  }
  if (
    envelope.payload.configurationHash !==
    await hashCanonical(record.configuration)
  ) {
    return { valid: false, reason: "configuration_mismatch" };
  }
  if (
    record.configuration.github.owner !==
      record.configuration.github.tokenLease.repository.owner ||
    record.configuration.github.repo !==
      record.configuration.github.tokenLease.repository.repo ||
    recoveryTokenLeases(record.configuration).some(
      (lease) =>
        lease.beaconId !== options.beaconId ||
        Date.parse(envelope.payload.expiresAt) >
          Date.parse(lease.expiresAt),
    )
  ) {
    return { valid: false, reason: "lease_mismatch" };
  }

  try {
    const monitoring = await decodeBase64Url(
      record.configuration.monitoringPublicKey,
    );
    const nextRecoveryKey = await decodeBase64Url(
      record.configuration.recoverySigningPublicKey,
    );
    if (monitoring.length !== 32 || nextRecoveryKey.length !== 32) {
      return { valid: false, reason: "invalid_key_material" };
    }
    if (
      (await ed25519KeyId(nextRecoveryKey)) !==
      record.configuration.recoverySigningKeyId
    ) {
      return { valid: false, reason: "invalid_key_material" };
    }
  } catch {
    return { valid: false, reason: "invalid_key_material" };
  }

  return {
    valid: true,
    generation: envelope.payload.generation,
    expiresAt: envelope.payload.expiresAt,
    configuration: record.configuration,
  };
}
