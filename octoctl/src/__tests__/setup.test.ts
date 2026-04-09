import { describe, test, expect } from "bun:test";
import { maskToken } from "../commands/setup/prompts.ts";

describe("maskToken", () => {
  test("masks middle of a PAT, showing prefix and last 4", () => {
    expect(maskToken("github_pat_11ABCDEF1234567890abcdef"))
      .toBe("github_pat_11ABC…cdef");
  });

  test("returns full string if shorter than 8 chars", () => {
    expect(maskToken("short")).toBe("short");
  });
});
