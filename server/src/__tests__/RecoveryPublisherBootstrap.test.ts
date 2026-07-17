import { describe, expect, it } from "bun:test";
import { SerializedRecoveryPublisher } from "../services/RecoveryPublisherBootstrap.ts";

describe("serialized recovery publication scheduling", () => {
  it("coalesces overlapping ticks into one trailing refresh", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const releases: Array<() => void> = [];
    const successes: number[] = [];
    const errors: unknown[] = [];
    const scheduler = new SerializedRecoveryPublisher(
      async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return calls;
      },
      (count) => successes.push(count),
      (error) => errors.push(error),
    );

    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    expect(calls).toBe(1);
    expect(maximumActive).toBe(1);

    releases.shift()!();
    await Bun.sleep(0);
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);

    releases.shift()!();
    await scheduler.whenIdle();
    expect(calls).toBe(2);
    expect(successes).toEqual([1, 2]);
    expect(errors).toEqual([]);
  });

  it("does not start a trailing refresh after stop", async () => {
    let calls = 0;
    let release!: () => void;
    const scheduler = new SerializedRecoveryPublisher(
      async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 1;
      },
      () => {},
      () => {},
    );
    scheduler.trigger();
    scheduler.trigger();
    scheduler.stop();
    release();
    await scheduler.whenIdle();
    expect(calls).toBe(1);
  });
});
