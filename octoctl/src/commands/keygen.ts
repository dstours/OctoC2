/**
 * octoctl keygen
 *
 * Generate a fresh X25519 operator key pair. Prints both values to stdout.
 *
 * Usage:
 *   octoctl keygen
 *   octoctl keygen --set-variable   # also pushes pubkey to GitHub Variable
 *
 * After running:
 *   1. Set OCTOC2_OPERATOR_SECRET=<secret> in your server environment (NEVER commit)
 *   2. Set MONITORING_PUBKEY as a GitHub repo Variable (octoctl keygen --set-variable)
 *      or manually via the GitHub UI → Settings → Variables
 */

import { generateOperatorKeyPair, bytesToBase64 } from "../lib/crypto.ts";
import { Octokit } from "@octokit/rest";

export interface KeygenOptions {
  setVariable: boolean;
}

export async function runKeygen(opts: KeygenOptions): Promise<void> {
  const kp        = await generateOperatorKeyPair();
  const publicB64 = await bytesToBase64(kp.publicKey);
  const secretB64 = await bytesToBase64(kp.secretKey);

  console.log("");
  console.log("  Operator Key Pair");
  console.log("  " + "─".repeat(60));
  console.log("");
  console.log(`  Public key  (GitHub Variable / env):  ${publicB64}`);
  console.log("");
  console.log(`  Secret key  (server env ONLY):         ${secretB64}`);
  console.log("");
  console.log("  " + "─".repeat(60));
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Set the secret key in your server environment:");
  console.log(`       export OCTOC2_OPERATOR_SECRET=${secretB64}`);
  console.log("");
  console.log("    2. Store the public key as a GitHub repo variable:");
  console.log(`       gh variable set MONITORING_PUBKEY --body '${publicB64}'`);
  console.log("       (or use: octoctl keygen --set-variable)");
  console.log("");

  if (!opts.setVariable) return;

  // Push public key to GitHub Variable
  const token = process.env["OCTOC2_GITHUB_TOKEN"]?.trim();
  const owner = process.env["OCTOC2_REPO_OWNER"]?.trim();
  const repo  = process.env["OCTOC2_REPO_NAME"]?.trim();

  if (!token || !owner || !repo) {
    console.error(
      "  Cannot set GitHub Variable: OCTOC2_GITHUB_TOKEN, OCTOC2_REPO_OWNER, " +
      "and OCTOC2_REPO_NAME must be set."
    );
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token, headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" } });

  try {
    // Create or update the variable
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/variables",
      { owner, repo, name: "MONITORING_PUBKEY", value: publicB64 }
    ).catch(async () => {
      // Variable exists — update it
      await octokit.request(
        "PATCH /repos/{owner}/{repo}/actions/variables/{name}",
        { owner, repo, name: "MONITORING_PUBKEY", value: publicB64 }
      );
    });

    console.log(`  GitHub Variable 'MONITORING_PUBKEY' set on ${owner}/${repo}`);
  } catch (err) {
    console.error("  Failed to set GitHub Variable:", (err as Error).message);
    process.exit(1);
  }
}
