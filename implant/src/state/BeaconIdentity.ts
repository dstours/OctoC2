import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const UUID_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_BODY}$`, "i");
const PRIMARY_STATE_PATTERN = new RegExp(
  `^(${UUID_BODY})\\.json$`,
  "i",
);
const SCOPED_STATE_PATTERN = new RegExp(
  `^(${UUID_BODY})\\.[0-9a-f]{24}\\.json$`,
  "i",
);
const RECOVERY_STATE_PATTERN = new RegExp(
  `^(${UUID_BODY})\\.recovery\\.json$`,
  "i",
);
const FALLBACK_STATE_PATTERN = /^svc-state(?:\.[0-9a-f]{24})?\.json$/i;

export interface BeaconIdentityDiscoveryOptions {
  stateDirectory?: string;
  recoveryDirectory?: string;
  fallbackDirectory?: string;
}

interface RecognizedArtifact {
  path: string;
  kind: "primary" | "fallback" | "scoped" | "recovery";
  beaconId: string;
}

export class BeaconIdentityDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeaconIdentityDiscoveryError";
  }
}

export function assertBeaconId(value: unknown, name = "beaconId"): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !UUID_PATTERN.test(value)
  ) {
    throw new BeaconIdentityDiscoveryError(
      `${name} must be a canonical lowercase UUID`,
    );
  }
  return value;
}

export function defaultBeaconStateDirectory(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env["APPDATA"] ?? join(home, "AppData", "Roaming"),
      "svc",
    );
  }
  return join(
    process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"),
    "svc",
  );
}

export function defaultRecoveryStateDirectory(): string {
  return process.env["OCTOC2_STATE_DIR"]?.trim() ||
    defaultBeaconStateDirectory();
}

/**
 * Discover a previously persisted beacon identity without guessing.
 *
 * Canonical unscoped state is authoritative. Scoped and recovery state may
 * corroborate that identity, but may never create one by themselves. Any
 * corrupt recognized artifact, conflicting identity, or primary/fallback
 * ambiguity stops startup so a damaged installation cannot silently enroll a
 * new beacon.
 */
export async function discoverPersistedBeaconId(
  options: BeaconIdentityDiscoveryOptions = {},
): Promise<string | null> {
  const stateDirectory = resolve(
    options.stateDirectory ?? defaultBeaconStateDirectory(),
  );
  const recoveryDirectory = resolve(
    options.recoveryDirectory ?? defaultRecoveryStateDirectory(),
  );
  const fallbackDirectory = resolve(
    options.fallbackDirectory ?? process.cwd(),
  );

  const artifacts: RecognizedArtifact[] = [];
  await scanDirectory(stateDirectory, "state", artifacts);
  if (recoveryDirectory !== stateDirectory) {
    await scanDirectory(recoveryDirectory, "recovery", artifacts);
  }
  await scanFallbackDirectory(fallbackDirectory, artifacts);

  const primary = artifacts.filter((entry) => entry.kind === "primary");
  const fallback = artifacts.filter((entry) => entry.kind === "fallback");
  const companions = artifacts.filter(
    (entry) => entry.kind === "scoped" || entry.kind === "recovery",
  );

  if (primary.length > 1) {
    throw new BeaconIdentityDiscoveryError(
      `Multiple canonical beacon state files exist: ${
        primary.map((entry) => entry.path).join(", ")
      }`,
    );
  }
  if (fallback.length > 1) {
    throw new BeaconIdentityDiscoveryError(
      `Multiple fallback beacon state files exist: ${
        fallback.map((entry) => entry.path).join(", ")
      }`,
    );
  }
  if (primary.length > 0 && fallback.length > 0) {
    throw new BeaconIdentityDiscoveryError(
      "Canonical and fallback beacon state both exist; identity is ambiguous",
    );
  }

  const authority = primary[0] ?? fallback[0];
  if (!authority) {
    if (companions.length > 0) {
      throw new BeaconIdentityDiscoveryError(
        `Orphaned scoped or recovery state exists without canonical beacon state: ${
          companions.map((entry) => entry.path).join(", ")
        }`,
      );
    }
    return null;
  }

  const conflicts = companions.filter(
    (entry) => entry.beaconId !== authority.beaconId,
  );
  if (conflicts.length > 0) {
    throw new BeaconIdentityDiscoveryError(
      `Persisted state contains conflicting beacon identities: ${
        [authority, ...conflicts]
          .map((entry) => `${entry.beaconId} (${entry.path})`)
          .join(", ")
      }`,
    );
  }
  return authority.beaconId;
}

async function scanDirectory(
  directory: string,
  mode: "state" | "recovery",
  artifacts: RecognizedArtifact[],
): Promise<void> {
  if (!existsSync(directory)) return;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new BeaconIdentityDiscoveryError(
      `Could not inspect beacon state directory ${directory}: ${
        errorMessage(error)
      }`,
    );
  }

  for (const name of names.sort()) {
    const primaryMatch =
      mode === "state" ? PRIMARY_STATE_PATTERN.exec(name) : null;
    const scopedMatch =
      mode === "state" ? SCOPED_STATE_PATTERN.exec(name) : null;
    const recoveryMatch = RECOVERY_STATE_PATTERN.exec(name);
    const match = primaryMatch ?? scopedMatch ?? recoveryMatch;
    if (!match) continue;

    const kind = primaryMatch
      ? "primary"
      : scopedMatch
      ? "scoped"
      : "recovery";
    const expectedId = assertBeaconId(match[1], `${kind} state filename`);
    const path = join(directory, name);
    artifacts.push({
      path,
      kind,
      beaconId: await readArtifactIdentity(path, expectedId, kind),
    });
  }
}

async function scanFallbackDirectory(
  directory: string,
  artifacts: RecognizedArtifact[],
): Promise<void> {
  if (!existsSync(directory)) return;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new BeaconIdentityDiscoveryError(
      `Could not inspect fallback state directory ${directory}: ${
        errorMessage(error)
      }`,
    );
  }
  for (const name of names.sort()) {
    if (!FALLBACK_STATE_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const scoped = name.toLowerCase() !== "svc-state.json";
    artifacts.push({
      path,
      kind: scoped ? "scoped" : "fallback",
      beaconId: await readArtifactIdentity(
        path,
        null,
        scoped ? "scoped" : "fallback",
      ),
    });
  }
}

async function readArtifactIdentity(
  path: string,
  expectedId: string | null,
  kind: RecognizedArtifact["kind"],
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new BeaconIdentityDiscoveryError(
      `Could not parse recognized ${kind} state at ${path}: ${
        errorMessage(error)
      }`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new BeaconIdentityDiscoveryError(
      `Recognized ${kind} state at ${path} must be an object`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== 1 && record["version"] !== 2) {
    throw new BeaconIdentityDiscoveryError(
      `Recognized ${kind} state at ${path} has an unsupported version`,
    );
  }
  const beaconId = assertBeaconId(
    record["beaconId"],
    `beaconId in ${path}`,
  );
  if (expectedId !== null && beaconId !== expectedId) {
    throw new BeaconIdentityDiscoveryError(
      `State filename identity ${expectedId} conflicts with ${beaconId} in ${path}`,
    );
  }
  return beaconId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
