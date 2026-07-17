import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  assertRecoveryConfiguration,
  decodeBase64Url,
  ed25519KeyId,
  type RecoveryConfigurationV2,
} from "@octoc2/shared";
import type { BeaconConfig } from "../types.ts";

export interface AcceptedRecoveryState {
  version: 2;
  beaconId: string;
  generation: number;
  acceptedAt: string;
  expiresAt: string;
  configuration: RecoveryConfigurationV2;
}

interface LegacyAcceptedRecoveryState {
  version: 1;
  beaconId: string;
  generation: number;
  acceptedAt: string;
  configuration: RecoveryConfigurationV2;
}

export interface AcceptedRecoveryTrust {
  generation: number;
  signingPublicKey: Uint8Array;
  signingKeyId: string;
}

export interface RecoveryStateSnapshot {
  trust: AcceptedRecoveryTrust;
  activeState: AcceptedRecoveryState | null;
}

function recoveryStateDirectory(): string {
  const override = process.env["OCTOC2_STATE_DIR"]?.trim();
  if (override) return override;
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

export function recoveryStatePath(beaconId: string): string {
  return join(recoveryStateDirectory(), `${beaconId}.recovery.json`);
}

function assertAcceptedRecoveryState(
  value: unknown,
  expectedBeaconId: string,
): asserts value is AcceptedRecoveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery state must be an object");
  }
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const expected = [
    "acceptedAt",
    "beaconId",
    "configuration",
    "expiresAt",
    "generation",
    "version",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Recovery state fields are invalid");
  }
  if (state["version"] !== 2 || state["beaconId"] !== expectedBeaconId) {
    throw new Error("Recovery state identity/version mismatch");
  }
  if (
    !Number.isSafeInteger(state["generation"]) ||
    (state["generation"] as number) <= 0
  ) {
    throw new Error("Recovery state generation is invalid");
  }
  if (
    typeof state["acceptedAt"] !== "string" ||
    new Date(state["acceptedAt"]).toISOString() !== state["acceptedAt"]
  ) {
    throw new Error("Recovery state acceptedAt is invalid");
  }
  if (
    typeof state["expiresAt"] !== "string" ||
    new Date(state["expiresAt"]).toISOString() !== state["expiresAt"] ||
    Date.parse(state["expiresAt"]) <= Date.parse(state["acceptedAt"])
  ) {
    throw new Error("Recovery state expiresAt is invalid");
  }
  assertRecoveryConfiguration(state["configuration"]);
  if (
    state["configuration"].github.tokenLease.beaconId !== expectedBeaconId
  ) {
    throw new Error("Recovery state lease belongs to another beacon");
  }
  const outerExpiry = Date.parse(state["expiresAt"] as string);
  const leases = [
    state["configuration"].github.tokenLease,
    ...state["configuration"].proxyRepos.map((proxy) => proxy.tokenLease),
  ];
  if (leases.some((lease) => outerExpiry > Date.parse(lease.expiresAt))) {
    throw new Error("Recovery state outlives a contained token lease");
  }
}

function assertLegacyAcceptedRecoveryState(
  value: unknown,
  expectedBeaconId: string,
): asserts value is LegacyAcceptedRecoveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Legacy recovery state must be an object");
  }
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const expected = [
    "acceptedAt",
    "beaconId",
    "configuration",
    "generation",
    "version",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Legacy recovery state fields are invalid");
  }
  if (state["version"] !== 1 || state["beaconId"] !== expectedBeaconId) {
    throw new Error("Legacy recovery state identity/version mismatch");
  }
  if (
    !Number.isSafeInteger(state["generation"]) ||
    (state["generation"] as number) <= 0
  ) {
    throw new Error("Legacy recovery state generation is invalid");
  }
  if (
    typeof state["acceptedAt"] !== "string" ||
    new Date(state["acceptedAt"]).toISOString() !== state["acceptedAt"]
  ) {
    throw new Error("Legacy recovery state acceptedAt is invalid");
  }
  assertRecoveryConfiguration(state["configuration"]);
  if (
    state["configuration"].github.tokenLease.beaconId !== expectedBeaconId
  ) {
    throw new Error("Legacy recovery state lease belongs to another beacon");
  }
}

async function extractAcceptedRecoveryTrust(
  state: AcceptedRecoveryState | LegacyAcceptedRecoveryState,
): Promise<AcceptedRecoveryTrust> {
  const signingPublicKey = await decodeBase64Url(
    state.configuration.recoverySigningPublicKey,
  );
  if (
    signingPublicKey.length !== 32 ||
    await ed25519KeyId(signingPublicKey) !==
      state.configuration.recoverySigningKeyId
  ) {
    throw new Error("Recovery state signing trust is invalid");
  }
  return {
    generation: state.generation,
    signingPublicKey: signingPublicKey.slice(),
    signingKeyId: state.configuration.recoverySigningKeyId,
  };
}

export function applyAcceptedRecoveryTrust(
  config: Pick<
    BeaconConfig,
    | "recoveryGeneration"
    | "recoverySigningPublicKey"
    | "recoverySigningKeyId"
  >,
  trust: AcceptedRecoveryTrust,
): void {
  const currentGeneration = config.recoveryGeneration ?? 0;
  if (trust.generation < currentGeneration) {
    throw new Error("Persisted recovery trust generation is stale");
  }
  if (trust.generation === currentGeneration) {
    const currentPublicKey = config.recoverySigningPublicKey;
    if (
      config.recoverySigningKeyId !== trust.signingKeyId ||
      currentPublicKey === undefined ||
      currentPublicKey.length !== trust.signingPublicKey.length ||
      currentPublicKey.some(
        (byte, index) => byte !== trust.signingPublicKey[index],
      )
    ) {
      throw new Error("Persisted recovery trust conflicts at the same generation");
    }
    return;
  }
  config.recoveryGeneration = trust.generation;
  config.recoverySigningPublicKey = trust.signingPublicKey.slice();
  config.recoverySigningKeyId = trust.signingKeyId;
}

export async function loadRecoveryStateSnapshot(
  beaconId: string,
  now = Date.now(),
): Promise<RecoveryStateSnapshot | null> {
  const path = recoveryStatePath(beaconId);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { version?: unknown }).version === 1
  ) {
    // Version 1 did not retain the signed outer expiry, so its credentials
    // remain unusable. The already-accepted monotonic generation and next
    // signing key are still safe to retain as trust-only restart metadata.
    assertLegacyAcceptedRecoveryState(parsed, beaconId);
    return {
      trust: await extractAcceptedRecoveryTrust(parsed),
      activeState: null,
    };
  }
  assertAcceptedRecoveryState(parsed, beaconId);
  const trust = await extractAcceptedRecoveryTrust(parsed);
  const expired =
    Date.parse(parsed.expiresAt) <= now ||
    Date.parse(parsed.configuration.github.tokenLease.expiresAt) <= now ||
    parsed.configuration.proxyRepos.some(
      (proxy) => Date.parse(proxy.tokenLease.expiresAt) <= now,
    );
  return {
    trust,
    activeState: expired ? null : structuredClone(parsed),
  };
}

export async function loadAcceptedRecoveryState(
  beaconId: string,
  now = Date.now(),
): Promise<AcceptedRecoveryState | null> {
  return (await loadRecoveryStateSnapshot(beaconId, now))?.activeState ?? null;
}

export async function saveAcceptedRecoveryState(
  state: AcceptedRecoveryState,
): Promise<void> {
  assertAcceptedRecoveryState(state, state.beaconId);
  await extractAcceptedRecoveryTrust(state);
  const path = recoveryStatePath(state.beaconId);
  const temp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
}
