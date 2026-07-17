/** Guarded compiled-beacon HTTPS/WSS qualification on the local Windows host. */

import { Octokit } from "@octokit/rest";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import {
  bytesToBase64,
  generateOperatorKeyPair,
} from "../server/src/crypto/sodium.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, ms));
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate an HTTPS test port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function stopProcess(process: Bun.Subprocess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await Promise.race([process.exited, pause(5_000)]);
  if (process.exitCode === null) process.kill(9);
}

function verifiedTemporaryPath(path: string): string {
  const resolvedPath = resolve(path);
  const prefix = `${resolve(tmpdir())}${sep}`;
  if (!resolvedPath.startsWith(prefix)) {
    throw new Error("Refusing to remove HTTPS fixture outside the OS temp directory");
  }
  return resolvedPath;
}

function findOpenSsl(): string {
  const onPath = Bun.which("openssl");
  if (onPath) return onPath;
  for (const candidate of [
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("OpenSSL is required for live HTTPS qualification");
}

function runOpenSsl(cwd: string, args: string[]): void {
  const result = Bun.spawnSync([findOpenSsl(), ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error("OpenSSL certificate generation failed");
}

async function createCertificates(directory: string): Promise<{
  ca: string;
  certificate: string;
  privateKey: string;
}> {
  const caKey = join(directory, "ca.key");
  const ca = join(directory, "ca.crt");
  const privateKey = join(directory, "server.key");
  const request = join(directory, "server.csr");
  const certificate = join(directory, "server.crt");
  const extensions = join(directory, "server.ext");
  await writeFile(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "",
    ].join("\n"),
  );
  runOpenSsl(directory, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey, "-out", ca, "-subj", "/CN=Transport Qualification CA",
    "-days", "1", "-sha256", "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl(directory, [
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
    "-out", request, "-subj", "/CN=localhost", "-sha256",
  ]);
  runOpenSsl(directory, [
    "x509", "-req", "-in", request, "-CA", ca, "-CAkey", caKey,
    "-CAcreateserial", "-out", certificate, "-days", "1", "-sha256",
    "-extfile", extensions,
  ]);
  return { ca, certificate, privateKey };
}

function randomCredential(): string {
  return randomBytes(32).toString("base64url");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Pass --execute to authorize the disposable HTTPS host test");
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("HTTPS host qualification currently requires Windows x64");
  }
  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const repo = required("OCTOC2_LIVE_REPO_NAME");
  const forbidden = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  const serverToken = required("OCTOC2_SERVER_GITHUB_TOKEN");
  const gistToken = required("OCTOC2_SERVER_GIST_TOKEN");
  if (owner.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("The configured forbidden account cannot host this test");
  }
  const identity = await new Octokit({ auth: serverToken }).rest.users.getAuthenticated();
  if (identity.data.login.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error("Server credential resolves to the configured forbidden account");
  }
  const repository = await new Octokit({ auth: serverToken }).rest.repos.get({ owner, repo });
  if (!repository.data.private) throw new Error("HTTPS qualification requires a private repo");

  const directory = await mkdtemp(join(tmpdir(), "octoc2-live-http-"));
  const binary = join(directory, "https-host-smoke.exe");
  const enrollmentFile = `${binary}.enrollment.json`;
  const serverOut = join(directory, "server.out");
  const serverErr = join(directory, "server.err");
  const implantOut = join(directory, "implant.out");
  const implantErr = join(directory, "implant.err");
  let server: Bun.Subprocess | null = null;
  let implant: Bun.Subprocess | null = null;
  try {
    const certificates = await createCertificates(directory);
    const ca = await readFile(certificates.ca, "utf8");
    const port = await freePort();
    const baseUrl = `https://localhost:${port}`;
    const operator = await generateOperatorKeyPair();
    const operatorPublic = await bytesToBase64(operator.publicKey);
    const operatorSecret = await bytesToBase64(operator.secretKey);
    const operatorApiToken = randomCredential();
    const beaconApiToken = randomCredential();
    const runtimeDir = dirname(process.execPath);
    const childEnv = {
      ...process.env,
      PATH: `${runtimeDir}${delimiter}${process.env.PATH ?? ""}`,
      OCTOC2_REPO_OWNER: owner,
      OCTOC2_REPO_NAME: repo,
    };

    const build = Bun.spawn([
      process.execPath, "run", "octoctl/src/index.ts", "build-beacon",
      "--outfile", binary, "--target", "bun-windows-x64",
      "--http-url", baseUrl, "--tentacle-priority", "http",
      "--no-random-title",
    ], { cwd: process.cwd(), env: childEnv, stdout: "ignore", stderr: "ignore" });
    if (await build.exited !== 0) throw new Error("HTTPS beacon build failed");
    const enrollment = JSON.parse(await readFile(enrollmentFile, "utf8")) as {
      beaconId?: unknown;
    };
    if (typeof enrollment.beaconId !== "string") {
      throw new Error("HTTPS enrollment artifact is invalid");
    }
    const beaconId = enrollment.beaconId;

    server = Bun.spawn([process.execPath, "run", "server/src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        OCTOC2_SERVER_GITHUB_TOKEN: serverToken,
        OCTOC2_SERVER_GIST_TOKEN: gistToken,
        OCTOC2_OPERATOR_SECRET: operatorSecret,
        MONITORING_PUBKEY: operatorPublic,
        OCTOC2_OPERATOR_API_TOKEN: operatorApiToken,
        OCTOC2_BEACON_API_TOKENS: JSON.stringify({ [beaconId]: beaconApiToken }),
        OCTOC2_DATA_DIR: join(directory, "data"),
        OCTOC2_ENROLLMENT_DIR: directory,
        OCTOC2_POLL_INTERVAL_MS: "30000",
        OCTOC2_HTTP_ENABLED: "true",
        OCTOC2_HTTP_HOST: "127.0.0.1",
        OCTOC2_HTTP_PORT: String(port),
        OCTOC2_HTTP_SERVER_CERT: certificates.certificate,
        OCTOC2_HTTP_SERVER_KEY: certificates.privateKey,
        OCTOC2_GRPC_ENABLED: "false",
      },
      stdout: Bun.file(serverOut),
      stderr: Bun.file(serverErr),
    });
    await pause(3_000);
    if (server.exitCode !== null) throw new Error("HTTPS controller exited early");

    implant = Bun.spawn([binary], {
      cwd: directory,
      env: {
        ...childEnv,
        SVC_BEACON_API_TOKEN: beaconApiToken,
        OCTOC2_OPERATOR_PUBKEY: operatorPublic,
        OCTOC2_STATE_DIR: join(directory, "state"),
        SVC_TENTACLE_PRIORITY: "http",
        SVC_HTTP_URL: baseUrl,
        SVC_SLEEP: "1",
        SVC_JITTER: "0",
        OCTOC2_LOG_LEVEL: "info",
        NODE_EXTRA_CA_CERTS: certificates.ca,
        SSL_CERT_FILE: certificates.ca,
        SVC_GITHUB_TOKEN: "",
        SVC_GITHUB_TOKEN_LEASE: "",
      },
      stdout: Bun.file(implantOut),
      stderr: Bun.file(implantErr),
    });

    const trustedFetch = (url: string, init: RequestInit = {}) =>
      fetch(url, { ...init, tls: { ca } });
    const registrationDeadline = Date.now() + 45_000;
    let registered = false;
    while (Date.now() < registrationDeadline && implant.exitCode === null) {
      await pause(1_000);
      const response = await trustedFetch(`${baseUrl}/api/beacons`, {
        headers: { Authorization: `Bearer ${operatorApiToken}` },
      }).catch(() => null);
      if (!response?.ok) continue;
      const beacons = await response.json() as Array<{ id?: unknown }>;
      registered = beacons.some((beacon) => beacon.id === beaconId);
      if (registered) break;
    }
    if (!registered) throw new Error("HTTPS beacon did not register");

    const queued = await trustedFetch(`${baseUrl}/api/beacon/${beaconId}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operatorApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "ping", args: {}, preferredChannel: "http" }),
    });
    if (queued.status !== 201) throw new Error("HTTPS ping task was not queued");
    const queuedBody = await queued.json() as { taskId?: unknown };
    if (typeof queuedBody.taskId !== "string") throw new Error("HTTPS task ID is invalid");

    const resultDeadline = Date.now() + 45_000;
    let completed = false;
    while (Date.now() < resultDeadline && implant.exitCode === null) {
      await pause(1_000);
      const response = await trustedFetch(`${baseUrl}/api/beacon/${beaconId}/results`, {
        headers: { Authorization: `Bearer ${operatorApiToken}` },
      });
      if (!response.ok) continue;
      const tasks = await response.json() as Array<{ taskId?: unknown; status?: unknown }>;
      completed = tasks.some((task) =>
        task.taskId === queuedBody.taskId && task.status === "completed"
      );
      if (completed) break;
    }
    console.log(`https_registration=${registered}`);
    console.log(`https_ping_completed=${completed}`);
    if (!completed) throw new Error("HTTPS signed ping result was not accepted");
    console.log("https_live_qualification=true");
  } finally {
    if (implant) await stopProcess(implant);
    if (server) await stopProcess(server);
    await rm(verifiedTemporaryPath(directory), { recursive: true, force: true });
    console.log("https_local_cleanup=true");
  }
}

await main();
