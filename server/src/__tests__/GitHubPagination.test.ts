import { describe, expect, it } from "bun:test";
import { collectGitHubPages } from "../lib/GitHubPagination.ts";

describe("GitHub list pagination", () => {
  it("collects later pages and stops after a short page", async () => {
    const requested: number[] = [];
    const values = await collectGitHubPages(
      async (page, perPage) => {
        requested.push(page);
        return {
          data: page === 1
            ? Array.from({ length: perPage }, (_, index) => index)
            : [100, 101],
        };
      },
      (response) => response.data,
    );
    expect(requested).toEqual([1, 2]);
    expect(values).toHaveLength(102);
    expect(values.at(-1)).toBe(101);
  });

  it("rejects invalid page sizes before making a request", async () => {
    let called = false;
    await expect(collectGitHubPages(
      async () => {
        called = true;
        return { data: [] as number[] };
      },
      (response) => response.data,
      101,
    )).rejects.toThrow("page size");
    expect(called).toBe(false);
  });
});
