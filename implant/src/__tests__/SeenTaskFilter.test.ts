import { describe, expect, it } from "bun:test";
import { SeenTaskFilter } from "../state/SeenTaskFilter.ts";

describe("SeenTaskFilter", () => {
  it("round-trips appended task IDs without false negatives", () => {
    const filter = SeenTaskFilter.empty();
    expect(filter.has("task-1")).toBe(false);
    expect(filter.has("task-2")).toBe(false);

    filter.add("task-1");
    filter.add("task-2");
    const restored = SeenTaskFilter.fromJSON(filter.toJSON());

    expect(restored.has("task-1")).toBe(true);
    expect(restored.has("task-2")).toBe(true);
  });

  it("rejects truncated, noncanonical, or parameter-swapped state", () => {
    const valid = SeenTaskFilter.empty().toJSON();
    expect(() =>
      SeenTaskFilter.fromJSON({ ...valid, bits: valid.bits.slice(1) })
    ).toThrow("bits");
    expect(() =>
      SeenTaskFilter.fromJSON({ ...valid, hashCount: 6 })
    ).toThrow("parameters");
    expect(() =>
      SeenTaskFilter.fromJSON({ ...valid, extra: true })
    ).toThrow("fields");
  });
});
