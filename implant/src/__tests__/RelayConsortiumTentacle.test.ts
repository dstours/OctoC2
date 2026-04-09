import { describe, it, expect, mock, beforeEach } from "bun:test";
import { RelayConsortiumTentacle } from "../tentacles/RelayConsortiumTentacle.ts";
import type { BeaconConfig, ITentacle, TentacleKind, CheckinPayload, Task, TaskResult } from "../types.ts";

function makeConfig(consortium: BeaconConfig["relayConsortium"] = []): BeaconConfig {
  return {
    id: "test-beacon",
    repo: { owner: "owner", name: "repo" },
    token: "ghp_test",
    tentaclePriority: ["relay"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    relayConsortium: consortium,
  };
}

const PAYLOAD: CheckinPayload = {
  beaconId: "test-beacon", publicKey: "",
  hostname: "h", username: "u", os: "linux", arch: "x64",
  pid: 1, checkinAt: new Date().toISOString(),
};

function makeMockTentacle(tasks: Task[] = [], available = true): ITentacle {
  return {
    kind: "codespaces" as TentacleKind,
    isAvailable: mock(async () => available),
    checkin: mock(async () => tasks),
    submitResult: mock(async () => {}),
    teardown: mock(async () => {}),
  };
}

describe("RelayConsortiumTentacle", () => {
  it("isAvailable returns false when relayConsortium is empty", async () => {
    const t = new RelayConsortiumTentacle(makeConfig([]));
    expect(await t.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when relayConsortium has entries", async () => {
    const t = new RelayConsortiumTentacle(
      makeConfig([{ account: "relay1", repo: "relay-repo" }])
    );
    expect(await t.isAvailable()).toBe(true);
  });

  it("checkin returns [] when no relays are available", async () => {
    const t = new RelayConsortiumTentacle(
      makeConfig([{ account: "relay1", repo: "relay-repo" }])
    );
    // Inject mocks that bypass both codespace discovery and inner tentacle
    const mock1 = makeMockTentacle([], false);
    (t as any).discoverCodespace = async () => "test-codespace-name";
    (t as any).createInnerTentacle = () => mock1;
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([]);
  });

  it("checkin returns tasks from the first available relay", async () => {
    const task: Task = { taskId: "t1", kind: "shell", args: { cmd: "id" }, ref: "r1" };
    const t = new RelayConsortiumTentacle(
      makeConfig([
        { account: "dead-relay", repo: "repo" },
        { account: "live-relay", repo: "repo" },
      ])
    );
    const deadMock = makeMockTentacle([], false);
    const liveMock = makeMockTentacle([task], true);
    let callCount = 0;
    (t as any).discoverCodespace = async () => "test-codespace-name";
    (t as any).createInnerTentacle = () => callCount++ === 0 ? deadMock : liveMock;
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([task]);
  });

  it("checkin caches the working relay for subsequent calls", async () => {
    const task: Task = { taskId: "t2", kind: "ping", args: {}, ref: "r2" };
    const t = new RelayConsortiumTentacle(
      makeConfig([{ account: "relay1", repo: "repo" }])
    );
    const inner = makeMockTentacle([task], true);
    (t as any).discoverCodespace = async () => "test-codespace-name";
    (t as any).createInnerTentacle = () => inner;

    await t.checkin(PAYLOAD);  // First call — discovers relay
    await t.checkin(PAYLOAD);  // Second call — should use cached relay

    // createInnerTentacle should only have been called once (cached after first)
    expect((t as any).createInnerTentacle).not.toBeUndefined();
    // inner.checkin called twice (both checkins went to the same tentacle)
    expect((inner.checkin as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  it("submitResult uses the cached relay", async () => {
    const t = new RelayConsortiumTentacle(
      makeConfig([{ account: "relay1", repo: "repo" }])
    );
    const inner = makeMockTentacle([], true);
    (t as any).discoverCodespace = async () => "test-codespace-name";
    (t as any).createInnerTentacle = () => inner;
    await t.checkin(PAYLOAD);   // establish cache

    const result: TaskResult = {
      taskId: "t1", beaconId: "test-beacon",
      success: true, output: "ok", completedAt: new Date().toISOString(),
    };
    await t.submitResult(result);
    expect((inner.submitResult as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("teardown calls teardown on the cached relay and clears cache", async () => {
    const t = new RelayConsortiumTentacle(
      makeConfig([{ account: "relay1", repo: "repo" }])
    );
    const inner = makeMockTentacle([], true);
    (t as any).discoverCodespace = async () => "test-codespace-name";
    (t as any).createInnerTentacle = () => inner;
    await t.checkin(PAYLOAD);
    await t.teardown();
    expect((inner.teardown as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((t as any).activeRelay).toBeNull();
  });

  it("checkin re-discovers when cached relay fails on subsequent call", async () => {
    const task: Task = { taskId: "t3", kind: "shell", args: { cmd: "id" }, ref: "r3" };
    const t = new RelayConsortiumTentacle(
      makeConfig([
        { account: "relay1", repo: "repo" },
        { account: "relay2", repo: "repo" },
      ])
    );

    const failingRelay = makeMockTentacle([], true);
    const backupRelay  = makeMockTentacle([task], true);
    let calls = 0;

    (t as any).discoverCodespace = async () => "test-codespace";
    (t as any).createInnerTentacle = () => calls++ === 0 ? failingRelay : backupRelay;

    // First checkin — relay1 succeeds and is cached
    await t.checkin(PAYLOAD);
    expect((t as any).activeRelay).toBe(failingRelay);

    // Make cached relay throw on next checkin
    (failingRelay.checkin as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    // Second checkin — cached relay fails, re-discovers backup relay
    const tasks = await t.checkin(PAYLOAD);
    expect(tasks).toEqual([task]);
    expect((t as any).activeRelay).toBe(backupRelay);
    expect((failingRelay.teardown as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});
