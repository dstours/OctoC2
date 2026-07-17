import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { decodeBase64Url, verifyEnvelope } from "@octoc2/shared";

function makeActions(overrides: Record<string, any> = {}) {
  return {
    getRepoVariable: mock(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }),
    createRepoVariable: mock(async () => ({})),
    updateRepoVariable: mock(async () => ({})),
    deleteRepoVariable: mock(async () => ({})),
    listRepoVariables: mock(async () => ({ data: { variables: [] } })),
    ...overrides,
  };
}

function makeRepos(overrides: Record<string, any> = {}) {
  return {
    get: mock(async () => ({})),
    createDispatchEvent: mock(async () => ({})),
    ...overrides,
  };
}

function makeOctokit(
  actionsOverrides: Record<string, any> = {},
  reposOverrides: Record<string, any> = {},
) {
  return {
    hook: { wrap: (_name: string, _fn: Function) => {} },
    rest: {
      actions: makeActions(actionsOverrides),
      repos: makeRepos(reposOverrides),
    },
  } as any;
}

mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = {
      actions: makeActions(),
      repos: makeRepos(),
    };
  },
}));

const { ActionsTentacle } = await import("../tentacles/ActionsTentacle.ts");
const { clearSharedGitHubTokenProviders } = await import(
  "../lib/GitHubTokenProvider.ts"
);
const {
  encryptBox,
  generateKeyPair,
  openSealBox,
} = await import("../crypto/sodium.ts");
const { signedCheckin } = await import("./signedCheckinFixture.ts");
type BeaconConfig = import("../types.ts").BeaconConfig;

async function makeConfig(
  overrides: Partial<BeaconConfig> = {},
): Promise<BeaconConfig> {
  return {
    id: "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["actions"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: (await generateKeyPair()).publicKey,
    beaconKeyPair: await generateKeyPair(),
    ...overrides,
  };
}

let originalGitHubToken: string | undefined;

beforeEach(() => {
  clearSharedGitHubTokenProviders();
  originalGitHubToken = process.env["GITHUB_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
});

afterEach(() => {
  if (originalGitHubToken === undefined) {
    delete process.env["GITHUB_TOKEN"];
  } else {
    process.env["GITHUB_TOKEN"] = originalGitHubToken;
  }
});

describe("ActionsTentacle availability", () => {
  it("uses the configured credential outside GitHub Actions", async () => {
    const tentacle = new ActionsTentacle(await makeConfig({
      token: "configured-app-lease",
    }));
    expect(await (tentacle as any).tokenProvider.getToken()).toBe(
      "configured-app-lease",
    );
  });

  it("binds API calls to the ambient short-lived Actions credential", async () => {
    process.env["GITHUB_TOKEN"] = "gha_runtime_token";
    const tentacle = new ActionsTentacle(await makeConfig({
      token: "configured-fallback",
    }));
    expect(await (tentacle as any).tokenProvider.getToken()).toBe(
      "gha_runtime_token",
    );
  });

  it("ignores a blank ambient GITHUB_TOKEN", async () => {
    process.env["GITHUB_TOKEN"] = "   ";
    const tentacle = new ActionsTentacle(await makeConfig({
      token: "configured-fallback",
    }));
    expect(await (tentacle as any).tokenProvider.getToken()).toBe(
      "configured-fallback",
    );
  });

  it("reports available when the repository Variables API is accessible", async () => {
    const tentacle = new ActionsTentacle(await makeConfig());
    (tentacle as any).octokit = makeOctokit();
    expect(await tentacle.isAvailable()).toBe(true);
  });

  it("converts availability probe errors into false", async () => {
    const tentacle = new ActionsTentacle(await makeConfig());
    (tentacle as any).octokit = makeOctokit({
      listRepoVariables: mock(async () => {
        throw new Error("probe failed");
      }),
    });
    expect(await tentacle.isAvailable()).toBe(false);
  });

  it("exposes the actions channel kind", async () => {
    expect(new ActionsTentacle(await makeConfig()).kind).toBe("actions");
  });
});

describe("ActionsTentacle signed checkin", () => {
  it("writes and dispatches a verifiable signed ACK", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    let ackValue: string | undefined;
    let dispatchIdentity: unknown;
    (tentacle as any).octokit = makeOctokit(
      {
        updateRepoVariable: mock(async (params: any) => {
          ackValue = params.value;
          return {};
        }),
      },
      {
        createDispatchEvent: mock(async (params: any) => {
          dispatchIdentity = params.client_payload.identity;
          return {};
        }),
      },
    );

    await tentacle.checkin(await signedCheckin(config, {
      hostname: "runner-host",
      username: "runner",
    }));

    expect(ackValue).toBeDefined();
    const ack = JSON.parse(ackValue!);
    expect(ack.publicKey).toBe(ack.identity.payload.encryptionPublicKey);
    const signingPublicKey = await decodeBase64Url(
      ack.identity.payload.signingPublicKey,
    );
    expect(await verifyEnvelope(ack.identity, signingPublicKey)).toBe(true);
    expect(dispatchIdentity).toEqual(ack.identity);
  });

  it("creates the ACK variable when update reports it missing", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    const create = mock(async () => ({}));
    (tentacle as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }),
      createRepoVariable: create,
    });

    await tentacle.checkin(await signedCheckin(config));

    expect(create).toHaveBeenCalledTimes(1);
    expect(((create.mock.calls[0] as any)[0] as any).name).toBe(
      "INFRA_STATUS_AAAA1111",
    );
  });

  it("refreshes the signed ACK on every checkin, dispatches once, and keeps polling", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    const update = mock(async () => ({}));
    const poll = mock(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const dispatch = mock(async () => ({}));
    (tentacle as any).octokit = makeOctokit(
      {
        updateRepoVariable: update,
        getRepoVariable: poll,
      },
      {
        createDispatchEvent: dispatch,
      },
    );

    await tentacle.checkin(await signedCheckin(config, {
      checkinAt: "2026-07-16T12:00:00.000Z",
    }));
    await tentacle.checkin(await signedCheckin(config, {
      checkinAt: "2026-07-16T12:00:01.000Z",
    }));

    expect(update).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
    const firstAck = JSON.parse(((update.mock.calls[0] as any)[0] as any).value);
    const secondAck = JSON.parse(((update.mock.calls[1] as any)[0] as any).value);
    expect(secondAck.identity.sequence).toBeGreaterThan(firstAck.identity.sequence);
    expect(secondAck.identity.signature).not.toBe(firstAck.identity.signature);
  });

  it("returns an empty task list when the task variable is absent", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    (tentacle as any).octokit = makeOctokit({
      getRepoVariable: mock(async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }),
    });

    expect(
      await tentacle.checkin(await signedCheckin(config)),
    ).toEqual([]);
  });

  it("decrypts a task variable and deletes it after reading", async () => {
    const operatorKeyPair = await generateKeyPair();
    const beaconKeyPair = await generateKeyPair();
    const config = await makeConfig({
      operatorPublicKey: operatorKeyPair.publicKey,
      beaconKeyPair,
    });
    const encrypted = await encryptBox(
      JSON.stringify([{
        taskId: "task-abc",
        kind: "shell",
        args: { cmd: "id" },
      }]),
      beaconKeyPair.publicKey,
      operatorKeyPair.secretKey,
    );
    const remove = mock(async () => ({}));
    const tentacle = new ActionsTentacle(config);
    (tentacle as any).octokit = makeOctokit({
      getRepoVariable: mock(async () => ({
        data: { value: JSON.stringify(encrypted) },
      })),
      deleteRepoVariable: remove,
    });

    const tasks = await tentacle.checkin(await signedCheckin(config));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe("task-abc");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(((remove.mock.calls[0] as any)[0] as any).name).toBe(
      "INFRA_JOB_AAAA1111",
    );
  });

  it("returns an empty task list for malformed encrypted content", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    (tentacle as any).octokit = makeOctokit({
      getRepoVariable: mock(async () => ({
        data: { value: "not-valid-json" },
      })),
    });

    expect(
      await tentacle.checkin(await signedCheckin(config)),
    ).toEqual([]);
  });
});

describe("ActionsTentacle results and teardown", () => {
  it("writes a task-scoped result variable", async () => {
    const config = await makeConfig();
    const tentacle = new ActionsTentacle(config);
    const update = mock(async () => ({}));
    (tentacle as any).octokit = makeOctokit({
      updateRepoVariable: update,
    });

    await tentacle.submitResult({
      taskId: "task-def0",
      beaconId: config.id,
      success: true,
      output: "root",
      completedAt: new Date().toISOString(),
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(((update.mock.calls[0] as any)[0] as any).name).toBe(
      "INFRA_RESULT_TASK-DEF",
    );
  });

  it("seals result content to the operator key", async () => {
    const operatorKeyPair = await generateKeyPair();
    const config = await makeConfig({
      operatorPublicKey: operatorKeyPair.publicKey,
    });
    const tentacle = new ActionsTentacle(config);
    let capturedValue: string | undefined;
    (tentacle as any).octokit = makeOctokit({
      updateRepoVariable: mock(async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }),
      createRepoVariable: mock(async (params: any) => {
        capturedValue = params.value;
        return {};
      }),
    });

    await tentacle.submitResult({
      taskId: "task-1234",
      beaconId: config.id,
      success: true,
      output: "uid=0(root)",
      completedAt: new Date().toISOString(),
    });

    const plaintext = await openSealBox(
      capturedValue!,
      operatorKeyPair.publicKey,
      operatorKeyPair.secretKey,
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext)).output).toBe(
      "uid=0(root)",
    );
  });

  it("teardown preserves registration and unread task variables", async () => {
    const tentacle = new ActionsTentacle(await makeConfig());
    const remove = mock(async () => ({}));
    (tentacle as any).octokit = makeOctokit({
      deleteRepoVariable: remove,
    });

    await tentacle.teardown();

    expect(remove).not.toHaveBeenCalled();
  });
});
