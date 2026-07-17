/** Guarded real GitHub Actions OIDC signature and provenance qualification. */

import { Octokit } from "@octokit/rest";
import { randomUUID } from "node:crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, ms));
}

function workflow(branch: string): string {
  return [
    "name: Transport identity qualification",
    "",
    "on:",
    "  push:",
    "    branches:",
    `      - ${branch}`,
    "",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Verify GitHub-issued identity",
    "        shell: bash",
    "        env:",
    "          EXPECTED_AUDIENCE: github-actions",
    "          EXPECTED_REPOSITORY: ${{ github.repository }}",
    "          EXPECTED_OWNER: ${{ github.repository_owner }}",
    "          EXPECTED_REF: ${{ github.ref }}",
    "        run: |",
    "          set -euo pipefail",
    "          response=\"$(curl --fail --silent --show-error \\",
    "            -H \"Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}\" \\",
    "            \"${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${EXPECTED_AUDIENCE}\")\"",
    "          OIDC_JWT=\"$(jq -er '.value' <<<\"${response}\")\"",
    "          export OIDC_JWT",
    "          work=\"${RUNNER_TEMP}/identity-verify\"",
    "          mkdir -p \"${work}\"",
    "          cd \"${work}\"",
    "          npm --silent install --no-save --ignore-scripts jose@6.2.2",
    "          node --input-type=module <<'NODE'",
    "          import { createRemoteJWKSet, jwtVerify } from 'jose';",
    "          const token = process.env.OIDC_JWT;",
    "          delete process.env.OIDC_JWT;",
    "          if (!token) throw new Error('missing ephemeral identity');",
    "          const jwks = createRemoteJWKSet(",
    "            new URL('https://token.actions.githubusercontent.com/.well-known/jwks'),",
    "          );",
    "          const { payload, protectedHeader } = await jwtVerify(token, jwks, {",
    "            issuer: 'https://token.actions.githubusercontent.com',",
    "            audience: process.env.EXPECTED_AUDIENCE,",
    "            algorithms: ['RS256'],",
    "          });",
    "          if (protectedHeader.alg !== 'RS256') throw new Error('unexpected signing algorithm');",
    "          if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('subject missing');",
    "          if (payload.repository !== process.env.EXPECTED_REPOSITORY) throw new Error('repository mismatch');",
    "          if (payload.repository_owner !== process.env.EXPECTED_OWNER) throw new Error('owner mismatch');",
    "          if (payload.ref !== process.env.EXPECTED_REF) throw new Error('ref mismatch');",
    "          if (payload.runner_environment !== 'github-hosted') throw new Error('runner mismatch');",
    "          if (typeof payload.workflow !== 'string' || !payload.workflow) throw new Error('workflow missing');",
    "          if (typeof payload.jti !== 'string' || !payload.jti) throw new Error('jti missing');",
    "          if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') throw new Error('lifetime missing');",
    "          if (payload.exp <= payload.iat || payload.exp - payload.iat > 600) throw new Error('lifetime invalid');",
    "          console.log('oidc_signature_and_claims=true');",
    "          NODE",
    "          unset OIDC_JWT response",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Pass --execute to authorize one disposable Actions run");
  }
  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const repo = required("OCTOC2_LIVE_REPO_NAME");
  const forbidden = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  const token = required("OCTOC2_LIVE_GITHUB_TOKEN");
  const cleanupToken = required("OCTOC2_LIVE_ACTIONS_CLEANUP_TOKEN");
  if (owner.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("The configured forbidden account cannot host this test");
  }
  const octokit = new Octokit({ auth: token });
  const cleanup = new Octokit({ auth: cleanupToken });
  const identity = await octokit.rest.users.getAuthenticated();
  if (identity.data.login.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("Live Actions credential resolves to the forbidden account");
  }
  const cleanupIdentity = await cleanup.rest.users.getAuthenticated();
  if (cleanupIdentity.data.login.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("Actions cleanup credential resolves to the forbidden account");
  }
  const repository = await octokit.rest.repos.get({ owner, repo });
  if (!repository.data.private) throw new Error("OIDC qualification requires a private repo");

  const suffix = randomUUID().slice(0, 8);
  const branch = `live-identity-${suffix}`;
  const workflowPath = `.github/workflows/identity-${suffix}.yml`;
  let branchCreated = false;
  let runId: number | null = null;
  let commitSha: string | null = null;
  try {
    const baseRef = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${repository.data.default_branch}`,
    });
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseRef.data.object.sha,
    });
    branchCreated = true;
    const baseCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseRef.data.object.sha,
    });
    const blob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: workflow(branch),
      encoding: "utf-8",
    });
    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: [{
        path: workflowPath,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      }],
    });
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: "temporary identity transport qualification",
      tree: tree.data.sha,
      parents: [baseRef.data.object.sha],
    });
    commitSha = commit.data.sha;
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
      force: false,
    });
    console.log("oidc_fixture_branch_created=true");

    const discoveryDeadline = Date.now() + 120_000;
    while (Date.now() < discoveryDeadline && runId === null) {
      await pause(3_000);
      const runs = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch,
        event: "push",
        per_page: 20,
      });
      const run = runs.data.workflow_runs.find((candidate) =>
        candidate.head_sha === commitSha && candidate.head_branch === branch
      );
      if (run) runId = run.id;
    }
    if (runId === null) throw new Error("GitHub did not create the OIDC workflow run");
    console.log("oidc_workflow_started=true");

    const completionDeadline = Date.now() + 8 * 60_000;
    let conclusion: string | null = null;
    while (Date.now() < completionDeadline) {
      const run = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      if (run.data.status === "completed") {
        conclusion = run.data.conclusion;
        break;
      }
      await pause(5_000);
    }
    console.log(`oidc_workflow_success=${conclusion === "success"}`);
    if (conclusion !== "success") {
      throw new Error(`OIDC workflow did not succeed (${conclusion ?? "timeout"})`);
    }
    console.log("oidc_live_qualification=true");
  } finally {
    if (runId !== null) {
      let deleted = false;
      await cleanup.rest.actions.deleteWorkflowRun({
        owner,
        repo,
        run_id: runId,
      }).then(() => {
        deleted = true;
      }).catch(() => undefined);
      console.log(`oidc_workflow_run_deleted=${deleted}`);
    }
    if (branchCreated) {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      }).catch(() => undefined);
      console.log("oidc_fixture_branch_deleted=true");
    }
  }
}

await main();
