import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HttpTlsFixture {
  directory: string;
  certificate: Buffer;
  privateKey: Buffer;
  cleanup(): Promise<void>;
}

export async function createHttpTlsFixture(): Promise<HttpTlsFixture> {
  const directory = await mkdtemp(join(tmpdir(), "octoc2-http-tls-"));
  const certificatePath = join(directory, "server.crt");
  const privateKeyPath = join(directory, "server.key");
  const openssl = findOpenSsl();
  const result = spawnSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `openssl failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }

  return {
    directory,
    certificate: await readFile(certificatePath),
    privateKey: await readFile(privateKeyPath),
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
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
  throw new Error("openssl is required for the local HTTPS integration suite");
}
