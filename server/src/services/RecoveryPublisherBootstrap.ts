import { readFile } from "node:fs/promises";
import {
  decodeBase64Url,
  ed25519KeyId,
} from "@octoc2/shared";
import type { OctoStore } from "../store/index.ts";
import {
  GitHubInstallationTokenService,
  parseGitHubInstallationPolicies,
} from "./GitHubInstallationTokenService.ts";
import {
  RecoveryPublisherService,
  parseRecoveryPublisherPolicies,
} from "./RecoveryPublisherService.ts";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 45 * 60 * 1000;

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when recovery publishing is enabled`);
  }
  return value;
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

async function readSecretFile(
  env: NodeJS.ProcessEnv,
  name: string,
): Promise<string> {
  const path = requiredEnv(env, name);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${name} points to an empty file`);
  return value;
}

export interface RecoveryPublisherRuntime {
  publisher: RecoveryPublisherService;
  stop(): Promise<void>;
}

export class SerializedRecoveryPublisher {
  private inFlight: Promise<void> | null = null;
  private trailing = false;
  private stopped = false;

  constructor(
    private readonly publish: () => Promise<number>,
    private readonly onSuccess: (count: number) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  trigger(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.trailing = true;
      return;
    }

    this.inFlight = this.publish()
      .then(this.onSuccess, this.onError)
      .finally(() => {
        this.inFlight = null;
        if (this.trailing && !this.stopped) {
          this.trailing = false;
          this.trigger();
        }
      });
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  stop(): void {
    this.stopped = true;
    this.trailing = false;
  }
}

export async function startRecoveryPublisherFromEnv(
  store: OctoStore,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryPublisherRuntime> {
  const appId = parsePositiveInteger(
    requiredEnv(env, "OCTOC2_GITHUB_APP_ID"),
    "OCTOC2_GITHUB_APP_ID",
  );
  const appPrivateKeyPem = await readSecretFile(
    env,
    "OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE",
  );
  const signingSecretKey = await decodeBase64Url(
    await readSecretFile(env, "OCTOC2_RECOVERY_SIGNING_SECRET_FILE"),
  );
  const signingPublicKey = await decodeBase64Url(
    requiredEnv(env, "OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY"),
  );
  const signingKeyId =
    env["OCTOC2_RECOVERY_SIGNING_KEY_ID"]?.trim() ||
    await ed25519KeyId(signingPublicKey);

  const nextPublicRaw =
    env["OCTOC2_RECOVERY_NEXT_SIGNING_PUBLIC_KEY"]?.trim();
  const nextKeyIdRaw =
    env["OCTOC2_RECOVERY_NEXT_SIGNING_KEY_ID"]?.trim();
  if (Boolean(nextPublicRaw) !== Boolean(nextKeyIdRaw)) {
    throw new Error(
      "OCTOC2_RECOVERY_NEXT_SIGNING_PUBLIC_KEY and " +
      "OCTOC2_RECOVERY_NEXT_SIGNING_KEY_ID must be set together",
    );
  }
  const nextSigningPublicKey = nextPublicRaw
    ? await decodeBase64Url(nextPublicRaw)
    : undefined;

  const appPolicies = parseGitHubInstallationPolicies(
    requiredEnv(env, "OCTOC2_GITHUB_APP_POLICIES"),
  );
  const recoveryPolicies = await parseRecoveryPublisherPolicies(
    requiredEnv(env, "OCTOC2_RECOVERY_POLICIES"),
  );
  const appPolicyIds = Object.keys(appPolicies).sort();
  const recoveryPolicyIds = Object.keys(recoveryPolicies).sort();
  if (
    appPolicyIds.length !== recoveryPolicyIds.length ||
    appPolicyIds.some((id, index) => id !== recoveryPolicyIds[index])
  ) {
    throw new Error(
      "GitHub App and recovery policies must name the same beacon IDs",
    );
  }

  const tokenMinter = new GitHubInstallationTokenService({
    appId,
    appPrivateKeyPem,
    policies: appPolicies,
    fetchImpl,
  });
  const publisher = new RecoveryPublisherService({
    store,
    tokenMinter,
    policies: recoveryPolicies,
    recoveryRepository: {
      owner: requiredEnv(env, "OCTOC2_RECOVERY_REPO_OWNER"),
      repo: requiredEnv(env, "OCTOC2_RECOVERY_REPO_NAME"),
      ref: env["OCTOC2_RECOVERY_REPO_REF"]?.trim() || "main",
    },
    recoveryWriteToken: requiredEnv(env, "OCTOC2_RECOVERY_WRITE_TOKEN"),
    signingSecretKey,
    signingPublicKey,
    signingKeyId,
    ...(nextSigningPublicKey && nextKeyIdRaw
      ? {
          nextSigningPublicKey,
          nextSigningKeyId: nextKeyIdRaw,
        }
      : {}),
    fetchImpl,
  });

  const intervalRaw = env["OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS"]?.trim();
  const intervalMs = intervalRaw
    ? parsePositiveInteger(
        intervalRaw,
        "OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS",
      )
    : DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(
      `OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS must be between ` +
      `${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  }

  const initial = await publisher.publishAll();
  console.log(
    `[Server] Published ${initial.length} proactive recovery record(s)`,
  );
  const scheduler = new SerializedRecoveryPublisher(
    async () => (await publisher.publishAll()).length,
    (count) => {
      console.log(
        `[Server] Refreshed ${count} proactive recovery record(s)`,
      );
    },
    (error) => {
      console.error(
        `[Server] Recovery publication failed: ${(error as Error).message}`,
      );
    },
  );
  const timer = setInterval(() => scheduler.trigger(), intervalMs);

  return {
    publisher,
    async stop() {
      clearInterval(timer);
      scheduler.stop();
      await scheduler.whenIdle();
    },
  };
}
