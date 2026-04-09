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
