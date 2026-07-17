#!/usr/bin/env bun
/**
 * Secure live-E2E prerequisite gate.
 *
 * This script deliberately does not start the controller or beacon. The former
 * harness embedded a shared PAT/App key in the beacon and used the C2
 * repository as its own proxy, so a successful run could not prove the current
 * security architecture.
 *
 * The replacement validates that a manually approved external run is prepared
 * with:
 *   - one pre-enrolled beacon identity and matching controller credential;
 *   - an isolated private C2/control repository and distinct private decoy;
 *   - a dedicated public deterministic-recovery repository;
 *   - role-separated GitHub and controller credentials;
 *   - server-held App/recovery keys and exact per-repository policies;
 *   - no legacy beacon App key, shared PAT, or static proxy token;
 *   - current proxy workflows/routes; and
 *   - complete mTLS material when the gRPC path is selected.
 *
 * Passing this gate is not a live E2E success. It means only that the declared
 * prerequisites are internally consistent and, with --check-github, observable
 * through read-only GitHub API checks.
 *
 * Usage:
 *   bun run scripts/test-end-to-end.ts --preflight
 *   bun run scripts/test-end-to-end.ts --dry-run
 *   bun run scripts/test-end-to-end.ts --preflight --check-github
 *   bun run scripts/test-end-to-end.ts --preflight --check-github --grpc
 */

import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  createHash,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_BY_KIND,
  decodeBase64Url,
  ed25519KeyId,
  isChannelKind,
  type ChannelKind,
} from "@octoc2/shared";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GITHUB_API = "https://api.github.com";
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

const FORBIDDEN_BEACON_ENV = [
  "OCTOC2_GITHUB_TOKEN",
  "OCTOC2_APP_PRIVATE_KEY",
  "OCTOC2_PROXY_TOKEN",
  "SVC_APP_ID",
  "SVC_INSTALLATION_ID",
  "SVC_APP_PRIVATE_KEY",
  "SVC_GITHUB_TOKEN",
  "SVC_GITHUB_TOKEN_LEASE",
  "SVC_PROXY_REPOS",
] as const;

const REQUIRED_PROXY_FILES = [
  {
    repository: "decoy" as const,
    remote: ".github/workflows/helper.yml",
    local: "templates/proxy/helper.yml",
  },
  {
    repository: "decoy" as const,
    remote: ".github/workflows/sync-helper.yml",
    local: "templates/proxy/sync-helper.yml",
  },
  {
    repository: "control" as const,
    remote: ".github/workflows/process-checkin.yml",
    local: "templates/proxy/process-checkin.yml",
  },
  {
    repository: "control" as const,
    remote: ".github/workflows/forward-replies.yml",
    local: "templates/proxy/forward-replies.yml",
  },
] as const;

const MAIN_WRITE_PERMISSIONS = {
  issues: ["issues"],
  branch: ["contents"],
  actions: ["actions", "variables"],
  pages: ["deployments"],
  secrets: ["variables"],
  stego: ["contents"],
  notes: ["contents"],
} as const satisfies Partial<Record<ChannelKind, readonly string[]>>;

export interface PreflightOptions {
  dryRun: boolean;
  checkGitHub: boolean;
  grpc: boolean;
  beaconHttp: boolean;
  json: boolean;
}

export interface PreflightReport {
  ok: boolean;
  scope: "local" | "github";
  checks: string[];
  warnings: string[];
  errors: string[];
  liveExecutionPerformed: false;
}

interface RepositoryRef {
  owner: string;
  repo: string;
}

interface EnrollmentArtifact {
  version: 1;
  beaconId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  signingKeyId: string;
  createdAt: string;
}

interface RepositoryPolicy {
  installationId: number;
  repository: RepositoryRef;
  permissions: Record<string, "read" | "write">;
}

interface AppPolicy extends RepositoryPolicy {
  proxyRepositories: RepositoryPolicy[];
}

interface RecoveryProxyPolicy extends RepositoryRef {
  innerKind: "issues";
  decoyIssue: number;
}

interface RecoveryPolicy {
  serverUrl: string;
  controllerToken: string;
  monitoringPublicKey: string;
  tentaclePriority: ChannelKind[];
  proxyRepos: RecoveryProxyPolicy[];
  sleepSeconds: number;
  jitter: number;
}

interface LocalContext {
  beaconId: string;
  c2: RepositoryRef;
  control: RepositoryRef;
  decoy: RepositoryRef;
  recovery: RepositoryRef;
  serverGitHubToken: string;
  operatorGitHubToken: string;
  operatorApiToken: string;
  beaconApiToken: string;
  recoveryWriteToken: string;
  controlDispatchToken: string;
  targetDispatchToken: string;
  relaySigningKey: string;
  monitoringPublicKey: string;
  enrollment: EnrollmentArtifact | null;
  appPolicy: AppPolicy | null;
  recoveryPolicy: RecoveryPolicy | null;
}

interface GitHubRepository {
  id?: unknown;
  private?: unknown;
  archived?: unknown;
  fork?: unknown;
  default_branch?: unknown;
  permissions?: {
    push?: unknown;
  };
}

interface GitHubContent {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
}

interface GitHubSecretList {
  secrets?: Array<{ name?: unknown }>;
}

interface GitHubVariableList {
  variables?: Array<{ name?: unknown; value?: unknown }>;
}

class Audit {
  readonly checks: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  pass(label: string): void {
    this.checks.push(label);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  fail(message: string): void {
    this.errors.push(message);
  }

  require(condition: boolean, message: string): boolean {
    if (!condition) this.fail(message);
    return condition;
  }
}

function usage(): string {
  return [
    "Secure OctoC2 live-E2E prerequisite gate",
    "",
    "Usage:",
    "  bun run scripts/test-end-to-end.ts [options]",
    "",
    "Options:",
    "  --preflight       Validate local declarations and files (default)",
    "  --dry-run         Alias for local-only preflight; never calls GitHub",
    "  --check-github     Add read-only checks of repositories/workflows/routes",
    "  --proxy            Accepted for clarity; proxy isolation is always required",
    "  --grpc             Require and validate server/client mTLS material",
    "  --http             Require the beacon HTTP transport in recovery priority",
    "  --json             Emit a machine-readable, secret-free report",
    "  --help             Show this help",
    "",
    "This command never starts a beacon or controller and never reports live E2E",
    "success. See docs/PRODUCTION.md for the manual evidence requirements.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): PreflightOptions | "help" {
  const options: PreflightOptions = {
    dryRun: false,
    checkGitHub: false,
    grpc: false,
    beaconHttp: false,
    json: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case "--preflight":
      case "--proxy":
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--check-github":
        options.checkGitHub = true;
        break;
      case "--grpc":
        options.grpc = true;
        break;
      case "--http":
        options.beaconHttp = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        return "help";
      default:
        throw new Error(
          `Unsupported legacy/unknown E2E option '${arg}'.\n\n${usage()}`,
        );
    }
  }
  if (options.dryRun) options.checkGitHub = false;
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(
  env: NodeJS.ProcessEnv,
  audit: Audit,
  name: string,
): string {
  const value = env[name]?.trim() ?? "";
  if (!value) audit.fail(`Missing required environment variable ${name}`);
  return value;
}

function trueEnv(
  env: NodeJS.ProcessEnv,
  audit: Audit,
  name: string,
): boolean {
  const value = envValue(env, audit, name).toLowerCase();
  const valid = value === "true";
  if (value && !valid) audit.fail(`${name} must be exactly 'true'`);
  return valid;
}

function parseRepository(
  env: NodeJS.ProcessEnv,
  audit: Audit,
  ownerName: string,
  repoName: string,
): RepositoryRef {
  const owner = envValue(env, audit, ownerName);
  const repo = envValue(env, audit, repoName);
  if (owner && !REPOSITORY_SEGMENT.test(owner)) {
    audit.fail(`${ownerName} contains unsupported characters`);
  }
  if (repo && !REPOSITORY_SEGMENT.test(repo)) {
    audit.fail(`${repoName} contains unsupported characters`);
  }
  return { owner, repo };
}

function repositoryKey(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

function parseJson(
  raw: string,
  audit: Audit,
  name: string,
): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    audit.fail(`${name} must be valid JSON`);
    return null;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

async function decodeKey(
  value: string,
  bytes: number,
  audit: Audit,
  name: string,
): Promise<Uint8Array | null> {
  if (!value) return null;
  try {
    const decoded = await decodeBase64Url(value);
    if (decoded.length !== bytes) {
      audit.fail(`${name} must decode to ${bytes} bytes`);
      return null;
    }
    return decoded;
  } catch {
    audit.fail(`${name} must be unpadded base64url`);
    return null;
  }
}

function deriveRawPublicKey(
  privateSeed: Uint8Array,
  pkcs8Prefix: Buffer,
): Buffer | null {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, Buffer.from(privateSeed)]),
      format: "der",
      type: "pkcs8",
    });
    const publicDer = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    return Buffer.from(publicDer).subarray(-32);
  } catch {
    return null;
  }
}

async function readDeclaredFile(
  env: NodeJS.ProcessEnv,
  audit: Audit,
  name: string,
): Promise<Buffer | null> {
  const path = envValue(env, audit, name);
  if (!path) return null;
  if (!isAbsolute(path)) {
    audit.fail(`${name} must be an absolute path`);
    return null;
  }
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) {
      audit.fail(`${name} must point to a non-empty regular file`);
      return null;
    }
    return await readFile(path);
  } catch {
    audit.fail(`${name} could not be read`);
    return null;
  }
}

async function validateEnrollmentDirectory(
  env: NodeJS.ProcessEnv,
  audit: Audit,
): Promise<void> {
  const directory = envValue(env, audit, "OCTOC2_ENROLLMENT_DIR");
  const enrollmentFile =
    env["OCTOC2_E2E_ENROLLMENT_FILE"]?.trim() ?? "";
  if (!directory) return;
  if (!isAbsolute(directory)) {
    audit.fail("OCTOC2_ENROLLMENT_DIR must be an absolute path");
    return;
  }
  try {
    if (!(await stat(directory)).isDirectory()) {
      audit.fail("OCTOC2_ENROLLMENT_DIR must point to a directory");
      return;
    }
  } catch {
    audit.fail("OCTOC2_ENROLLMENT_DIR could not be read");
    return;
  }
  if (enrollmentFile && isAbsolute(enrollmentFile)) {
    const expected = resolve(directory);
    const actual = resolve(dirname(enrollmentFile));
    const equal = process.platform === "win32"
      ? expected.toLowerCase() === actual.toLowerCase()
      : expected === actual;
    if (!equal || !enrollmentFile.endsWith(".enrollment.json")) {
      audit.fail(
        "The E2E enrollment artifact must be directly importable from OCTOC2_ENROLLMENT_DIR",
      );
      return;
    }
    audit.pass("Server enrollment directory contains the declared beacon identity");
  }
}

function validateCredentialSeparation(
  credentials: Readonly<Record<string, string>>,
  audit: Audit,
): void {
  const errorsBefore = audit.errors.length;
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(credentials)) {
    if (!value) continue;
    if (value.length < 20) {
      audit.fail(`${name} is too short for an E2E-only random credential`);
    }
    const previous = seen.get(value);
    if (previous) {
      audit.fail(`${name} must be distinct from ${previous}`);
    } else {
      seen.set(value, name);
    }
  }
  if (
    Object.values(credentials).every(Boolean) &&
    audit.errors.length === errorsBefore
  ) {
    audit.pass("Credential roles are value-distinct");
  }
}

async function validateEnrollment(
  env: NodeJS.ProcessEnv,
  beaconId: string,
  audit: Audit,
): Promise<EnrollmentArtifact | null> {
  const bytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_E2E_ENROLLMENT_FILE",
  );
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    audit.fail("OCTOC2_E2E_ENROLLMENT_FILE must contain valid JSON");
    return null;
  }
  if (!isRecord(parsed)) {
    audit.fail("Enrollment artifact must be an object");
    return null;
  }
  const exactFields = [
    "beaconId",
    "createdAt",
    "encryptionPublicKey",
    "signingKeyId",
    "signingPublicKey",
    "version",
  ];
  const actualFields = Object.keys(parsed).sort();
  if (
    actualFields.length !== exactFields.length ||
    actualFields.some((field, index) => field !== exactFields[index])
  ) {
    audit.fail(
      "Enrollment artifact must contain only public version-1 identity fields",
    );
    return null;
  }
  if (
    parsed["version"] !== 1 ||
    parsed["beaconId"] !== beaconId ||
    typeof parsed["encryptionPublicKey"] !== "string" ||
    typeof parsed["signingPublicKey"] !== "string" ||
    typeof parsed["signingKeyId"] !== "string" ||
    !canonicalTimestamp(parsed["createdAt"])
  ) {
    audit.fail("Enrollment artifact identity/version/timestamp is invalid");
    return null;
  }
  const encryptionKey = await decodeKey(
    parsed["encryptionPublicKey"],
    32,
    audit,
    "Enrollment encryptionPublicKey",
  );
  const signingKey = await decodeKey(
    parsed["signingPublicKey"],
    32,
    audit,
    "Enrollment signingPublicKey",
  );
  if (
    !encryptionKey ||
    !signingKey ||
    await ed25519KeyId(signingKey) !== parsed["signingKeyId"]
  ) {
    if (signingKey) {
      audit.fail("Enrollment signingKeyId does not match signingPublicKey");
    }
    return null;
  }
  audit.pass("Pre-enrolled X25519 and Ed25519 beacon identity is valid");
  return {
    version: 1,
    beaconId,
    encryptionPublicKey: parsed["encryptionPublicKey"],
    signingPublicKey: parsed["signingPublicKey"],
    signingKeyId: parsed["signingKeyId"],
    createdAt: parsed["createdAt"],
  };
}

function parsePermissions(
  value: unknown,
  audit: Audit,
  name: string,
): Record<string, "read" | "write"> | null {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    audit.fail(`${name} must be a non-empty object`);
    return null;
  }
  const permissions: Record<string, "read" | "write"> = {};
  for (const [permission, access] of Object.entries(value)) {
    if (
      !/^[a-z][a-z_]*$/.test(permission) ||
      (access !== "read" && access !== "write")
    ) {
      audit.fail(`${name} contains an invalid permission`);
      return null;
    }
    permissions[permission] = access;
  }
  return permissions;
}

function parseRepositoryPolicy(
  value: unknown,
  audit: Audit,
  name: string,
  allowProxyRepositories = false,
): RepositoryPolicy | null {
  if (!isRecord(value) || !isRecord(value["repository"])) {
    audit.fail(`${name} must contain installationId, repository, permissions`);
    return null;
  }
  const expectedKeys = [
    "installationId",
    "permissions",
    ...(allowProxyRepositories ? ["proxyRepositories"] : []),
    "repository",
  ].sort();
  if (
    Object.keys(value).sort().join(",") !== expectedKeys.join(",") ||
    Object.keys(value["repository"]).sort().join(",") !== "owner,repo"
  ) {
    audit.fail(`${name} contains unexpected policy fields`);
    return null;
  }
  const installationId = value["installationId"];
  const owner = value["repository"]["owner"];
  const repo = value["repository"]["repo"];
  const permissions = parsePermissions(
    value["permissions"],
    audit,
    `${name}.permissions`,
  );
  if (
    !Number.isSafeInteger(installationId) ||
    (installationId as number) <= 0 ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(repo) ||
    !permissions
  ) {
    audit.fail(`${name} contains invalid repository policy fields`);
    return null;
  }
  return {
    installationId: installationId as number,
    repository: { owner, repo },
    permissions,
  };
}

function parseAppPolicy(
  raw: string,
  beaconId: string,
  c2: RepositoryRef,
  decoy: RepositoryRef,
  audit: Audit,
): AppPolicy | null {
  const errorsBefore = audit.errors.length;
  const parsed = parseJson(raw, audit, "OCTOC2_GITHUB_APP_POLICIES");
  if (!isRecord(parsed)) {
    if (parsed !== null) {
      audit.fail("OCTOC2_GITHUB_APP_POLICIES must be a JSON object");
    }
    return null;
  }
  const ids = Object.keys(parsed);
  if (ids.length !== 1 || ids[0] !== beaconId) {
    audit.fail(
      "OCTOC2_GITHUB_APP_POLICIES must contain exactly the E2E beacon ID",
    );
    return null;
  }
  const entry = parsed[beaconId];
  const primary = parseRepositoryPolicy(
    entry,
    audit,
    `App policy ${beaconId}`,
    true,
  );
  if (!primary || !isRecord(entry)) return null;
  const proxyRaw = entry["proxyRepositories"];
  if (!Array.isArray(proxyRaw) || proxyRaw.length !== 1) {
    audit.fail(
      "App policy must contain exactly one distinct proxyRepositories entry",
    );
    return null;
  }
  const proxy = parseRepositoryPolicy(
    proxyRaw[0],
    audit,
    "App proxy policy",
  );
  if (!proxy) return null;
  if (repositoryKey(primary.repository) !== repositoryKey(c2)) {
    audit.fail("Primary App policy repository must match the isolated C2 repo");
  }
  if (repositoryKey(proxy.repository) !== repositoryKey(decoy)) {
    audit.fail("Proxy App policy repository must match the decoy repo");
  }
  if (
    primary.installationId === proxy.installationId &&
    primary.repository.owner.toLowerCase() !==
      proxy.repository.owner.toLowerCase()
  ) {
    audit.warn(
      "Primary and proxy repositories share an App installation; verify that this is intentional",
    );
  }
  if (audit.errors.length === errorsBefore) {
    audit.pass("Server-held App policy binds primary and proxy repositories");
  }
  return {
    ...primary,
    proxyRepositories: [proxy],
  };
}

function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseRecoveryPolicy(
  raw: string,
  beaconId: string,
  beaconApiToken: string,
  monitoringPublicKey: string,
  decoy: RepositoryRef,
  options: PreflightOptions,
  audit: Audit,
): RecoveryPolicy | null {
  const errorsBefore = audit.errors.length;
  const parsed = parseJson(raw, audit, "OCTOC2_RECOVERY_POLICIES");
  if (!isRecord(parsed)) {
    if (parsed !== null) {
      audit.fail("OCTOC2_RECOVERY_POLICIES must be a JSON object");
    }
    return null;
  }
  const ids = Object.keys(parsed);
  if (ids.length !== 1 || ids[0] !== beaconId) {
    audit.fail(
      "OCTOC2_RECOVERY_POLICIES must contain exactly the E2E beacon ID",
    );
    return null;
  }
  const value = parsed[beaconId];
  if (!isRecord(value)) {
    audit.fail("Recovery policy entry must be an object");
    return null;
  }
  const serverUrl = value["serverUrl"];
  const controllerToken = value["controllerToken"];
  const monitoring = value["monitoringPublicKey"];
  const priorities = value["tentaclePriority"];
  const relayConsortium = value["relayConsortium"];
  const proxies = value["proxyRepos"];
  const sleepSeconds = value["sleepSeconds"];
  const jitter = value["jitter"];
  if (
    typeof serverUrl !== "string" ||
    !validServerUrl(serverUrl) ||
    typeof controllerToken !== "string" ||
    typeof monitoring !== "string" ||
    !Array.isArray(priorities) ||
    !Array.isArray(relayConsortium) ||
    !Array.isArray(proxies) ||
    !Number.isSafeInteger(sleepSeconds) ||
    (sleepSeconds as number) <= 0 ||
    typeof jitter !== "number" ||
    !Number.isFinite(jitter) ||
    jitter < 0 ||
    jitter > 1
  ) {
    audit.fail("Recovery policy has invalid complete-configuration fields");
    return null;
  }
  const expectedKeys = [
    "controllerToken",
    "jitter",
    "monitoringPublicKey",
    "proxyRepos",
    "relayConsortium",
    "serverUrl",
    "sleepSeconds",
    "tentaclePriority",
  ];
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
    audit.fail("Recovery policy contains unexpected top-level fields");
  }
  if (relayConsortium.length !== 0) {
    audit.fail(
      "The isolated proxy E2E scenario must not add relay-consortium repositories",
    );
  }
  if (controllerToken !== beaconApiToken) {
    audit.fail(
      "Recovery controllerToken must equal the unique E2E beacon API token",
    );
  }
  if (monitoring !== monitoringPublicKey) {
    audit.fail(
      "Recovery monitoringPublicKey must match MONITORING_PUBKEY",
    );
  }
  const tentaclePriority: ChannelKind[] = [];
  const seenChannels = new Set<string>();
  for (const channel of priorities) {
    if (
      !isChannelKind(channel) ||
      CHANNEL_BY_KIND[channel].implementationStatus === "unavailable"
    ) {
      audit.fail(`Recovery priority contains an unavailable channel`);
      continue;
    }
    if (seenChannels.has(channel)) {
      audit.fail(`Recovery priority contains a duplicate channel`);
      continue;
    }
    seenChannels.add(channel);
    tentaclePriority.push(channel);
  }
  if (!seenChannels.has("proxy") || !seenChannels.has("issues")) {
    audit.fail(
      "Recovery priority must include proxy and issues for the external proxy scenario",
    );
  } else if (
    tentaclePriority.indexOf("proxy") > tentaclePriority.indexOf("issues")
  ) {
    audit.fail("Proxy must precede Issues in recovery priority");
  }
  if (options.grpc && !seenChannels.has("codespaces")) {
    audit.fail("--grpc requires codespaces in recovery tentaclePriority");
  }
  if (!options.grpc && seenChannels.has("codespaces")) {
    audit.fail(
      "A codespaces recovery channel requires --grpc so mTLS is validated",
    );
  }
  if (options.beaconHttp && !seenChannels.has("http")) {
    audit.fail("--http requires http in recovery tentaclePriority");
  }
  if (!options.beaconHttp && seenChannels.has("http")) {
    audit.fail(
      "An http recovery channel requires --http so its endpoint is validated",
    );
  }
  const proxyRepos: RecoveryProxyPolicy[] = [];
  if (proxies.length !== 1 || !isRecord(proxies[0])) {
    audit.fail("Recovery policy must contain exactly one proxy repo");
  } else {
    const proxy = proxies[0];
    const owner = proxy["owner"];
    const repo = proxy["repo"];
    const innerKind = proxy["innerKind"];
    const decoyIssue = proxy["decoyIssue"];
    const keys = Object.keys(proxy).sort();
    if (
      keys.join(",") !== "decoyIssue,innerKind,owner,repo" ||
      typeof owner !== "string" ||
      typeof repo !== "string" ||
      innerKind !== "issues" ||
      !Number.isSafeInteger(decoyIssue) ||
      (decoyIssue as number) <= 0
    ) {
      audit.fail(
        "Recovery proxy entry must contain only owner, repo, innerKind=issues, and a positive decoyIssue",
      );
    } else {
      const parsedProxy: RecoveryProxyPolicy = {
        owner,
        repo,
        innerKind,
        decoyIssue: decoyIssue as number,
      };
      proxyRepos.push(parsedProxy);
      if (repositoryKey(parsedProxy) !== repositoryKey(decoy)) {
        audit.fail("Recovery proxy repo must match the distinct decoy repo");
      }
    }
  }
  const forbiddenPolicyKeys = [
    "appPrivateKey",
    "githubTokenLease",
    "proxyToken",
    "tokenLease",
  ];
  const serialized = JSON.stringify(value);
  for (const forbidden of forbiddenPolicyKeys) {
    if (serialized.includes(`"${forbidden}"`)) {
      audit.fail(
        `Recovery policy must not contain forbidden credential field ${forbidden}`,
      );
    }
  }
  if (audit.errors.length === errorsBefore) {
    audit.pass("Complete recovery policy uses server-minted repository leases");
  }
  return {
    serverUrl,
    controllerToken,
    monitoringPublicKey: monitoring,
    tentaclePriority,
    proxyRepos,
    sleepSeconds: sleepSeconds as number,
    jitter,
  };
}

function validatePolicyPermissions(
  appPolicy: AppPolicy | null,
  recoveryPolicy: RecoveryPolicy | null,
  audit: Audit,
): void {
  if (!appPolicy || !recoveryPolicy) return;
  const errorsBefore = audit.errors.length;
  const primaryVariables = appPolicy.permissions.variables;
  if (primaryVariables !== "read" && primaryVariables !== "write") {
    audit.fail(
      "Primary App policy requires variables:read for MONITORING_PUBKEY",
    );
  }
  if (appPolicy.permissions.metadata !== "read") {
    audit.fail("Primary App policy requires metadata:read");
  }
  for (const channel of recoveryPolicy.tentaclePriority) {
    if (channel === "proxy") continue;
    const definition = CHANNEL_BY_KIND[channel];
    if (
      definition.transport === "github" &&
      !definition.authModes.some(
        (mode) => mode === "github-app-installation-token",
      )
    ) {
      audit.fail(
        `Recovery channel ${channel} cannot use the installation-token-only beacon`,
      );
    }
    for (const permission of (
      MAIN_WRITE_PERMISSIONS[
        channel as keyof typeof MAIN_WRITE_PERMISSIONS
      ] ?? []
    )) {
      if (appPolicy.permissions[permission] !== "write") {
        audit.fail(
          `Primary App policy requires ${permission}:write for ${channel}`,
        );
      }
    }
  }
  const proxy = recoveryPolicy.proxyRepos[0];
  const proxyPolicy = appPolicy.proxyRepositories[0];
  if (proxy && proxyPolicy) {
    if (proxyPolicy.permissions.issues !== "write") {
      audit.fail(
        "Proxy App policy requires issues:write for the Issues relay",
      );
    }
    if (proxyPolicy.permissions.variables !== "read") {
      audit.fail(
        "Proxy App policy requires variables:read for MONITORING_PUBKEY",
      );
    }
    if (proxyPolicy.permissions.metadata !== "read") {
      audit.fail("Proxy App policy requires metadata:read");
    }
  }
  if (audit.errors.length === errorsBefore) {
    audit.pass("Installation-token permissions cover selected channels");
  }
}

async function validateRecoveryKeys(
  env: NodeJS.ProcessEnv,
  audit: Audit,
): Promise<{ appPem: string; signingSecret: string }> {
  const appBytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE",
  );
  let appPem = "";
  if (appBytes) {
    appPem = appBytes.toString("utf8").trim();
    try {
      const key = createPrivateKey(appPem);
      if (key.asymmetricKeyType !== "rsa") {
        audit.fail("GitHub App private key must be RSA");
      } else if (
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        audit.fail("GitHub App RSA private key must be at least 2048 bits");
      } else {
        audit.pass("Server-only GitHub App key is RSA-2048 or stronger");
      }
    } catch {
      audit.fail("OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE is not a valid private key");
    }
  }

  const secretBytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_RECOVERY_SIGNING_SECRET_FILE",
  );
  const signingSecret = secretBytes?.toString("utf8").trim() ?? "";
  const secretKey = await decodeKey(
    signingSecret,
    64,
    audit,
    "Recovery signing secret file",
  );
  const publicRaw = envValue(
    env,
    audit,
    "OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY",
  );
  const publicKey = await decodeKey(
    publicRaw,
    32,
    audit,
    "OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY",
  );
  const keyId = envValue(
    env,
    audit,
    "OCTOC2_RECOVERY_SIGNING_KEY_ID",
  );
  if (publicKey) {
    if (await ed25519KeyId(publicKey) !== keyId) {
      audit.fail(
        "OCTOC2_RECOVERY_SIGNING_KEY_ID does not match its public key",
      );
    }
    if (
      secretKey &&
      (
        !Buffer.from(secretKey.slice(32)).equals(Buffer.from(publicKey)) ||
        !deriveRawPublicKey(
          secretKey.slice(0, 32),
          ED25519_PKCS8_PREFIX,
        )?.equals(Buffer.from(publicKey))
      )
    ) {
      audit.fail("Recovery signing secret/public keys do not form a keypair");
    } else if (secretKey) {
      audit.pass("Recovery signing secret/public keypair is consistent");
    }
  }
  return { appPem, signingSecret };
}

async function validateBeaconBinary(
  env: NodeJS.ProcessEnv,
  sensitiveValues: readonly string[],
  audit: Audit,
): Promise<void> {
  const bytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_E2E_BEACON_BINARY",
  );
  if (!bytes) return;
  for (const value of sensitiveValues) {
    if (
      value.length >= 16 &&
      bytes.includes(Buffer.from(value, "utf8"))
    ) {
      audit.fail(
        "Beacon binary contains a server/operator credential or private key",
      );
      return;
    }
  }
  audit.pass("Beacon binary contains none of the declared sensitive values");
}

function parseBeaconTokenMap(
  raw: string,
  beaconId: string,
  beaconApiToken: string,
  audit: Audit,
): void {
  if (!raw) return;
  const parsed = parseJson(raw, audit, "OCTOC2_BEACON_API_TOKENS");
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    parsed[beaconId] !== beaconApiToken
  ) {
    audit.fail(
      "OCTOC2_BEACON_API_TOKENS must map only the E2E beacon ID to its unique token",
    );
    return;
  }
  audit.pass("Beacon API credential map is bound to the enrolled identity");
}

function certificateCurrentlyValid(
  certificate: X509Certificate,
): boolean {
  const now = Date.now();
  return (
    Date.parse(certificate.validFrom) <= now &&
    Date.parse(certificate.validTo) > now
  );
}

function privateKeyMatchesCertificate(
  privateKeyPem: string,
  certificate: X509Certificate,
): boolean {
  try {
    const actual = createPublicKey(createPrivateKey(privateKeyPem)).export({
      type: "spki",
      format: "der",
    });
    const expected = certificate.publicKey.export({
      type: "spki",
      format: "der",
    });
    return Buffer.from(actual).equals(Buffer.from(expected));
  } catch {
    return false;
  }
}

async function validateMtls(
  env: NodeJS.ProcessEnv,
  options: PreflightOptions,
  audit: Audit,
): Promise<void> {
  if (!options.grpc) return;
  if (!trueEnv(env, audit, "OCTOC2_GRPC_ENABLED")) return;
  const errorsBefore = audit.errors.length;
  const grpcHost = envValue(env, audit, "OCTOC2_GRPC_HOST");
  if (
    grpcHost !== "127.0.0.1" &&
    grpcHost !== "::1" &&
    grpcHost !== "localhost"
  ) {
    audit.fail("OCTOC2_GRPC_HOST must remain loopback for this E2E gate");
  }
  const serverName = envValue(
    env,
    audit,
    "OCTOC2_E2E_GRPC_SERVER_NAME",
  );
  const directEndpoint = envValue(env, audit, "SVC_GRPC_DIRECT");
  const beaconId = envValue(env, audit, "OCTOC2_E2E_BEACON_ID");
  const fingerprintBindings = parseJson(
    envValue(
      env,
      audit,
      "OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS",
    ),
    audit,
    "OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS",
  );
  if (!/^[^:]+:\d+$/.test(directEndpoint)) {
    audit.fail("SVC_GRPC_DIRECT must be host:port for the approved private path");
  } else {
    const endpointHost = directEndpoint.slice(
      0,
      directEndpoint.lastIndexOf(":"),
    );
    if (endpointHost !== serverName) {
      audit.fail(
        "OCTOC2_E2E_GRPC_SERVER_NAME must equal the SVC_GRPC_DIRECT hostname because insecure TLS target overrides are not supported",
      );
    }
  }
  const serverCa = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_GRPC_CA_CERT",
  );
  const serverCertBytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_GRPC_SERVER_CERT",
  );
  const serverKeyBytes = await readDeclaredFile(
    env,
    audit,
    "OCTOC2_GRPC_SERVER_KEY",
  );
  const clientCa = await readDeclaredFile(env, audit, "SVC_GRPC_CA_CERT");
  const clientCertBytes = await readDeclaredFile(
    env,
    audit,
    "SVC_GRPC_CLIENT_CERT",
  );
  const clientKeyBytes = await readDeclaredFile(
    env,
    audit,
    "SVC_GRPC_CLIENT_KEY",
  );
  if (
    !serverCa ||
    !serverCertBytes ||
    !serverKeyBytes ||
    !clientCa ||
    !clientCertBytes ||
    !clientKeyBytes
  ) {
    return;
  }
  if (!serverCa.equals(clientCa)) {
    audit.fail("Server and beacon must use the same approved E2E CA");
  }
  try {
    const ca = new X509Certificate(serverCa);
    const serverCert = new X509Certificate(serverCertBytes);
    const clientCert = new X509Certificate(clientCertBytes);
    const serverKey = serverKeyBytes.toString("utf8");
    const clientKey = clientKeyBytes.toString("utf8");
    if (!ca.ca) audit.fail("OCTOC2_GRPC_CA_CERT is not a CA certificate");
    if (
      !certificateCurrentlyValid(ca) ||
      !certificateCurrentlyValid(serverCert) ||
      !certificateCurrentlyValid(clientCert)
    ) {
      audit.fail("One or more mTLS certificates are not currently valid");
    }
    if (
      !serverCert.verify(ca.publicKey) ||
      !clientCert.verify(ca.publicKey)
    ) {
      audit.fail("Server/client certificates are not signed by the declared CA");
    }
    if (!privateKeyMatchesCertificate(serverKey, serverCert)) {
      audit.fail("gRPC server key does not match its certificate");
    }
    if (!privateKeyMatchesCertificate(clientKey, clientCert)) {
      audit.fail("gRPC client key does not match its certificate");
    }
    const isIp = /^[0-9a-f:.]+$/i.test(serverName);
    const matched = isIp
      ? serverCert.checkIP(serverName)
      : serverCert.checkHost(serverName);
    if (!matched) {
      audit.fail(
        "gRPC server certificate SAN does not cover OCTOC2_E2E_GRPC_SERVER_NAME",
      );
    }
    if (serverCert.fingerprint256 === clientCert.fingerprint256) {
      audit.fail("gRPC server and beacon must not share one certificate");
    }
    const expectedFingerprint =
      isRecord(fingerprintBindings) &&
        Object.keys(fingerprintBindings).length === 1 &&
        typeof fingerprintBindings[beaconId] === "string"
        ? fingerprintBindings[beaconId].replaceAll(":", "").toLowerCase()
        : "";
    const actualFingerprint = clientCert.fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    if (
      !/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
      expectedFingerprint !== actualFingerprint
    ) {
      audit.fail(
        "OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS must bind only the E2E beacon ID to the supplied client certificate",
      );
    }
    if (audit.errors.length === errorsBefore) {
      audit.pass(
        "Per-beacon gRPC mTLS chain, fingerprint binding, SAN, and private keys are valid",
      );
    }
  } catch {
    audit.fail("gRPC mTLS material could not be parsed or verified");
  }
}

async function validateHttpListener(
  env: NodeJS.ProcessEnv,
  options: PreflightOptions,
  recoveryPolicy: RecoveryPolicy | null,
  audit: Audit,
): Promise<void> {
  if (!trueEnv(env, audit, "OCTOC2_HTTP_ENABLED")) return;
  const errorsBefore = audit.errors.length;
  const host = envValue(env, audit, "OCTOC2_HTTP_HOST");
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    audit.fail("OCTOC2_HTTP_HOST must remain loopback for live E2E");
  }
  const portRaw = envValue(env, audit, "OCTOC2_HTTP_PORT");
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    audit.fail("OCTOC2_HTTP_PORT must be a valid TCP port");
  }
  const [certificateBytes, privateKeyBytes, caBytes] = await Promise.all([
    readDeclaredFile(env, audit, "OCTOC2_HTTP_SERVER_CERT"),
    readDeclaredFile(env, audit, "OCTOC2_HTTP_SERVER_KEY"),
    readDeclaredFile(env, audit, "OCTOC2_HTTP_CA_CERT"),
  ]);
  if (certificateBytes && privateKeyBytes && caBytes) {
    try {
      const certificate = new X509Certificate(certificateBytes);
      const ca = new X509Certificate(caBytes);
      if (!certificateCurrentlyValid(certificate)) {
        audit.fail("HTTP server certificate is expired or not yet valid");
      }
      if (!certificateCurrentlyValid(ca)) {
        audit.fail("HTTP CA certificate is expired or not yet valid");
      }
      if (!certificate.verify(ca.publicKey)) {
        audit.fail("HTTP server certificate is not signed by the declared CA");
      }
      if (!privateKeyMatchesCertificate(
        privateKeyBytes.toString("utf8"),
        certificate,
      )) {
        audit.fail("HTTP server key does not match its certificate");
      }
      const isIp = /^[0-9a-f:.]+$/i.test(host);
      const matched = isIp
        ? certificate.checkIP(host)
        : certificate.checkHost(host);
      if (!matched) {
        audit.fail("HTTP server certificate SAN does not cover OCTOC2_HTTP_HOST");
      }
    } catch {
      audit.fail("HTTP TLS material could not be parsed or verified");
    }
  }
  if (options.beaconHttp && recoveryPolicy) {
    const expected = `https://${host}:${port}`;
    if (recoveryPolicy.serverUrl !== expected) {
      audit.fail(
        "HTTP recovery serverUrl must match the loopback controller listener",
      );
    }
  }
  if (audit.errors.length === errorsBefore) {
    audit.pass("Operator HTTPS/WSS API is enabled on loopback with trusted TLS");
  }
}

async function githubRequest(
  path: string,
  token: string | undefined,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OctoC2-E2E-Preflight/0.1",
    },
  });
}

async function githubJson<T>(
  path: string,
  token: string | undefined,
  audit: Audit,
  label: string,
): Promise<T | null> {
  try {
    const response = await githubRequest(path, token);
    if (!response.ok) {
      audit.fail(`${label} failed with GitHub HTTP ${response.status}`);
      return null;
    }
    return await response.json() as T;
  } catch {
    audit.fail(`${label} could not reach GitHub`);
    return null;
  }
}

function repoPath(repository: RepositoryRef): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

async function inspectRepository(
  repository: RepositoryRef,
  token: string | undefined,
  expectedPrivate: boolean,
  audit: Audit,
  label: string,
): Promise<GitHubRepository | null> {
  const result = await githubJson<GitHubRepository>(
    repoPath(repository),
    token,
    audit,
    `Inspect ${label} repository`,
  );
  if (!result) return null;
  if (result.private !== expectedPrivate) {
    audit.fail(
      `${label} repository must be ${expectedPrivate ? "private" : "public"}`,
    );
  }
  if (result.archived !== false) {
    audit.fail(`${label} repository must not be archived`);
  }
  if (result.fork !== false) {
    audit.fail(`${label} repository must be a standalone disposable repository`);
  }
  if (typeof result.default_branch !== "string" || !result.default_branch) {
    audit.fail(`${label} repository must have a default branch`);
  }
  return result;
}

function normalizedWorkflow(content: string): string {
  return `${content.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

async function validateRemoteWorkflow(
  repository: RepositoryRef,
  remotePath: string,
  localPath: string,
  token: string,
  audit: Audit,
): Promise<void> {
  const result = await githubJson<GitHubContent>(
    `${repoPath(repository)}/contents/${remotePath.split("/").map(encodeURIComponent).join("/")}`,
    token,
    audit,
    `Read proxy workflow ${remotePath}`,
  );
  if (
    !result ||
    result.type !== "file" ||
    result.encoding !== "base64" ||
    typeof result.content !== "string"
  ) {
    if (result) audit.fail(`Proxy workflow ${remotePath} has invalid content`);
    return;
  }
  const remote = normalizedWorkflow(
    Buffer.from(result.content.replace(/\s+/g, ""), "base64").toString("utf8"),
  );
  const local = normalizedWorkflow(
    await readFile(join(ROOT, localPath), "utf8"),
  );
  const remoteHash = createHash("sha256").update(remote).digest("hex");
  const localHash = createHash("sha256").update(local).digest("hex");
  if (remoteHash !== localHash) {
    audit.fail(`Proxy workflow ${remotePath} does not match this revision`);
  }
}

async function repositorySecrets(
  repository: RepositoryRef,
  token: string,
  audit: Audit,
  label: string,
): Promise<Set<string> | null> {
  const result = await githubJson<GitHubSecretList>(
    `${repoPath(repository)}/actions/secrets?per_page=100`,
    token,
    audit,
    `List ${label} Actions secrets`,
  );
  if (!result || !Array.isArray(result.secrets)) return null;
  return new Set(
    result.secrets.flatMap((entry) =>
      typeof entry.name === "string" ? [entry.name] : []),
  );
}

async function repositoryVariables(
  repository: RepositoryRef,
  token: string,
  audit: Audit,
  label: string,
): Promise<Map<string, string> | null> {
  const result = await githubJson<GitHubVariableList>(
    `${repoPath(repository)}/actions/variables?per_page=100`,
    token,
    audit,
    `List ${label} Actions variables`,
  );
  if (!result || !Array.isArray(result.variables)) return null;
  return new Map(
    result.variables.flatMap((entry) =>
      typeof entry.name === "string" && typeof entry.value === "string"
        ? [[entry.name, entry.value] as const]
        : []),
  );
}

function requireNames(
  actual: Set<string> | Map<string, string> | null,
  expected: readonly string[],
  audit: Audit,
  label: string,
): void {
  if (!actual) return;
  for (const name of expected) {
    if (!actual.has(name)) {
      audit.fail(`${label} is missing ${name}`);
    }
  }
}

async function validateIssue(
  repository: RepositoryRef,
  issueNumber: number,
  token: string,
  audit: Audit,
  label: string,
): Promise<void> {
  const issue = await githubJson<{ state?: unknown }>(
    `${repoPath(repository)}/issues/${issueNumber}`,
    token,
    audit,
    `Inspect ${label} issue`,
  );
  if (issue && issue.state !== "open") {
    audit.fail(`${label} proxy route issue must be open`);
  }
}

async function validateGitHubState(
  context: LocalContext,
  audit: Audit,
): Promise<void> {
  const errorsBefore = audit.errors.length;
  const c2Metadata = await inspectRepository(
    context.c2,
    context.serverGitHubToken,
    true,
    audit,
    "C2/control",
  );
  const decoyMetadata = await inspectRepository(
    context.decoy,
    context.operatorGitHubToken,
    true,
    audit,
    "proxy decoy",
  );
  const recoveryAnonymous = await inspectRepository(
    context.recovery,
    undefined,
    false,
    audit,
    "recovery",
  );
  const recoveryWriter = await inspectRepository(
    context.recovery,
    context.recoveryWriteToken,
    false,
    audit,
    "recovery writer view",
  );
  const ids = [
    c2Metadata?.id,
    decoyMetadata?.id,
    recoveryAnonymous?.id,
  ].filter((id): id is number => typeof id === "number");
  if (ids.length === 3 && new Set(ids).size !== ids.length) {
    audit.fail("GitHub repository IDs are not distinct");
  }
  if (recoveryWriter?.permissions?.push !== true) {
    audit.fail(
      "OCTOC2_RECOVERY_WRITE_TOKEN cannot write the public recovery repository",
    );
  }

  for (const workflow of REQUIRED_PROXY_FILES) {
    const repository =
      workflow.repository === "control" ? context.control : context.decoy;
    await validateRemoteWorkflow(
      repository,
      workflow.remote,
      workflow.local,
      context.operatorGitHubToken,
      audit,
    );
  }

  const controlSecrets = await repositorySecrets(
    context.control,
    context.operatorGitHubToken,
    audit,
    "control",
  );
  const decoySecrets = await repositorySecrets(
    context.decoy,
    context.operatorGitHubToken,
    audit,
    "decoy",
  );
  requireNames(
    controlSecrets,
    ["TARGET_TOKEN", "RELAY_SIGNING_KEY"],
    audit,
    "Control repository secrets",
  );
  requireNames(
    decoySecrets,
    [
      "CONTROL_TOKEN",
      "CONTROL_OWNER",
      "CONTROL_REPO",
      "NODE_ID",
      "RELAY_SIGNING_KEY",
    ],
    audit,
    "Decoy repository secrets",
  );

  const controlVariables = await repositoryVariables(
    context.control,
    context.operatorGitHubToken,
    audit,
    "control",
  );
  const decoyVariables = await repositoryVariables(
    context.decoy,
    context.operatorGitHubToken,
    audit,
    "decoy",
  );
  requireNames(
    controlVariables,
    [
      "MONITORING_PUBKEY",
      "NODE_ROUTE_MAP",
      "OCTOC2_PROXY_CONTROL_FINGERPRINTS",
    ],
    audit,
    "Control repository variables",
  );
  requireNames(
    decoyVariables,
    ["FORWARD_ISSUE", "MONITORING_PUBKEY"],
    audit,
    "Decoy repository variables",
  );
  if (
    controlVariables?.get("MONITORING_PUBKEY") !==
    context.monitoringPublicKey
  ) {
    audit.fail(
      "Control MONITORING_PUBKEY does not match the declared operator key",
    );
  }
  if (
    decoyVariables?.get("MONITORING_PUBKEY") !==
    context.monitoringPublicKey
  ) {
    audit.fail(
      "Decoy MONITORING_PUBKEY does not match the declared operator key",
    );
  }
  const fingerprintRaw = controlVariables?.get(
    "OCTOC2_PROXY_CONTROL_FINGERPRINTS",
  );
  if (fingerprintRaw) {
    const parsed = parseJson(
      fingerprintRaw,
      audit,
      "OCTOC2_PROXY_CONTROL_FINGERPRINTS",
    );
    const expectedKeys =
      "relaySigningKeySha256,targetDispatchTokenSha256,version";
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).sort().join(",") !== expectedKeys ||
      parsed["version"] !== 1 ||
      typeof parsed["relaySigningKeySha256"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed["relaySigningKeySha256"]) ||
      typeof parsed["targetDispatchTokenSha256"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed["targetDispatchTokenSha256"])
    ) {
      audit.fail(
        "OCTOC2_PROXY_CONTROL_FINGERPRINTS has an invalid exact shape",
      );
    } else {
      const relayFingerprint = createHash("sha256")
        .update(context.relaySigningKey, "utf8")
        .digest("hex");
      const targetFingerprint = createHash("sha256")
        .update(context.targetDispatchToken, "utf8")
        .digest("hex");
      if (
        parsed["relaySigningKeySha256"] !== relayFingerprint ||
        parsed["targetDispatchTokenSha256"] !== targetFingerprint
      ) {
        audit.fail(
          "Control proxy credential fingerprints do not match the declared stable credentials",
        );
      }
    }
  }

  const routeRaw = controlVariables?.get("NODE_ROUTE_MAP");
  let route: Record<string, unknown> | null = null;
  if (routeRaw) {
    const routes = parseJson(routeRaw, audit, "NODE_ROUTE_MAP");
    const candidate = isRecord(routes)
      ? routes[context.beaconId]
      : undefined;
    if (isRecord(candidate)) {
      route = candidate;
    } else {
      audit.fail("NODE_ROUTE_MAP has no route for the enrolled E2E beacon");
    }
  }
  if (route) {
    const controlIssue = route["controlIssue"];
    const decoyIssue = route["decoyIssue"];
    const decoyRepository = route["decoyRepository"];
    if (
      !Number.isSafeInteger(controlIssue) ||
      (controlIssue as number) <= 0 ||
      !Number.isSafeInteger(decoyIssue) ||
      (decoyIssue as number) <= 0 ||
      decoyRepository !== `${context.decoy.owner}/${context.decoy.repo}`
    ) {
      audit.fail("NODE_ROUTE_MAP entry is invalid or targets another decoy");
    } else {
      if (
        decoyVariables?.get("FORWARD_ISSUE") !== String(decoyIssue)
      ) {
        audit.fail("Decoy FORWARD_ISSUE does not match NODE_ROUTE_MAP");
      }
      if (
        context.recoveryPolicy?.proxyRepos[0]?.decoyIssue !== decoyIssue
      ) {
        audit.fail(
          "Signed recovery decoyIssue does not match NODE_ROUTE_MAP",
        );
      }
      await Promise.all([
        validateIssue(
          context.control,
          controlIssue as number,
          context.operatorGitHubToken,
          audit,
          "control",
        ),
        validateIssue(
          context.decoy,
          decoyIssue as number,
          context.operatorGitHubToken,
          audit,
          "decoy",
        ),
      ]);
    }
  }
  if (audit.errors.length === errorsBefore) {
    audit.pass("Read-only GitHub topology/workflow/route checks completed");
  }
}

async function validateLocal(
  env: NodeJS.ProcessEnv,
  options: PreflightOptions,
  audit: Audit,
): Promise<LocalContext> {
  trueEnv(env, audit, "OCTOC2_E2E_AUTHORIZED");
  trueEnv(env, audit, "OCTOC2_E2E_CLEANUP_ACK");
  envValue(env, audit, "OCTOC2_E2E_CLEANUP_OWNER");
  const legacyErrorsBefore = audit.errors.length;
  for (const name of FORBIDDEN_BEACON_ENV) {
    if (env[name]?.trim()) {
      audit.fail(
        `${name} is forbidden: beacons must bootstrap with signed recovery leases`,
      );
    }
  }
  if (audit.errors.length === legacyErrorsBefore) {
    audit.pass("Legacy shared-PAT/App-key/static-proxy inputs are absent");
  }

  const beaconId = envValue(env, audit, "OCTOC2_E2E_BEACON_ID");
  if (beaconId && !UUID.test(beaconId)) {
    audit.fail("OCTOC2_E2E_BEACON_ID must be a full UUID");
  }
  const c2 = parseRepository(
    env,
    audit,
    "OCTOC2_REPO_OWNER",
    "OCTOC2_REPO_NAME",
  );
  const control = parseRepository(
    env,
    audit,
    "OCTOC2_PROXY_CONTROL_OWNER",
    "OCTOC2_PROXY_CONTROL_REPO",
  );
  const decoy = parseRepository(
    env,
    audit,
    "OCTOC2_PROXY_DECOY_OWNER",
    "OCTOC2_PROXY_DECOY_REPO",
  );
  const recovery = parseRepository(
    env,
    audit,
    "OCTOC2_RECOVERY_REPO_OWNER",
    "OCTOC2_RECOVERY_REPO_NAME",
  );
  const repositoriesDeclared = [c2, control, decoy, recovery].every(
    ({ owner, repo }) => Boolean(owner && repo),
  );
  if (
    c2.owner &&
    c2.repo &&
    control.owner &&
    control.repo &&
    repositoryKey(control) !== repositoryKey(c2)
  ) {
    audit.fail(
      "Current proxy control repository must be the isolated C2 repository",
    );
  }
  if (
    decoy.owner &&
    decoy.repo &&
    control.owner &&
    control.repo &&
    repositoryKey(decoy) === repositoryKey(control)
  ) {
    audit.fail("Proxy decoy and control repositories must be distinct");
  }
  if (
    recovery.owner &&
    recovery.repo &&
    control.owner &&
    control.repo &&
    decoy.owner &&
    decoy.repo &&
    (
      repositoryKey(recovery) === repositoryKey(control) ||
      repositoryKey(recovery) === repositoryKey(decoy)
    )
  ) {
    audit.fail(
      "Public recovery repository must be dedicated and distinct from C2/proxy repos",
    );
  }
  if (
    repositoriesDeclared &&
    repositoryKey(control) === repositoryKey(c2) &&
    repositoryKey(decoy) !== repositoryKey(control) &&
    repositoryKey(recovery) !== repositoryKey(control) &&
    repositoryKey(recovery) !== repositoryKey(decoy)
  ) {
    audit.pass("Repository topology separates control, decoy, and recovery roles");
  }

  const serverGitHubToken = envValue(
    env,
    audit,
    "OCTOC2_SERVER_GITHUB_TOKEN",
  );
  const operatorGitHubToken = envValue(
    env,
    audit,
    "OCTOC2_OPERATOR_GITHUB_TOKEN",
  );
  const operatorApiToken = envValue(
    env,
    audit,
    "OCTOC2_OPERATOR_API_TOKEN",
  );
  const beaconApiToken = envValue(
    env,
    audit,
    "OCTOC2_BEACON_API_TOKEN",
  );
  const recoveryWriteToken = envValue(
    env,
    audit,
    "OCTOC2_RECOVERY_WRITE_TOKEN",
  );
  const controlDispatchToken = envValue(
    env,
    audit,
    "OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN",
  );
  const targetDispatchToken = envValue(
    env,
    audit,
    "OCTOC2_PROXY_TARGET_DISPATCH_TOKEN",
  );
  validateCredentialSeparation({
    OCTOC2_SERVER_GITHUB_TOKEN: serverGitHubToken,
    OCTOC2_OPERATOR_GITHUB_TOKEN: operatorGitHubToken,
    OCTOC2_OPERATOR_API_TOKEN: operatorApiToken,
    OCTOC2_BEACON_API_TOKEN: beaconApiToken,
    OCTOC2_RECOVERY_WRITE_TOKEN: recoveryWriteToken,
    OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN: controlDispatchToken,
    OCTOC2_PROXY_TARGET_DISPATCH_TOKEN: targetDispatchToken,
  }, audit);

  const relaySigningKey = envValue(
    env,
    audit,
    "OCTOC2_PROXY_RELAY_SIGNING_KEY",
  );
  if (relaySigningKey && relaySigningKey.length < 32) {
    audit.fail("OCTOC2_PROXY_RELAY_SIGNING_KEY must have at least 32 characters");
  }
  if (
    relaySigningKey &&
    Object.values({
      serverGitHubToken,
      operatorGitHubToken,
      operatorApiToken,
      beaconApiToken,
      recoveryWriteToken,
      controlDispatchToken,
      targetDispatchToken,
    }).includes(relaySigningKey)
  ) {
    audit.fail("Proxy relay signing key must not reuse a credential value");
  }

  const operatorSecret = envValue(env, audit, "OCTOC2_OPERATOR_SECRET");
  const operatorSecretKey = await decodeKey(
    operatorSecret,
    32,
    audit,
    "OCTOC2_OPERATOR_SECRET",
  );
  const monitoringPublicKey = envValue(
    env,
    audit,
    "MONITORING_PUBKEY",
  );
  const monitoringPublicKeyBytes = await decodeKey(
    monitoringPublicKey,
    32,
    audit,
    "MONITORING_PUBKEY",
  );
  if (operatorSecretKey && monitoringPublicKeyBytes) {
    const derived = deriveRawPublicKey(
      operatorSecretKey,
      X25519_PKCS8_PREFIX,
    );
    if (!derived?.equals(Buffer.from(monitoringPublicKeyBytes))) {
      audit.fail("MONITORING_PUBKEY does not derive from OCTOC2_OPERATOR_SECRET");
    } else {
      audit.pass("Operator X25519 secret and monitoring public key are paired");
    }
  }

  await validateEnrollmentDirectory(env, audit);
  const enrollment = await validateEnrollment(env, beaconId, audit);
  parseBeaconTokenMap(
    envValue(env, audit, "OCTOC2_BEACON_API_TOKENS"),
    beaconId,
    beaconApiToken,
    audit,
  );
  trueEnv(env, audit, "OCTOC2_RECOVERY_PUBLISH_ENABLED");
  const appIdRaw = envValue(env, audit, "OCTOC2_GITHUB_APP_ID");
  const appId = Number(appIdRaw);
  if (appIdRaw && (!Number.isSafeInteger(appId) || appId <= 0)) {
    audit.fail("OCTOC2_GITHUB_APP_ID must be a positive safe integer");
  }
  const recoveryRef = envValue(env, audit, "OCTOC2_RECOVERY_REPO_REF");
  if (
    recoveryRef &&
    (
      recoveryRef.startsWith("/") ||
      recoveryRef.endsWith("/") ||
      recoveryRef.includes("..") ||
      recoveryRef.includes("\\") ||
      !/^[A-Za-z0-9_./-]+$/.test(recoveryRef)
    )
  ) {
    audit.fail("OCTOC2_RECOVERY_REPO_REF is invalid");
  }
  const appPolicy = parseAppPolicy(
    envValue(env, audit, "OCTOC2_GITHUB_APP_POLICIES"),
    beaconId,
    c2,
    decoy,
    audit,
  );
  const recoveryPolicy = parseRecoveryPolicy(
    envValue(env, audit, "OCTOC2_RECOVERY_POLICIES"),
    beaconId,
    beaconApiToken,
    monitoringPublicKey,
    decoy,
    options,
    audit,
  );
  validatePolicyPermissions(appPolicy, recoveryPolicy, audit);
  const { appPem, signingSecret } = await validateRecoveryKeys(env, audit);
  await validateBeaconBinary(
    env,
    [
      serverGitHubToken,
      operatorGitHubToken,
      operatorApiToken,
      beaconApiToken,
      recoveryWriteToken,
      controlDispatchToken,
      targetDispatchToken,
      relaySigningKey,
      operatorSecret,
      appPem,
      signingSecret,
      ...FORBIDDEN_BEACON_ENV.map((name) => env[name]?.trim() ?? ""),
    ],
    audit,
  );
  await validateHttpListener(env, options, recoveryPolicy, audit);
  await validateMtls(env, options, audit);

  return {
    beaconId,
    c2,
    control,
    decoy,
    recovery,
    serverGitHubToken,
    operatorGitHubToken,
    operatorApiToken,
    beaconApiToken,
    recoveryWriteToken,
    controlDispatchToken,
    targetDispatchToken,
    relaySigningKey,
    monitoringPublicKey,
    enrollment,
    appPolicy,
    recoveryPolicy,
  };
}

export async function runPreflight(
  env: NodeJS.ProcessEnv,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const audit = new Audit();
  const context = await validateLocal(env, options, audit);
  if (options.checkGitHub && !options.dryRun && audit.errors.length === 0) {
    await validateGitHubState(context, audit);
  } else if (!options.checkGitHub) {
    audit.warn(
      "GitHub was not queried; repository visibility, workflows, secrets, variables, and routes remain unchecked",
    );
  }
  audit.warn(
    "Preflight only: no controller/beacon was started and live E2E remains unverified",
  );
  return {
    ok: audit.errors.length === 0,
    scope:
      options.checkGitHub && !options.dryRun
        ? "github"
        : "local",
    checks: audit.checks,
    warnings: audit.warnings,
    errors: audit.errors,
    liveExecutionPerformed: false,
  };
}

function printReport(report: PreflightReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("\nOctoC2 secure live-E2E prerequisite gate\n");
  for (const check of report.checks) {
    console.log(`  PASS  ${check}`);
  }
  for (const warning of report.warnings) {
    console.log(`  WARN  ${warning}`);
  }
  for (const error of report.errors) {
    console.error(`  FAIL  ${error}`);
  }
  console.log("");
  if (report.ok) {
    console.log(
      "Preflight passed. This is prerequisite evidence only; live E2E is still unverified.",
    );
  } else {
    console.error(
      `Preflight failed with ${report.errors.length} prerequisite error(s).`,
    );
  }
}

if (import.meta.main) {
  try {
    const parsed = parseOptions(process.argv.slice(2));
    if (parsed === "help") {
      console.log(usage());
    } else {
      const report = await runPreflight(process.env, parsed);
      printReport(report, parsed.json);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
