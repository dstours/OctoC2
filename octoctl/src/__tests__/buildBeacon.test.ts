import { describe, it, expect } from "bun:test";
import { buildBeaconDefines } from "../commands/buildBeacon.ts";
import { generateOperatorKeyPair, bytesToBase64 } from "../lib/crypto.ts";
import { runBuildBeaconSimple, type SpawnSyncFn } from "../commands/buildBeaconSimple.ts";

describe("buildBeaconDefines", () => {
  it("includes all required defines", async () => {
    const kp = await generateOperatorKeyPair();
    const beaconId = crypto.randomUUID();
    const pubB64 = await bytesToBase64(kp.publicKey);
    const secB64 = await bytesToBase64(kp.secretKey);

    const defines = buildBeaconDefines({
      beaconId,
      publicKeyB64: pubB64,
      secretKeyB64: secB64,
      token: "ghp_test",
      owner: "owner",
      repo:  "repo",
      relayConsortium: [{ account: "relay1", repo: "relay-repo" }],
    });

    expect(defines["process.env.OCTOC2_BEACON_ID"]).toBe(beaconId);
    expect(defines["process.env.OCTOC2_BEACON_PUBKEY"]).toBe(pubB64);
    expect(defines["process.env.OCTOC2_BEACON_SECKEY"]).toBe(secB64);
    expect(defines["process.env.OCTOC2_GITHUB_TOKEN"]).toBe("ghp_test");
    expect(defines["process.env.OCTOC2_REPO_OWNER"]).toBe("owner");
    expect(defines["process.env.OCTOC2_REPO_NAME"]).toBe("repo");
    expect(defines["process.env.OCTOC2_RELAY_CONSORTIUM"]).toContain("relay1");
    expect(defines["process.env.OCTOC2_USER_AGENT"]).toBe("GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0");
  });

  it("omits OCTOC2_RELAY_CONSORTIUM when no relays", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
    });
    expect(defines["process.env.OCTOC2_RELAY_CONSORTIUM"]).toBeUndefined();
  });

  it("includes OCTOC2_ISSUE_TITLE when issueTitle is provided", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
      issueTitle: "Fix: review config for abcd1234",
    });
    expect(defines["process.env.SVC_ISSUE_TITLE"]).toBe("Fix: review config for abcd1234");
  });

  it("omits OCTOC2_ISSUE_TITLE when issueTitle is undefined", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
    });
    expect(defines["process.env.SVC_ISSUE_TITLE"]).toBeUndefined();
  });

  // --no-random-title E2E path:
  //   When `octoctl build-beacon --no-random-title` is passed, Commander sets
  //   opts.randomTitle = false.  runBuildBeacon skips loadTitleTemplates/pickIssueTitle
  //   entirely (buildBeacon.ts:94 — `if (opts.randomTitle !== false)`), leaving
  //   issueTitle = undefined, which means buildBeaconDefines never injects
  //   OCTOC2_ISSUE_TITLE.  The test below covers the final step of that chain
  //   (undefined issueTitle → no define key) explicitly for --no-random-title.
  it("omits OCTOC2_ISSUE_TITLE when issueTitle is undefined (--no-random-title path)", () => {
    // Simulates the state produced by runBuildBeacon when randomTitle === false:
    // issueTitle is never set, so buildBeaconDefines receives no issueTitle field.
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
      // issueTitle intentionally omitted — matches randomTitle: false branch
    });
    expect(defines["process.env.SVC_ISSUE_TITLE"]).toBeUndefined();
    // Confirm no accidental leakage of the key under any alias
    const keys = Object.keys(defines);
    expect(keys.some((k) => k.includes("ISSUE_TITLE"))).toBe(false);
  });

  it("bakes SVC_APP_ID when appId is provided", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
      appId: 123456,
    });
    expect(defines["process.env.SVC_APP_ID"]).toBe("123456");
    expect(defines["process.env.SVC_INSTALLATION_ID"]).toBeUndefined();
  });

  it("bakes SVC_INSTALLATION_ID when installationId is provided", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
      appId: 123456,
      installationId: 987654,
    });
    expect(defines["process.env.SVC_APP_ID"]).toBe("123456");
    expect(defines["process.env.SVC_INSTALLATION_ID"]).toBe("987654");
  });

  it("does NOT bake App fields when absent (no accidental leakage)", () => {
    const defines = buildBeaconDefines({
      beaconId: "id", publicKeyB64: "pub", secretKeyB64: "sec",
      token: "tok", owner: "o", repo: "r",
      relayConsortium: [],
    });
    expect(defines["process.env.SVC_APP_ID"]).toBeUndefined();
    expect(defines["process.env.SVC_INSTALLATION_ID"]).toBeUndefined();
    // Private key is NEVER baked — verify no PRIVATE_KEY define exists
    const keys = Object.keys(defines);
    expect(keys.some((k) => k.includes("PRIVATE_KEY") || k.includes("APP_KEY"))).toBe(false);
  });
});

// ── runBuildBeaconSimple ──────────────────────────────────────────────────────

describe("runBuildBeaconSimple", () => {
  // Helper: capture console.log and console.error output during a sync call
  function captureOutput(fn: () => void): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog   = console.log;
    const origError = console.error;
    console.log   = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
    try { fn(); } finally {
      console.log   = origLog;
      console.error = origError;
    }
    return { stdout, stderr };
  }

  it("calls bun build with correct args for default options", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockSpawn: SpawnSyncFn = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: null, stderr: null, pid: 1, output: [], signal: null, error: undefined };
    };

    captureOutput(() => {
      runBuildBeaconSimple({ output: "./beacon", platform: "linux-x64" }, mockSpawn);
    });

    expect(calls).toHaveLength(1);
    const { args } = calls[0]!;
    expect(args).toContain("build");
    expect(args).toContain("--compile");
    expect(args).toContain("--target=bun-linux-x64");
    expect(args).toContain("--outfile");
    expect(args).toContain("./beacon");
    expect(args).toContain("implant/src/index.ts");
  });

  it("calls bun build with custom --output and --platform", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockSpawn: SpawnSyncFn = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: null, stderr: null, pid: 1, output: [], signal: null, error: undefined };
    };

    captureOutput(() => {
      runBuildBeaconSimple({ output: "/tmp/my-beacon", platform: "darwin-arm64" }, mockSpawn);
    });

    expect(calls).toHaveLength(1);
    const { args } = calls[0]!;
    expect(args).toContain("--target=bun-darwin-arm64");
    expect(args).toContain("/tmp/my-beacon");
  });

  it("prints 'Done' and the output path on success", () => {
    const mockSpawn: SpawnSyncFn = (_cmd, _args, _opts) =>
      ({ status: 0, stdout: null, stderr: null, pid: 1, output: [], signal: null, error: undefined });

    const { stdout } = captureOutput(() => {
      runBuildBeaconSimple({ output: "/tmp/svc-beacon-smoke", platform: "linux-x64" }, mockSpawn);
    });

    const joined = stdout.join("\n");
    expect(joined).toContain("Done");
    expect(joined).toContain("/tmp/svc-beacon-smoke");
  });

  it("propagates non-zero exit codes", () => {
    const mockSpawn: SpawnSyncFn = (_cmd, _args, _opts) =>
      ({ status: 2, stdout: null, stderr: null, pid: 1, output: [], signal: null, error: undefined });

    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;

    try {
      captureOutput(() => {
        runBuildBeaconSimple({ output: "./beacon", platform: "linux-x64" }, mockSpawn);
      });
    } finally {
      process.exit = origExit;
    }

    expect(exitCode).toBe(2);
  });
});
