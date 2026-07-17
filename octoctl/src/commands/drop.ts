/**
 * octoctl drop
 *
 * Builds and publishes deterministic recovery records. Records are complete
 * configuration replacements, signed by the provisioned controller recovery
 * key, then sealed to the beacon X25519 public key. The recovery repository is
 * dedicated, publicly readable, and writable only with the operator credential.
 */

import {
  assertRecoveryConfiguration,
  canonicalJson,
  createRecoveryRecord,
  decodeBase64Url,
  recoveryDropPath,
  verifyRecoveryRecord,
  type RecoveryConfigurationV2,
} from "@octoc2/shared";
import { readFile } from "node:fs/promises";
import { getBeacon } from "../lib/registry.ts";
import { base64ToBytes, sealBox } from "../lib/crypto.ts";

const GITHUB_API_BASE = "https://api.github.com";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BuildDropPayloadInput {
  beaconId: string;
  beaconPublicKeyB64: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  recoverySigningKeyId: string;
  recoverySigningPublicKeyB64: string;
  recoverySigningSecretKeyB64: string;
  configuration: RecoveryConfigurationV2;
}

export interface RecoveryRepositoryTarget {
  owner: string;
  repo: string;
  ref: string;
}

export interface PublishRecoveryDropInput {
  beaconId: string;
  ciphertext: string;
  writerToken: string;
  target: RecoveryRepositoryTarget;
  apiBase?: string;
  fetchImpl?: FetchLike;
}

export interface PublishedRecoveryDrop {
  path: string;
  htmlUrl: string | null;
  updated: boolean;
}

function requireString(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) throw new Error(`${name} is required`);
  return normalized;
}

function requireRepositorySegment(value: string, name: string): string {
  const normalized = requireString(value, name);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return normalized;
}

function requireRepositoryRef(value: string): string {
  const normalized = requireString(value, "recovery ref");
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\\") ||
    !/^[A-Za-z0-9_./-]+$/.test(normalized)
  ) {
    throw new Error("recovery ref is invalid");
  }
  return normalized;
}

function encodeContentPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export async function buildDropPayload(
  input: BuildDropPayloadInput,
): Promise<string> {
  assertRecoveryConfiguration(input.configuration);
  const beaconPublicKey = await base64ToBytes(input.beaconPublicKeyB64);
  const signingPublicKey = await decodeBase64Url(
    input.recoverySigningPublicKeyB64,
  );
  const signingSecretKey = await decodeBase64Url(
    input.recoverySigningSecretKeyB64,
  );
  if (beaconPublicKey.length !== 32) {
    throw new Error("Beacon X25519 public key must be 32 bytes");
  }
  if (signingPublicKey.length !== 32 || signingSecretKey.length !== 64) {
    throw new Error("Recovery Ed25519 key lengths are invalid");
  }

  const record = await createRecoveryRecord({
    beaconId: input.beaconId,
    generation: input.generation,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signingKeyId: input.recoverySigningKeyId,
    signingSecretKey,
    configuration: input.configuration,
  });
  const selfCheck = await verifyRecoveryRecord(record, {
    beaconId: input.beaconId,
    minimumGenerationExclusive: input.generation - 1,
    signingPublicKey,
    expectedSigningKeyId: input.recoverySigningKeyId,
    now: new Date(input.issuedAt),
  });
  if (!selfCheck.valid) {
    throw new Error(
      `Recovery record self-verification failed: ${selfCheck.reason}`,
    );
  }
  return sealBox(canonicalJson(record), beaconPublicKey);
}

export async function publishRecoveryDrop(
  input: PublishRecoveryDropInput,
): Promise<PublishedRecoveryDrop> {
  const owner = requireRepositorySegment(input.target.owner, "recovery owner");
  const repo = requireRepositorySegment(input.target.repo, "recovery repo");
  const ref = requireRepositoryRef(input.target.ref);
  const writerToken = requireString(input.writerToken, "recovery writer token");
  const path = await recoveryDropPath(input.beaconId);
  const apiBase = (input.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const repositoryEndpoint =
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const endpoint = `${apiBase}/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/contents/${encodeContentPath(path)}`;
  const headers = {
    Authorization: `Bearer ${writerToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OctoC2-Operator/0.1",
  };

  const repository = await fetchImpl(repositoryEndpoint, { headers });
  if (!repository.ok) {
    const body = await repository.text().catch(() => "(no body)");
    throw new Error(
      `Failed to inspect recovery repository (${repository.status}): ${body}`,
    );
  }
  const repositoryMetadata = await repository.json() as { private?: unknown };
  if (repositoryMetadata.private !== false) {
    throw new Error(
      "Recovery repository must be public for anonymous beacon reads",
    );
  }

  const existing = await fetchImpl(
    `${endpoint}?ref=${encodeURIComponent(ref)}`,
    { headers },
  );
  let sha: string | undefined;
  if (existing.ok) {
    const body = await existing.json() as { sha?: unknown };
    if (typeof body.sha !== "string" || body.sha.trim().length === 0) {
      throw new Error("Recovery repository returned an invalid content SHA");
    }
    sha = body.sha;
  } else if (existing.status !== 404) {
    const body = await existing.text().catch(() => "(no body)");
    throw new Error(
      `Failed to inspect deterministic recovery path (${existing.status}): ${body}`,
    );
  }

  const response = await fetchImpl(endpoint, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Update recovery record for ${input.beaconId}`,
      content: Buffer.from(`${input.ciphertext.trim()}\n`, "utf8").toString(
        "base64",
      ),
      branch: ref,
      ...(sha !== undefined ? { sha } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(
      `Failed to publish recovery record (${response.status}): ${body}`,
    );
  }
  const result = await response.json() as {
    content?: { html_url?: unknown };
  };
  return {
    path,
    htmlUrl:
      typeof result.content?.html_url === "string"
        ? result.content.html_url
        : null,
    updated: sha !== undefined,
  };
}

export interface DropCreateOptions {
  beacon: string;
  dataDir?: string;
  configurationFile?: string;
  generation?: number;
  issuedAt?: string;
  expiresAt?: string;
  recoverySigningSecretFile?: string;
  recoverySigningPublicKey?: string;
  recoverySigningKeyId?: string;
  recoveryOwner?: string;
  recoveryRepo?: string;
  recoveryRef?: string;
  writerToken?: string;
}

async function readBase64KeyFile(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${path} must contain one unpadded base64url key`);
  }
  return value;
}

export async function runDropCreate(opts: DropCreateOptions): Promise<void> {
  const configurationFile = requireString(
    opts.configurationFile,
    "configurationFile",
  );
  const signingSecretFile = requireString(
    opts.recoverySigningSecretFile,
    "recoverySigningSecretFile",
  );
  const generation = opts.generation;
  if (!Number.isSafeInteger(generation) || (generation ?? 0) <= 0) {
    throw new Error("generation must be a positive safe integer");
  }

  const dataDir =
    opts.dataDir ?? process.env["OCTOC2_DATA_DIR"]?.trim() ?? "./data";
  const beacon = await getBeacon(opts.beacon, dataDir);
  if (!beacon) throw new Error(`Beacon '${opts.beacon}' not found in registry`);

  const parsed: unknown = JSON.parse(await readFile(configurationFile, "utf8"));
  assertRecoveryConfiguration(parsed);
  if (parsed.github.tokenLease.beaconId !== beacon.beaconId) {
    throw new Error("Configuration token lease belongs to a different beacon");
  }

  const issuedAt = opts.issuedAt ?? new Date().toISOString();
  const expiresAt = opts.expiresAt ?? parsed.github.tokenLease.expiresAt;
  const signingPublicKey = requireString(
    opts.recoverySigningPublicKey ??
      process.env["OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY"],
    "recoverySigningPublicKey",
  );
  const signingKeyId = requireString(
    opts.recoverySigningKeyId ??
      process.env["OCTOC2_RECOVERY_SIGNING_KEY_ID"],
    "recoverySigningKeyId",
  );
  const ciphertext = await buildDropPayload({
    beaconId: beacon.beaconId,
    beaconPublicKeyB64: beacon.publicKey,
    generation: generation!,
    issuedAt,
    expiresAt,
    recoverySigningKeyId: signingKeyId,
    recoverySigningPublicKeyB64: signingPublicKey,
    recoverySigningSecretKeyB64: await readBase64KeyFile(signingSecretFile),
    configuration: parsed,
  });
  const published = await publishRecoveryDrop({
    beaconId: beacon.beaconId,
    ciphertext,
    writerToken: requireString(
      opts.writerToken ?? process.env["OCTOC2_RECOVERY_WRITE_TOKEN"],
      "writerToken",
    ),
    target: {
      owner: requireString(
        opts.recoveryOwner ?? process.env["OCTOC2_RECOVERY_REPO_OWNER"],
        "recoveryOwner",
      ),
      repo: requireString(
        opts.recoveryRepo ?? process.env["OCTOC2_RECOVERY_REPO_NAME"],
        "recoveryRepo",
      ),
      ref: opts.recoveryRef ??
        process.env["OCTOC2_RECOVERY_REPO_REF"] ??
        "main",
    },
  });

  console.log(
    `Recovery record ${published.updated ? "updated" : "created"}: ` +
      `${published.path}${published.htmlUrl ? ` (${published.htmlUrl})` : ""}`,
  );
}

export interface DropListOptions {
  beacon: string;
  dataDir?: string;
  recoveryOwner?: string;
  recoveryRepo?: string;
  recoveryRef?: string;
}

export async function runDropList(opts: DropListOptions): Promise<void> {
  const dataDir =
    opts.dataDir ?? process.env["OCTOC2_DATA_DIR"]?.trim() ?? "./data";
  const beacon = await getBeacon(opts.beacon, dataDir);
  if (!beacon) throw new Error(`Beacon '${opts.beacon}' not found in registry`);

  const owner = requireRepositorySegment(
    opts.recoveryOwner ??
      process.env["OCTOC2_RECOVERY_REPO_OWNER"] ??
      "",
    "recovery owner",
  );
  const repo = requireRepositorySegment(
    opts.recoveryRepo ??
      process.env["OCTOC2_RECOVERY_REPO_NAME"] ??
      "",
    "recovery repo",
  );
  const ref = requireRepositoryRef(
    opts.recoveryRef ??
      process.env["OCTOC2_RECOVERY_REPO_REF"] ??
      "main",
  );
  const path = await recoveryDropPath(beacon.beaconId);
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/contents/${encodeContentPath(path)}` +
      `?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OctoC2-Operator/0.1",
      },
    },
  );
  if (response.status === 404) {
    console.log(`No recovery record at ${path}`);
    return;
  }
  if (!response.ok) {
    throw new Error(`Failed to inspect recovery record (${response.status})`);
  }
  const result = await response.json() as { html_url?: unknown };
  console.log(
    typeof result.html_url === "string"
      ? `${path}: ${result.html_url}`
      : path,
  );
}
