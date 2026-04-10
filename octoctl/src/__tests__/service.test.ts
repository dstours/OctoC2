import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPids, savePids, loadEnvFile, type PidFile } from "../commands/service.ts";

describe("PID file helpers", () => {
  let tmpDir: string;
  let pidPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/octoctl-test-");
    pidPath = join(tmpDir, "pids.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadPids returns empty state when file missing", () => {
    const pids = loadPids(pidPath);
    expect(pids.server).toBeUndefined();
    expect(pids.dashboard).toBeUndefined();
  });

  test("savePids writes and loadPids reads back", () => {
    const state: PidFile = { server: 1234, dashboard: 5678 };
    savePids(pidPath, state);
    const loaded = loadPids(pidPath);
    expect(loaded.server).toBe(1234);
    expect(loaded.dashboard).toBe(5678);
  });

  test("savePids with undefined values omits them", () => {
    savePids(pidPath, { server: 1234 });
    const raw = JSON.parse(readFileSync(pidPath, "utf8"));
    expect(raw.server).toBe(1234);
    expect(raw.dashboard).toBeUndefined();
  });
});

describe("loadEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/octoctl-env-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty object for missing file", () => {
    expect(loadEnvFile(join(tmpDir, "nope"))).toEqual({});
  });

  test("parses KEY=value lines", () => {
    const p = join(tmpDir, ".env");
    require("node:fs").writeFileSync(p, "FOO=bar\nBAZ=qux\n");
    const vars = loadEnvFile(p);
    expect(vars.FOO).toBe("bar");
    expect(vars.BAZ).toBe("qux");
  });

  test("skips comments and blank lines", () => {
    const p = join(tmpDir, ".env");
    require("node:fs").writeFileSync(p, "# comment\n\nKEY=val\n");
    const vars = loadEnvFile(p);
    expect(vars.KEY).toBe("val");
    expect(Object.keys(vars)).toHaveLength(1);
  });

  test("strips surrounding quotes", () => {
    const p = join(tmpDir, ".env");
    require("node:fs").writeFileSync(p, 'A="hello"\nB=\'world\'\n');
    const vars = loadEnvFile(p);
    expect(vars.A).toBe("hello");
    expect(vars.B).toBe("world");
  });
});
