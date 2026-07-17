import assert from "node:assert/strict";
import { afterAll, describe, test } from "bun:test";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ed25519KeyId,
  encodeBase64Url,
} from "@octoc2/shared";
import {
  runPreflight,
  type PreflightOptions,
} from "../test-end-to-end.ts";

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirectories.map((path) =>
      rm(path, { recursive: true, force: true })),
  );
});

function rawPublicKey(key: ReturnType<typeof createPublicKey>): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der).subarray(-32);
}

function privateSeed(
  key: ReturnType<typeof generateKeyPairSync>["privateKey"],
): Buffer {
  const der = key.export({ type: "pkcs8", format: "der" });
  return Buffer.from(der).subarray(-32);
}

function createHttpTlsFiles(directory: string): {
  certificatePath: string;
  privateKeyPath: string;
} {
  const certificatePath = join(directory, "http-server.crt");
  const privateKeyPath = join(directory, "http-server.key");
  const openssl = Bun.which("openssl") ??
    [
      "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
      "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    ].find((candidate) => existsSync(candidate));
  if (!openssl) throw new Error("openssl is required for the E2E preflight test");
  const result = spawnSync(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
  ], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr || result.stdout}`);
  }
  return { certificatePath, privateKeyPath };
}

describe("secure E2E prerequisite gate", () => {
  test("accepts a complete isolated local declaration without claiming live execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octoc2-e2e-"));
    tempDirectories.push(directory);

    const beaconId = "123e4567-e89b-42d3-a456-426614174000";
    const enrollmentSigningPublic = randomBytes(32);
    const operator = generateKeyPairSync("x25519");
    const operatorSecret = privateSeed(operator.privateKey);
    const monitoringPublic = rawPublicKey(operator.publicKey);
    const recovery = generateKeyPairSync("ed25519");
    const recoverySeed = privateSeed(recovery.privateKey);
    const recoveryPublic = rawPublicKey(recovery.publicKey);
    const recoverySecret = Buffer.concat([recoverySeed, recoveryPublic]);
    const app = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const enrollmentPath = join(directory, "beacon.enrollment.json");
    const beaconPath = join(directory, "beacon");
    const appPath = join(directory, "github-app.pem");
    const recoverySecretPath = join(directory, "recovery-signing.key");
    const httpTls = createHttpTlsFiles(directory);
    await Promise.all([
      writeFile(
        enrollmentPath,
        JSON.stringify({
          version: 1,
          beaconId,
          encryptionPublicKey: encodeBase64Url(randomBytes(32)),
          signingPublicKey: encodeBase64Url(enrollmentSigningPublic),
          signingKeyId: await ed25519KeyId(enrollmentSigningPublic),
          createdAt: new Date().toISOString(),
        }),
      ),
      writeFile(beaconPath, "synthetic recovery-only beacon fixture"),
      writeFile(
        appPath,
        app.privateKey.export({ type: "pkcs8", format: "pem" }),
      ),
      writeFile(recoverySecretPath, encodeBase64Url(recoverySecret)),
    ]);

    const credentials = {
      server: `server-${randomBytes(24).toString("hex")}`,
      operatorGitHub: `operator-github-${randomBytes(24).toString("hex")}`,
      operatorApi: `operator-api-${randomBytes(24).toString("hex")}`,
      beaconApi: `beacon-api-${randomBytes(24).toString("hex")}`,
      recoveryWriter: `recovery-${randomBytes(24).toString("hex")}`,
      controlDispatch: `control-${randomBytes(24).toString("hex")}`,
      targetDispatch: `target-${randomBytes(24).toString("hex")}`,
    };
    const appPolicies = {
      [beaconId]: {
        installationId: 101,
        repository: { owner: "example", repo: "isolated-control" },
        permissions: {
          metadata: "read",
          issues: "write",
          variables: "read",
        },
        proxyRepositories: [
          {
            installationId: 202,
            repository: { owner: "example", repo: "isolated-decoy" },
            permissions: {
              metadata: "read",
              issues: "write",
              variables: "read",
            },
          },
        ],
      },
    };
    const recoveryPolicies = {
      [beaconId]: {
        serverUrl: "https://127.0.0.1:8080",
        controllerToken: credentials.beaconApi,
        monitoringPublicKey: encodeBase64Url(monitoringPublic),
        tentaclePriority: ["proxy", "issues"],
        relayConsortium: [],
        proxyRepos: [
          {
            owner: "example",
            repo: "isolated-decoy",
            innerKind: "issues",
            decoyIssue: 7,
          },
        ],
        sleepSeconds: 60,
        jitter: 0.2,
      },
    };
    const env: NodeJS.ProcessEnv = {
      OCTOC2_E2E_AUTHORIZED: "true",
      OCTOC2_E2E_CLEANUP_ACK: "true",
      OCTOC2_E2E_CLEANUP_OWNER: "authorized-operator",
      OCTOC2_E2E_BEACON_ID: beaconId,
      OCTOC2_ENROLLMENT_DIR: directory,
      OCTOC2_E2E_ENROLLMENT_FILE: enrollmentPath,
      OCTOC2_E2E_BEACON_BINARY: beaconPath,
      OCTOC2_REPO_OWNER: "example",
      OCTOC2_REPO_NAME: "isolated-control",
      OCTOC2_PROXY_CONTROL_OWNER: "example",
      OCTOC2_PROXY_CONTROL_REPO: "isolated-control",
      OCTOC2_PROXY_DECOY_OWNER: "example",
      OCTOC2_PROXY_DECOY_REPO: "isolated-decoy",
      OCTOC2_RECOVERY_REPO_OWNER: "example",
      OCTOC2_RECOVERY_REPO_NAME: "public-recovery",
      OCTOC2_RECOVERY_REPO_REF: "main",
      OCTOC2_SERVER_GITHUB_TOKEN: credentials.server,
      OCTOC2_OPERATOR_GITHUB_TOKEN: credentials.operatorGitHub,
      OCTOC2_OPERATOR_API_TOKEN: credentials.operatorApi,
      OCTOC2_BEACON_API_TOKEN: credentials.beaconApi,
      OCTOC2_BEACON_API_TOKENS: JSON.stringify({
        [beaconId]: credentials.beaconApi,
      }),
      OCTOC2_RECOVERY_WRITE_TOKEN: credentials.recoveryWriter,
      OCTOC2_PROXY_CONTROL_DISPATCH_TOKEN: credentials.controlDispatch,
      OCTOC2_PROXY_TARGET_DISPATCH_TOKEN: credentials.targetDispatch,
      OCTOC2_PROXY_RELAY_SIGNING_KEY:
        `relay-${randomBytes(32).toString("hex")}`,
      OCTOC2_OPERATOR_SECRET: encodeBase64Url(operatorSecret),
      MONITORING_PUBKEY: encodeBase64Url(monitoringPublic),
      OCTOC2_RECOVERY_PUBLISH_ENABLED: "true",
      OCTOC2_GITHUB_APP_ID: "12345",
      OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE: appPath,
      OCTOC2_GITHUB_APP_POLICIES: JSON.stringify(appPolicies),
      OCTOC2_RECOVERY_POLICIES: JSON.stringify(recoveryPolicies),
      OCTOC2_RECOVERY_SIGNING_SECRET_FILE: recoverySecretPath,
      OCTOC2_RECOVERY_SIGNING_PUBLIC_KEY:
        encodeBase64Url(recoveryPublic),
      OCTOC2_RECOVERY_SIGNING_KEY_ID:
        await ed25519KeyId(recoveryPublic),
      OCTOC2_HTTP_ENABLED: "true",
      OCTOC2_HTTP_HOST: "127.0.0.1",
      OCTOC2_HTTP_PORT: "8080",
      OCTOC2_HTTP_SERVER_CERT: httpTls.certificatePath,
      OCTOC2_HTTP_SERVER_KEY: httpTls.privateKeyPath,
      OCTOC2_HTTP_CA_CERT: httpTls.certificatePath,
    };
    const options: PreflightOptions = {
      dryRun: true,
      checkGitHub: false,
      grpc: false,
      beaconHttp: false,
      json: false,
    };

    const report = await runPreflight(env, options);

    assert.equal(report.ok, true);
    assert.equal(report.scope, "local");
    assert.equal(report.liveExecutionPerformed, false);
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.includes(
      "Preflight only: no controller/beacon was started and live E2E remains unverified",
    ));

    const insecureRecoveryPolicies = JSON.parse(
      env.OCTOC2_RECOVERY_POLICIES!,
    ) as Record<string, { serverUrl: string }>;
    insecureRecoveryPolicies[beaconId]!.serverUrl =
      "http://127.0.0.1:8080";
    const insecure = await runPreflight(
      {
        ...env,
        OCTOC2_RECOVERY_POLICIES:
          JSON.stringify(insecureRecoveryPolicies),
      },
      options,
    );
    assert.equal(insecure.ok, false);
    assert.ok(insecure.errors.some((error) =>
      error.includes("Recovery policy has invalid complete-configuration fields")));

    const forbiddenValue = `legacy-${randomBytes(24).toString("hex")}`;
    const rejected = await runPreflight(
      { ...env, OCTOC2_GITHUB_TOKEN: forbiddenValue },
      options,
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) =>
      error.startsWith("OCTOC2_GITHUB_TOKEN is forbidden:")));
    assert.equal(JSON.stringify(rejected).includes(forbiddenValue), false);
  });
});
