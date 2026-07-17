import { afterAll, vi } from "bun:test";

type ModuleSnapshot = readonly [specifier: string, exports: object];

export function restoreModuleMocks(
  snapshots: readonly ModuleSnapshot[],
): void {
  afterAll(() => {
    for (const [specifier, exports] of snapshots) {
      vi.mock(specifier, () => exports);
    }
  });
}
