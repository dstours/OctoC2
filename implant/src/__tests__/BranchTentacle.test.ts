import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mocks (must be declared before module import) ─────────────────────────────

const mockGit = {
  getRef:     mock(async () => ({ data: { object: { sha: "head-sha1" } } })),
  createBlob: mock(async () => ({ data: { sha: "blob-sha1" } })),
  getCommit:  mock(async () => ({ data: { tree: { sha: "tree-sha1" } } })),
  createTree: mock(async () => ({ data: { sha: "new-tree-sha" } })),
  createCommit: mock(async () => ({ data: { sha: "new-commit-sha" } })),
  updateRef:  mock(async () => ({})),
  createRef:  mock(async () => ({})),
  deleteRef:  mock(async () => ({})),
  getTree:    mock(async () => ({ data: { tree: [] } })),
};

const mockActions = {
  getRepoVariable: mock(async () => ({
    data: { value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  })),
};

const mockRepos = {
  get:        mock(async () => ({ data: { default_branch: "trunk" } })),
  getContent: mock(async () => ({
    data: { type: "file", content: btoa("{}"), sha: "file-sha1" },
  })),
};

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = { git: mockGit, actions: mockActions, repos: mockRepos };
  },
}));

import { BranchTentacle } from "../tentacles/BranchTentacle.ts";
import { generateKeyPair, bytesToBase64, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";
import { signedCheckin } from "./signedCheckinFixture.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeConfig(): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["branch"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: kp,
  };
}

const PAYLOAD = {
  beaconId:  "abcd1234-5678-90ab-cdef-1234567890ab",
  publicKey: "",
  hostname:  "host",
  username:  "user",
  os:        "linux",
  arch:      "x64",
  pid:       1234,
  checkinAt: new Date().toISOString(),
};

function clearAllMocks() {
  mockGit.getRef.mockClear();
  mockGit.createBlob.mockClear();
  mockGit.getCommit.mockClear();
  mockGit.createTree.mockClear();
  mockGit.createCommit.mockClear();
  mockGit.updateRef.mockClear();
  mockGit.createRef.mockClear();
  mockGit.deleteRef.mockClear();
  mockGit.getTree.mockClear();
  mockActions.getRepoVariable.mockClear();
  mockRepos.get.mockClear();
  mockRepos.getContent.mockClear();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BranchTentacle", () => {
  beforeEach(clearAllMocks);

  // ── id8 ──────────────────────────────────────────────────────────────────────

  it("id8 returns first 8 chars of beaconId", async () => {
    const cfg = await makeConfig();
    const t   = new BranchTentacle(cfg);
    // Access via checkin which uses id8 internally; verify branch name pattern
    // by inspecting the getRef call after first checkin
    (mockGit.getRef as any).mockImplementation(async ({ ref }: any) => {
      if (ref === "heads/infra-sync-abcd1234") {
        return { data: { object: { sha: "head-sha1" } } };
      }
      throw Object.assign(new Error("404"), { status: 404 });
    });
    // Trigger a writeFile path by running checkin
    mockRepos.getContent.mockResolvedValueOnce({
      data: { type: "file", content: btoa(""), sha: "f1" },
    });
    await t.checkin(await signedCheckin(cfg, PAYLOAD));
    // The getRef call during writeFile should use "heads/infra-sync-abcd1234"
    const calls = mockGit.getRef.mock.calls.map((c: any) => c[0].ref);
    expect(calls.some((r: string) => r === "heads/infra-sync-abcd1234")).toBe(true);
  });

  // ── isAvailable ───────────────────────────────────────────────────────────────

  it("isAvailable checks repository metadata and the actual default branch", async () => {
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "sha1" } } });
    const t = new BranchTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
    expect(mockGit.getRef).toHaveBeenCalledTimes(1);
    expect(mockRepos.get).toHaveBeenCalledTimes(1);
    expect(((mockGit.getRef.mock.calls[0] as any)[0] as any).ref).toBe("heads/trunk");
  });

  it("isAvailable returns false when repository metadata is unavailable", async () => {
    mockRepos.get.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    const t = new BranchTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("isAvailable returns false on other errors", async () => {
    mockRepos.get.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const t = new BranchTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  // ── checkin — first call creates branch + ack ─────────────────────────────────

  it("checkin creates branch and writes ack.json on first call", async () => {
    // getRef for writeFile: branch doesn't exist yet → 404 → triggers createRef
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // After branch creation, getRef for task.json read poll: branch exists now with new SHA
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "new-commit-sha" } } });

    // readFile → repos.getContent returns empty content (no task yet)
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));

    expect(tasks).toEqual([]);
    // ACK write: createBlob called for ack.json content
    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    // Branch created via createRef (no existing HEAD)
    expect(mockGit.createRef).toHaveBeenCalledTimes(1);
    const createRefCall = (mockGit.createRef.mock.calls[0] as any)[0] as any;
    expect(createRefCall.ref).toBe("refs/heads/infra-sync-abcd1234");
    const createCommitCall = (mockGit.createCommit.mock.calls[0] as any)[0] as any;
    expect(createCommitCall.parents).toEqual(["new-commit-sha"]);
  });

  it("checkin refreshes ack.json on every call and still polls for tasks", async () => {
    // First checkin: branch doesn't exist
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // After createRef, second getRef for SHA check
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "new-commit-sha" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    const firstPayload = await signedCheckin(cfg, {
      ...PAYLOAD,
      checkinAt: "2026-07-16T12:00:00.000Z",
    });
    await t.checkin(firstPayload);

    clearAllMocks();

    // Second checkin updates the existing ACK file, then polls for tasks.
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "new-commit-sha" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const secondPayload = await signedCheckin(cfg, {
      ...PAYLOAD,
      checkinAt: "2026-07-16T12:00:01.000Z",
    });
    await t.checkin(secondPayload);

    expect(mockGit.createRef).not.toHaveBeenCalled();
    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    expect(mockGit.updateRef).toHaveBeenCalledTimes(1);
    expect(((mockGit.updateRef.mock.calls[0] as any)[0] as any).force).toBe(false);
    expect(mockRepos.getContent).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      ((mockGit.createBlob.mock.calls[0] as any)[0] as any).content,
    );
    expect(written.identity.sequence).toBe(secondPayload.identity!.sequence);
    expect(written.identity.signature).not.toBe(
      firstPayload.identity!.signature,
    );
  });

  it("retries a conflicting ACK ref update from the latest branch head", async () => {
    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    mockGit.getRef
      .mockResolvedValueOnce({ data: { object: { sha: "head-before-race" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "head-after-race" } } });
    mockGit.updateRef
      .mockRejectedValueOnce(
        Object.assign(new Error("not a fast forward"), { status: 422 }),
      )
      .mockResolvedValueOnce({});
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    await t.checkin(await signedCheckin(cfg, PAYLOAD));

    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    expect(mockGit.createCommit).toHaveBeenCalledTimes(2);
    expect(
      ((mockGit.createCommit.mock.calls[0] as any)[0] as any).parents,
    ).toEqual(["head-before-race"]);
    expect(
      ((mockGit.createCommit.mock.calls[1] as any)[0] as any).parents,
    ).toEqual(["head-after-race"]);
    expect(mockGit.updateRef).toHaveBeenCalledTimes(2);
    for (const call of mockGit.updateRef.mock.calls as any) {
      expect(call[0].force).toBe(false);
    }
  });

  it("retries a conflicting task deletion from the latest branch head", async () => {
    const t = new BranchTentacle(await makeConfig());
    mockGit.getRef
      .mockResolvedValueOnce({ data: { object: { sha: "head-before-race" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "head-after-race" } } });
    mockGit.updateRef
      .mockRejectedValueOnce(
        Object.assign(new Error("not a fast forward"), { status: 409 }),
      )
      .mockResolvedValueOnce({});

    await (t as any).deleteFile("task.json");

    expect(mockGit.createCommit).toHaveBeenCalledTimes(2);
    expect(
      ((mockGit.createCommit.mock.calls[0] as any)[0] as any).parents,
    ).toEqual(["head-before-race"]);
    expect(
      ((mockGit.createCommit.mock.calls[1] as any)[0] as any).parents,
    ).toEqual(["head-after-race"]);
    expect(mockGit.updateRef).toHaveBeenCalledTimes(2);
    for (const call of mockGit.updateRef.mock.calls as any) {
      expect(call[0].force).toBe(false);
    }
  });

  // ── checkin — task.json polling ────────────────────────────────────────────────

  it("checkin returns [] when task.json is not found (404)", async () => {
    // First call: branch already exists (ack re-check skipped after first)
    // Simulate ackSent=true by running a first checkin that sets it
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "commit-sha" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("checkin returns [] when task.json content is empty", async () => {
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "commit-sha" } } });
    // getContent returns empty file
    mockRepos.getContent.mockResolvedValueOnce({
      data: { type: "file", content: btoa("   "), sha: "f-sha" },
    });

    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("checkin decrypts and returns tasks from task.json, then deletes it", async () => {
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
    const taskJsonContent = JSON.stringify(encrypted);

    // First: write ack.json → branch doesn't exist → createRef
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // Second: getBranchSha for SHA dedup check → returns a sha
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "task-commit-sha" } } });
    // Third: getBranchSha for deleteFile → returns same sha
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "task-commit-sha" } } });

    // readFile returns our task content
    mockRepos.getContent.mockResolvedValueOnce({
      data: { type: "file", content: btoa(taskJsonContent), sha: "task-file-sha" },
    });

    const t = new BranchTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("t1");
    expect(tasks[0]!.kind).toBe("shell");

    // deleteFile should have been called: createBlob (for ack) + createTree + createCommit + updateRef
    // The key check is that updateRef was called for the delete commit
    expect(mockGit.updateRef).toHaveBeenCalled();
  });

  it("checkin returns [] and does not re-process when SHA is unchanged", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    const taskList = [{ taskId: "t2", kind: "ping" as const, args: {} }];
    const encrypted = await encryptBox(
      JSON.stringify(taskList),
      cfg.beaconKeyPair.publicKey,
      operatorKp.secretKey,
    );
    const taskJsonContent = JSON.stringify(encrypted);

    // Checkin 1: ack (branch doesn't exist) + task found + SHA "same-sha"
    mockGit.getRef
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
      .mockResolvedValueOnce({ data: { object: { sha: "same-sha" } } })  // SHA check
      .mockResolvedValueOnce({ data: { object: { sha: "same-sha" } } }); // deleteFile

    mockRepos.getContent.mockResolvedValueOnce({
      data: { type: "file", content: btoa(taskJsonContent), sha: "tf-sha" },
    });

    const t = new BranchTentacle(cfg);
    const tasks1 = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks1).toHaveLength(1);

    clearAllMocks();

    // Checkin 2: refresh ACK, then task.json is gone → return []
    // After deleteFile, lastTaskSha is reset to null, so this won't short-circuit on SHA
    // Instead, task.json is gone → 404 → returns []
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "after-delete-sha" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const tasks2 = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks2).toEqual([]);
  });

  // ── submitResult ───────────────────────────────────────────────────────────────

  it("submitResult writes a sealed result file to the branch", async () => {
    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);

    // Branch already exists for writeFile
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "head-sha" } } });

    await t.submitResult({
      taskId:      "taskid-1234-abcd",
      beaconId:    cfg.id,
      success:     true,
      output:      "done",
      completedAt: new Date().toISOString(),
    });

    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    // Verify the file path is result-{taskId8}.json
    expect(mockGit.createTree).toHaveBeenCalledTimes(1);
    const treeCall = (mockGit.createTree.mock.calls[0] as any)[0] as any;
    expect(treeCall.tree[0].path).toBe("result-taskid-1.json");
  });

  it("submitResult writes correct result-{taskId8}.json filename", async () => {
    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);

    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "head-sha" } } });

    await t.submitResult({
      taskId:      "aabbccdd-eeff-1122",
      beaconId:    cfg.id,
      success:     false,
      output:      "err",
      completedAt: new Date().toISOString(),
    });

    const treeCall = (mockGit.createTree.mock.calls[0] as any)[0] as any;
    expect(treeCall.tree[0].path).toBe("result-aabbccdd.json");
  });

  it("posted result artifacts survive teardown", async () => {
    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);

    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "head-sha" } } });

    await t.submitResult({
      taskId:      "persist1-result",
      beaconId:    cfg.id,
      success:     true,
      output:      "awaiting collection",
      completedAt: new Date().toISOString(),
    });
    await t.teardown();

    const treeCall = (mockGit.createTree.mock.calls[0] as any)[0] as any;
    expect(treeCall.tree[0].path).toBe("result-persist1.json");
    expect(mockGit.deleteRef).not.toHaveBeenCalled();
  });

  // ── teardown ──────────────────────────────────────────────────────────────────

  it("teardown releases local state without deleting the branch ref", async () => {
    const t = new BranchTentacle(await makeConfig());
    const state = t as any;
    state.lastTaskSha = "task-sha";
    state.operatorPublicKey = new Uint8Array(32);
    state.defaultBranch = "trunk";

    await t.teardown();

    expect(state.lastTaskSha).toBeNull();
    expect(state.operatorPublicKey).toBeNull();
    expect(state.defaultBranch).toBeNull();
    expect(mockGit.deleteRef).not.toHaveBeenCalled();
  });

  // ── writeFile — creates branch when it doesn't exist ─────────────────────────

  it("writeFile creates a new branch ref when branch does not yet exist", async () => {
    mockGit.getRef.mockReset();
    // getBranchSha returns null (404)
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // readFile after ack → 404 (no task)
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "new-commit-sha" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const cfg = await makeConfig();
    const t = new BranchTentacle(cfg);
    await t.checkin(await signedCheckin(cfg, PAYLOAD));

    // Because branch didn't exist, createRef should have been used (not updateRef)
    expect(mockGit.createRef).toHaveBeenCalledTimes(1);
    expect(mockGit.updateRef).not.toHaveBeenCalled();
  });
});
