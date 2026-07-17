import {
  phaseAdvanced,
  phaseBuildBeacon,
  phaseCredentials,
  phaseInstall,
  phaseKeygen,
  phaseServerRecovery,
  phaseTentacles,
  phaseValidate,
  phaseVerify,
  phaseWriteEnv,
  type SetupProxyPolicy,
  type SetupState,
} from "./setup/phases.ts";
import {
  promptSelect,
  promptText,
  wizardIntro,
  wizardOutro,
} from "./setup/prompts.ts";
import { findProjectRoot, loadEnvFile } from "./service.ts";
import * as p from "@clack/prompts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface SetupOptions {
  phase?: string;
}

function parseJsonRecord(
  raw: string | undefined,
  name: string,
): Record<string, unknown> {
  if (!raw) throw new Error(`${name} is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireString(
  vars: Record<string, string>,
  name: string,
): string {
  const value = vars[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Import only the remediated controller environment. Legacy setup files are
 * rejected explicitly so an obsolete shared PAT/App-key beacon flow cannot be
 * reintroduced silently.
 */
export function stateFromEnv(
  vars: Record<string, string>,
): SetupState {
  const legacyFields = [
    "OCTOC2_GITHUB_TOKEN",
    "SVC_APP_ID",
    "SVC_INSTALLATION_ID",
    "SVC_APP_PRIVATE_KEY",
    "OCTOC2_APP_PRIVATE_KEY",
    "SVC_PROXY_REPOS",
  ].filter((name) => vars[name]?.trim());
  if (legacyFields.length > 0) {
    throw new Error(
      `Legacy setup fields are not importable: ${legacyFields.join(", ")}. ` +
      "Run guided setup to create separated controller credentials and signed recovery policy.",
    );
  }

  const appPolicies = parseJsonRecord(
    vars["OCTOC2_GITHUB_APP_POLICIES"],
    "OCTOC2_GITHUB_APP_POLICIES",
  );
  const recoveryPolicies = parseJsonRecord(
    vars["OCTOC2_RECOVERY_POLICIES"],
    "OCTOC2_RECOVERY_POLICIES",
  );
  const beaconTokens = parseJsonRecord(
    vars["OCTOC2_BEACON_API_TOKENS"],
    "OCTOC2_BEACON_API_TOKENS",
  );
  const beaconIds = Object.keys(appPolicies);
  if (
    beaconIds.length !== 1 ||
    Object.keys(recoveryPolicies).length !== 1 ||
    Object.keys(beaconTokens).length !== 1 ||
    !(beaconIds[0]! in recoveryPolicies) ||
    !(beaconIds[0]! in beaconTokens)
  ) {
    throw new Error(
      "Setup import requires exactly one matching beacon entry in the App, recovery, and controller-token policies",
    );
  }

  const beaconId = beaconIds[0]!;
  const appPolicy = requireObject(
    appPolicies[beaconId],
    `GitHub App policy for ${beaconId}`,
  );
  const recoveryPolicy = requireObject(
    recoveryPolicies[beaconId],
    `Recovery policy for ${beaconId}`,
  );
  const repository = requireObject(
    appPolicy["repository"],
    "GitHub App policy repository",
  );
  const owner = repository["owner"];
  const repo = repository["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") {
    throw new Error("GitHub App policy repository coordinates are invalid");
  }

  const primaryInstallationId = requirePositiveInteger(
    appPolicy["installationId"],
    "GitHub App installationId",
  );
  const rawAppProxies = appPolicy["proxyRepositories"] ?? [];
  const rawRecoveryProxies = recoveryPolicy["proxyRepos"] ?? [];
  if (!Array.isArray(rawAppProxies) || !Array.isArray(rawRecoveryProxies)) {
    throw new Error("Imported proxy policies must be arrays");
  }
  if (rawAppProxies.length > 1 || rawRecoveryProxies.length > 1) {
    throw new Error("Imported policy supports at most one proxy route per beacon");
  }
  const appProxyByRepo = new Map(
    rawAppProxies.map((raw, index) => {
      const proxy = requireObject(raw, `App proxy policy ${index}`);
      const proxyRepository = requireObject(
        proxy["repository"],
        `App proxy policy ${index} repository`,
      );
      if (
        typeof proxyRepository["owner"] !== "string" ||
        typeof proxyRepository["repo"] !== "string"
      ) {
        throw new Error(`App proxy policy ${index} repository is invalid`);
      }
      return [
        `${proxyRepository["owner"]}/${proxyRepository["repo"]}`.toLowerCase(),
        requirePositiveInteger(
          proxy["installationId"],
          `App proxy policy ${index} installationId`,
        ),
      ] as const;
    }),
  );
  const proxyPolicies: SetupProxyPolicy[] = rawRecoveryProxies.map(
    (raw, index) => {
      const proxy = requireObject(raw, `Recovery proxy policy ${index}`);
      if (
        typeof proxy["owner"] !== "string" ||
        typeof proxy["repo"] !== "string" ||
        proxy["innerKind"] !== "issues" ||
        !Number.isSafeInteger(proxy["decoyIssue"]) ||
        (proxy["decoyIssue"] as number) <= 0
      ) {
        throw new Error(`Recovery proxy policy ${index} is invalid`);
      }
      const key = `${proxy["owner"]}/${proxy["repo"]}`.toLowerCase();
      const installationId = appProxyByRepo.get(key);
      if (!installationId) {
        throw new Error(
          `Recovery proxy ${proxy["owner"]}/${proxy["repo"]} has no matching App policy`,
        );
      }
      return {
        owner: proxy["owner"],
        repo: proxy["repo"],
        installationId,
        innerKind: "issues",
        decoyIssue: proxy["decoyIssue"] as number,
      };
    },
  );

  const rawPriority = recoveryPolicy["tentaclePriority"];
  if (
    !Array.isArray(rawPriority) ||
    rawPriority.some((value) => typeof value !== "string")
  ) {
    throw new Error("Imported recovery tentaclePriority is invalid");
  }
  const serverUrl = recoveryPolicy["serverUrl"];
  const beaconControllerToken = beaconTokens[beaconId];
  if (
    typeof beaconControllerToken !== "string" ||
    typeof recoveryPolicy["controllerToken"] !== "string" ||
    recoveryPolicy["controllerToken"] !== beaconControllerToken ||
    typeof recoveryPolicy["monitoringPublicKey"] !== "string" ||
    typeof serverUrl !== "string"
  ) {
    throw new Error("Imported recovery/controller credential policy is invalid");
  }

  const sleepSeconds = recoveryPolicy["sleepSeconds"];
  const jitter = recoveryPolicy["jitter"];
  if (
    typeof sleepSeconds !== "number" ||
    !Number.isSafeInteger(sleepSeconds) ||
    sleepSeconds <= 0 ||
    typeof jitter !== "number" ||
    !Number.isFinite(jitter) ||
    jitter < 0 ||
    jitter > 1
  ) {
    throw new Error("Imported recovery timing policy is invalid");
  }
  const appId = requirePositiveInteger(
    Number(requireString(vars, "OCTOC2_GITHUB_APP_ID")),
    "OCTOC2_GITHUB_APP_ID",
  );

  return {
    operatorGitHubToken: requireString(
      vars,
      "OCTOC2_OPERATOR_GITHUB_TOKEN",
    ),
    serverGitHubToken: requireString(vars, "OCTOC2_SERVER_GITHUB_TOKEN"),
    owner,
    repo,
    operatorSecret: requireString(vars, "OCTOC2_OPERATOR_SECRET"),
    operatorPublicKey: requireString(vars, "MONITORING_PUBKEY"),
    operatorApiToken: requireString(vars, "OCTOC2_OPERATOR_API_TOKEN"),
    beaconControllerToken,
    beaconId,
    appId,
    installationId: primaryInstallationId,
    appPrivateKeyFile: requireString(
      vars,
      "OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE",
    ),
    recoveryRepoOwner: requireString(
      vars,
      "OCTOC2_RECOVERY_REPO_OWNER",
    ),
    recoveryRepoName: requireString(vars, "OCTOC2_RECOVERY_REPO_NAME"),
    recoveryRepoRef: requireString(vars, "OCTOC2_RECOVERY_REPO_REF"),
    recoveryWriteToken: requireString(
      vars,
      "OCTOC2_RECOVERY_WRITE_TOKEN",
    ),
    recoverySigningSecretFile: requireString(
      vars,
      "OCTOC2_RECOVERY_SIGNING_SECRET_FILE",
    ),
    recoverySigningPublicKey: requireString(
      vars,
      "OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY",
    ),
    recoverySigningKeyId: requireString(
      vars,
      "OCTOC2_RECOVERY_SIGNING_KEY_ID",
    ),
    tentaclePriority: rawPriority.join(","),
    ...(proxyPolicies.length > 0 && {
      proxyRepos: JSON.stringify(proxyPolicies),
    }),
    ...(
      serverUrl !== "https://127.0.0.1:8080" &&
      serverUrl !== "https://localhost:8080"
      ? { httpUrl: serverUrl }
      : {}
    ),
    sleepSeconds,
    jitter,
    enrollmentDir:
      vars["OCTOC2_ENROLLMENT_DIR"]?.trim() || findProjectRoot(),
    ...(vars["OCTOC2_LOG_LEVEL"]?.trim() && {
      logLevel: vars["OCTOC2_LOG_LEVEL"].trim(),
    }),
  };
}

export async function runSetup(_opts: SetupOptions): Promise<void> {
  wizardIntro();

  const mode = await promptSelect<"fresh" | "import">({
    message: "How would you like to set up?",
    options: [
      {
        value: "fresh",
        label: "Guided setup",
        hint: "create separated credentials, identity enrollment, and signed recovery",
      },
      {
        value: "import",
        label: "Import modern .env",
        hint: "rebuild the single beacon already represented by a remediated policy",
      },
    ],
  });

  let state: SetupState;

  if (mode === "import") {
    const { resolve } = await import("node:path");
    const defaultPath = resolve(findProjectRoot(), ".env");
    const envPath = await promptText({
      message: "Path to existing controller .env file",
      initialValue: defaultPath,
      placeholder: defaultPath,
      validate: (value) => {
        const { existsSync } = require("node:fs");
        return existsSync(value.trim()) ? undefined : "File not found";
      },
    });

    try {
      state = {
        ...stateFromEnv(loadEnvFile(envPath.trim())),
        envPath: envPath.trim(),
      };
    } catch (error) {
      p.log.error((error as Error).message);
      p.log.info(
        `${DIM}Legacy files are not upgraded implicitly; choose guided setup.${RESET}`,
      );
      return;
    }

    p.log.success(`Loaded remediated policy for beacon ${state.beaconId}`);
  } else {
    let credentials: Awaited<ReturnType<typeof phaseCredentials>>;
    while (true) {
      credentials = await phaseCredentials();
      try {
        await phaseValidate(
          credentials.operatorGitHubToken,
          credentials.owner,
          credentials.repo,
        );
        break;
      } catch (error) {
        if ((error as Error).message === "RETRY_CREDENTIALS") continue;
        throw error;
      }
    }

    const keys = await phaseKeygen(
      credentials.operatorGitHubToken,
      credentials.owner,
      credentials.repo,
    );
    const recovery = await phaseServerRecovery(
      credentials.owner,
      credentials.operatorGitHubToken,
      credentials.serverGitHubToken,
    );
    const tentaclePriority = await phaseTentacles();
    const advanced = await phaseAdvanced(recovery.installationId);

    state = {
      ...credentials,
      ...keys,
      ...recovery,
      ...(tentaclePriority !== undefined && { tentaclePriority }),
      ...advanced,
    };
  }

  const build = await phaseBuildBeacon(state);
  state.beaconId = build.beaconId;
  state.enrollmentDir = build.enrollmentDir;
  if (build.binaryPath) state.binaryPath = build.binaryPath;

  state.envPath = await phaseWriteEnv(state);
  await phaseInstall();
  await phaseVerify(state);
  wizardOutro("Setup complete.");
}
