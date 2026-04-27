import { describe, it, expect, beforeEach } from "bun:test";
import { BeaconRegistry } from "../BeaconRegistry.ts";

const BASE = {
  beaconId:    "abc-001",
  issueNumber: 7,
  publicKey:   "cHViS2V5",
  hostname:    "host1",
  username:    "user1",
  os:          "linux",
  arch:        "x64",
  seq:         1,
};

let reg: BeaconRegistry;
beforeEach(() => { reg = new BeaconRegistry("/tmp/reg-test"); });

describe("activeTentacle", () => {
  it("is undefined when register() is called without tentacleId", () => {
    const r = reg.register(BASE);
    expect(r.activeTentacle).toBeUndefined();
  });

  it("is set when register() is called with tentacleId", () => {
    const r = reg.register({ ...BASE, tentacleId: 1 });
    expect(r.activeTentacle).toBe(1);
  });

  it("updateActiveTentacle() stores the tentacle and returns true", () => {
    reg.register(BASE);
    const ok = reg.updateActiveTentacle("abc-001", 4);
    expect(ok).toBe(true);
    expect(reg.get("abc-001")!.activeTentacle).toBe(4);
  });

  it("updateActiveTentacle() returns false for unknown beacon", () => {
    const ok = reg.updateActiveTentacle("no-such-id", 4);
    expect(ok).toBe(false);
  });

  it("preserves activeTentacle across re-registration when tentacleId omitted", () => {
    reg.register({ ...BASE, tentacleId: 4 });
    reg.register({ ...BASE, seq: 2 }); // re-register without tentacleId
    expect(reg.get("abc-001")!.activeTentacle).toBe(4);
  });
});

describe("debounced persist", () => {
  it("coalesces rapid registrations into a single write", async () => {
    const testReg = new BeaconRegistry("/tmp/reg-debounce-test");
    for (let i = 0; i < 10; i++) {
      testReg.register({ ...BASE, beaconId: `b${i}`, issueNumber: i + 1 });
    }
    // Wait for debounce to fire
    await new Promise(r => setTimeout(r, 1500));
    // After shutdown, file should exist and contain all beacons
    await testReg.shutdown();

    const file = await Bun.file("/tmp/reg-debounce-test/registry.json").text();
    const snap = JSON.parse(file);
    expect(snap.beacons).toHaveLength(10);
  });
});
