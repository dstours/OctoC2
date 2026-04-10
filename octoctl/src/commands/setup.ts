import {
  phaseCredentials,
  phaseValidate,
  phaseKeygen,
  phaseAuthMode,
  phaseTentacles,
  phaseAdvanced,
  phaseWriteEnv,
  phaseBuildBeacon,
  phaseInstall,
  phaseVerify,
  type SetupState,
} from "./setup/phases.ts";
import { wizardIntro, wizardOutro } from "./setup/prompts.ts";

export interface SetupOptions {
  phase?: string;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  wizardIntro();

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
  const state: SetupState = {
    ...creds,
    ...keys,
    ...auth,
    tentaclePriority,
    ...advanced,
  };

  // Phase 7: Write .env
  state.envPath = await phaseWriteEnv(state);

  // Phase 8: Build beacon
  await phaseBuildBeacon(state);

  // Phase 9: Install to PATH
  await phaseInstall();

  // Phase 10: Next steps
  await phaseVerify(state);

  wizardOutro("Setup complete.");
}
