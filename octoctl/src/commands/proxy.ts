/**
 * OctoProxy provisioning and local configuration helpers.
 *
 * The relay is deliberately split across a decoy repository and a control
 * repository. Cross-repository dispatch credentials remain GitHub Actions
 * secrets; beacons receive repository-bound short-lived leases only through
 * signed recovery records.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { decodeBase64Url } from "@octoc2/shared";
import { encryptGitHubSecret } from "../lib/crypto.ts";
import { getBeacon } from "../lib/registry.ts";
import {
  PROXY_WORKFLOW_TEMPLATES,
  TEMPLATE_FORWARD_REPLIES,
  TEMPLATE_HELPER,
  TEMPLATE_PROCESS_CHECKIN,
  TEMPLATE_SYNC_HELPER,
} from "./proxyTemplates.ts";

export type InnerKind = "issues";

/** Non-secret proxy route. Runtime credentials arrive in signed recovery. */
export interface ProxyConfig {
  owner: string;
  repo: string;
  innerKind: InnerKind;
  decoyIssue: number;
}

export interface ProxyCreateOptions {
  owner: string;
  repo: string;
  innerKind: InnerKind | string;
}

export interface ProxyRotateOptions {
  beaconId: string;
  newProxyRepos: string;
}

export interface ProxyProvisionOptions {
  decoyOwner: string;
  decoyRepo: string;
  beaconId: string;
  controlDispatchToken: string;
  targetDispatchToken: string;
  relaySigningKey: string;
  ctrlOwner: string;
  ctrlRepo: string;
  proxyInstallationId: number;
  innerKind?: InnerKind;
  issueTitle?: string;
  createRepo?: boolean;
  scaffold?: boolean;
  dataDir?: string;
  /** Test-only dependency injection. */
  _octokit?: unknown;
}

interface RepositoryRef {
  owner: string;
  repo: string;
}

type RouteMap = Record<
  string,
  {
    controlIssue: number;
    decoyRepository: string;
    decoyIssue: number;
  }
>;

const VALID_INNER_KINDS: ReadonlySet<string> = new Set(["issues"]);
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const CONTROL_CREDENTIAL_FINGERPRINTS =
  "OCTOC2_PROXY_CONTROL_FINGERPRINTS";

function assertInnerKind(value: string): asserts value is InnerKind {
  if (!VALID_INNER_KINDS.has(value)) {
    throw new Error(
      `--inner-kind must be 'issues', got '${value}'`,
    );
  }
}

function assertRepository(ref: RepositoryRef, name: string): void {
  if (!REPO_SEGMENT.test(ref.owner) || !REPO_SEGMENT.test(ref.repo)) {
    throw new Error(`${name} must contain a valid GitHub owner and repository`);
  }
}

function repositoryKey(ref: RepositoryRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

function parseProxyRouteArray(
  parsed: unknown,
  sourceName: string,
): ProxyConfig[] {
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${sourceName} must be an array of proxy route objects, got ${typeof parsed}`,
    );
  }
  if (parsed.length > 1) {
    throw new Error(
      `${sourceName} supports at most one proxy route per beacon`,
    );
  }

  const routes: ProxyConfig[] = [];
  const seen = new Set<string>();
  for (const [index, value] of parsed.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${sourceName}[${index}] must be an object`);
    }
    const route = value as Record<string, unknown>;
    if (
      typeof route.owner !== "string" ||
      typeof route.repo !== "string" ||
      typeof route.innerKind !== "string" ||
      !Number.isSafeInteger(route.decoyIssue) ||
      (route.decoyIssue as number) <= 0
    ) {
      throw new Error(
        `${sourceName}[${index}] requires owner, repo, innerKind, and a positive decoyIssue`,
      );
    }
    assertInnerKind(route.innerKind);
    const candidate: ProxyConfig = {
      owner: route.owner,
      repo: route.repo,
      innerKind: route.innerKind,
      decoyIssue: route.decoyIssue as number,
    };
    assertRepository(candidate, `${sourceName}[${index}]`);
    for (const forbidden of [
      "token",
      "appConfig",
      "githubTokenLease",
      "tokenLease",
    ]) {
      if (forbidden in route) {
        throw new Error(
          `${sourceName}[${index}] must not contain credential field '${forbidden}'`,
        );
      }
    }
    const key = repositoryKey(candidate);
    if (seen.has(key)) {
      throw new Error(`Duplicate proxy repository ${candidate.owner}/${candidate.repo}`);
    }
    seen.add(key);
    routes.push(candidate);
  }
  return routes;
}

function parseProxyRoutes(raw: string): ProxyConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON for newProxyRepos: ${raw}`);
  }
  return parseProxyRouteArray(parsed, "newProxyRepos");
}

function parseRecoveryProxyRoutes(
  raw: string,
): Array<{ beaconId: string; routes: ProxyConfig[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OCTOC2_RECOVERY_POLICIES must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OCTOC2_RECOVERY_POLICIES must be a JSON object");
  }

  return Object.entries(parsed)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([beaconId, value]) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Recovery policy for ${beaconId} must be an object`);
      }
      const policy = value as Record<string, unknown>;
      return {
        beaconId,
        routes: parseProxyRouteArray(
          policy["proxyRepos"] ?? [],
          `OCTOC2_RECOVERY_POLICIES.${beaconId}.proxyRepos`,
        ),
      };
    });
}

async function upsertVariable(
  octokit: Octokit,
  repository: RepositoryRef,
  name: string,
  value: string,
): Promise<void> {
  try {
    await octokit.rest.actions.createRepoVariable({
      ...repository,
      name,
      value,
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    await octokit.rest.actions.updateRepoVariable({
      ...repository,
      name,
      value,
    });
  }
}

async function readOptionalVariable(
  octokit: Octokit,
  repository: RepositoryRef,
  name: string,
): Promise<string | null> {
  try {
    const response = await octokit.rest.actions.getRepoVariable({
      ...repository,
      name,
    });
    return response.data.value;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

async function readRequiredMonitoringKey(
  octokit: Octokit,
  repository: RepositoryRef,
): Promise<string> {
  const value = (await readOptionalVariable(
    octokit,
    repository,
    "MONITORING_PUBKEY",
  ))?.trim();
  if (!value) {
    throw new Error(
      `${repository.owner}/${repository.repo} MONITORING_PUBKEY is required`,
    );
  }
  return value;
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ControlCredentialFingerprints {
  version: 1;
  relaySigningKeySha256: string;
  targetDispatchTokenSha256: string;
}

function parseControlCredentialFingerprints(
  raw: string,
  repository: RepositoryRef,
): ControlCredentialFingerprints {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${repository.owner}/${repository.repo} ${CONTROL_CREDENTIAL_FINGERPRINTS} is not valid JSON`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `${repository.owner}/${repository.repo} ${CONTROL_CREDENTIAL_FINGERPRINTS} must be an object`,
    );
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
      "relaySigningKeySha256,targetDispatchTokenSha256,version" ||
    value["version"] !== 1 ||
    typeof value["relaySigningKeySha256"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value["relaySigningKeySha256"]) ||
    typeof value["targetDispatchTokenSha256"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value["targetDispatchTokenSha256"])
  ) {
    throw new Error(
      `${repository.owner}/${repository.repo} ${CONTROL_CREDENTIAL_FINGERPRINTS} is invalid`,
    );
  }
  return {
    version: 1,
    relaySigningKeySha256: value["relaySigningKeySha256"],
    targetDispatchTokenSha256: value["targetDispatchTokenSha256"],
  };
}

async function setSecrets(
  octokit: Octokit,
  repository: RepositoryRef,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await octokit.rest.actions.getRepoPublicKey({
    ...repository,
  });
  for (const [name, value] of Object.entries(secrets)) {
    if (value.trim().length === 0) {
      throw new Error(`Secret ${name} must not be empty`);
    }
    const encryptedValue = await encryptGitHubSecret(
      value,
      response.data.key,
    );
    await octokit.rest.actions.createOrUpdateRepoSecret({
      ...repository,
      secret_name: name,
      encrypted_value: encryptedValue,
      key_id: response.data.key_id,
    });
  }
}

async function readRouteMap(
  octokit: Octokit,
  repository: RepositoryRef,
): Promise<RouteMap> {
  let raw: string;
  try {
    const response = await octokit.rest.actions.getRepoVariable({
      ...repository,
      name: "NODE_ROUTE_MAP",
    });
    raw = response.data.value;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${repository.owner}/${repository.repo} NODE_ROUTE_MAP is not valid JSON`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${repository.owner}/${repository.repo} NODE_ROUTE_MAP must be an object`,
    );
  }
  return parsed as RouteMap;
}

/** Print all four canonical workflow templates and their repository placement. */
export async function proxyCreate(
  opts: ProxyCreateOptions,
  print: (line: string) => void = console.log,
): Promise<void> {
  assertInnerKind(opts.innerKind);
  const sep = "-".repeat(72);
  print("");
  print(`OctoProxy workflows for ${opts.owner}/${opts.repo}`);
  print(`inner-kind: ${opts.innerKind}`);
  print("Use two distinct repositories; same-repository runs are not E2E proof.");
  print("");

  for (const template of PROXY_WORKFLOW_TEMPLATES) {
    print(sep);
    print(
      `${template.repository}: .github/workflows/${template.filename}`,
    );
    print(sep);
    print(template.content);
  }

  print(sep);
  print("Decoy repository:");
  print("  workflows: helper.yml, sync-helper.yml");
  print("  secrets: CONTROL_TOKEN, CONTROL_OWNER, CONTROL_REPO, NODE_ID, RELAY_SIGNING_KEY");
  print("  variables: FORWARD_ISSUE, MONITORING_PUBKEY");
  print("  App lease permissions: metadata:read, issues:write, variables:read");
  print("Control repository:");
  print("  workflows: process-checkin.yml, forward-replies.yml");
  print("  secrets: TARGET_TOKEN, RELAY_SIGNING_KEY");
  print(
    `  variables: NODE_ROUTE_MAP, ${CONTROL_CREDENTIAL_FINGERPRINTS}`,
  );
  print("");
}

/** Show proxy route metadata from the server's signed-recovery policy source. */
export async function proxyList(
  print: (line: string) => void = console.log,
): Promise<void> {
  const raw = process.env.OCTOC2_RECOVERY_POLICIES;
  print("");
  print("Proxy routes from OCTOC2_RECOVERY_POLICIES");
  print("(credentials are minted separately and delivered only in signed recovery records)");
  print("");
  if (!raw) {
    print("  (none configured)");
    return;
  }

  let policies: Array<{ beaconId: string; routes: ProxyConfig[] }>;
  try {
    policies = parseRecoveryProxyRoutes(raw);
  } catch (error) {
    print(`  Error: ${(error as Error).message}`);
    return;
  }
  if (policies.every(({ routes }) => routes.length === 0)) {
    print("  (none configured)");
    return;
  }
  for (const { beaconId, routes } of policies) {
    if (routes.length === 0) continue;
    print(`  ${beaconId}:`);
    for (const [index, route] of routes.entries()) {
      print(
        `    ${index + 1}. ${route.owner}/${route.repo}  ` +
          `inner-kind: ${route.innerKind}  issue: ${route.decoyIssue}`,
      );
    }
  }
  print("");
}

/**
 * Print the policy fragment required for a signed recovery rotation.
 * A raw, unsigned proxy-rotate dead-drop is intentionally not emitted.
 */
export async function proxyRotate(
  opts: ProxyRotateOptions,
  print: (line: string) => void = console.log,
): Promise<void> {
  const routes = parseProxyRoutes(opts.newProxyRepos);
  print("");
  print(`Proxy recovery-policy update for beacon ${opts.beaconId}`);
  print(JSON.stringify({ [opts.beaconId]: { proxyRepos: routes } }, null, 2));
  print("");
  print(
    "Merge this fragment into OCTOC2_RECOVERY_POLICIES and add matching " +
      "repository-bound entries to OCTOC2_GITHUB_APP_POLICIES.",
  );
  print(
    "The server will mint short-lived leases and publish the next signed, sealed recovery record.",
  );
  print("");
}

/**
 * Provision the two-repository relay contract without placing persistent
 * GitHub credentials or App private keys in beacon configuration.
 */
export async function proxyProvision(
  opts: ProxyProvisionOptions,
  print: (line: string) => void = console.log,
): Promise<void> {
  const decoy = { owner: opts.decoyOwner, repo: opts.decoyRepo };
  const control = { owner: opts.ctrlOwner, repo: opts.ctrlRepo };
  assertRepository(decoy, "decoy repository");
  assertRepository(control, "control repository");
  if (repositoryKey(decoy) === repositoryKey(control)) {
    throw new Error("Decoy and control repositories must be distinct");
  }
  const innerKind = opts.innerKind ?? "issues";
  assertInnerKind(innerKind);
  if (
    !Number.isSafeInteger(opts.proxyInstallationId) ||
    opts.proxyInstallationId <= 0
  ) {
    throw new Error("proxyInstallationId must be a positive safe integer");
  }
  if (opts.controlDispatchToken.trim().length === 0) {
    throw new Error("A control-repository dispatch credential is required");
  }
  if (opts.targetDispatchToken.trim().length === 0) {
    throw new Error(
      "A stable control egress credential authorized for every decoy repository is required",
    );
  }
  if (opts.controlDispatchToken === opts.targetDispatchToken) {
    throw new Error(
      "Control and decoy dispatch credentials must be distinct and repository-scoped",
    );
  }
  if (opts.relaySigningKey.trim().length < 32) {
    throw new Error("Relay signing key must contain at least 32 characters");
  }

  const dataDir = opts.dataDir ?? process.env["OCTOC2_DATA_DIR"] ?? "./data";
  const beacon = await getBeacon(opts.beaconId, dataDir);
  if (!beacon) {
    throw new Error(`Beacon not found: no beacon matching '${opts.beaconId}'`);
  }
  if (!Number.isSafeInteger(beacon.issueNumber) || beacon.issueNumber <= 0) {
    throw new Error(
      `Beacon ${beacon.beaconId} has no control issue for proxy routing`,
    );
  }

  let octokit: Octokit;
  if (opts._octokit) {
    octokit = opts._octokit as Octokit;
  } else {
    const token = process.env["OCTOC2_OPERATOR_GITHUB_TOKEN"];
    if (!token) {
      throw new Error(
        "OCTOC2_OPERATOR_GITHUB_TOKEN is required to provision repositories",
      );
    }
    octokit = new Octokit({
      auth: token,
      headers: {
        "user-agent": "OctoC2-Operator/0.1",
      },
    });
  }

  const routeMap = await readRouteMap(octokit, control);
  const existingRoute = routeMap[beacon.beaconId];
  if (existingRoute) {
    if (typeof existingRoute.decoyRepository !== "string") {
      throw new Error(
        `Beacon ${beacon.beaconId} has an invalid existing proxy route`,
      );
    }
    if (
      existingRoute.decoyRepository.toLowerCase() !== repositoryKey(decoy)
    ) {
      throw new Error(
        `Beacon ${beacon.beaconId} already has a proxy route to ` +
          existingRoute.decoyRepository,
      );
    }
  }
  const expectedFingerprints: ControlCredentialFingerprints = {
    version: 1,
    relaySigningKeySha256: credentialFingerprint(opts.relaySigningKey),
    targetDispatchTokenSha256:
      credentialFingerprint(opts.targetDispatchToken),
  };
  const storedFingerprintRaw = await readOptionalVariable(
    octokit,
    control,
    CONTROL_CREDENTIAL_FINGERPRINTS,
  );
  if (storedFingerprintRaw === null && Object.keys(routeMap).length > 0) {
    throw new Error(
      `${control.owner}/${control.repo} already has proxy routes but no ` +
        `${CONTROL_CREDENTIAL_FINGERPRINTS}; rotate the control credentials ` +
        "explicitly before adding another route",
    );
  }
  if (storedFingerprintRaw !== null) {
    const stored = parseControlCredentialFingerprints(
      storedFingerprintRaw,
      control,
    );
    if (
      stored.relaySigningKeySha256 !==
        expectedFingerprints.relaySigningKeySha256 ||
      stored.targetDispatchTokenSha256 !==
        expectedFingerprints.targetDispatchTokenSha256
    ) {
      throw new Error(
        `${control.owner}/${control.repo} proxy control credentials differ ` +
          "from the stable credentials used by existing routes",
      );
    }
  }
  const monitoringPublicKey = await readRequiredMonitoringKey(
    octokit,
    control,
  );
  let monitoringKeyBytes: Uint8Array;
  try {
    monitoringKeyBytes = await decodeBase64Url(monitoringPublicKey);
  } catch {
    throw new Error("MONITORING_PUBKEY must be valid base64url");
  }
  if (monitoringKeyBytes.length !== 32) {
    throw new Error("MONITORING_PUBKEY must decode to 32 bytes");
  }

  if (opts.createRepo) {
    await octokit.rest.repos.createForAuthenticatedUser({
      name: decoy.repo,
      private: true,
      description: "Infrastructure utilities and helper scripts",
      auto_init: false,
    });
  }

  if (opts.scaffold) {
    await octokit.rest.repos.createOrUpdateFileContents({
      ...decoy,
      path: "README.md",
      message: "Initial scaffold",
      content: Buffer.from(
        `# ${decoy.repo}\n\nInternal infrastructure tooling.\n`,
      ).toString("base64"),
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      ...decoy,
      path: ".gitignore",
      message: "Add .gitignore",
      content: Buffer.from("node_modules/\n.env\n*.log\ndist/\n").toString(
        "base64",
      ),
    });
  }

  const issue = await octokit.rest.issues.create({
    ...decoy,
    title:
      opts.issueTitle ?? "Dependency audit: review pinned versions",
    body: "Track progress on quarterly dependency review.",
  });
  const decoyIssue = issue.data.number;

  for (const template of [
    {
      repository: decoy,
      filename: "helper.yml",
      content: TEMPLATE_HELPER,
    },
    {
      repository: decoy,
      filename: "sync-helper.yml",
      content: TEMPLATE_SYNC_HELPER,
    },
    {
      repository: control,
      filename: "process-checkin.yml",
      content: TEMPLATE_PROCESS_CHECKIN,
    },
    {
      repository: control,
      filename: "forward-replies.yml",
      content: TEMPLATE_FORWARD_REPLIES,
    },
  ] as const) {
    await octokit.rest.repos.createOrUpdateFileContents({
      ...template.repository,
      path: `.github/workflows/${template.filename}`,
      message: `Install OctoProxy ${template.filename}`,
      content: Buffer.from(template.content).toString("base64"),
    });
  }

  await setSecrets(octokit, decoy, {
    CONTROL_TOKEN: opts.controlDispatchToken,
    CONTROL_OWNER: control.owner,
    CONTROL_REPO: control.repo,
    NODE_ID: beacon.beaconId,
    RELAY_SIGNING_KEY: opts.relaySigningKey,
  });
  await setSecrets(octokit, control, {
    TARGET_TOKEN: opts.targetDispatchToken,
    RELAY_SIGNING_KEY: opts.relaySigningKey,
  });

  await upsertVariable(octokit, decoy, "FORWARD_ISSUE", String(decoyIssue));
  await upsertVariable(
    octokit,
    decoy,
    "MONITORING_PUBKEY",
    monitoringPublicKey,
  );
  routeMap[beacon.beaconId] = {
    controlIssue: beacon.issueNumber,
    decoyRepository: `${decoy.owner}/${decoy.repo}`,
    decoyIssue,
  };
  await upsertVariable(
    octokit,
    control,
    "NODE_ROUTE_MAP",
    JSON.stringify(routeMap),
  );
  await upsertVariable(
    octokit,
    control,
    CONTROL_CREDENTIAL_FINGERPRINTS,
    JSON.stringify(expectedFingerprints),
  );

  const recordDir = join(dataDir, "proxies", beacon.beaconId);
  await mkdir(recordDir, { recursive: true });
  const recordPath = join(
    recordDir,
    `${decoy.owner}--${decoy.repo}.json`,
  );
  await writeFile(
    recordPath,
    JSON.stringify(
      {
        beaconId: beacon.beaconId,
        controlRepository: `${control.owner}/${control.repo}`,
        controlIssue: beacon.issueNumber,
        decoyOwner: decoy.owner,
        decoyRepo: decoy.repo,
        decoyIssue,
        innerKind,
        proxyInstallationId: opts.proxyInstallationId,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const requiredPermission = {
    metadata: "read",
    issues: "write",
    variables: "read",
  };
  print(
    `Proxy relay configured: ${decoy.owner}/${decoy.repo} <-> ` +
      `${control.owner}/${control.repo}`,
  );
  print("");
  print("Merge into OCTOC2_RECOVERY_POLICIES:");
  print(
    JSON.stringify(
      {
        [beacon.beaconId]: {
          proxyRepos: [
            {
              owner: decoy.owner,
              repo: decoy.repo,
              innerKind,
              decoyIssue,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  print("");
  print("Merge into OCTOC2_GITHUB_APP_POLICIES:");
  print(
    JSON.stringify(
      {
        [beacon.beaconId]: {
          proxyRepositories: [
            {
              installationId: opts.proxyInstallationId,
              repository: decoy,
              permissions: requiredPermission,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  print("");
  print(
    "No static proxy token or GitHub App private key was written to beacon configuration.",
  );
}
