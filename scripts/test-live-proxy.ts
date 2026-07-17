/** Guarded two-repository proxy ingress/egress qualification. */

import { Octokit } from "@octokit/rest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encryptGitHubSecret } from "../octoctl/src/lib/crypto.ts";
import {
  TEMPLATE_FORWARD_REPLIES,
  TEMPLATE_HELPER,
  TEMPLATE_PROCESS_CHECKIN,
  TEMPLATE_SYNC_HELPER,
} from "../octoctl/src/commands/proxyTemplates.ts";
import {
  bytesToBase64,
  generateOperatorKeyPair,
} from "../server/src/crypto/sodium.ts";

interface RepositoryRef {
  owner: string;
  repo: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, ms));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function assertEmptyConfiguration(
  octokit: Octokit,
  repository: RepositoryRef,
  secrets: readonly string[],
  variables: readonly string[],
): Promise<void> {
  const [secretList, variableList] = await Promise.all([
    octokit.rest.actions.listRepoSecrets({ ...repository, per_page: 100 }),
    octokit.rest.actions.listRepoVariables({ ...repository, per_page: 100 }),
  ]);
  const conflicts = [
    ...secretList.data.secrets.map((secret) => secret.name)
      .filter((name) => secrets.includes(name)),
    ...variableList.data.variables.map((variable) => variable.name)
      .filter((name) => variables.includes(name)),
  ];
  if (conflicts.length > 0) {
    throw new Error(
      `${repository.repo} already contains proxy configuration: ${conflicts.join(", ")}`,
    );
  }
}

async function setSecret(
  octokit: Octokit,
  repository: RepositoryRef,
  name: string,
  value: string,
): Promise<void> {
  const key = await octokit.rest.actions.getRepoPublicKey(repository);
  await octokit.rest.actions.createOrUpdateRepoSecret({
    ...repository,
    secret_name: name,
    encrypted_value: await encryptGitHubSecret(value, key.data.key),
    key_id: key.data.key_id,
  });
}

async function setVariable(
  octokit: Octokit,
  repository: RepositoryRef,
  name: string,
  value: string,
): Promise<void> {
  await octokit.rest.actions.createRepoVariable({ ...repository, name, value });
}

async function createWorkflowBranch(
  octokit: Octokit,
  repository: RepositoryRef,
  defaultBranch: string,
  branch: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  const baseRef = await octokit.rest.git.getRef({
    ...repository,
    ref: `heads/${defaultBranch}`,
  });
  const baseCommit = await octokit.rest.git.getCommit({
    ...repository,
    commit_sha: baseRef.data.object.sha,
  });
  const blobs = await Promise.all(files.map(async (file) => ({
    ...file,
    sha: (await octokit.rest.git.createBlob({
      ...repository,
      content: file.content,
      encoding: "utf-8",
    })).data.sha,
  })));
  const tree = await octokit.rest.git.createTree({
    ...repository,
    base_tree: baseCommit.data.tree.sha,
    tree: blobs.map((blob) => ({
      path: blob.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blob.sha,
    })),
  });
  const commit = await octokit.rest.git.createCommit({
    ...repository,
    message: "temporary proxy transport qualification",
    tree: tree.data.sha,
    parents: [baseRef.data.object.sha],
  });
  await octokit.rest.git.createRef({
    ...repository,
    ref: `refs/heads/${branch}`,
    sha: commit.data.sha,
  });
}

async function waitForMarker(
  octokit: Octokit,
  repository: RepositoryRef,
  issueNumber: number,
  marker: string,
  timeoutMs = 5 * 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const comments = await octokit.rest.issues.listComments({
      ...repository,
      issue_number: issueNumber,
      per_page: 100,
    });
    if (comments.data.some((comment) => comment.body?.includes(marker))) return true;
    await pause(5_000);
  }
  return false;
}

async function deleteIssue(
  octokit: Octokit,
  repository: RepositoryRef,
  issueNumber: number,
): Promise<void> {
  const issue = await octokit.rest.issues.get({
    ...repository,
    issue_number: issueNumber,
  }).catch(() => null);
  if (!issue) return;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repository,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const comment of comments) {
    await octokit.rest.issues.deleteComment({
      ...repository,
      comment_id: comment.id,
    }).catch(() => undefined);
  }
  try {
    await octokit.graphql(
      "mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}",
      { id: issue.data.node_id },
    );
  } catch {
    await octokit.rest.issues.update({
      ...repository,
      issue_number: issueNumber,
      state: "closed",
      title: "Closed maintenance record",
      body: "",
    });
  }
}

async function deleteRuns(
  octokit: Octokit,
  repository: RepositoryRef,
  branch: string,
  startedAt: number,
): Promise<number> {
  const runs = await octokit.rest.actions.listWorkflowRunsForRepo({
    ...repository,
    branch,
    per_page: 100,
  });
  const matches = runs.data.workflow_runs.filter((run) =>
    run.head_branch === branch && Date.parse(run.created_at) >= startedAt - 30_000
  );
  for (const run of matches) {
    if (run.status !== "completed") {
      await octokit.rest.actions.cancelWorkflowRun({
        ...repository,
        run_id: run.id,
      }).catch(() => undefined);
      await pause(2_000);
    }
    await octokit.rest.actions.deleteWorkflowRun({
      ...repository,
      run_id: run.id,
    }).catch(() => undefined);
  }
  return matches.length;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Pass --execute to authorize the disposable proxy test");
  }
  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const controlRepo = required("OCTOC2_LIVE_CONTROL_REPO");
  const decoyRepo = required("OCTOC2_LIVE_DECOY_REPO");
  const forbidden = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  const cleanupToken = required("OCTOC2_LIVE_CLEANUP_TOKEN");
  const controlDispatchToken = required("OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN");
  const targetDispatchToken = required("OCTOC2_PROXY_TARGET_DISPATCH_TOKEN");
  if (owner.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("The configured forbidden account cannot host this test");
  }
  if (new Set([cleanupToken, controlDispatchToken, targetDispatchToken]).size !== 3) {
    throw new Error("Proxy credentials must be role-separated");
  }
  const octokit = new Octokit({ auth: cleanupToken });
  for (const token of [cleanupToken, controlDispatchToken, targetDispatchToken]) {
    const identity = await new Octokit({ auth: token }).rest.users.getAuthenticated();
    if (identity.data.login.toLowerCase() === forbidden.toLowerCase()) {
      throw new Error("A proxy credential resolves to the forbidden account");
    }
  }

  const control = { owner, repo: controlRepo };
  const decoy = { owner, repo: decoyRepo };
  const [controlRepository, decoyRepository] = await Promise.all([
    octokit.rest.repos.get(control),
    octokit.rest.repos.get(decoy),
  ]);
  if (!controlRepository.data.private || !decoyRepository.data.private) {
    throw new Error("Proxy qualification requires two private repositories");
  }
  await Promise.all([
    assertEmptyConfiguration(
      octokit,
      control,
      ["TARGET_TOKEN", "RELAY_SIGNING_KEY"],
      ["NODE_ROUTE_MAP", "OCTOC2_PROXY_CONTROL_FINGERPRINTS"],
    ),
    assertEmptyConfiguration(
      octokit,
      decoy,
      ["CONTROL_TOKEN", "CONTROL_OWNER", "CONTROL_REPO", "NODE_ID", "RELAY_SIGNING_KEY"],
      ["FORWARD_ISSUE", "MONITORING_PUBKEY"],
    ),
  ]);

  const suffix = randomUUID().slice(0, 8);
  const controlBranch = `live-control-${suffix}`;
  const decoyBranch = `live-decoy-${suffix}`;
  const controlDefault = controlRepository.data.default_branch;
  const decoyDefault = decoyRepository.data.default_branch;
  const startedAt = Date.now();
  let controlBranchCreated = false;
  let decoyBranchCreated = false;
  let controlDefaultChanged = false;
  let decoyDefaultChanged = false;
  let controlIssue: number | null = null;
  let decoyIssue: number | null = null;
  const controlSecrets = ["TARGET_TOKEN", "RELAY_SIGNING_KEY"];
  const decoySecrets = ["CONTROL_TOKEN", "CONTROL_OWNER", "CONTROL_REPO", "NODE_ID", "RELAY_SIGNING_KEY"];
  const controlVariables = ["NODE_ROUTE_MAP", "OCTOC2_PROXY_CONTROL_FINGERPRINTS"];
  const decoyVariables = ["FORWARD_ISSUE", "MONITORING_PUBKEY"];
  try {
    await createWorkflowBranch(octokit, control, controlDefault, controlBranch, [
      { path: ".github/workflows/process-checkin.yml", content: TEMPLATE_PROCESS_CHECKIN },
      { path: ".github/workflows/forward-replies.yml", content: TEMPLATE_FORWARD_REPLIES },
    ]);
    controlBranchCreated = true;
    await createWorkflowBranch(octokit, decoy, decoyDefault, decoyBranch, [
      { path: ".github/workflows/helper.yml", content: TEMPLATE_HELPER },
      { path: ".github/workflows/sync-helper.yml", content: TEMPLATE_SYNC_HELPER },
    ]);
    decoyBranchCreated = true;

    const controlCreated = await octokit.rest.issues.create({
      ...control,
      title: "Temporary transport coordination",
      body: "Disposable qualification record.",
    });
    controlIssue = controlCreated.data.number;
    const decoyCreated = await octokit.rest.issues.create({
      ...decoy,
      title: "Temporary dependency coordination",
      body: "Disposable qualification record.",
    });
    decoyIssue = decoyCreated.data.number;

    const nodeId = randomUUID();
    const relaySigningKey = randomBytes(48).toString("base64url");
    const operatorKey = await generateOperatorKeyPair();
    const monitoringPublicKey = await bytesToBase64(operatorKey.publicKey);
    await Promise.all([
      setSecret(octokit, control, "TARGET_TOKEN", targetDispatchToken),
      setSecret(octokit, control, "RELAY_SIGNING_KEY", relaySigningKey),
      setSecret(octokit, decoy, "CONTROL_TOKEN", controlDispatchToken),
      setSecret(octokit, decoy, "CONTROL_OWNER", owner),
      setSecret(octokit, decoy, "CONTROL_REPO", controlRepo),
      setSecret(octokit, decoy, "NODE_ID", nodeId),
      setSecret(octokit, decoy, "RELAY_SIGNING_KEY", relaySigningKey),
    ]);
    await Promise.all([
      setVariable(octokit, decoy, "FORWARD_ISSUE", String(decoyIssue)),
      setVariable(octokit, decoy, "MONITORING_PUBKEY", monitoringPublicKey),
      setVariable(
        octokit,
        control,
        "NODE_ROUTE_MAP",
        JSON.stringify({
          [nodeId]: {
            controlIssue,
            decoyRepository: `${owner}/${decoyRepo}`,
            decoyIssue,
          },
        }),
      ),
      setVariable(
        octokit,
        control,
        "OCTOC2_PROXY_CONTROL_FINGERPRINTS",
        JSON.stringify({
          version: 1,
          relaySigningKeySha256: sha256(relaySigningKey),
          targetDispatchTokenSha256: sha256(targetDispatchToken),
        }),
      ),
    ]);

    await octokit.rest.repos.update({ ...control, default_branch: controlBranch });
    controlDefaultChanged = true;
    await octokit.rest.repos.update({ ...decoy, default_branch: decoyBranch });
    decoyDefaultChanged = true;
    console.log("proxy_workflow_branches_active=true");
    await pause(8_000);

    const ingressBody = [
      `<!-- job:${Math.floor(Date.now() / 1000)}:reg:0001 -->`,
      "<!-- infra-diagnostic:qualification -->",
      "<!-- - -->",
    ].join("\n");
    await octokit.rest.issues.createComment({
      ...decoy,
      issue_number: decoyIssue,
      body: ingressBody,
    });
    const ingress = await waitForMarker(
      octokit,
      control,
      controlIssue,
      "<!-- octoc2-relay:ingress:",
    );
    console.log(`proxy_ingress_relayed=${ingress}`);
    if (!ingress) throw new Error("Proxy ingress did not reach the control issue");

    await octokit.rest.issues.createComment({
      ...control,
      issue_number: controlIssue,
      body: `Temporary relay response ${suffix}`,
    });
    const egress = await waitForMarker(
      octokit,
      decoy,
      decoyIssue,
      "<!-- octoc2-relay:egress:",
    );
    console.log(`proxy_egress_relayed=${egress}`);
    if (!egress) throw new Error("Proxy egress did not return to the decoy issue");
    console.log("proxy_live_qualification=true");
  } finally {
    if (decoyDefaultChanged) {
      await octokit.rest.repos.update({ ...decoy, default_branch: decoyDefault });
    }
    if (controlDefaultChanged) {
      await octokit.rest.repos.update({ ...control, default_branch: controlDefault });
    }
    if (decoyIssue !== null) await deleteIssue(octokit, decoy, decoyIssue);
    if (controlIssue !== null) await deleteIssue(octokit, control, controlIssue);
    for (const name of decoySecrets) {
      await octokit.rest.actions.deleteRepoSecret({
        ...decoy,
        secret_name: name,
      }).catch(() => undefined);
    }
    for (const name of controlSecrets) {
      await octokit.rest.actions.deleteRepoSecret({
        ...control,
        secret_name: name,
      }).catch(() => undefined);
    }
    for (const name of decoyVariables) {
      await octokit.rest.actions.deleteRepoVariable({
        ...decoy,
        name,
      }).catch(() => undefined);
    }
    for (const name of controlVariables) {
      await octokit.rest.actions.deleteRepoVariable({
        ...control,
        name,
      }).catch(() => undefined);
    }
    const decoyRuns = await deleteRuns(octokit, decoy, decoyBranch, startedAt)
      .catch(() => 0);
    const controlRuns = await deleteRuns(octokit, control, controlBranch, startedAt)
      .catch(() => 0);
    if (decoyBranchCreated) {
      await octokit.rest.git.deleteRef({
        ...decoy,
        ref: `heads/${decoyBranch}`,
      }).catch(() => undefined);
    }
    if (controlBranchCreated) {
      await octokit.rest.git.deleteRef({
        ...control,
        ref: `heads/${controlBranch}`,
      }).catch(() => undefined);
    }
    console.log(`proxy_workflow_runs_cleaned=${decoyRuns + controlRuns}`);
    console.log("proxy_cleanup_completed=true");
  }
}

await main();
