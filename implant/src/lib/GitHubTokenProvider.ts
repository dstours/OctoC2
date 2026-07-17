import {
  CHANNEL_BY_KIND,
  assertGitHubTokenLease,
  type ChannelKind,
  type GitHubTokenLease,
} from "@octoc2/shared";

export type GitHubCredentialMode =
  | "installation-lease"
  | "explicit-fine-grained";

export interface GitHubTokenRequest {
  channel?: ChannelKind;
}

export interface GitHubTokenProvider {
  readonly mode: GitHubCredentialMode;
  getToken(request?: GitHubTokenRequest): Promise<string>;
  needsRenewal(now?: Date): boolean;
  expiresAt(): string | null;
  invalidate(reason?: string): void;
}

export interface GitHubTokenProviderConfig {
  id: string;
  repo: { owner: string; name: string };
  token?: string;
  githubTokenLease?: GitHubTokenLease;
}

export type LeaseRenewal = (
  current: GitHubTokenLease,
) => Promise<GitHubTokenLease>;

function normalizeRepository(value: string): string {
  return value.trim().toLowerCase();
}

function providerBindingKey(
  beaconId: string,
  repository: { owner: string; name: string },
): string {
  return [
    beaconId,
    normalizeRepository(repository.owner),
    normalizeRepository(repository.name),
  ].join("|");
}

function validateLeaseBinding(
  lease: GitHubTokenLease,
  beaconId: string,
  repository: { owner: string; name: string },
): void {
  assertGitHubTokenLease(lease);
  if (lease.beaconId !== beaconId) {
    throw new Error("GitHub token lease belongs to a different beacon");
  }
  if (
    normalizeRepository(lease.repository.owner) !==
      normalizeRepository(repository.owner) ||
    normalizeRepository(lease.repository.repo) !==
      normalizeRepository(repository.name)
  ) {
    throw new Error("GitHub token lease is scoped to a different repository");
  }
}

export class InstallationTokenLeaseProvider implements GitHubTokenProvider {
  readonly mode = "installation-lease" as const;

  private lease: GitHubTokenLease;
  private renewalInFlight: Promise<void> | null = null;
  private invalidatedReason: string | null = null;

  constructor(
    private readonly beaconId: string,
    private readonly repository: { owner: string; name: string },
    lease: GitHubTokenLease,
    private readonly renew?: LeaseRenewal,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateLeaseBinding(lease, beaconId, repository);
    this.lease = lease;
  }

  async getToken(request: GitHubTokenRequest = {}): Promise<string> {
    if (request.channel !== undefined) {
      const definition = CHANNEL_BY_KIND[request.channel];
      if (
        !definition.authModes.some(
          (mode) => mode === "github-app-installation-token",
        )
      ) {
        throw new Error(
          `${definition.name} does not support GitHub App installation tokens`,
        );
      }
    }
    if (this.invalidatedReason !== null) {
      throw new Error(
        `GitHub token lease is invalidated: ${this.invalidatedReason}`,
      );
    }
    if (this.now().getTime() >= Date.parse(this.lease.expiresAt)) {
      throw new Error("GitHub token lease has expired");
    }
    if (this.needsRenewal() && this.renew) {
      await this.renewLease();
    }
    return this.lease.token;
  }

  needsRenewal(now = this.now()): boolean {
    return (
      this.invalidatedReason !== null ||
      now.getTime() >= Date.parse(this.lease.renewAfter)
    );
  }

  expiresAt(): string {
    return this.lease.expiresAt;
  }

  currentLease(): GitHubTokenLease {
    return this.lease;
  }

  applyLease(next: GitHubTokenLease): void {
    validateLeaseBinding(next, this.beaconId, this.repository);
    const currentIssuedAt = Date.parse(this.lease.issuedAt);
    const nextIssuedAt = Date.parse(next.issuedAt);
    if (
      nextIssuedAt < currentIssuedAt ||
      (nextIssuedAt === currentIssuedAt && next.leaseId !== this.lease.leaseId)
    ) {
      throw new Error("Refusing stale or conflicting GitHub token lease");
    }
    this.lease = next;
    this.invalidatedReason = null;
  }

  invalidate(reason = "authentication failure"): void {
    this.invalidatedReason = reason;
  }

  private async renewLease(): Promise<void> {
    if (!this.renewalInFlight) {
      this.renewalInFlight = (async () => {
        const next = await this.renew!(this.lease);
        this.applyLease(next);
      })().finally(() => {
        this.renewalInFlight = null;
      });
    }
    await this.renewalInFlight;
  }
}

export class ExplicitFineGrainedTokenProvider implements GitHubTokenProvider {
  readonly mode = "explicit-fine-grained" as const;
  private invalidatedReason: string | null = null;

  constructor(private readonly token: string) {
    if (token.trim().length === 0) {
      throw new Error("An explicit fine-grained GitHub token is required");
    }
  }

  async getToken(): Promise<string> {
    if (this.invalidatedReason !== null) {
      throw new Error(
        `Explicit GitHub credential is invalidated: ${this.invalidatedReason}`,
      );
    }
    return this.token;
  }

  needsRenewal(): boolean {
    return this.invalidatedReason !== null;
  }

  expiresAt(): null {
    return null;
  }

  invalidate(reason = "authentication failure"): void {
    this.invalidatedReason = reason;
  }
}

export function buildGitHubTokenProvider(
  config: GitHubTokenProviderConfig,
): GitHubTokenProvider {
  if (config.githubTokenLease !== undefined) {
    return new InstallationTokenLeaseProvider(
      config.id,
      config.repo,
      config.githubTokenLease,
    );
  }
  return new ExplicitFineGrainedTokenProvider(config.token ?? "");
}

let sharedProviders = new WeakMap<object, GitHubTokenProvider>();
let sharedProvidersByBinding = new Map<string, GitHubTokenProvider>();

export function getSharedGitHubTokenProvider(
  config: GitHubTokenProviderConfig,
): GitHubTokenProvider {
  const key = config as object;
  const existing = sharedProviders.get(key);
  if (existing) return existing;
  const binding = providerBindingKey(config.id, config.repo);
  const existingBinding = sharedProvidersByBinding.get(binding);
  if (existingBinding) {
    sharedProviders.set(key, existingBinding);
    return existingBinding;
  }
  const provider = buildGitHubTokenProvider(config);
  sharedProviders.set(key, provider);
  sharedProvidersByBinding.set(binding, provider);
  return provider;
}

export function getSharedGitHubTokenProviderIfPresent(
  beaconId: string,
  repository: { owner: string; name: string },
): GitHubTokenProvider | undefined {
  return sharedProvidersByBinding.get(
    providerBindingKey(beaconId, repository),
  );
}

export function replaceSharedGitHubTokenLease(
  config: GitHubTokenProviderConfig,
  lease: GitHubTokenLease,
): InstallationTokenLeaseProvider {
  const existing = sharedProviders.get(config as object);
  if (existing instanceof InstallationTokenLeaseProvider) {
    existing.applyLease(lease);
    return existing;
  }
  const provider = new InstallationTokenLeaseProvider(
    config.id,
    config.repo,
    lease,
  );
  sharedProviders.set(config as object, provider);
  sharedProvidersByBinding.set(
    providerBindingKey(config.id, config.repo),
    provider,
  );
  return provider;
}

export function clearSharedGitHubTokenProviders(): void {
  sharedProviders = new WeakMap<object, GitHubTokenProvider>();
  sharedProvidersByBinding = new Map<string, GitHubTokenProvider>();
}
