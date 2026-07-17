/**
 * Guarded live qualification for the Codespaces control plane, authenticated
 * remote command path, and raw port forwarding. The script refuses to reuse
 * or delete an existing Codespace and always deletes the one it creates.
 */

import { Octokit } from "@octokit/rest";
import { createConnection, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { SshTunnel } from "../implant/src/tentacles/grpc/SshTunnel.ts";
import { RelayConsortiumTentacle } from "../implant/src/tentacles/RelayConsortiumTentacle.ts";
import type {
  BeaconConfig,
  CheckinPayload,
  ITentacle,
  Task,
  TaskResult,
} from "../implant/src/types.ts";

const WAIT_MS = 8 * 60 * 1000;
const REMOTE_PORT = 2_222;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a local port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitAvailable(octokit: Octokit, name: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const response = await octokit.rest.codespaces.getForAuthenticatedUser({
      codespace_name: name,
    });
    const state = response.data.state ?? "Unknown";
    if (state === "Available") return;
    if (state === "Failed" || state === "Deleted") {
      throw new Error(`Codespace entered terminal state ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Codespace did not become available before the timeout");
}

async function waitForSshBanner(port: number): Promise<string> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const banner = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "localhost", port });
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("SSH banner timeout"));
        }, 5_000);
        socket.once("data", (chunk) => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(chunk.toString("utf8"));
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      if (banner.startsWith("SSH-")) return banner;
      lastError = new Error("unexpected service banner");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Forwarded SSH service did not become ready: ${(lastError as Error | null)?.message ?? "unknown error"}`,
  );
}

class LiveRelayProbe implements ITentacle {
  readonly kind = "codespaces" as const;
  private tunnel: SshTunnel | null = null;
  checkins = 0;

  constructor(private readonly token: string) {}

  async isAvailable(): Promise<boolean> {
    const name = process.env["SVC_GRPC_CODESPACE_NAME"]?.trim();
    if (!name) return false;
    try {
      this.tunnel = new SshTunnel();
      await this.tunnel.connect(name, this.token);
      const localPort = await freePort();
      await this.tunnel.forward(localPort, REMOTE_PORT);
      await waitForSshBanner(localPort);
      return true;
    } catch {
      await this.teardown();
      return false;
    }
  }

  async checkin(_payload: CheckinPayload): Promise<Task[]> {
    this.checkins++;
    return [];
  }

  async submitResult(_result: TaskResult) {
    return {
      artifactWritten: true,
      controllerAccepted: true,
      channel: "codespaces" as const,
      acceptance: "direct-response" as const,
    };
  }

  async teardown(): Promise<void> {
    await this.tunnel?.close().catch(() => undefined);
    this.tunnel = null;
  }
}

class LiveRelayConsortium extends RelayConsortiumTentacle {
  discoveryAttempts = 0;
  innerCreations = 0;
  probe: LiveRelayProbe | null = null;

  constructor(config: BeaconConfig, private readonly token: string) {
    super(config);
  }

  protected override async discoverCodespace(
    relay: NonNullable<BeaconConfig["relayConsortium"]>[number],
  ): Promise<string | null> {
    this.discoveryAttempts++;
    return await super.discoverCodespace(relay);
  }

  protected override createInnerTentacle(_config: BeaconConfig): ITentacle {
    this.innerCreations++;
    this.probe = new LiveRelayProbe(this.token);
    return this.probe;
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Pass --execute to authorize one disposable Codespace");
  }
  const token = required("SVC_CODESPACES_GITHUB_TOKEN");
  const cleanupToken = required("OCTOC2_LIVE_CLEANUP_TOKEN");
  const owner = required("OCTOC2_LIVE_REPO_OWNER");
  const repo = required("OCTOC2_LIVE_REPO_NAME");
  const forbiddenOwner = required("OCTOC2_LIVE_FORBIDDEN_OWNER");
  if (owner.toLowerCase() === forbiddenOwner.toLowerCase()) {
    throw new Error("The configured forbidden account cannot be used for live qualification");
  }

  const octokit = new Octokit({ auth: token });
  const cleanupOctokit = new Octokit({ auth: cleanupToken });
  const identity = await octokit.rest.users.getAuthenticated();
  if (identity.data.login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Codespaces credential does not belong to the approved owner");
  }
  // Keep the dedicated Codespaces credential least-privileged: repository
  // metadata and fixture mutations belong to the separate cleanup credential.
  const repository = await cleanupOctokit.rest.repos.get({ owner, repo });
  if (repository.data.private !== true) {
    throw new Error("Codespaces qualification requires the approved private repository");
  }
  const before = await octokit.rest.codespaces.listForAuthenticatedUser({
    per_page: 100,
  });
  if (before.data.codespaces.some(
    (codespace) => codespace.repository?.full_name === `${owner}/${repo}`,
  )) {
    throw new Error("Refusing to reuse or delete an existing Codespace");
  }

  let createdName: string | null = null;
  let branchRef: string | null = null;
  let tunnel: SshTunnel | null = null;
  let relay: LiveRelayConsortium | null = null;
  try {
    const defaultBranch = repository.data.default_branch;
    const baseRef = await cleanupOctokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseCommit = await cleanupOctokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseRef.data.object.sha,
    });
    const devcontainer = JSON.stringify({
      name: "transport-qualification",
      image: "mcr.microsoft.com/devcontainers/base:ubuntu",
      features: {
        "ghcr.io/devcontainers/features/sshd:1": {
          version: "latest",
        },
      },
      forwardPorts: [REMOTE_PORT],
    }, null, 2) + "\n";
    const blob = await cleanupOctokit.rest.git.createBlob({
      owner,
      repo,
      content: devcontainer,
      encoding: "utf-8",
    });
    const tree = await cleanupOctokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: [{
        path: ".devcontainer/devcontainer.json",
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      }],
    });
    const commit = await cleanupOctokit.rest.git.createCommit({
      owner,
      repo,
      message: "temporary Codespaces transport qualification",
      tree: tree.data.sha,
      parents: [baseRef.data.object.sha],
    });
    branchRef = `live-codespace-${randomUUID().slice(0, 8)}`;
    await cleanupOctokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchRef}`,
      sha: commit.data.sha,
    });
    console.log("codespace_fixture_branch_created=true");

    const created = await octokit.rest.codespaces.createWithRepoForAuthenticatedUser({
      owner,
      repo,
      ref: `refs/heads/${branchRef}`,
      devcontainer_path: ".devcontainer/devcontainer.json",
      display_name: "transport-qualification",
      retention_period_minutes: 60,
      idle_timeout_minutes: 30,
    });
    createdName = created.data.name;
    console.log("codespace_created=true");
    await waitAvailable(octokit, createdName);
    console.log("codespace_available=true");
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    tunnel = new SshTunnel();
    await tunnel.connect(createdName, token);
    const localPort = await freePort();
    await tunnel.forward(localPort, REMOTE_PORT);
    await waitForSshBanner(localPort);
    console.log("codespace_remote_service=true");
    console.log("codespace_port_forward=true");
    await tunnel.close();
    tunnel = null;

    const relayConfig: BeaconConfig = {
      id: "00000000-0000-4000-8000-000000000001",
      repo: { owner, name: repo },
      token: "",
      tentaclePriority: ["relay"],
      sleepSeconds: 60,
      jitter: 0,
      operatorPublicKey: new Uint8Array(32),
      beaconKeyPair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
      },
      relayConsortium: [
        { account: owner, repo: `transport-unavailable-${randomUUID().slice(0, 8)}` },
        { account: owner, repo },
      ],
    };
    relay = new LiveRelayConsortium(relayConfig, token);
    const payload: CheckinPayload = {
      beaconId: relayConfig.id,
      publicKey: "",
      hostname: "qualification-host",
      username: "qualification-user",
      os: "test",
      arch: "x64",
      pid: 1,
      checkinAt: new Date().toISOString(),
    };
    await relay.checkin(payload);
    const discoveriesAfterFailover = relay.discoveryAttempts;
    await relay.checkin(payload);
    const failoverWorked =
      discoveriesAfterFailover >= 2 &&
      relay.discoveryAttempts === discoveriesAfterFailover &&
      relay.innerCreations === 1 &&
      relay.probe?.checkins === 2;
    console.log(`relay_discovery_failover=${failoverWorked}`);
    console.log(`relay_cached_reuse=${relay.probe?.checkins === 2}`);
    if (!failoverWorked) {
      throw new Error("Relay consortium did not fail over and cache the live relay");
    }
  } finally {
    if (relay) {
      await relay.teardown().catch(() => undefined);
    }
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
    }
    if (createdName) {
      await octokit.rest.codespaces.deleteForAuthenticatedUser({
        codespace_name: createdName,
      });
      console.log("codespace_deleted=true");
    }
    if (branchRef) {
      await cleanupOctokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branchRef}`,
      });
      console.log("codespace_fixture_branch_deleted=true");
    }
  }
}

await main();
