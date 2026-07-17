import {
  RECOVERY_RECORD_VERSION,
  assertRecoveryConfiguration,
  createRecoveryRecord,
  decodeBase64Url,
  ed25519KeyId,
  encodeBase64Url,
  recoveryDropPath,
  type ChannelKind,
  type GitHubTokenLease,
  type RecoveryConfigurationV2,
  type RecoveryRelayConfig,
} from "@octoc2/shared";
import { createHash } from "node:crypto";
import { base64ToBytes, sealBox } from "../crypto/sodium.ts";
import type {
  CommitChannelProgressInput,
  PollCursor,
  StoredBeacon,
} from "../store/types.ts";

const DEFAULT_API_BASE = "https://api.github.com";
const PUBLISHER_CHANNEL = "recovery-publisher";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RecoveryPublisherPolicy {
  serverUrl: string;
  controllerToken: string | null;
  monitoringPublicKey: string;
  tentaclePriority: readonly ChannelKind[];
  relayConsortium: readonly RecoveryRelayConfig[];
  proxyRepos: readonly RecoveryPublisherProxyPolicy[];
  sleepSeconds: number;
  jitter: number;
}

export interface RecoveryPublisherProxyPolicy {
  owner: string;
  repo: string;
  innerKind: "issues";
  decoyIssue: number;
}

export interface RecoveryPublisherStore {
  getBeacon(beaconId: string): StoredBeacon | undefined;
  getPollCursor(channel: string, scope: string): PollCursor | undefined;
  commitChannelProgress(
    input: CommitChannelProgressInput,
  ): { status: "committed" | "exact_duplicate" | "conflicting_duplicate" };
}

export interface InstallationLeaseMinter {
  mintLease(
    beaconId: string,
    repository?: { owner: string; repo: string },
  ): Promise<GitHubTokenLease>;
}

export interface RecoveryPublisherOptions {
  store: RecoveryPublisherStore;
  tokenMinter: InstallationLeaseMinter;
  policies: Readonly<Record<string, RecoveryPublisherPolicy>>;
  recoveryRepository: {
    owner: string;
    repo: string;
    ref: string;
  };
  recoveryWriteToken: string;
  signingSecretKey: Uint8Array;
  signingPublicKey: Uint8Array;
  signingKeyId: string;
  nextSigningPublicKey?: Uint8Array;
  nextSigningKeyId?: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface PublishedRecoveryDrop {
  beaconId: string;
  generation: number;
  path: string;
  expiresAt: string;
}

interface ContentsResponse {
  sha?: unknown;
}

function validateRepoSegment(value: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
}

function validateRef(value: string): void {
  if (
    value.trim().length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("\\") ||
    !/^[A-Za-z0-9_./-]+$/.test(value)
  ) {
    throw new Error("Recovery repository ref is invalid");
  }
}

function parsePreviousGeneration(cursor: PollCursor | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(cursor.cursor);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Server-side deterministic recovery publisher.
 *
 * It receives only a policy-bound lease from the GitHub App token service,
 * signs the complete replacement configuration, seals it to the pre-enrolled
 * beacon X25519 key, and writes exactly one deterministic path in the
 * configured public recovery repository.
 */
export class RecoveryPublisherService {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly nextSigningPublicKey: Uint8Array;
  private readonly nextSigningKeyId: string;

  constructor(private readonly options: RecoveryPublisherOptions) {
    validateRepoSegment(
      options.recoveryRepository.owner,
      "recoveryRepository.owner",
    );
    validateRepoSegment(
      options.recoveryRepository.repo,
      "recoveryRepository.repo",
    );
    validateRef(options.recoveryRepository.ref);
    if (options.recoveryWriteToken.trim().length === 0) {
      throw new Error("Recovery repository write token is required");
    }
    if (options.signingSecretKey.length !== 64) {
      throw new Error("Recovery Ed25519 secret key must be 64 bytes");
    }
    if (options.signingPublicKey.length !== 32) {
      throw new Error("Recovery Ed25519 public key must be 32 bytes");
    }
    this.nextSigningPublicKey =
      options.nextSigningPublicKey ?? options.signingPublicKey;
    this.nextSigningKeyId =
      options.nextSigningKeyId ?? options.signingKeyId;
    if (this.nextSigningPublicKey.length !== 32) {
      throw new Error("Next recovery Ed25519 public key must be 32 bytes");
    }
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async validateSigningKeys(): Promise<void> {
    if (
      (await ed25519KeyId(this.options.signingPublicKey)) !==
      this.options.signingKeyId
    ) {
      throw new Error("Recovery signing key ID does not match its public key");
    }
    if (
      (await ed25519KeyId(this.nextSigningPublicKey)) !==
      this.nextSigningKeyId
    ) {
      throw new Error(
        "Next recovery signing key ID does not match its public key",
      );
    }
  }

  async publish(beaconId: string): Promise<PublishedRecoveryDrop> {
    const policy = this.options.policies[beaconId];
    if (!policy) {
      throw new Error(`No recovery policy for beacon ${beaconId}`);
    }
    const beacon = this.options.store.getBeacon(beaconId);
    if (!beacon) {
      throw new Error(`Cannot publish recovery for unknown beacon ${beaconId}`);
    }

    await this.validateSigningKeys();
    await this.assertRecoveryRepositoryIsPublic();

    const lease = await this.options.tokenMinter.mintLease(beaconId);
    const proxyRepos = await Promise.all(
      policy.proxyRepos.map(async (proxy) => ({
        ...proxy,
        tokenLease: await this.options.tokenMinter.mintLease(beaconId, {
          owner: proxy.owner,
          repo: proxy.repo,
        }),
      })),
    );
    const configuration: RecoveryConfigurationV2 = {
      serverUrl: policy.serverUrl,
      controllerToken: policy.controllerToken,
      monitoringPublicKey: policy.monitoringPublicKey,
      recoverySigningPublicKey: encodeBase64Url(
        this.nextSigningPublicKey,
      ),
      recoverySigningKeyId: this.nextSigningKeyId,
      github: {
        owner: lease.repository.owner,
        repo: lease.repository.repo,
        tokenLease: lease,
      },
      tentaclePriority: [...policy.tentaclePriority],
      relayConsortium: policy.relayConsortium.map((entry) => ({ ...entry })),
      proxyRepos,
      sleepSeconds: policy.sleepSeconds,
      jitter: policy.jitter,
    };
    assertRecoveryConfiguration(configuration);

    const previousGeneration = parsePreviousGeneration(
      this.options.store.getPollCursor(PUBLISHER_CHANNEL, beaconId),
    );
    const generation = Math.max(
      previousGeneration + 1,
      this.now().getTime(),
    );
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Could not allocate a safe recovery generation");
    }
    const issuedAt = this.now().toISOString();
    const expiresAt = [lease, ...proxyRepos.map((proxy) => proxy.tokenLease)]
      .map((tokenLease) => tokenLease.expiresAt)
      .sort()[0]!;
    const record = await createRecoveryRecord({
      beaconId,
      generation,
      issuedAt,
      expiresAt,
      signingKeyId: this.options.signingKeyId,
      signingSecretKey: this.options.signingSecretKey,
      configuration,
    });
    if (record.version !== RECOVERY_RECORD_VERSION) {
      throw new Error("Unexpected recovery record version");
    }

    const beaconPublicKey = await base64ToBytes(beacon.x25519PublicKey);
    if (beaconPublicKey.length !== 32) {
      throw new Error(`Beacon ${beaconId} has an invalid X25519 public key`);
    }
    const sealed = await sealBox(JSON.stringify(record), beaconPublicKey);
    const path = await recoveryDropPath(beaconId);
    await this.putDeterministicDrop(path, sealed);

    const digest = createHash("sha256").update(sealed, "utf8").digest("hex");
    const progress = this.options.store.commitChannelProgress({
      channel: PUBLISHER_CHANNEL,
      scope: beaconId,
      messageId: `${beaconId}:${generation}`,
      payloadDigest: digest,
      cursor: String(generation),
      beaconId,
      outcome: "accepted",
      processedAt: issuedAt,
    });
    if (progress.status !== "committed") {
      throw new Error(
        `Could not commit recovery generation ${generation}: ${progress.status}`,
      );
    }

    return {
      beaconId,
      generation,
      path,
      expiresAt,
    };
  }

  async publishAll(): Promise<PublishedRecoveryDrop[]> {
    const results: PublishedRecoveryDrop[] = [];
    for (const beaconId of Object.keys(this.options.policies).sort()) {
      results.push(await this.publish(beaconId));
    }
    return results;
  }

  private async assertRecoveryRepositoryIsPublic(): Promise<void> {
    const { owner, repo } = this.options.recoveryRepository;
    const response = await this.fetchImpl(
      `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: this.githubHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Could not inspect recovery repository (${response.status})`,
      );
    }
    const data = await response.json() as { private?: unknown };
    if (data.private !== false) {
      throw new Error(
        "Recovery repository must be public for anonymous beacon reads",
      );
    }
  }

  private async putDeterministicDrop(
    path: string,
    sealed: string,
  ): Promise<void> {
    const { owner, repo, ref } = this.options.recoveryRepository;
    const endpoint =
      `${this.apiBase}/repos/${encodeURIComponent(owner)}` +
      `/${encodeURIComponent(repo)}/contents/${path}`;
    const current = await this.fetchImpl(
      `${endpoint}?ref=${encodeURIComponent(ref)}`,
      { headers: this.githubHeaders() },
    );
    let sha: string | undefined;
    if (current.ok) {
      const data = await current.json() as ContentsResponse;
      if (typeof data.sha !== "string" || data.sha.trim().length === 0) {
        throw new Error("Recovery repository returned an invalid content SHA");
      }
      sha = data.sha;
    } else if (current.status !== 404) {
      throw new Error(
        `Could not inspect existing recovery drop (${current.status})`,
      );
    }

    const body = {
      message: "Update sealed OctoC2 recovery record",
      content: Buffer.from(`${sealed}\n`, "utf8").toString("base64"),
      branch: ref,
      ...(sha !== undefined && { sha }),
    };
    const response = await this.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        ...this.githubHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "(no body)");
      throw new Error(
        `Could not publish recovery drop (${response.status}): ${detail}`,
      );
    }
  }

  private githubHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.recoveryWriteToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OctoC2-Server/0.1",
    };
  }
}

export async function parseRecoveryPublisherPolicies(
  raw: string,
): Promise<Record<string, RecoveryPublisherPolicy>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OCTOC2_RECOVERY_POLICIES must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OCTOC2_RECOVERY_POLICIES must be a JSON object");
  }

  const policies: Record<string, RecoveryPublisherPolicy> = {};
  for (const [beaconId, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Recovery policy for ${beaconId} must be an object`);
    }
    const policy = value as Record<string, unknown>;
    const rawProxyRepos = policy["proxyRepos"] ?? [];
    if (Array.isArray(rawProxyRepos) && rawProxyRepos.length > 1) {
      throw new Error(
        `Invalid recovery policy for ${beaconId}: proxyRepos supports at most one route per beacon`,
      );
    }
    const proxyRepos = Array.isArray(rawProxyRepos)
      ? rawProxyRepos.map((entry) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            return entry;
          }
          const proxy = entry as Record<string, unknown>;
          const owner =
            typeof proxy["owner"] === "string"
              ? proxy["owner"]
              : "invalid";
          const repo =
            typeof proxy["repo"] === "string"
              ? proxy["repo"]
              : "invalid";
          return {
            ...proxy,
            tokenLease: {
              version: 1,
              leaseId: "placeholder",
              beaconId,
              installationId: 1,
              token: "placeholder",
              repository: { owner, repo },
              permissions: {
                metadata: "read",
                issues: "write",
                variables: "read",
              },
              issuedAt: "2026-01-01T00:00:00.000Z",
              renewAfter: "2026-01-01T00:30:00.000Z",
              expiresAt: "2026-01-01T01:00:00.000Z",
            },
          };
        })
      : rawProxyRepos;
    const candidate = {
      serverUrl: policy["serverUrl"],
      controllerToken: policy["controllerToken"] ?? null,
      monitoringPublicKey: policy["monitoringPublicKey"],
      recoverySigningPublicKey: encodeBase64Url(new Uint8Array(32)),
      recoverySigningKeyId: `ed25519:${"0".repeat(64)}`,
      github: {
        owner: "placeholder",
        repo: "placeholder",
        tokenLease: {
          version: 1,
          leaseId: "placeholder",
          beaconId,
          installationId: 1,
          token: "placeholder",
          repository: { owner: "placeholder", repo: "placeholder" },
          permissions: {
            metadata: "read",
            issues: "write",
            contents: "write",
            actions: "write",
            deployments: "write",
            variables: "write",
          },
          issuedAt: "2026-01-01T00:00:00.000Z",
          renewAfter: "2026-01-01T00:30:00.000Z",
          expiresAt: "2026-01-01T01:00:00.000Z",
        },
      },
      tentaclePriority: policy["tentaclePriority"],
      relayConsortium: policy["relayConsortium"] ?? [],
      proxyRepos,
      sleepSeconds: policy["sleepSeconds"],
      jitter: policy["jitter"],
    };
    try {
      assertRecoveryConfiguration(candidate);
    } catch (error) {
      throw new Error(
        `Invalid recovery policy for ${beaconId}: ${(error as Error).message}`,
      );
    }
    policies[beaconId] = {
      serverUrl: candidate.serverUrl,
      controllerToken: candidate.controllerToken,
      monitoringPublicKey: candidate.monitoringPublicKey,
      tentaclePriority: [...candidate.tentaclePriority],
      relayConsortium: candidate.relayConsortium.map((entry) => ({ ...entry })),
      proxyRepos: candidate.proxyRepos.map((entry) => ({
        owner: entry.owner,
        repo: entry.repo,
        innerKind: entry.innerKind,
        decoyIssue: entry.decoyIssue,
      })),
      sleepSeconds: candidate.sleepSeconds,
      jitter: candidate.jitter,
    };
  }
  return policies;
}
