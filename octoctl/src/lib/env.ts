/**
 * octoctl — environment helpers
 *
 * Resolves operator credentials and repo config from environment variables.
 * All octoctl commands call resolveEnv() as their first step.
 */

import { Octokit } from "@octokit/rest";
import { base64ToBytes, bytesToBase64, openSealBox, generateOperatorKeyPair } from "./crypto.ts";
import { normalizeHttpsControllerUrl } from "./controllerUrl.ts";

export interface OctoctlEnv {
  githubToken:      string;
  owner:            string;
  repo:             string;
  operatorSecretKey: Uint8Array;
  operatorPublicKey: Uint8Array;
  octokit:          Octokit;
  dataDir:          string;
}

/**
 * Resolve operator public key:
 *   1. GitHub repo variable MONITORING_PUBKEY (preferred)
 *   2. MONITORING_PUBKEY env var (fallback)
 */
export async function resolvePublicKey(
  octokit: Octokit,
  owner:   string,
  repo:    string
): Promise<Uint8Array> {
  try {
    const resp = await octokit.rest.actions.getRepoVariable({
      owner, repo, name: "MONITORING_PUBKEY",
    });
    const b64 = resp.data.value?.trim();
    if (b64 && b64.length > 0) {
      const key = await base64ToBytes(b64);
      if (key.length === 32) return key;
    }
  } catch { /* fall through */ }

  const envB64 = process.env["MONITORING_PUBKEY"]?.trim();
  if (envB64 && envB64.length > 0) {
    const key = await base64ToBytes(envB64);
    if (key.length === 32) return key;
  }

  throw new Error(
    "Operator public key not found. " +
    "Set the MONITORING_PUBKEY GitHub repo variable, or export it as an env var."
  );
}

export async function resolveEnv(): Promise<OctoctlEnv> {
  const githubToken =
    process.env["OCTOC2_OPERATOR_GITHUB_TOKEN"]?.trim();
  const owner = process.env["OCTOC2_REPO_OWNER"]?.trim();
  const repo  = process.env["OCTOC2_REPO_NAME"]?.trim();
  const secretB64 = process.env["OCTOC2_OPERATOR_SECRET"]?.trim();
  const dataDir   = process.env["OCTOC2_DATA_DIR"]?.trim() ?? "./data";

  const missing: string[] = [];
  if (!githubToken) missing.push("OCTOC2_OPERATOR_GITHUB_TOKEN");
  if (!owner)     missing.push("OCTOC2_REPO_OWNER");
  if (!repo)      missing.push("OCTOC2_REPO_NAME");
  if (!secretB64) missing.push("OCTOC2_OPERATOR_SECRET");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const operatorSecretKey = await base64ToBytes(secretB64!);
  if (operatorSecretKey.length !== 32) {
    throw new Error("OCTOC2_OPERATOR_SECRET is invalid (expected 32 bytes). Run: octoctl keygen");
  }

  const octokit = new Octokit({
    auth:    githubToken!,
    headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
  });

  const operatorPublicKey = await resolvePublicKey(octokit, owner!, repo!);

  return {
    githubToken:      githubToken!,
    owner:            owner!,
    repo:             repo!,
    operatorSecretKey,
    operatorPublicKey,
    octokit,
    dataDir,
  };
}

export function requireOperatorApiToken(explicit?: string): string {
  const token =
    explicit?.trim() ??
    process.env["OCTOC2_OPERATOR_API_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "OCTOC2_OPERATOR_API_TOKEN is required for controller API access",
    );
  }
  return token;
}

export function requireControllerServerUrl(explicit?: string): string {
  const raw =
    explicit?.trim() ??
    process.env["OCTOC2_SERVER_URL"]?.trim();
  if (!raw) {
    throw new Error(
      "OCTOC2_SERVER_URL is required for controller API access",
    );
  }

  return normalizeHttpsControllerUrl(raw, "OCTOC2_SERVER_URL");
}

export function controllerFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  caFile =
    process.env["OCTOC2_HTTP_CA_CERT"]?.trim() || undefined,
): Promise<Response> {
  return fetch(input, {
    ...init,
    ...(caFile && {
      tls: {
        ca: Bun.file(caFile),
      },
    }),
  });
}

// Re-export crypto helpers that commands need
export { base64ToBytes, bytesToBase64, openSealBox, generateOperatorKeyPair };
