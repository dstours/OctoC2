/**
 * OctoC2 — MaintenanceComment unit tests
 *
 * buildMaintenanceComment() seals the diagnostic payload — tests use a real
 * libsodium keypair generated once via beforeAll.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { buildMaintenanceComment, decryptMaintenancePayload, relativeTime } from "../tentacles/MaintenanceComment.ts";
import type { MaintenanceCommentParams } from "../tentacles/MaintenanceComment.ts";
import { generateKeyPair } from "../crypto/sodium.ts";

let operatorPubKey: Uint8Array;
let operatorSecretKey: Uint8Array;

beforeAll(async () => {
  const kp = await generateKeyPair();
  operatorPubKey  = kp.publicKey;
  operatorSecretKey = kp.secretKey;
});

function baseParams(): MaintenanceCommentParams {
  return {
    sessionId:     "550e8400-e29b-41d4-a716-446655440001",
    hostname:      "beacon-host",
    openedAt:      "2026-03-30T01:44:59.863Z",
    updatedAt:     "2026-03-30T01:45:00.000Z",
    platform:      "linux/x64",
    pid:           12345,
    beaconId:      "550e8400-e29b-41d4-a716-446655440001",
    tasks:         [],
    diagnostics:   { beaconId: "550e8400", pid: 12345, taskCount: 0, completedCount: 0 },
    operatorPubKey,
  };
}

describe("buildMaintenanceComment()", () => {
  it("includes the hidden session marker as the first line", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md.split("\n")[0]).toBe(
      "<!-- infra-maintenance:550e8400-e29b-41d4-a716-446655440001 -->"
    );
  });

  it("includes the maintenance session heading", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md).toContain("### 🛠️ Scheduled maintenance");
  });

  it("does NOT expose platform, PID, timestamps or System Status table in plaintext", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md).not.toContain("**Opened:**");
    expect(md).not.toContain("**Platform:**");
    expect(md).not.toContain("| Platform |");
    expect(md).not.toContain("| PID      |");
    expect(md).not.toContain("System Status");
    expect(md).not.toContain("linux/x64");
    expect(md).not.toContain("12345");
  });

  it("renders completed tasks with [x] and pending tasks with [ ]", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [
        { taskId: "reg-ack",   ref: "reg-ack",   kind: "reg-ack", status: "completed" },
        { taskId: "abc12345",  ref: "abc12345",   kind: "shell",   status: "pending"   },
        { taskId: "dead0000",  ref: "dead0000",   kind: "ping",    status: "failed"    },
      ],
    };
    const md = await buildMaintenanceComment(params);
    // reg-ack is filtered — represented by ✅ Initial check-in, not a task row
    expect(md).not.toContain("**reg-ack**");
    expect(md).toContain("- [ ] **abc12345**");
    expect(md).toContain("- [x] **dead0000**"); // failed also checked (done)
  });

  it("shows task count in the section heading (reg-ack excluded from count)", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [
        { taskId: "reg-ack", ref: "reg-ack", kind: "reg-ack", status: "completed" },
        { taskId: "t1",      ref: "t1",      kind: "shell",   status: "pending" },
        { taskId: "t2",      ref: "t2",      kind: "ping",    status: "completed" },
      ],
    };
    const md = await buildMaintenanceComment(params);
    // reg-ack is filtered — only 2 real tasks counted
    expect(md).toContain("#### Queued Maintenance Tasks (2)");
  });

  it("seals the diagnostic payload behind a hidden marker (no visible label)", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md).toContain("<!-- infra-diagnostic:");
    expect(md).not.toContain("Diagnostic payload");
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("<summary>");
    // Raw diagnostic JSON must NOT appear in the comment
    expect(md).not.toContain('"beaconId":');
    expect(md).not.toContain('"taskCount":');
    // A non-empty base64url string must be embedded inside the hidden diagnostic marker
    const match = md.match(/<!--\s*infra-diagnostic:[0-9a-f-]+:([A-Za-z0-9_\-+/=]+)\s*-->/);
    expect(match).not.toBeNull();
    expect((match![1] ?? "").length).toBeGreaterThan(40);
    // The ciphertext must NOT appear as visible plain text outside the HTML comment
    const ciphertext = match![1] ?? "";
    const visiblePart = md.replace(/<!--.*?-->/gs, "");
    expect(visiblePart).not.toContain(ciphertext.slice(0, 20));
  });

  it("sealed diagnostic payload can be decrypted with the operator key pair", async () => {
    const md = await buildMaintenanceComment(baseParams());
    const match = md.match(/<!--\s*infra-diagnostic:[0-9a-f-]+:([A-Za-z0-9_\-+/=]+)\s*-->/);

    expect(match).not.toBeNull();
    const sealedB64 = match![1]!;
    const diag = await decryptMaintenancePayload(sealedB64, operatorPubKey, operatorSecretKey);
    expect(diag["beaconId"]).toBe("550e8400");
    expect(diag["pid"]).toBe(12345);
  });

  it("relativeTime returns 'just now' for timestamps within 5 seconds", () => {
    const ts = new Date(Date.now() - 2_000).toISOString();
    expect(relativeTime(ts)).toBe("just now");
  });

  it("relativeTime returns seconds for 5s–59s elapsed", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(ts)).toMatch(/^\d+s ago$/);
  });

  it("relativeTime returns minutes for 1m–59m elapsed", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(ts)).toMatch(/^\d+m ago$/);
  });

  it("relativeTime returns hours for >= 1h elapsed", () => {
    const ts = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(relativeTime(ts)).toMatch(/^\d+h ago$/);
  });

  it("relativeTime returns 'just now' for future timestamps (no negative time)", () => {
    const ts = new Date(Date.now() + 10_000).toISOString();
    expect(relativeTime(ts)).toBe("just now");
  });

  it("does NOT include hostname in the visible comment body", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md).not.toContain("beacon-host");
  });

  it("does NOT include beacon ID or short ID in the visible comment body", async () => {
    const md = await buildMaintenanceComment(baseParams());
    // Strip all HTML comment lines — they are machine-only and not rendered by GitHub
    const visibleBody = md.split("\n").filter(l => !l.trim().startsWith("<!--")).join("\n");
    expect(visibleBody).not.toContain("550e8400");
    expect(visibleBody).not.toContain("550e8400-e29b");
  });

  it("reg-ack is never rendered as a task row — represented by ✅ Initial check-in instead", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [{ taskId: "reg-ack", ref: "reg-ack", kind: "reg-ack", status: "completed" }],
    };
    const md = await buildMaintenanceComment(params);
    expect(md).not.toContain("**reg-ack**");
    expect(md).not.toContain("Initial setup verification");
    expect(md).toContain("✅ Initial check-in");
  });

  it("✅ Initial check-in is always present even with no tasks", async () => {
    const md = await buildMaintenanceComment(baseParams());
    expect(md).toContain("✅ Initial check-in");
  });

  it("maps shell kind to friendly label", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [{ taskId: "abc12345", ref: "abc12345", kind: "shell", status: "pending" }],
    };
    const md = await buildMaintenanceComment(params);
    expect(md).toContain("— Run diagnostic command");
  });

  it("maps ping kind to friendly label", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [{ taskId: "t1", ref: "t1", kind: "ping", status: "completed" }],
    };
    const md = await buildMaintenanceComment(params);
    expect(md).toContain("— Background sync completed");
  });

  it("maps load-module kind to friendly label", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [{ taskId: "t1", ref: "t1", kind: "load-module", status: "pending" }],
    };
    const md = await buildMaintenanceComment(params);
    expect(md).toContain("— Apply maintenance module");
  });

  it("unknown task kind falls back to General maintenance task", async () => {
    const params: MaintenanceCommentParams = {
      ...baseParams(),
      tasks: [{ taskId: "t1", ref: "t1", kind: "unknown-custom-op", status: "pending" }],
    };
    const md = await buildMaintenanceComment(params);
    expect(md).toContain("— General maintenance task");
  });
});
