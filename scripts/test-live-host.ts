/**
 * Guarded compiled-host smoke test.
 *
 * Builds a disposable native Windows beacon, starts an isolated controller,
 * verifies Issues registration plus the authenticated registration ACK, and
 * removes every local and GitHub artifact in finally.
 */

import { Octokit } from "@octokit/rest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import {
  bytesToBase64,
  generateOperatorKeyPair,
} from "../server/src/crypto/sodium.ts";

const OWNER_VAR = "MONITORING_PUBKEY";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));
}

async function textOrEmpty(path: string): Promise<string> {
  return await readFile(path, "utf8").catch(() => "");
}

async function stopProcess(process: Bun.Subprocess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await Promise.race([process.exited, pause(5_000)]);
  if (process.exitCode === null) process.kill(9);
}

function verifiedTemporaryPath(path: string): string {
  const resolvedTemp = resolve(path);
  const tempPrefix = `${resolve(tmpdir())}${sep}`;
  if (!resolvedTemp.startsWith(tempPrefix)) {
    throw new Error("Refusing to remove host-smoke path outside the OS temp directory");
  }
  return resolvedTemp;
}

async function allowedLogin(token: string, forbidden: string): Promise<string> {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  if (data.login.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("A live credential resolves to the configured forbidden account");
  }
  return data.login;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Pass --execute to authorize the disposable host smoke test");
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This host smoke harness currently requires Windows x64");
  }

  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const repo = required("OCTOC2_LIVE_REPO_NAME");
  const forbidden = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  const cleanupToken = required("OCTOC2_LIVE_CLEANUP_TOKEN");
  const serverToken = required("OCTOC2_SERVER_GITHUB_TOKEN");
  const serverGistToken = required("OCTOC2_SERVER_GIST_TOKEN");
  const beaconToken = required("OCTOC2_LIVE_BEACON_TOKEN");
  if (owner.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("The configured forbidden account cannot host this test");
  }
  if (new Set([cleanupToken, serverToken, serverGistToken, beaconToken]).size !== 4) {
    throw new Error("Host smoke credentials must remain role-separated");
  }
  await Promise.all([
    allowedLogin(cleanupToken, forbidden),
    allowedLogin(serverToken, forbidden),
    allowedLogin(serverGistToken, forbidden),
    allowedLogin(beaconToken, forbidden),
  ]);

  const cleanup = new Octokit({ auth: cleanupToken });
  const repository = await cleanup.rest.repos.get({ owner, repo });
  if (repository.data.private !== true) {
    throw new Error("Host smoke testing requires the approved private repository");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "octoc2-host-smoke-"));
  const binary = join(tempRoot, "host-smoke.exe");
  const enrollmentPath = `${binary}.enrollment.json`;
  const serverOut = join(tempRoot, "server.out");
  const serverErr = join(tempRoot, "server.err");
  const implantOut = join(tempRoot, "implant.out");
  const implantErr = join(tempRoot, "implant.err");
  let server: Bun.Subprocess | null = null;
  let implant: Bun.Subprocess | null = null;
  let previousVariable: string | null = null;
  let variableChanged = false;
  let beaconId: string | null = null;
  let issueCleanup = "not-created";

  try {
    const operator = await generateOperatorKeyPair();
    const operatorPublic = await bytesToBase64(operator.publicKey);
    const operatorSecret = await bytesToBase64(operator.secretKey);
    const variables = await cleanup.rest.actions.listRepoVariables({
      owner,
      repo,
      per_page: 100,
    });
    const current = variables.data.variables.find(
      (variable) => variable.name === OWNER_VAR,
    );
    if (current) {
      previousVariable = current.value;
      await cleanup.rest.actions.updateRepoVariable({
        owner,
        repo,
        name: OWNER_VAR,
        value: operatorPublic,
      });
    } else {
      await cleanup.rest.actions.createRepoVariable({
        owner,
        repo,
        name: OWNER_VAR,
        value: operatorPublic,
      });
    }
    variableChanged = true;

    const runtimeDir = dirname(process.execPath);
    const childEnv = {
      ...process.env,
      PATH: `${runtimeDir}${delimiter}${process.env.PATH ?? ""}`,
      OCTOC2_REPO_OWNER: owner,
      OCTOC2_REPO_NAME: repo,
    };
    const build = Bun.spawn([
      process.execPath,
      "run",
      "octoctl/src/index.ts",
      "build-beacon",
      "--outfile",
      binary,
      "--target",
      "bun-windows-x64",
      "--tentacle-priority",
      "issues",
      "--no-random-title",
    ], {
      cwd: process.cwd(),
      env: childEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await build.exited !== 0) throw new Error("Disposable beacon build failed");

    const enrollment = JSON.parse(await readFile(enrollmentPath, "utf8")) as {
      beaconId?: unknown;
    };
    if (typeof enrollment.beaconId !== "string") {
      throw new Error("Disposable enrollment artifact is invalid");
    }
    beaconId = enrollment.beaconId;

    server = Bun.spawn([process.execPath, "run", "server/src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        OCTOC2_SERVER_GITHUB_TOKEN: serverToken,
        OCTOC2_SERVER_GIST_TOKEN: serverGistToken,
        OCTOC2_OPERATOR_SECRET: operatorSecret,
        MONITORING_PUBKEY: operatorPublic,
        OCTOC2_DATA_DIR: join(tempRoot, "data"),
        OCTOC2_ENROLLMENT_DIR: tempRoot,
        OCTOC2_POLL_INTERVAL_MS: "1000",
        OCTOC2_HTTP_ENABLED: "false",
        OCTOC2_GRPC_ENABLED: "false",
      },
      stdout: Bun.file(serverOut),
      stderr: Bun.file(serverErr),
    });
    await pause(4_000);
    if (server.exitCode !== null) throw new Error("Disposable controller exited early");

    implant = Bun.spawn([binary], {
      cwd: tempRoot,
      env: {
        ...childEnv,
        SVC_GITHUB_TOKEN: beaconToken,
        OCTOC2_OPERATOR_PUBKEY: operatorPublic,
        OCTOC2_STATE_DIR: join(tempRoot, "state"),
        SVC_TENTACLE_PRIORITY: "issues",
        SVC_SLEEP: "2",
        SVC_JITTER: "0",
        SVC_POLL_TIMEOUT_MS: "20000",
        SVC_POLL_RETRY_MS: "1000",
        OCTOC2_LOG_LEVEL: "info",
        SVC_GITHUB_TOKEN_LEASE: "",
      },
      stdout: Bun.file(implantOut),
      stderr: Bun.file(implantErr),
    });

    const deadline = Date.now() + 90_000;
    let serverRegistered = false;
    let implantAcked = false;
    while (Date.now() < deadline && implant.exitCode === null) {
      await pause(2_000);
      const serverLog = `${await textOrEmpty(serverOut)} ${await textOrEmpty(serverErr)}`;
      const implantLog = `${await textOrEmpty(implantOut)} ${await textOrEmpty(implantErr)}`;
      serverRegistered =
        serverLog.includes("Posted deploy comment (ref=reg-ack)") &&
        serverLog.includes(beaconId);
      implantAcked = implantLog.includes("[IssuesTentacle] Registered. Server responded");
      if (serverRegistered && implantAcked) break;
    }
    console.log(`host_binary_started=${implant.exitCode === null}`);
    console.log(`server_observed_registration=${serverRegistered}`);
    console.log(`implant_verified_registration_ack=${implantAcked}`);
    if (!serverRegistered || !implantAcked) {
      throw new Error("Compiled host registration did not complete before timeout");
    }
    console.log("host_smoke_passed=true");
  } finally {
    if (implant) await stopProcess(implant);
    if (server) await stopProcess(server);

    if (variableChanged) {
      if (previousVariable === null) {
        await cleanup.rest.actions.deleteRepoVariable({
          owner,
          repo,
          name: OWNER_VAR,
        }).catch((error: any) => {
          if (error?.status !== 404) throw error;
        });
      } else {
        await cleanup.rest.actions.updateRepoVariable({
          owner,
          repo,
          name: OWNER_VAR,
          value: previousVariable,
        });
      }
    }

    if (beaconId) {
      const issues = await cleanup.paginate(cleanup.rest.issues.listForRepo, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      });
      const issue = issues.find((candidate) =>
        !candidate.pull_request && candidate.body?.includes(`<!-- node:${beaconId} -->`)
      );
      if (issue) {
        const comments = await cleanup.paginate(cleanup.rest.issues.listComments, {
          owner,
          repo,
          issue_number: issue.number,
          per_page: 100,
        });
        for (const comment of comments) {
          await cleanup.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: comment.id,
          }).catch(() => undefined);
        }
        try {
          await cleanup.graphql(
            "mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}",
            { id: issue.node_id },
          );
          issueCleanup = "deleted";
        } catch {
          await cleanup.rest.issues.update({
            owner,
            repo,
            issue_number: issue.number,
            state: "closed",
            title: "Closed maintenance record",
            body: "",
          });
          issueCleanup = "closed-and-sanitized";
        }
      } else {
        issueCleanup = "not-found";
      }
    }
    console.log(`test_issue_cleanup=${issueCleanup}`);

    await rm(verifiedTemporaryPath(tempRoot), { recursive: true, force: true });
    console.log("local_test_artifacts_remaining=0");
  }
}

await main();
