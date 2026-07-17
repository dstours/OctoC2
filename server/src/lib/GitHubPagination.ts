const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

/**
 * Collect every page from a GitHub list endpoint without relying on mutable
 * in-memory cursors. The endpoint callback must pass `page` and `per_page`
 * through to GitHub.
 */
export async function collectGitHubPages<T, TResponse>(
  requestPage: (page: number, perPage: number) => Promise<TResponse>,
  selectItems: (response: TResponse) => readonly T[],
  perPage = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isSafeInteger(perPage) || perPage <= 0 || perPage > 100) {
    throw new Error("GitHub page size must be an integer from 1 through 100");
  }

  const collected: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await requestPage(page, perPage);
    const items = [...selectItems(response)];
    collected.push(...items);
    if (items.length < perPage) return collected;
  }
  throw new Error(`GitHub pagination exceeded ${MAX_PAGES} pages`);
}
