import { describe, expect, it } from "bun:test";
import { resolveGistServerToken } from "../config/GistConfig.ts";

describe("Gist controller credential configuration", () => {
  it("keeps the Gist channel disabled when no dedicated token is configured", () => {
    expect(resolveGistServerToken(undefined, ["repo-token"])).toBeNull();
    expect(resolveGistServerToken("   ", ["repo-token"])).toBeNull();
  });

  it("accepts a dedicated role-separated token", () => {
    expect(
      resolveGistServerToken(" gist-controller-token ", [
        "repo-token",
        "operator-token",
        "beacon-token",
      ]),
    ).toBe("gist-controller-token");
  });

  it("rejects reuse of repository or controller API credentials", () => {
    for (const collision of ["repo-token", "operator-token", "beacon-token"]) {
      expect(() => resolveGistServerToken(collision, [
        "repo-token",
        "operator-token",
        "beacon-token",
      ])).toThrow("must be distinct");
    }
  });
});
