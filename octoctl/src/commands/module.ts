/**
 * Remote module build/upload is intentionally unavailable.
 *
 * Unsigned module execution is an unrestricted remote-code-execution path.
 * Keep this exported guard for callers that previously imported the command
 * directly; the public CLI no longer registers a `module` command.
 */

export const MODULE_EXECUTION_DISABLED_MESSAGE =
  "load-module is disabled: unsigned remote module execution is not permitted";

export interface ModuleBuildOptions {
  beacon: string;
  source: string;
  serverUrl: string | undefined;
}

export function runModuleBuild(
  _name: string,
  _opts: ModuleBuildOptions
): Promise<never> {
  return Promise.reject(new Error(MODULE_EXECUTION_DISABLED_MESSAGE));
}
