import {
  GITHUB_TOKEN_LEASE_VERSION,
  assertGitHubTokenLease,
  type GitHubRepositoryPermission,
  type GitHubTokenLease,
} from "@octoc2/shared";
import { createPrivateKey, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_RENEWAL_LEAD_MS = 10 * 60 * 1000;
const MAX_INSTALLATION_TOKEN_TTL_MS = 65 * 60 * 1000;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BeaconInstallationTokenPolicy {
  installationId: number;
  repository: {
    owner: string;
    repo: string;
  };
  permissions: Readonly<Record<string, GitHubRepositoryPermission>>;
  proxyRepositories?: readonly RepositoryInstallationTokenPolicy[];
}

export interface RepositoryInstallationTokenPolicy {
  installationId: number;
  repository: {
    owner: string;
    repo: string;
  };
  permissions: Readonly<Record<string, GitHubRepositoryPermission>>;
}

export interface GitHubInstallationTokenServiceOptions {
  appId: number;
  appPrivateKeyPem: string;
  policies: Readonly<Record<string, BeaconInstallationTokenPolicy>>;
  apiBase?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  renewalLeadMs?: number;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/**
 * Recovery leases use the channel-facing `variables` permission name shared by
 * the implant and server contracts. GitHub's installation-token endpoint calls
 * the same repository permission `actions_variables`, so translate only at the
 * API boundary and keep the signed lease contract stable.
 */
function githubApiPermissions(
  permissions: Readonly<Record<string, GitHubRepositoryPermission>>,
): Record<string, GitHubRepositoryPermission> {
  return Object.fromEntries(
    Object.entries(permissions).map(([permission, access]) => [
      permission === "variables" ? "actions_variables" : permission,
      access,
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateRepositorySegment(value: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
}

function validateRepositoryPolicy(
  policy: RepositoryInstallationTokenPolicy,
  name: string,
): void {
  validatePositiveInteger(policy.installationId, `${name}.installationId`);
  validateRepositorySegment(
    policy.repository.owner,
    `${name}.repository.owner`,
  );
  validateRepositorySegment(
    policy.repository.repo,
    `${name}.repository.repo`,
  );
  const permissionEntries = Object.entries(policy.permissions);
  if (permissionEntries.length === 0) {
    throw new Error(`${name}.permissions must not be empty`);
  }
  for (const [permission, access] of permissionEntries) {
    if (!/^[a-z][a-z_]*$/.test(permission)) {
      throw new Error(`Invalid GitHub permission '${permission}'`);
    }
    if (access !== "read" && access !== "write") {
      throw new Error(
        `GitHub permission '${permission}' must be read or write`,
      );
    }
  }
}

function repositoryKey(repository: { owner: string; repo: string }): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

function validatePolicy(
  beaconId: string,
  policy: BeaconInstallationTokenPolicy,
): void {
  if (beaconId.trim().length === 0) {
    throw new Error("Beacon policy IDs must not be empty");
  }
  validateRepositoryPolicy(policy, "primary");
  if ((policy.proxyRepositories?.length ?? 0) > 1) {
    throw new Error("At most one proxy repository may be configured per beacon");
  }
  const repositories = new Set([repositoryKey(policy.repository)]);
  for (const [index, proxy] of (
    policy.proxyRepositories ?? []
  ).entries()) {
    validateRepositoryPolicy(proxy, `proxyRepositories[${index}]`);
    const key = repositoryKey(proxy.repository);
    if (repositories.has(key)) {
      throw new Error("GitHub installation-token repositories must be unique");
    }
    repositories.add(key);
  }
}

function parseRepositoryPolicy(
  value: unknown,
  name: string,
): RepositoryInstallationTokenPolicy {
  if (!isRecord(value) || !isRecord(value["repository"])) {
    throw new Error(`${name} must be an object`);
  }
  if (
    typeof value["installationId"] !== "number" ||
    typeof value["repository"]["owner"] !== "string" ||
    typeof value["repository"]["repo"] !== "string"
  ) {
    throw new Error(
      `${name} must contain a numeric installationId and string repository coordinates`,
    );
  }
  const permissions = value["permissions"];
  if (!isRecord(permissions)) {
    throw new Error(`${name}.permissions must be an object`);
  }
  return {
    installationId: value["installationId"],
    repository: {
      owner: value["repository"]["owner"],
      repo: value["repository"]["repo"],
    },
    permissions: permissions as Record<string, GitHubRepositoryPermission>,
  };
}

export function parseGitHubInstallationPolicies(
  raw: string,
): Record<string, BeaconInstallationTokenPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OCTOC2_GITHUB_APP_POLICIES must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("OCTOC2_GITHUB_APP_POLICIES must be a JSON object");
  }

  const policies: Record<string, BeaconInstallationTokenPolicy> = {};
  for (const [beaconId, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new Error(`GitHub App policy for ${beaconId} must be an object`);
    }
    const primary = parseRepositoryPolicy(
      value,
      `GitHub App policy for ${beaconId}`,
    );
    const proxyRepositoriesRaw = value["proxyRepositories"] ?? [];
    if (!Array.isArray(proxyRepositoriesRaw)) {
      throw new Error(
        `GitHub App proxyRepositories for ${beaconId} must be an array`,
      );
    }
    if (proxyRepositoriesRaw.length > 1) {
      throw new Error(
        `GitHub App proxyRepositories for ${beaconId} supports at most one entry`,
      );
    }
    const proxyRepositories = proxyRepositoriesRaw.map((proxy, index) =>
      parseRepositoryPolicy(
        proxy,
        `GitHub App proxyRepositories[${index}] for ${beaconId}`,
      ));
    const policy: BeaconInstallationTokenPolicy = {
      ...primary,
      ...(proxyRepositories.length > 0 && { proxyRepositories }),
    };
    try {
      validatePolicy(beaconId, policy);
    } catch (error) {
      throw new Error(
        `Invalid GitHub App policy for ${beaconId}: ${(error as Error).message}`,
      );
    }
    policies[beaconId] = {
      installationId: policy.installationId,
      repository: { ...policy.repository },
      permissions: { ...policy.permissions },
      ...((policy.proxyRepositories?.length ?? 0) > 0 && {
        proxyRepositories: policy.proxyRepositories!.map((proxy) => ({
          installationId: proxy.installationId,
          repository: { ...proxy.repository },
          permissions: { ...proxy.permissions },
        })),
      }),
    };
  }
  return policies;
}

/**
 * Server-only GitHub App token minter.
 *
 * The App private key never crosses this service boundary. Callers identify a
 * preconfigured beacon policy; they cannot request arbitrary repositories or
 * broaden permissions at runtime.
 */
export class GitHubInstallationTokenService {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly renewalLeadMs: number;

  constructor(
    private readonly options: GitHubInstallationTokenServiceOptions,
  ) {
    validatePositiveInteger(options.appId, "appId");
    if (options.appPrivateKeyPem.trim().length === 0) {
      throw new Error("GitHub App private key is required");
    }
    // Parse once at construction so malformed key material fails startup.
    createPrivateKey(options.appPrivateKeyPem);
    for (const [beaconId, policy] of Object.entries(options.policies)) {
      validatePolicy(beaconId, policy);
    }
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.renewalLeadMs =
      options.renewalLeadMs ?? DEFAULT_RENEWAL_LEAD_MS;
    if (
      !Number.isSafeInteger(this.renewalLeadMs) ||
      this.renewalLeadMs <= 0
    ) {
      throw new Error("renewalLeadMs must be a positive safe integer");
    }
  }

  async mintLease(
    beaconId: string,
    repository?: { owner: string; repo: string },
  ): Promise<GitHubTokenLease> {
    const policy = this.options.policies[beaconId];
    if (!policy) {
      throw new Error(`No GitHub installation-token policy for beacon ${beaconId}`);
    }
    const tokenPolicy: RepositoryInstallationTokenPolicy = repository
      ? (policy.proxyRepositories ?? []).find(
          (candidate) =>
            repositoryKey(candidate.repository) === repositoryKey(repository),
        ) ?? (() => {
          throw new Error(
            `No GitHub installation-token policy for beacon ${beaconId} ` +
            `repository ${repository.owner}/${repository.repo}`,
          );
        })()
      : policy;
    const issuedAtDate = this.now();
    const jwt = await this.signAppJwt(issuedAtDate);
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${tokenPolicy.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "OctoC2-Server/0.1",
        },
        body: JSON.stringify({
          repositories: [tokenPolicy.repository.repo],
          permissions: githubApiPermissions(tokenPolicy.permissions),
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      throw new Error(
        `GitHub installation token exchange failed (${response.status}): ${body}`,
      );
    }
    const result = await response.json() as InstallationTokenResponse;
    if (
      typeof result.token !== "string" ||
      result.token.trim().length === 0 ||
      typeof result.expires_at !== "string"
    ) {
      throw new Error("GitHub returned an invalid installation token response");
    }
    const expiresAtDate = new Date(result.expires_at);
    const ttlMs = expiresAtDate.getTime() - issuedAtDate.getTime();
    if (
      !Number.isFinite(expiresAtDate.getTime()) ||
      ttlMs <= 2_000 ||
      ttlMs > MAX_INSTALLATION_TOKEN_TTL_MS
    ) {
      throw new Error("GitHub installation token expiry is outside safe bounds");
    }
    const effectiveLeadMs = Math.min(
      this.renewalLeadMs,
      Math.floor(ttlMs / 2),
    );
    const renewAfterDate = new Date(
      expiresAtDate.getTime() - effectiveLeadMs,
    );

    const lease: GitHubTokenLease = {
      version: GITHUB_TOKEN_LEASE_VERSION,
      leaseId: randomUUID(),
      beaconId,
      installationId: tokenPolicy.installationId,
      token: result.token,
      repository: {
        owner: tokenPolicy.repository.owner,
        repo: tokenPolicy.repository.repo,
      },
      permissions: { ...tokenPolicy.permissions },
      issuedAt: issuedAtDate.toISOString(),
      renewAfter: renewAfterDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
    };
    assertGitHubTokenLease(lease);
    return lease;
  }

  private async signAppJwt(now: Date): Promise<string> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(String(this.options.appId))
      .setIssuedAt(nowSeconds - 30)
      .setExpirationTime(nowSeconds + 5 * 60)
      .sign(createPrivateKey(this.options.appPrivateKeyPem));
  }
}
