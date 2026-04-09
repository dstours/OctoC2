import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proxyCreate,
  proxyList,
  proxyRotate,
  proxyProvision,
  type ProxyCreateOptions,
  type ProxyRotateOptions,
} from "../commands/proxy.ts";

// ── proxy create ──────────────────────────────────────────────────────────────

describe("proxy create", () => {
  it("rejects invalid --inner-kind values", async () => {
    await expect(
      proxyCreate({ owner: "acme", repo: "decoy", innerKind: "invalid" as "issues" })
    ).rejects.toThrow(/inner-kind must be/);
  });

  it("accepts 'issues' as inner-kind", async () => {
    const lines: string[] = [];
    await proxyCreate(
      { owner: "acme", repo: "decoy", innerKind: "issues" },
      (line) => lines.push(line)
    );
    const output = lines.join("\n");
    // Should contain the CI Forward template header
    expect(output).toContain("CI Forward");
    // Should contain all three workflow file headers
    expect(output).toContain("helper.yml");
    expect(output).toContain("sync-helper.yml");
    expect(output).toContain("process-checkin.yml");
  });

  it("accepts 'notes' as inner-kind", async () => {
    const lines: string[] = [];
    await proxyCreate(
      { owner: "acme", repo: "decoy", innerKind: "notes" },
      (line) => lines.push(line)
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ── proxy list ────────────────────────────────────────────────────────────────

describe("proxy list", () => {
  it("shows '(none configured)' when env var is absent", async () => {
    const saved = process.env.SVC_PROXY_REPOS;
    delete process.env.SVC_PROXY_REPOS;

    const lines: string[] = [];
    await proxyList((line) => lines.push(line));
    const output = lines.join("\n");

    expect(output).toContain("(none configured)");

    if (saved !== undefined) process.env.SVC_PROXY_REPOS = saved;
  });

  it("shows parsed repos when env var is set", async () => {
    const saved = process.env.SVC_PROXY_REPOS;
    process.env.SVC_PROXY_REPOS = JSON.stringify([
      { owner: "acme", repo: "decoy", innerKind: "issues" },
    ]);

    const lines: string[] = [];
    await proxyList((line) => lines.push(line));
    const output = lines.join("\n");

    expect(output).toContain("acme");
    expect(output).toContain("decoy");

    if (saved !== undefined) process.env.SVC_PROXY_REPOS = saved;
    else delete process.env.SVC_PROXY_REPOS;
  });
});

// ── proxy rotate ──────────────────────────────────────────────────────────────

describe("proxy rotate", () => {
  it("rejects non-JSON newProxyRepos", async () => {
    await expect(
      proxyRotate({ beaconId: "abc123", newProxyRepos: "not-json" })
    ).rejects.toThrow(/invalid JSON/i);
  });

  it("rejects newProxyRepos that is not an array", async () => {
    await expect(
      proxyRotate({ beaconId: "abc123", newProxyRepos: '{"owner":"x"}' })
    ).rejects.toThrow(/must be an array/i);
  });

  it("prints rotation instructions for valid input", async () => {
    const lines: string[] = [];
    await proxyRotate(
      {
        beaconId: "abc123",
        newProxyRepos: JSON.stringify([{ owner: "acme", repo: "decoy", innerKind: "issues" }]),
      },
      (line) => lines.push(line)
    );
    const output = lines.join("\n");
    expect(output).toContain("abc123");
    expect(output).toContain("dead-drop");
  });
});

// ── mock Octokit builder ───────────────────────────────────────────────────────

function buildMockOctokit(calls: Record<string, unknown[]>) {
  return {
    rest: {
      repos: {
        createForAuthenticatedUser: async (args: unknown) => {
          (calls.createRepo ??= []).push(args);
          return { data: {} };
        },
        createOrUpdateFileContents: async (args: unknown) => {
          (calls.createOrUpdateFileContents ??= []).push(args);
          return { data: {} };
        },
      },
      issues: {
        create: async (args: unknown) => {
          (calls.createIssue ??= []).push(args);
          return { data: { number: 1 } };
        },
      },
      actions: {
        getRepoPublicKey: async (args: unknown) => {
          (calls.getRepoPublicKey ??= []).push(args);
          // Return a valid NaCl Curve25519 public key (9 repeated = valid point on curve)
          return { data: { key_id: "test-key-id", key: Buffer.from(new Uint8Array(32).fill(9)).toString('base64') } };
        },
        createOrUpdateRepoSecret: async (args: unknown) => {
          (calls.createOrUpdateRepoSecret ??= []).push(args);
          return { data: {} };
        },
        createRepoVariable: async (args: unknown) => {
          (calls.createRepoVariable ??= []).push(args);
          return { data: {} };
        },
        updateRepoVariable: async (args: unknown) => {
          (calls.updateRepoVariable ??= []).push(args);
          return { data: {} };
        },
      },
    },
  };
}

function buildMockOctokitWith422Variables(calls: Record<string, unknown[]>) {
  const base = buildMockOctokit(calls);
  return {
    ...base,
    rest: {
      ...base.rest,
      actions: {
        ...base.rest.actions,
        createRepoVariable: async (args: unknown) => {
          (calls.createRepoVariable ??= []).push(args);
          // Simulate GitHub 422 "variable already exists" error
          const err = new Error("Variable already exists") as Error & { status: number };
          err.status = 422;
          throw err;
        },
      },
    },
  };
}

// ── proxy provision ───────────────────────────────────────────────────────────

describe("proxy provision", () => {
  it("fails if beacon not found in registry", async () => {
    await expect(
      proxyProvision({
        decoyOwner: "acme", decoyRepo: "decoy",
        beaconId: "nonexistent-beacon",
        ctrlToken: "tok", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
        dataDir: "/tmp/nonexistent-data-dir-svc-test",
        _octokit: buildMockOctokit({}),
      })
    ).rejects.toThrow(/beacon.*not found/i);
  });

  it("provisions decoy repo: creates issue, pushes workflows, sets secrets/vars, writes record", async () => {
    // Use a temp dir for the data
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-test-"));

    // Pre-populate a registry with one beacon
    await mkdir(join(tmpDir), { recursive: true });
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {
      createIssue: [], createOrUpdateFileContents: [],
      getRepoPublicKey: [], createOrUpdateRepoSecret: [],
      createRepoVariable: [],
    };

    const mockOctokit = buildMockOctokit(calls);

    const lines: string[] = [];
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      proxyToken: "proxy-pat",
      dataDir: tmpDir,
      _octokit: mockOctokit,
    }, (line) => lines.push(line));

    // Verify issue created
    expect(calls.createIssue.length).toBe(1);

    // Verify workflows pushed (helper.yml + sync-helper.yml = 2 files)
    const wfCalls = (calls.createOrUpdateFileContents as Array<Record<string,unknown>>)
      .filter(c => String(c.path ?? "").includes(".github/workflows"));
    expect(wfCalls.length).toBe(2);
    expect(wfCalls.some(c => String(c.path).includes("helper.yml"))).toBe(true);
    expect(wfCalls.some(c => String(c.path).includes("sync-helper.yml"))).toBe(true);

    // Verify 4 secrets set
    expect(calls.createOrUpdateRepoSecret.length).toBe(4);
    const secretNames = (calls.createOrUpdateRepoSecret as Array<Record<string,unknown>>)
      .map(c => c.secret_name as string);
    expect(secretNames).toContain("SYNC_TOKEN");
    expect(secretNames).toContain("NODE_ID");

    // Verify 2 variables set
    expect(calls.createRepoVariable.length).toBe(2);

    // Verify proxy record written
    const recordPath = join(tmpDir, "proxies", "aaaabbbb-1111-2222-3333-ccccddddeeee", "acme--infra-utils.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(record.decoyOwner).toBe("acme");
    expect(record.decoyRepo).toBe("infra-utils");
    expect(record.proxyIssueNumber).toBe(1);

    // Verify output contains SVC_PROXY_REPOS
    const output = lines.join("\n");
    expect(output).toContain("SVC_PROXY_REPOS");
    expect(output).toContain("proxy-pat"); // token is in the output value
  });

  it("bakes appConfig into proxy record and SVC_PROXY_REPOS when App auth fields provided", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-appauth-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    const lines: string[] = [];
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      appId: "12345", installationId: "67890", appPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK=\n-----END RSA PRIVATE KEY-----",
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    }, (line) => lines.push(line));

    // Verify proxy record has appConfig
    const recordPath = join(tmpDir, "proxies", "aaaabbbb-1111-2222-3333-ccccddddeeee", "acme--infra-utils.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(record.appConfig).toBeDefined();
    expect(record.appConfig.appId).toBe("12345");
    expect(record.appConfig.installationId).toBe("67890");
    expect(record.appConfig.privateKey).toContain("RSA PRIVATE KEY");

    // Verify SVC_PROXY_REPOS output also includes appConfig
    const output = lines.join("\n");
    expect(output).toContain("SVC_PROXY_REPOS");
    expect(output).toContain('"appConfig"');
    expect(output).toContain('"appId"');
    expect(output).toContain("12345");
  });

  it("calls createForAuthenticatedUser when createRepo: true", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-createrepo-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      createRepo: true,
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    });

    expect(calls.createRepo).toBeDefined();
    expect(calls.createRepo.length).toBe(1);
    const createArgs = calls.createRepo[0] as Record<string, unknown>;
    expect(createArgs.name).toBe("infra-utils");
    expect(createArgs.private).toBe(true);
    expect((calls.createRepo as Array<Record<string,unknown>>)[0]).toMatchObject({ name: "infra-utils", private: true });
  });

  it("does NOT call createForAuthenticatedUser when createRepo is absent", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-norepo-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    });

    // createRepo should not have been called when createRepo option is absent
    expect(!calls.createRepo || calls.createRepo.length === 0).toBe(true);
  });

  it("calls createOrUpdateFileContents for README.md and .gitignore when scaffold: true", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-scaffold-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      scaffold: true,
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    });

    const allFileCalls = calls.createOrUpdateFileContents as Array<Record<string, unknown>>;
    // Filter out workflow files to get only scaffold file calls
    const scaffoldCalls = allFileCalls.filter(c => !String(c.path ?? "").includes(".github/workflows"));
    expect(scaffoldCalls.length).toBe(2);
    const scaffoldPaths = scaffoldCalls.map(c => c.path as string);
    expect(scaffoldPaths).toContain(".gitignore");
    expect(scaffoldPaths).toContain("README.md");
    // Verify the README content includes the repo name
    const readmeCall = scaffoldCalls.find(c => c.path === "README.md")!;
    const readmeContent = Buffer.from(readmeCall.content as string, "base64").toString("utf8");
    expect(readmeContent).toContain("infra-utils");
  });

  it("writes innerKind: 'notes' to proxy record and SVC_PROXY_REPOS when innerKind: 'notes'", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-innerkind-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    const lines: string[] = [];
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      innerKind: "notes",
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    }, (line) => lines.push(line));

    // Verify proxy record has innerKind: 'notes'
    const recordPath = join(tmpDir, "proxies", "aaaabbbb-1111-2222-3333-ccccddddeeee", "acme--infra-utils.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(record.innerKind).toBe("notes");

    // Verify SVC_PROXY_REPOS value includes "innerKind":"notes"
    const output = lines.join("\n");
    expect(output).toContain('"innerKind":"notes"');
  });

  it("calls issues.create with custom issueTitle when provided", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-issuetitle-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    const calls: Record<string, unknown[]> = {};
    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      issueTitle: "Security review: dependencies",
      dataDir: tmpDir,
      _octokit: buildMockOctokit(calls),
    });

    expect(calls.createIssue).toBeDefined();
    expect(calls.createIssue.length).toBe(1);
    const issueArgs = calls.createIssue[0] as Record<string, unknown>;
    expect(issueArgs.title).toBe("Security review: dependencies");
  });

  it("calls updateRepoVariable when createRepoVariable returns 422", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "svc-proxy-422-"));
    await writeFile(join(tmpDir, "registry.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: [{
        beaconId: "aaaabbbb-1111-2222-3333-ccccddddeeee",
        issueNumber: 42,
        publicKey: "dGVzdA",
        hostname: "beacon-host", username: "alice", os: "linux", arch: "x64",
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
        status: "active", lastSeq: 0,
      }],
    }));

    // Build a mock Octokit where createRepoVariable always throws 422
    const calls: Record<string, unknown[]> = {};
    const mock422Octokit = buildMockOctokitWith422Variables(calls);

    await proxyProvision({
      decoyOwner: "acme", decoyRepo: "infra-utils",
      beaconId: "aaaabbbb",
      ctrlToken: "ctrl-pat", ctrlOwner: "ctrl-org", ctrlRepo: "ctrl-repo",
      dataDir: tmpDir,
      _octokit: mock422Octokit,
    });

    // createRepoVariable was called at least once per variable (2 total)
    expect(calls.createRepoVariable.length).toBeGreaterThanOrEqual(2);
    // updateRepoVariable was called as fallback for each variable
    expect(calls.updateRepoVariable).toBeDefined();
    expect(calls.updateRepoVariable.length).toBeGreaterThanOrEqual(2);
  });
});
