/**
 * OctoC2 — IssuesTentacle unit tests
 *
 * Covers: isAvailable(), ensureInitialized() flow, comment format
 * parsing, and the NONCE_RE handling for both beacon (<!-- - -->)
 * and operator (<!-- base64url_nonce -->) comment endings.
 *
 * The GitHub API (Octokit) is fully mocked — no network calls.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Set short poll timeouts BEFORE module import so the constants are read correctly.
// Without this, initialization tests wait 30s for a poll ACK that never arrives.
process.env["SVC_POLL_TIMEOUT_MS"] = "200";
process.env["SVC_POLL_RETRY_MS"]   = "50";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, mkdir } from "node:fs/promises";

// ── Mock @octokit/rest before importing IssuesTentacle ────────────────────────
//
// Bun's mock.module replaces the module for all imports in this test file.
// We expose spy functions so individual tests can configure responses.

const mockRepoGet         = mock(() => Promise.resolve({ data: { full_name: "op/c2" } }));
const mockGetRepoVariable = mock(() =>
  Promise.resolve({ data: { value: "" } }) // set per-test
);
const mockListIssues      = mock(() => Promise.resolve({ data: [] }));
const mockCreateIssue     = mock(() => Promise.resolve({ data: { number: 42 } }));
const mockCreateComment   = mock(() => Promise.resolve({ data: { id: 1001 } }));
const mockListComments    = mock(() => Promise.resolve({ data: [] as any[] }));
const mockDeleteComment   = mock(
  (_params?: { comment_id: number }) => Promise.resolve({}),
);
const mockUpdateComment   = mock(() => Promise.resolve({ data: {} }));
const mockPaginate        = mock((_fn: unknown, params: unknown) => {
  void params;
  return Promise.resolve([]);
});

const mockHookWrap = mock((_name: string, _fn: Function) => {});

mock.module("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    hook = { wrap: mockHookWrap };
    rest = {
      repos:   { get: mockRepoGet },
      actions: { getRepoVariable: mockGetRepoVariable },
      issues: {
        listForRepo:    mockListIssues,
        create:         mockCreateIssue,
        createComment:  mockCreateComment,
        updateComment:  mockUpdateComment,
        listComments:   mockListComments,
        deleteComment:  mockDeleteComment,
      },
    };
    paginate = mockPaginate;
  },
}));

// Import AFTER mock is registered
const { IssuesTentacle } = await import("../tentacles/IssuesTentacle.ts");
const {
  encryptBox,
  generateKeyPair,
  publicKeyToBase64,
} = await import("../crypto/sodium.ts");
const {
  computeTaskResultDigest,
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
} = await import("@octoc2/shared");

// ── Helpers ───────────────────────────────────────────────────────────────────

let testDir: string;
let originalXdg: string | undefined;
let originalAppData: string | undefined;
let originalResultAckTimeout: string | undefined;
let originalResultAckRetry: string | undefined;
const TEST_BEACON_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_BEACON_KEYS = await generateKeyPair();
const TEST_BEACON_PUBLIC_KEY = await publicKeyToBase64(
  TEST_BEACON_KEYS.publicKey,
);
const TEST_SIGNING_KEYS = await generateEd25519KeyPair();
const TEST_SIGNING_KEY_ID = await ed25519KeyId(
  TEST_SIGNING_KEYS.publicKey,
);
const TEST_SIGNING_PUBLIC_KEY = encodeBase64Url(
  TEST_SIGNING_KEYS.publicKey,
);

let currentOperatorKeyPair:
  | Awaited<ReturnType<typeof generateKeyPair>>
  | null = null;
let identitySequence = 0;

async function signedCheckin(
  payload: import("../types.ts").CheckinPayload,
): Promise<import("../types.ts").CheckinPayload> {
  const checkin = {
    ...payload,
    beaconId: TEST_BEACON_ID,
    publicKey: TEST_BEACON_PUBLIC_KEY,
  };
  const identity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: TEST_BEACON_ID,
      keyId: TEST_SIGNING_KEY_ID,
      issuedAt: checkin.checkinAt,
      sequence: ++identitySequence,
      payload: {
        beaconId: TEST_BEACON_ID,
        encryptionPublicKey: TEST_BEACON_PUBLIC_KEY,
        signingPublicKey: TEST_SIGNING_PUBLIC_KEY,
        hostname: checkin.hostname,
        username: checkin.username,
        os: checkin.os,
        arch: checkin.arch,
        pid: checkin.pid,
        checkinAt: checkin.checkinAt,
      },
    }),
    TEST_SIGNING_KEYS.secretKey,
  );
  return { ...checkin, identity };
}

function makeTentacle(
  tokenOverride = "ghp_test_token",
  configOverrides: Partial<import("../types.ts").BeaconConfig> = {},
) {
  const config = {
    id:   TEST_BEACON_ID,
    repo: { owner: "op", name: "c2" },
    token: tokenOverride,
    tentaclePriority: ["issues"] as import("../types.ts").TentacleKind[],
    sleepSeconds: 60,
    jitter: 0.2,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: TEST_BEACON_KEYS,
    signingKeyPair: TEST_SIGNING_KEYS,
    signingKeyId: TEST_SIGNING_KEY_ID,
    ...configOverrides,
  };
  const tentacle = new IssuesTentacle(config);

  // All successful fixtures exercise the production signed-checkin path.
  const originalCheckin = tentacle.checkin.bind(tentacle);
  tentacle.checkin = async (payload) =>
    originalCheckin(await signedCheckin(payload));

  // Registration requires an explicit encrypted ACK bound to the exact
  // GitHub registration comment. Inject that server response for the initial
  // poll while leaving each test's ordinary listComments mock untouched.
  const issuesApi = (
    tentacle as unknown as {
      octokit: {
        rest: {
          issues: {
            listComments: (params: Record<string, unknown>) => Promise<{
              data: any[];
            }>;
            deleteComment: (
              params: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        };
      };
    }
  ).octokit.rest.issues;
  const listComments = issuesApi.listComments;
  const deleteComment = issuesApi.deleteComment;
  let ackCommentId: number | null = null;
  let ackSent = false;

  issuesApi.listComments = async (params) => {
    const state = (
      tentacle as unknown as {
        state: {
          beaconId: string;
          registrationStatus: string;
          regCommentId: number | null;
        } | null;
      }
    ).state;
    if (
      params["since"] !== undefined &&
      state?.registrationStatus === "pending" &&
      state.regCommentId !== null &&
      !ackSent
    ) {
      if (!currentOperatorKeyPair) {
        throw new Error("test fixture is missing the operator key pair");
      }
      const acceptedAt = new Date().toISOString();
      const encrypted = await encryptBox(
        JSON.stringify({
          kind: "registration-ack",
          beaconId: state.beaconId,
          registrationId: String(state.regCommentId),
          acceptedAt,
        }),
        TEST_BEACON_KEYS.publicKey,
        currentOperatorKeyPair.secretKey,
      );
      ackCommentId = state.regCommentId + 1_000_000;
      ackSent = true;
      return {
        data: [{
          id: ackCommentId,
          created_at: acceptedAt,
          body: [
            `<!-- job:${Math.floor(Date.now() / 1000)}:deploy:reg-ack -->`,
            "```text",
            encrypted.ciphertext,
            "```",
            `<!-- ${encrypted.nonce} -->`,
          ].join("\n"),
        }],
      };
    }
    return listComments(params);
  };

  // Keep cleanup assertions focused on repository comments supplied by each
  // test; the synthetic ACK is consumed and deleted entirely inside the fixture.
  issuesApi.deleteComment = async (params) => {
    if (params["comment_id"] === ackCommentId) return {};
    return deleteComment(params);
  };

  return tentacle;
}

async function makeOperatorKeyPair() {
  const kp  = await generateKeyPair();
  const b64 = await publicKeyToBase64(kp.publicKey);
  currentOperatorKeyPair = kp;
  return { kp, b64 };
}

async function makeSignedResult(
  taskId = "result-acceptance-task",
): Promise<import("../types.ts").TaskResult> {
  const completedAt = new Date().toISOString();
  const unsigned = {
    taskId,
    beaconId: TEST_BEACON_ID,
    success: true,
    output: "completed",
    completedAt,
  };
  return {
    ...unsigned,
    signature: serializeSignedEnvelope(await signEnvelope(
      createUnsignedEnvelope({
        kind: "task-result",
        signerId: TEST_BEACON_ID,
        keyId: TEST_SIGNING_KEY_ID,
        issuedAt: completedAt,
        sequence: ++identitySequence,
        payload: await createTaskResultSignaturePayload(unsigned),
      }),
      TEST_SIGNING_KEYS.secretKey,
    )),
  };
}

async function makeResultReceiptComment(
  result: import("../types.ts").TaskResult,
  operatorKeys: Awaited<ReturnType<typeof generateKeyPair>>,
  overrides: Partial<{
    beaconId: string;
    taskId: string;
    resultDigest: string;
    acceptedAt: string;
    id: number;
  }> = {},
) {
  const encrypted = await encryptBox(
    JSON.stringify({
      kind: "result-acceptance",
      beaconId: overrides.beaconId ?? result.beaconId,
      taskId: overrides.taskId ?? result.taskId,
      resultDigest:
        overrides.resultDigest ?? await computeTaskResultDigest(result),
      acceptedAt: overrides.acceptedAt ?? new Date().toISOString(),
    }),
    TEST_BEACON_KEYS.publicKey,
    operatorKeys.secretKey,
  );
  return {
    id: overrides.id ?? 80_001,
    created_at: new Date().toISOString(),
    body: [
      `<!-- job:${Math.floor(Date.now() / 1000)}:deploy:result-ack-${result.taskId} -->`,
      "```text",
      encrypted.ciphertext,
      "```",
      `<!-- ${encrypted.nonce} -->`,
    ].join("\n"),
  };
}

beforeEach(async () => {
  testDir     = join(tmpdir(), `svc-tentacle-test-${crypto.randomUUID()}`);
  originalXdg = process.env["XDG_CONFIG_HOME"];
  originalAppData = process.env["APPDATA"];
  originalResultAckTimeout =
    process.env["SVC_RESULT_ACK_TIMEOUT_MS"];
  originalResultAckRetry =
    process.env["SVC_RESULT_ACK_RETRY_MS"];
  process.env["XDG_CONFIG_HOME"] = testDir;
  process.env["APPDATA"] = testDir;
  process.env["SVC_RESULT_ACK_TIMEOUT_MS"] = "0";
  process.env["SVC_RESULT_ACK_RETRY_MS"] = "1";
  await mkdir(join(testDir, "svc"), { recursive: true });
  currentOperatorKeyPair = null;
  identitySequence = 0;

  // Reset all mocks to clean state (mockReset clears both call history AND implementation)
  mockRepoGet.mockReset();
  mockGetRepoVariable.mockReset();
  mockListIssues.mockReset();
  mockCreateIssue.mockReset();
  mockCreateComment.mockReset();
  mockListComments.mockReset();
  mockDeleteComment.mockReset();
  mockPaginate.mockReset();

  // Restore defaults after reset
  mockRepoGet.mockResolvedValue({ data: { full_name: "op/c2" } });
  mockGetRepoVariable.mockResolvedValue({ data: { value: "" } });
  mockListIssues.mockResolvedValue({ data: [] });
  mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
  mockCreateComment.mockResolvedValue({ data: { id: 1001 } });
  mockListComments.mockResolvedValue({ data: [] });
  mockDeleteComment.mockResolvedValue({});
  mockUpdateComment.mockReset();
  mockUpdateComment.mockResolvedValue({ data: {} });
  mockPaginate.mockImplementation(() => Promise.resolve([]));
});

afterEach(async () => {
  if (originalXdg !== undefined) {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  } else {
    delete process.env["XDG_CONFIG_HOME"];
  }
  if (originalAppData !== undefined) {
    process.env["APPDATA"] = originalAppData;
  } else {
    delete process.env["APPDATA"];
  }
  if (originalResultAckTimeout !== undefined) {
    process.env["SVC_RESULT_ACK_TIMEOUT_MS"] =
      originalResultAckTimeout;
  } else {
    delete process.env["SVC_RESULT_ACK_TIMEOUT_MS"];
  }
  if (originalResultAckRetry !== undefined) {
    process.env["SVC_RESULT_ACK_RETRY_MS"] =
      originalResultAckRetry;
  } else {
    delete process.env["SVC_RESULT_ACK_RETRY_MS"];
  }
  await rm(testDir, { recursive: true, force: true });
});

// ── isAvailable ───────────────────────────────────────────────────────────────

describe("isAvailable()", () => {
  it("returns true when repo GET and variable GET both succeed", async () => {
    mockRepoGet.mockResolvedValueOnce({ data: { full_name: "op/c2" } });
    mockGetRepoVariable.mockResolvedValueOnce({ data: { value: "abc123" } });

    const tentacle = makeTentacle();
    expect(await tentacle.isAvailable()).toBe(true);
    expect(mockRepoGet).toHaveBeenCalledTimes(1);
    expect(mockGetRepoVariable).toHaveBeenCalledTimes(1);
  });

  it("returns false when repo GET fails (e.g. bad PAT)", async () => {
    mockRepoGet.mockRejectedValueOnce(new Error("401 Unauthorized"));

    const tentacle = makeTentacle();
    expect(await tentacle.isAvailable()).toBe(false);
  });

  it("returns false when operator pubkey variable is missing (404)", async () => {
    mockRepoGet.mockResolvedValueOnce({ data: { full_name: "op/c2" } });
    mockGetRepoVariable.mockRejectedValueOnce(new Error("404 Not Found"));

    const tentacle = makeTentacle();
    expect(await tentacle.isAvailable()).toBe(false);
  });

  it("does NOT call ensureInitialized (no issue search or comment API calls)", async () => {
    mockRepoGet.mockResolvedValueOnce({ data: { full_name: "op/c2" } });
    mockGetRepoVariable.mockResolvedValueOnce({ data: { value: "abc" } });

    const tentacle = makeTentacle();
    await tentacle.isAvailable();

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});

// ── ensureInitialized (via checkin) ──────────────────────────────────────────

describe("initialization flow", () => {
  it("fetches operator pubkey during initialization", async () => {
    const { kp, b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);           // no existing issues
    mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
    mockCreateComment.mockResolvedValue({ data: { id: 1001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();

    const payload = {
      beaconId: "test-id",
      publicKey: "",
      hostname:  "test-host",
      username:  "user",
      os:        "linux",
      arch:      "x64",
      pid:       999,
      checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    // getRepoVariable should have been called to fetch the operator pubkey
    expect(mockGetRepoVariable).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MONITORING_PUBKEY" })
    );
  });

  it("creates a beacon issue when none exists", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);           // no existing issues found
    mockCreateIssue.mockResolvedValue({ data: { number: 55 } });
    mockCreateComment.mockResolvedValue({ data: { id: 2001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    // No opsec-identifiable label; title uses short beacon ID, not "OctoC2"
    const call = (mockCreateIssue.mock.calls[0] as unknown as [{ title: string; labels?: string[] }])[0];
    expect(call.title).toMatch(/Scheduled maintenance/);
    expect(call.labels ?? []).not.toContain("infra-node");
  });

  it("reuses an existing issue matching the beacon ID in the body", async () => {
    const { b64 } = await makeOperatorKeyPair();
    const beaconId = "550e8400-e29b-41d4-a716-446655440001";

    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    // paginate returns an issue whose body contains the beacon ID marker
    mockPaginate.mockResolvedValue([
      { number: 77, body: `<!-- node:${beaconId} -->\n\nAutomated health tracking.` } as never,
    ]);
    mockCreateComment.mockResolvedValue({ data: { id: 3001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId, publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    // Should NOT create a new issue
    expect(mockCreateIssue).not.toHaveBeenCalled();
    // Should post to issue #77
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 77 })
    );
  });

  it("surfaces a fatal error when operator pubkey variable is empty", async () => {
    mockGetRepoVariable.mockResolvedValue({ data: { value: "" } }); // empty!

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "x", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await expect(tentacle.checkin(payload)).rejects.toThrow("MONITORING_PUBKEY");
  });

  it("updates a relayable CI comment on the second proxy checkin", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockCreateComment.mockResolvedValue({ data: { id: 4001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle("ghp_proxy_token", {
      issuesStateScope: "proxy:acme/decoy",
      issuesIssueNumber: 7,
    });
    const payload = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);
    mockUpdateComment.mockClear();
    await tentacle.checkin({
      ...payload,
      checkinAt: new Date(Date.now() + 1_000).toISOString(),
    });

    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: expect.any(Number),
        body: expect.stringContaining(":ci:"),
      }),
    );
  });

  it("rejects a proxy repository whose MONITORING_PUBKEY differs from recovery", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    const tentacle = makeTentacle("ghp_proxy_token", {
      issuesStateScope: "proxy:acme/decoy",
      issuesIssueNumber: 7,
      issuesRequireOperatorKeyMatch: true,
      operatorPublicKey: new Uint8Array(32).fill(9),
    });
    const payload = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await expect(tentacle.checkin(payload)).rejects.toThrow(
      "does not match the signed proxy configuration",
    );
  });

  it("resets only scoped Issues bookmarks when the signed decoy issue changes", async () => {
    const first = makeTentacle("ghp_proxy_token", {
      issuesStateScope: "proxy:acme/decoy",
      issuesIssueNumber: 7,
    }) as unknown as {
      loadOrCreateStateFile(): Promise<void>;
      state: {
        issueNumber: number | null;
        lastTaskCommentId: number | null;
        registrationStatus: "pending" | "registered";
        seq: number;
        nextSeq(): number;
        persist(): Promise<void>;
      };
    };
    await first.loadOrCreateStateFile();
    first.state.lastTaskCommentId = 99;
    first.state.registrationStatus = "registered";
    first.state.nextSeq();
    await first.state.persist();

    const second = makeTentacle("ghp_proxy_token", {
      issuesStateScope: "proxy:acme/decoy",
      issuesIssueNumber: 8,
    }) as unknown as {
      loadOrCreateStateFile(): Promise<void>;
      state: {
        issueNumber: number | null;
        lastTaskCommentId: number | null;
        registrationStatus: "pending" | "registered";
        seq: number;
      };
    };
    await second.loadOrCreateStateFile();

    expect(second.state.issueNumber).toBe(8);
    expect(second.state.lastTaskCommentId).toBeNull();
    expect(second.state.registrationStatus).toBe("pending");
    expect(second.state.seq).toBe(0);
  });

  it("rejects scoped state when persisted beacon key material differs", async () => {
    const scope = "proxy:acme/identity-check";
    const original = makeTentacle("ghp_proxy_token", {
      issuesStateScope: scope,
      issuesIssueNumber: 7,
    }) as unknown as {
      loadOrCreateStateFile(): Promise<void>;
    };
    await original.loadOrCreateStateFile();

    const differentEncryptionKeys = await generateKeyPair();
    const encryptionMismatch = makeTentacle("ghp_proxy_token", {
      issuesStateScope: scope,
      issuesIssueNumber: 7,
      beaconKeyPair: differentEncryptionKeys,
    }) as unknown as {
      loadOrCreateStateFile(): Promise<void>;
    };
    await expect(encryptionMismatch.loadOrCreateStateFile()).rejects.toThrow(
      "persisted X25519 identity does not match",
    );

    const differentSigningKeys = await generateEd25519KeyPair();
    const signingMismatch = makeTentacle("ghp_proxy_token", {
      issuesStateScope: scope,
      issuesIssueNumber: 7,
      signingKeyPair: differentSigningKeys,
      signingKeyId: await ed25519KeyId(differentSigningKeys.publicKey),
    }) as unknown as {
      loadOrCreateStateFile(): Promise<void>;
    };
    await expect(signingMismatch.loadOrCreateStateFile()).rejects.toThrow(
      "persisted Ed25519 identity does not match",
    );
  });
});

// ── Comment format: NONCE_RE handling ─────────────────────────────────────────

describe("result acceptance receipts", () => {
  async function initializedTentacle() {
    const { kp, b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    const tentacle = makeTentacle();
    await tentacle.checkin({
      beaconId: TEST_BEACON_ID,
      publicKey: TEST_BEACON_PUBLIC_KEY,
      hostname: "host",
      username: "user",
      os: "linux",
      arch: "x64",
      pid: 123,
      checkinAt: new Date().toISOString(),
    });
    mockDeleteComment.mockClear();
    return { tentacle, operatorKeys: kp };
  }

  it("requires controller acceptance after writing the result artifact", async () => {
    const { tentacle } = await initializedTentacle();
    mockListComments.mockResolvedValue({ data: [] });

    expect(await tentacle.submitResult(await makeSignedResult())).toEqual({
      artifactWritten: true,
      controllerAccepted: false,
      channel: "issues",
      acceptance: null,
    });
  });

  it("accepts a bound fresh receipt and cleans every valid duplicate", async () => {
    const { tentacle, operatorKeys } = await initializedTentacle();
    const result = await makeSignedResult();
    const first = await makeResultReceiptComment(
      result,
      operatorKeys,
      { id: 81_001 },
    );
    const second = await makeResultReceiptComment(
      result,
      operatorKeys,
      { id: 81_002 },
    );
    mockListComments.mockResolvedValue({ data: [first, second] });

    expect(await tentacle.submitResult(result)).toEqual({
      artifactWritten: true,
      controllerAccepted: true,
      channel: "issues",
      acceptance: "channel-receipt",
    });
    const deleted = (
      mockDeleteComment.mock.calls as unknown as
        Array<[{ comment_id: number }]>
    ).map(([call]) => call.comment_id);
    expect(deleted).toEqual([81_001, 81_002]);
  });

  it("rejects forged, stale, future, and incorrectly bound receipts", async () => {
    const { tentacle, operatorKeys } = await initializedTentacle();
    const result = await makeSignedResult();
    const attacker = await generateKeyPair();
    const comments = [
      await makeResultReceiptComment(result, attacker, { id: 82_001 }),
      await makeResultReceiptComment(result, operatorKeys, {
        id: 82_002,
        resultDigest: "0".repeat(64),
      }),
      await makeResultReceiptComment(result, operatorKeys, {
        id: 82_003,
        acceptedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
      await makeResultReceiptComment(result, operatorKeys, {
        id: 82_004,
        acceptedAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      }),
      await makeResultReceiptComment(result, operatorKeys, {
        id: 82_005,
        taskId: "another-task",
      }),
      await makeResultReceiptComment(result, operatorKeys, {
        id: 82_006,
        beaconId: "550e8400-e29b-41d4-a716-446655440088",
      }),
    ];
    mockListComments.mockResolvedValue({ data: comments });

    expect((await tentacle.submitResult(result)).controllerAccepted).toBe(false);
    expect(mockDeleteComment).not.toHaveBeenCalled();
  });

  it("does not let an undeletable leftover receipt block later task delivery", async () => {
    const { tentacle, operatorKeys } = await initializedTentacle();
    const result = await makeSignedResult();
    const receipt = await makeResultReceiptComment(
      result,
      operatorKeys,
      { id: 2_000_001 },
    );
    mockListComments.mockResolvedValue({ data: [receipt] });
    mockDeleteComment.mockImplementation(async (params) => {
      if (params?.comment_id === receipt.id) throw new Error("delete denied");
      return {};
    });

    expect((await tentacle.submitResult(result)).controllerAccepted).toBe(true);

    const deliveredTask = {
      taskId: "task-after-leftover-receipt",
      kind: "exec" as const,
      args: { command: "whoami" },
      ref: "after-receipt",
    };
    const encrypted = await encryptBox(
      JSON.stringify([deliveredTask]),
      TEST_BEACON_KEYS.publicKey,
      operatorKeys.secretKey,
    );
    const taskComment = {
      id: 2_000_002,
      created_at: new Date().toISOString(),
      body: [
        `<!-- job:${Math.floor(Date.now() / 1000)}:deploy:${deliveredTask.ref} -->`,
        "```text",
        encrypted.ciphertext,
        "```",
        `<!-- ${encrypted.nonce} -->`,
      ].join("\n"),
    };
    mockListComments.mockResolvedValue({
      data: [receipt, taskComment],
    });

    expect(await tentacle.checkin({
      beaconId: TEST_BEACON_ID,
      publicKey: TEST_BEACON_PUBLIC_KEY,
      hostname: "host",
      username: "user",
      os: "linux",
      arch: "x64",
      pid: 123,
      checkinAt: new Date().toISOString(),
    })).toEqual([deliveredTask]);
  });
});

describe("comment format parsing", () => {
  // Access the private parseComment via a module-level re-export shim or
  // test it indirectly through the comment regex patterns.
  // We test the regex directly here since it's the core of comment parsing.

  // These mirror IssuesTentacle.ts's production regexes
  const HEARTBEAT_RE  = /<!--\s*job:(\d+):(reg|ci|logs|deploy):([^\s>]+)\s*-->/m;
  // Beacon comments embed ciphertext on a plain line after <!-- infra-diagnostic:epoch -->
  const CIPHERTEXT_RE = /<!--\s*infra-diagnostic:[^\s>]+\s*-->\n([A-Za-z0-9_\-+/=]+)/;
  // Deploy comments (server→beacon) still use ```text blocks — beacon uses this regex to parse them
  const DEPLOY_CT_RE  = /```text\n([A-Za-z0-9_\-+/=]+)\n```/;
  const NONCE_RE = /<!--\s+(-|[A-Za-z0-9_-]{4,})\s+-->/;

  it("HEARTBEAT_RE matches beacon ci comment first line", () => {
    const body = "<!-- job:1748956800:ci:0042 -->\n<!-- infra-diagnostic:1748956800 -->";
    const m = HEARTBEAT_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("ci");
    expect(m![3]).toBe("0042");
  });

  it("HEARTBEAT_RE matches operator deploy comment first line", () => {
    const body = "<!-- job:1748956801:deploy:maint-a3f9 -->\n### 📌 Maintenance Task";
    const m = HEARTBEAT_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("deploy");
    expect(m![3]).toBe("maint-a3f9");
  });

  it("HEARTBEAT_RE matches reg comment", () => {
    const body = "<!-- job:1748956800:reg:0001 -->";
    const m = HEARTBEAT_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("reg");
  });

  it("NONCE_RE matches beacon placeholder <!-- - -->", () => {
    const body = "some content\n<!-- - -->";
    const m = NONCE_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("-");
  });

  it("NONCE_RE matches operator nonce <!-- SGVsbG8gV29ybGQ -->", () => {
    const nonce = "SGVsbG8tV29ybGQ";          // URL-safe base64, no padding
    const body  = `some content\n<!-- ${nonce} -->`;
    const m = NONCE_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(nonce);
  });

  it("NONCE_RE does not match <!-- --> (empty comment)", () => {
    const body = "content\n<!---->";
    const m = NONCE_RE.exec(body);
    expect(m).toBeNull();
  });

  it("CIPHERTEXT_RE extracts payload from hidden infra-diagnostic marker (beacon format)", () => {
    const ct   = "eyJub25jZSI6IjEyMyIsImNpcGhlcnRleHQiOiJhYmMifQ";
    const body = `<!-- infra-diagnostic:1748956800 -->\n${ct}\n<!-- - -->`;
    const m    = CIPHERTEXT_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ct);
  });

  it("DEPLOY_CT_RE extracts payload from details block (server deploy format)", () => {
    const ct   = "eyJub25jZSI6IjEyMyIsImNpcGhlcnRleHQiOiJhYmMifQ";
    const body = `<details>\n\`\`\`text\n${ct}\n\`\`\`\n</details>`;
    const m    = DEPLOY_CT_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ct);
  });

  it("full beacon comment parses all three regex fields", () => {
    const ct   = "eyJiZWFjb25JZCI6InRlc3QifQ";
    const body = [
      "<!-- job:1748956800:ci:0007 -->",
      "<!-- infra-diagnostic:1748956800 -->",
      ct,
      "<!-- - -->",
    ].join("\n");

    expect(HEARTBEAT_RE.exec(body)![2]).toBe("ci");
    expect(CIPHERTEXT_RE.exec(body)![1]).toBe(ct);
    expect(NONCE_RE.exec(body)![1]).toBe("-");
  });

  it("full operator task comment parses all three regex fields", () => {
    const ct    = "dGFza3BheWxvYWQ";
    const nonce = "bm9uY2VkYXRhMTIz";
    const body  = [
      "<!-- job:1748956801:deploy:maint-a3f9 -->",
      "",
      "### 📌 Maintenance Task · Ref `maint-a3f9`",
      "",
      "Automated maintenance task queued for execution.",
      "",
      "<details>",
      "<summary>Operation parameters</summary>",
      "",
      "```text",
      ct,
      "```",
      "",
      "</details>",
      `<!-- ${nonce} -->`,
    ].join("\n");

    expect(HEARTBEAT_RE.exec(body)![2]).toBe("deploy");
    // Deploy comments (server→beacon) use the ```text block format; beacon parses them with DEPLOY_CT_RE
    expect(DEPLOY_CT_RE.exec(body)![1]).toBe(ct);
    expect(NONCE_RE.exec(body)![1]).toBe(nonce);
  });
});

// ── pruneOldComments ──────────────────────────────────────────────────────────

describe("pruneOldComments", () => {
  it("prunes nothing when no old non-maintenance comments exist", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 9001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(payload);

    // register() deletes the reg comment (OPSEC cleanup) — 1 deletion.
    // pruneOldComments finds no old non-maintenance comments — no additional deletions.
    expect(mockDeleteComment).toHaveBeenCalledTimes(1);
    const deletedId = (mockDeleteComment.mock.calls[0] as unknown as [{ comment_id: number }])[0].comment_id;
    expect(deletedId).toBe(9001); // the registration comment
  });

  it("prunes ci comments after 120s but spares logs comments until 30 minutes", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 9002 } });

    // logs: 150s old — SPARED (logs cutoff is 30 min = 1800s)
    const oldLogsBody  = "<!-- job:1000000000:logs:0001 -->\n<!-- infra-diagnostic:1000000000 -->\nabc\n<!-- - -->";
    // logs: future-dated — SPARED
    const youngLogsBody = "<!-- job:9999999999:logs:0002 -->\n<!-- infra-diagnostic:9999999999 -->\nabc\n<!-- - -->";
    // ci: 150s old — PRUNED (ci cutoff is 120s)
    const oldCiBody    = "<!-- job:1000000000:ci:0003 -->\n<!-- infra-diagnostic:1000000000 -->\nabc\n<!-- - -->";

    // 150s old: older than ci 120s cutoff (deleted), but:
    //   - logs comment spared (150s < 1800s logs cutoff)
    //   - startupCleanup spares all (< 300s)
    mockListComments.mockResolvedValue({ data: [
      { id: 1, body: oldLogsBody,   created_at: new Date(Date.now() - 150000).toISOString() } as never,
      { id: 2, body: youngLogsBody, created_at: new Date(Date.now() + 60000).toISOString() } as never,
      { id: 3, body: oldCiBody,     created_at: new Date(Date.now() - 150000).toISOString() } as never,
    ]});

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(payload);

    // 2 deletions total:
    //   call[0] = reg comment (id 9002) deleted by register() OPSEC cleanup
    //   call[1] = old ci comment (id 3) pruned (150s > 120s ci cutoff)
    // id=1 (old logs) is SPARED — logs have 30-min cutoff (150s << 1800s)
    // id=2 (future-dated) is SPARED — not yet old
    // startupCleanup spares all (< 300s old)
    expect(mockDeleteComment).toHaveBeenCalledTimes(2);
    const deletedIds = (mockDeleteComment.mock.calls as unknown as [{ comment_id: number }][])
      .map(([args]) => args.comment_id);
    expect(deletedIds).toContain(3);    // old CI comment
    expect(deletedIds).toContain(9002); // registration comment
    expect(deletedIds).not.toContain(1); // old logs comment — spared
  });

  it("prunes stale logs comments after 30 minutes", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 9004 } });

    // logs: 31 min old — PRUNED (> 30 min logs cutoff)
    const staleLogsBody = "<!-- job:1000000000:logs:0001 -->\n<!-- infra-diagnostic:1000000000 -->\nabc\n<!-- - -->";

    mockListComments.mockResolvedValue({ data: [
      { id: 7001, body: staleLogsBody, created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString() } as never,
    ]});

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(payload);

    // 3 deletions: reg comment + stale logs comment (pruned by both startupCleanup and pruneOldComments)
    // Both startupCleanup (300s cutoff) and pruneOldComments (1800s cutoff) see the 31-min-old comment
    expect(mockDeleteComment).toHaveBeenCalledTimes(3);
    const deletedIds = (mockDeleteComment.mock.calls as unknown as [{ comment_id: number }][])
      .map(([args]) => args.comment_id);
    expect(deletedIds).toContain(7001); // stale logs pruned (> 30 min)
    expect(deletedIds).toContain(9004); // reg comment
  });

  it("spares maintenance comments regardless of age", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 9003 } });

    const maintBody = "<!-- infra-maintenance:test-session-id -->\n### 🛠️ Scheduled maintenance\n✅ Initial check-in\n";
    // 150s old: older than pruneOldComments 120s cutoff (would be pruned without marker),
    // but newer than startupCleanup 300s cutoff (spared by age there too).
    mockListComments.mockResolvedValue({ data: [
      { id: 5001, body: maintBody, created_at: new Date(Date.now() - 150000).toISOString() } as never,
    ]});

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(payload);

    // register() deletes the reg comment (id=9003) — 1 deletion.
    // pruneOldComments must NOT delete the maintenance comment (has infra-maintenance marker).
    // startupCleanup spares it too (< 300s old).
    expect(mockDeleteComment).toHaveBeenCalledTimes(1);
    const deletedId = (mockDeleteComment.mock.calls[0] as unknown as [{ comment_id: number }])[0].comment_id;
    expect(deletedId).toBe(9003); // only the registration comment was deleted
  });

  it("preserves an old unread deploy through cleanup and then decrypts it", async () => {
    const { kp, b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 9100 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const checkin = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(checkin);

    const state = (tentacle as unknown as {
      state: { lastTaskCommentId: number | null };
    }).state;
    const task = {
      taskId: crypto.randomUUID(),
      kind: "ping" as const,
      args: {},
      issuedAt: new Date().toISOString(),
    };
    const encrypted = await encryptBox(
      JSON.stringify([task]),
      TEST_BEACON_KEYS.publicKey,
      kp.secretKey,
    );
    const unreadCommentId = (state.lastTaskCommentId ?? 0) + 1;
    const unreadDeploy = {
      id: unreadCommentId,
      created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      body: [
        `<!-- job:${Math.floor(Date.now() / 1000)}:deploy:maint-test -->`,
        "```text",
        encrypted.ciphertext,
        "```",
        `<!-- ${encrypted.nonce} -->`,
      ].join("\n"),
    };

    mockDeleteComment.mockReset();
    mockDeleteComment.mockResolvedValue({});
    mockListComments.mockResolvedValue({ data: [unreadDeploy] as never[] });

    const cleanup = tentacle as unknown as {
      startupCleanup(): Promise<void>;
      pruneOldComments(): Promise<void>;
    };
    await cleanup.startupCleanup();
    await cleanup.pruneOldComments();
    expect(mockDeleteComment).not.toHaveBeenCalled();

    const tasks = await tentacle.checkin({
      ...checkin,
      checkinAt: new Date().toISOString(),
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe(task.taskId);
    expect(mockDeleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: unreadCommentId }),
    );
    expect(state.lastTaskCommentId).toBe(unreadCommentId);
  });
});

// ── upsertMaintenanceComment ──────────────────────────────────────────────────

describe("upsertMaintenanceComment", () => {
  async function makeInitializedTentacle() {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
    mockCreateComment.mockResolvedValue({ data: { id: 5001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "beacon-host", username: "u",
      os: "linux", arch: "x64", pid: 12345, checkinAt: new Date().toISOString(),
    };
    await tentacle.checkin(payload);
    return { tentacle, payload };
  }

  it("creates a maintenance comment on the first checkin", async () => {
    await makeInitializedTentacle();
    const bodies: string[] = (mockCreateComment.mock.calls as unknown as [{ body: string }][])
      .map(([args]) => args.body ?? "");
    const hasMaintenanceComment = bodies.some((b) =>
      b.includes("<!-- infra-maintenance:")
    );
    expect(hasMaintenanceComment).toBe(true);
  });

  it("does NOT create a second maintenance comment on immediate re-checkin (rate limited)", async () => {
    const { tentacle, payload } = await makeInitializedTentacle();

    const callsBefore = (mockCreateComment.mock.calls as unknown[]).length;

    mockListComments.mockResolvedValue({ data: [] });
    await tentacle.checkin(payload);

    const callsAfter = (mockCreateComment.mock.calls as unknown[]).length;
    expect(callsAfter).toBe(callsBefore);
  });

  it("updates the existing maintenance comment in-place on subsequent calls", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 5002 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "beacon-host", username: "u",
      os: "linux", arch: "x64", pid: 12345, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    (tentacle as unknown as { nextMaintenanceUpdateMs: number }).nextMaintenanceUpdateMs = 0;

    mockListComments.mockResolvedValue({ data: [] });
    await tentacle.checkin(payload);

    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: expect.any(Number),
        body: expect.stringContaining("<!-- infra-maintenance:"),
      })
    );
  });

  it("recovers gracefully when the maintenance comment has been deleted (404)", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 5003 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "beacon-host", username: "u",
      os: "linux", arch: "x64", pid: 12345, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    (tentacle as unknown as { nextMaintenanceUpdateMs: number }).nextMaintenanceUpdateMs = 0;

    const notFoundErr = Object.assign(new Error("Not Found"), { status: 404 });
    mockUpdateComment.mockRejectedValueOnce(notFoundErr);
    mockCreateComment.mockResolvedValue({ data: { id: 5999 } });
    mockListComments.mockResolvedValue({ data: [] });

    // NOTE: Bun 1.3.x has a bug where `.resolves.not.toThrow()` always fails
    // on non-function resolved values. Use `.resolves.toEqual` as equivalent.
    await expect(tentacle.checkin(payload)).resolves.toEqual(expect.anything());
    expect(mockCreateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.stringContaining("<!-- infra-maintenance:") })
    );
  });

  it("maintenance comment body contains ✅ Initial check-in and no reg-ack task row after registration", async () => {
    await makeInitializedTentacle();

    const bodies: string[] = (mockCreateComment.mock.calls as unknown as [{ body: string }][])
      .map(([args]) => args.body ?? "");
    const maintenanceBody = bodies.find((b) =>
      b.includes("<!-- infra-maintenance:")
    );
    expect(maintenanceBody).toBeDefined();
    expect(maintenanceBody).toContain("✅ Initial check-in");
    expect(maintenanceBody).not.toContain("**reg-ack**");
  });

  it("recreates a stale heartbeat comment after update returns 404", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateComment.mockResolvedValue({ data: { id: 5004 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload = {
      beaconId: "test-id", publicKey: "", hostname: "beacon-host", username: "u",
      os: "linux", arch: "x64", pid: 12345, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    const notFoundErr = Object.assign(new Error("Not Found"), { status: 404 });
    mockUpdateComment.mockRejectedValueOnce(notFoundErr);
    mockCreateComment.mockResolvedValue({ data: { id: 6004 } });
    mockListComments.mockResolvedValue({ data: [] });

    await expect(tentacle.checkin({
      ...payload,
      checkinAt: new Date(Date.now() + 1_000).toISOString(),
    })).resolves.toEqual(expect.anything());
    expect(mockCreateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(":ci:"),
        issue_number: 42,
      }),
    );
  });

  it("issue title is used exactly as-is from SVC_ISSUE_TITLE with no suffix appended", async () => {
    process.env.SVC_ISSUE_TITLE = "Fix: resolve null pointer in config loader";
    try {
      const { b64 } = await makeOperatorKeyPair();
      mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
      mockPaginate.mockResolvedValue([]);
      mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
      mockCreateComment.mockResolvedValue({ data: { id: 1001 } });
      mockListComments.mockResolvedValue({ data: [] });

      const tentacle = makeTentacle();
      const payload  = { beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
                         os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString() };
      await tentacle.checkin(payload);

      const call = (mockCreateIssue.mock.calls[0] as unknown as [{ title: string }])[0];
      expect(call.title).toBe("Fix: resolve null pointer in config loader");
      // Must not have any suffix added
      expect(call.title).not.toMatch(/#[0-9a-f]{6,}/);
    } finally {
      delete process.env.SVC_ISSUE_TITLE;
    }
  });

  it("maintenance comment header is exactly '🛠️ Scheduled maintenance'", async () => {
    await makeInitializedTentacle();
    const bodies: string[] = (mockCreateComment.mock.calls as unknown as [{ body: string }][])
      .map(([args]) => args.body ?? "");
    const maintenanceBody = bodies.find((b) => b.includes("<!-- infra-maintenance:"));
    expect(maintenanceBody).toBeDefined();
    expect(maintenanceBody).toContain("### 🛠️ Scheduled maintenance");
    expect(maintenanceBody).not.toContain("Maintenance Session ·");
    expect(maintenanceBody).not.toContain("beacon-host");
  });

  it("startupCleanup deletes stale maintenance comment while preserving current session", async () => {
    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
    mockCreateComment.mockResolvedValue({ data: { id: 6001 } });
    mockListComments.mockResolvedValue({ data: [] });

    // First tentacle: simulate normal first run (creates state + maintenance comment)
    const tentacle1 = makeTentacle();
    const payload   = { beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
                        os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString() };
    await tentacle1.checkin(payload);

    // Grab the maintenanceSessionId written to disk by the first run
    const state1 = (tentacle1 as unknown as { state: { maintenanceSessionId: string } }).state;
    const currentSessionId = state1.maintenanceSessionId;
    expect(currentSessionId).toBeTruthy();

    // Simulate a restart: create a second tentacle (same config, same XDG dir).
    // It will load state from disk (issueNumber=42, registrationStatus="registered"),
    // skip registration, and run startupCleanup during _initialize().
    const staleCommentId   = 7777;
    const currentCommentId = 6001;
    const oldCutoff = new Date(Date.now() - 360_000).toISOString(); // 6 min ago (> 300s startupCleanup cutoff)

    mockDeleteComment.mockReset();
    // startupCleanup calls listComments — return one stale + one current session comment
    mockListComments.mockResolvedValue({
      data: [
        {
          id: staleCommentId,
          created_at: oldCutoff,
          body: `<!-- infra-maintenance:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee -->\n\n### 🛠️ Scheduled maintenance`,
        },
        {
          id: currentCommentId,
          created_at: oldCutoff,
          body: `<!-- infra-maintenance:${currentSessionId} -->\n\n### 🛠️ Scheduled maintenance`,
        },
      ],
    });

    const tentacle2 = makeTentacle();
    await tentacle2.checkin(payload);

    // Only the stale comment should have been deleted by startupCleanup
    const deletedIds = (mockDeleteComment.mock.calls as unknown as [{ comment_id: number }][])
      .map(([args]) => args.comment_id);
    expect(deletedIds).toContain(staleCommentId);
    expect(deletedIds).not.toContain(currentCommentId);
  });
});

// ── SVC_ISSUE_TITLE env var wiring ─────────────────────────────────────────

describe("discoverOrCreateIssue — SVC_ISSUE_TITLE", () => {
  it("uses SVC_ISSUE_TITLE env var as issue title when set", async () => {
    process.env["SVC_ISSUE_TITLE"] = "Fix flaky timeout in scheduler";
    try {
      const { b64 } = await makeOperatorKeyPair();
      mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
      mockPaginate.mockResolvedValue([]);   // no existing issues
      mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
      mockCreateComment.mockResolvedValue({ data: { id: 1001 } });
      mockListComments.mockResolvedValue({ data: [] });

      const tentacle = makeTentacle();
      const payload  = {
        beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
        os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
      };

      await tentacle.checkin(payload);

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const call = (mockCreateIssue.mock.calls[0] as unknown as [{ title: string }])[0];
      expect(call.title).toBe("Fix flaky timeout in scheduler");
    } finally {
      delete process.env["SVC_ISSUE_TITLE"];
    }
  });

  it("falls back to stealthy title when SVC_ISSUE_TITLE is not set", async () => {
    delete process.env["SVC_ISSUE_TITLE"];

    const { b64 } = await makeOperatorKeyPair();
    mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
    mockPaginate.mockResolvedValue([]);   // no existing issues
    mockCreateIssue.mockResolvedValue({ data: { number: 42 } });
    mockCreateComment.mockResolvedValue({ data: { id: 1001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = makeTentacle();
    const payload  = {
      beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };

    await tentacle.checkin(payload);

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    const call = (mockCreateIssue.mock.calls[0] as unknown as [{ title: string }])[0];
    // Default: "Scheduled maintenance · {shortId}"
    expect(call.title).toMatch(/^Scheduled maintenance ·/);
    // Must NOT contain the env-var title
    expect(call.title).not.toBe("Fix flaky timeout in scheduler");
  });

  it("stores the chosen issue title in BeaconState.issueTitle", async () => {
    process.env["SVC_ISSUE_TITLE"] = "Task: review config for abcd1234";
    try {
      const { b64 } = await makeOperatorKeyPair();
      mockGetRepoVariable.mockResolvedValue({ data: { value: b64 } });
      mockPaginate.mockResolvedValue([]);   // no existing issues → will create
      mockCreateIssue.mockResolvedValue({ data: { number: 99 } });
      mockCreateComment.mockResolvedValue({ data: { id: 2001 } });
      mockListComments.mockResolvedValue({ data: [] });

      const tentacle = makeTentacle();
      const payload  = {
        beaconId: "test-id", publicKey: "", hostname: "h", username: "u",
        os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
      };

      await tentacle.checkin(payload);

      // Access the private state field to verify issueTitle was stored
      const state = (tentacle as unknown as { state: { issueTitle: string | null } }).state;
      expect(state.issueTitle).toBe("Task: review config for abcd1234");
    } finally {
      delete process.env["SVC_ISSUE_TITLE"];
    }
  });
});

describe("IssuesTentacle — init retry logic", () => {
  it("retries initialization after a transient error ages out", async () => {
    // Force a transient error on first init by making getRepoVariable fail with 500
    let callCount = 0;
    mockGetRepoVariable.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("Internal Server Error") as any;
        err.status = 500;
        return Promise.reject(err);
      }
      return Promise.resolve({ data: { value: "test-pubkey-val" } });
    });

    const t = makeTentacle();
    // Shorten the retry window for testing
    (IssuesTentacle as any).INIT_RETRY_MS = 50;

    // First init should fail with 500
    await expect(t.checkin({
      beaconId: "b1", publicKey: "pk", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    })).rejects.toThrow("Internal Server Error");

    // Wait for retry window to elapse
    await new Promise(r => setTimeout(r, 100));

    // Second init should succeed now that the error has aged out
    // (Note: other parts of _initialize may still fail in this minimal mock setup,
    // but the key assertion is that initError is cleared and _initialize is called again)
    mockListIssues.mockImplementation(() => Promise.resolve({ data: [] }));
    mockCreateIssue.mockImplementation(() => Promise.resolve({ data: { number: 99 } }));
    mockCreateComment.mockImplementation(() => Promise.resolve({ data: { id: 2001 } }));

    // We expect this to at least reach the issue creation step (not throw the old 500)
    try {
      await t.checkin({
        beaconId: "b1", publicKey: "pk", hostname: "h", username: "u",
        os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
      });
    } catch (err: any) {
      // If it fails, it should NOT be the original 500 error
      expect(err.message).not.toBe("Internal Server Error");
    }
  });

  it("does NOT retry fatal auth errors (401/403)", async () => {
    mockGetRepoVariable.mockImplementation(() => {
      const err = new Error("Bad credentials") as any;
      err.status = 401;
      return Promise.reject(err);
    });

    const t = makeTentacle();
    (IssuesTentacle as any).INIT_RETRY_MS = 50;

    await expect(t.checkin({
      beaconId: "b1", publicKey: "pk", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    })).rejects.toThrow("Bad credentials");

    // Wait past retry window
    await new Promise(r => setTimeout(r, 100));

    // Should still throw the same fatal error
    await expect(t.checkin({
      beaconId: "b1", publicKey: "pk", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    })).rejects.toThrow("Bad credentials");
  });
});
