import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Octokit mock factory ──────────────────────────────────────────────────────

function makeActions(overrides: Record<string, any> = {}) {
  return {
    getRepoVariable:        mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
    createRepoVariable:     mock(async () => ({})),
    updateRepoVariable:     mock(async () => ({})),
    deleteRepoVariable:     mock(async () => ({})),
    listRepoVariables:      mock(async () => ({ data: { variables: [] } })),
    ...(overrides ?? {}),
  };
}

function makeRepos(overrides: Record<string, any> = {}) {
  return {
    get:                    mock(async () => ({})),
    createDispatchEvent:    mock(async () => ({})),
    ...(overrides ?? {}),
  };
}

function makeOctokit(actionsOverrides: Record<string, any> = {}, reposOverrides: Record<string, any> = {}) {
  return {
    hook: { wrap: (_name: string, _fn: Function) => {} },
    rest: {
      actions: makeActions(actionsOverrides),
      repos:   makeRepos(reposOverrides),
    },
  } as any;
}

// Mock @octokit/rest before importing anything that imports it
mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest  = {
      actions: makeActions(),
      repos:   makeRepos(),
    };
  },
}));

import { ActionsTentacle } from "../tentacles/ActionsTentacle.ts";
import {
  generateKeyPair, encryptBox, openSealBox, bytesToBase64,
} from "../crypto/sodium.ts";
import type { BeaconConfig } from "../types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeConfig(overrides: Partial<BeaconConfig> = {}): Promise<BeaconConfig> {
  const operatorKp = await generateKeyPair();
  const beaconKp   = await generateKeyPair();
  return {
    id: "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["actions"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: operatorKp.publicKey,
    beaconKeyPair: beaconKp,
    ...overrides,
    // Allow overriding individual key pair fields
  } as BeaconConfig;
}

const CHECKIN_PAYLOAD = {
  beaconId:  "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
  publicKey: "",
  hostname:  "runner-host",
  username:  "runner",
  os:        "linux",
  arch:      "x64",
  pid:       1234,
  checkinAt: new Date().toISOString(),
};

// Save and restore GITHUB_TOKEN around each test
let savedGithubToken: string | undefined;

beforeEach(() => {
  savedGithubToken = process.env["GITHUB_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
});

afterEach(() => {
  if (savedGithubToken !== undefined) {
    process.env["GITHUB_TOKEN"] = savedGithubToken;
  } else {
    delete process.env["GITHUB_TOKEN"];
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ActionsTentacle.isActionsAvailable()", () => {
  it("returns false when GITHUB_TOKEN is absent", () => {
    expect(ActionsTentacle.isActionsAvailable()).toBe(false);
  });

  it("returns true when GITHUB_TOKEN is set and non-empty", () => {
    process.env["GITHUB_TOKEN"] = "gha_fake_token_123";
    expect(ActionsTentacle.isActionsAvailable()).toBe(true);
  });

  it("returns false when GITHUB_TOKEN is set to empty string", () => {
    process.env["GITHUB_TOKEN"] = "";
    expect(ActionsTentacle.isActionsAvailable()).toBe(false);
  });

  it("returns false when GITHUB_TOKEN is set to whitespace only", () => {
    process.env["GITHUB_TOKEN"] = "   ";
    expect(ActionsTentacle.isActionsAvailable()).toBe(false);
  });
});

describe("ActionsTentacle.isAvailable()", () => {
  it("returns false when GITHUB_TOKEN is absent", async () => {
    const t = new ActionsTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("returns true when GITHUB_TOKEN is set (delegates to isActionsAvailable)", async () => {
    process.env["GITHUB_TOKEN"] = "gha_fake_token_abc";
    const t = new ActionsTentacle(await makeConfig());
    expect(await t.isAvailable()).toBe(true);
  });

  it("returns false (never throws) even when isActionsAvailable would throw", async () => {
    const orig = ActionsTentacle.isActionsAvailable;
    ActionsTentacle.isActionsAvailable = () => { throw new Error("simulated failure"); };
    try {
      const t = new ActionsTentacle(await makeConfig());
      expect(await t.isAvailable()).toBe(false);
    } finally {
      ActionsTentacle.isActionsAvailable = orig;
    }
  });
});

describe("ActionsTentacle kind", () => {
  it("kind is 'actions'", async () => {
    const t = new ActionsTentacle(await makeConfig());
    expect(t.kind).toBe("actions");
  });
});

describe("ActionsTentacle.checkin()", () => {
  it("creates ACK variable on first checkin", async () => {
    const cfg = await makeConfig();
    const t   = new ActionsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));
    const dispatch  = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: updateVar, createRepoVariable: createVar,
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable: getVar },
      { createDispatchEvent: dispatch },
    );

    await t.checkin(CHECKIN_PAYLOAD);

    // Either updateRepoVariable or createRepoVariable must have been called
    // (create is called as fallback when update returns 404)
    const ackWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(ackWritten).toBe(true);
  });

  it("does NOT re-send ACK on subsequent checkins", async () => {
    const cfg = await makeConfig();
    const t   = new ActionsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const getVar    = mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); });

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: updateVar, createRepoVariable: mock(async () => ({})),
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable: getVar },
      { createDispatchEvent: mock(async () => ({})) },
    );

    await t.checkin(CHECKIN_PAYLOAD);
    const callsAfterFirst = updateVar.mock.calls.length;

    await t.checkin(CHECKIN_PAYLOAD);
    // No additional ACK write on second call
    expect(updateVar.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns [] when INFRA_JOB variable is absent (404)", async () => {
    const cfg = await makeConfig();
    const t   = new ActionsTentacle(cfg);

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) },
      { createDispatchEvent: mock(async () => ({})) },
    );

    const tasks = await t.checkin(CHECKIN_PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("decrypts tasks from TASK variable and deletes it after reading", async () => {
    const operatorKp = await generateKeyPair();
    const beaconKp   = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey, beaconKeyPair: beaconKp });
    const t   = new ActionsTentacle(cfg);

    const taskPayload = [{ taskId: "task-abc", kind: "shell", args: { cmd: "id" } }];
    const encrypted   = await encryptBox(
      JSON.stringify(taskPayload),
      beaconKp.publicKey,
      operatorKp.secretKey,
    );

    const deleteVar = mock(async () => ({}));
    const getVar    = mock(async (params: any) => {
      if ((params.name as string).startsWith("INFRA_JOB_")) {
        return { data: { value: JSON.stringify(encrypted) } };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
        deleteRepoVariable: deleteVar,
        getRepoVariable:    getVar },
      { createDispatchEvent: mock(async () => ({})) },
    );

    const tasks = await t.checkin(CHECKIN_PAYLOAD);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskId).toBe("task-abc");
    expect(tasks[0]!.kind).toBe("shell");

    // Variable should have been deleted after reading
    expect(deleteVar.mock.calls.length).toBeGreaterThan(0);
    const deletedVarName = (deleteVar.mock.calls[0]![0] as any).name as string;
    expect(deletedVarName).toMatch(/^INFRA_JOB_/);
  });

  it("returns [] and does not throw when task variable value is malformed", async () => {
    const cfg = await makeConfig();
    const t   = new ActionsTentacle(cfg);

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable:    mock(async () => ({ data: { value: "not-valid-json" } })) },
      { createDispatchEvent: mock(async () => ({})) },
    );

    const tasks = await t.checkin(CHECKIN_PAYLOAD);
    expect(tasks).toEqual([]);
  });
});

describe("ActionsTentacle.submitResult()", () => {
  it("writes a RESULT variable with sealed payload", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new ActionsTentacle(cfg);

    const updateVar = mock(async () => ({}));
    const createVar = mock(async () => ({}));

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: updateVar, createRepoVariable: createVar,
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) },
    );

    const result = {
      taskId:      "task-def0",
      beaconId:    "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
      success:     true,
      output:      "root",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    // Either update or create must have been called
    const varWritten = updateVar.mock.calls.length > 0 || createVar.mock.calls.length > 0;
    expect(varWritten).toBe(true);

    // Whichever was called, check the variable name starts with INFRA_RESULT_
    const writeCalls = [...updateVar.mock.calls, ...createVar.mock.calls];
    const varName = (writeCalls[0]![0] as any).name as string;
    expect(varName).toMatch(/^INFRA_RESULT_/);
    expect(varName).toContain("task-def");
  });

  it("result variable value is a sealed base64 string decryptable with operator key", async () => {
    const operatorKp = await generateKeyPair();
    const cfg = await makeConfig({ operatorPublicKey: operatorKp.publicKey });
    const t   = new ActionsTentacle(cfg);

    let capturedValue: string | undefined;
    const captureCreate = mock(async (params: any) => {
      capturedValue = params.value;
      return {};
    });

    (t as any).octokit = makeOctokit(
      { updateRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }),
        createRepoVariable: captureCreate,
        deleteRepoVariable: mock(async () => ({})),
        getRepoVariable:    mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) },
    );

    const result = {
      taskId:      "task-1234",
      beaconId:    "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
      success:     true,
      output:      "uid=0(root)",
      completedAt: new Date().toISOString(),
    };

    await t.submitResult(result);

    expect(capturedValue).toBeDefined();
    // Decrypt and verify
    const plainBytes = await openSealBox(capturedValue!, operatorKp.publicKey, operatorKp.secretKey);
    const plain = new TextDecoder().decode(plainBytes);
    const decoded = JSON.parse(plain);
    expect(decoded.taskId).toBe("task-1234");
    expect(decoded.output).toBe("uid=0(root)");
  });
});

describe("ActionsTentacle.teardown()", () => {
  it("resolves without throwing", async () => {
    const t = new ActionsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit(
      { deleteRepoVariable: mock(async () => ({})) },
    );
    await expect(t.teardown()).resolves.toBeUndefined();
  });

  it("resolves without throwing even when delete returns 404", async () => {
    const t = new ActionsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit(
      { deleteRepoVariable: mock(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) },
    );
    await expect(t.teardown()).resolves.toBeUndefined();
  });

  it("resolves without throwing even when delete throws an unexpected error", async () => {
    const t = new ActionsTentacle(await makeConfig());
    (t as any).octokit = makeOctokit(
      { deleteRepoVariable: mock(async () => { throw new Error("Network timeout"); }) },
    );
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});
