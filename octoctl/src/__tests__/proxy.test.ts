import { describe, expect, it } from "bun:test";
import {
  createHash,
} from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  proxyCreate,
  proxyList,
  proxyProvision,
  proxyRotate,
} from "../commands/proxy.ts";
import {
  TEMPLATE_FORWARD_REPLIES,
  TEMPLATE_HELPER,
  TEMPLATE_PROCESS_CHECKIN,
  TEMPLATE_SYNC_HELPER,
} from "../commands/proxyTemplates.ts";

const BEACON_ID = "aaaabbbb-1111-2222-3333-ccccddddeeee";
const SECOND_BEACON_ID = "ffffeeee-1111-4222-8333-aaaabbbbcccc";
const MONITORING_PUBLIC_KEY =
  Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const RELAY_SIGNING_KEY =
  "test-relay-signing-key-that-is-long-enough";
const TARGET_DISPATCH_TOKEN = "target-scoped-token";
const CONTROL_FINGERPRINT_VARIABLE =
  "OCTOC2_PROXY_CONTROL_FINGERPRINTS";

async function createRegistry(
  beacons: Array<{ beaconId: string; issueNumber: number }> = [{
    beaconId: BEACON_ID,
    issueNumber: 42,
  }],
): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "octoc2-proxy-"));
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      beacons: beacons.map(({ beaconId, issueNumber }) => ({
          beaconId,
          issueNumber,
          publicKey: "dGVzdA",
          hostname: "beacon-host",
          username: "alice",
          os: "linux",
          arch: "x64",
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          status: "active",
          lastSeq: 0,
        })),
    }),
  );
  return dataDir;
}

interface MockOptions {
  routeMap?: string;
  controlFingerprints?: string;
  monitoringPublicKey?: string | null;
  variableAlreadyExists?: boolean;
  variables?: Map<string, string>;
  issueNumberByRepo?: Record<string, number>;
}

function variableKey(args: {
  owner: string;
  repo: string;
  name: string;
}): string {
  return `${args.owner}/${args.repo}:${args.name}`;
}

function credentialFingerprints(
  relaySigningKey = RELAY_SIGNING_KEY,
  targetDispatchToken = TARGET_DISPATCH_TOKEN,
): string {
  return JSON.stringify({
    version: 1,
    relaySigningKeySha256: createHash("sha256")
      .update(relaySigningKey)
      .digest("hex"),
    targetDispatchTokenSha256: createHash("sha256")
      .update(targetDispatchToken)
      .digest("hex"),
  });
}

function buildMockOctokit(
  calls: Record<string, unknown[]>,
  options: MockOptions = {},
) {
  return {
    rest: {
      repos: {
        createForAuthenticatedUser: async (args: unknown) => {
          (calls.createRepo ??= []).push(args);
          return { data: {} };
        },
        createOrUpdateFileContents: async (args: unknown) => {
          (calls.files ??= []).push(args);
          return { data: {} };
        },
      },
      issues: {
        create: async (args: Record<string, unknown>) => {
          (calls.issues ??= []).push(args);
          return {
            data: {
              number:
                options.issueNumberByRepo?.[String(args.repo)] ?? 7,
            },
          };
        },
      },
      actions: {
        getRepoPublicKey: async (args: unknown) => {
          (calls.publicKeys ??= []).push(args);
          return {
            data: {
              key_id: "test-key-id",
              key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
            },
          };
        },
        createOrUpdateRepoSecret: async (args: unknown) => {
          (calls.secrets ??= []).push(args);
          return { data: {} };
        },
        getRepoVariable: async (args: {
          owner: string;
          repo: string;
          name: string;
        }) => {
          (calls.getVariables ??= []).push(args);
          const stored = options.variables?.get(variableKey(args));
          if (stored !== undefined) {
            return { data: { value: stored } };
          }
          if (
            args.name === "MONITORING_PUBKEY" &&
            args.owner === "control-org" &&
            args.repo === "control-repo"
          ) {
            if (options.monitoringPublicKey === null) {
              const error = new Error("not found") as Error & { status: number };
              error.status = 404;
              throw error;
            }
            return {
              data: {
                value:
                  options.monitoringPublicKey ?? MONITORING_PUBLIC_KEY,
              },
            };
          }
          if (
            args.name === "NODE_ROUTE_MAP" &&
            options.routeMap !== undefined
          ) {
            return { data: { value: options.routeMap } };
          }
          if (
            args.name === CONTROL_FINGERPRINT_VARIABLE &&
            options.controlFingerprints !== undefined
          ) {
            return { data: { value: options.controlFingerprints } };
          }
          const error = new Error("not found") as Error & { status: number };
          error.status = 404;
          throw error;
        },
        createRepoVariable: async (args: {
          owner: string;
          repo: string;
          name: string;
          value: string;
        }) => {
          (calls.createVariables ??= []).push(args);
          const key = variableKey(args);
          if (
            options.variableAlreadyExists ||
            options.variables?.has(key)
          ) {
            const error = new Error("exists") as Error & { status: number };
            error.status = 422;
            throw error;
          }
          options.variables?.set(key, args.value);
          return { data: {} };
        },
        updateRepoVariable: async (args: {
          owner: string;
          repo: string;
          name: string;
          value: string;
        }) => {
          (calls.updateVariables ??= []).push(args);
          options.variables?.set(variableKey(args), args.value);
          return { data: {} };
        },
      },
    },
  };
}

function provisionOptions(
  dataDir: string,
  octokit: unknown,
  overrides: Partial<Parameters<typeof proxyProvision>[0]> = {},
) {
  return {
    decoyOwner: "decoy-org",
    decoyRepo: "infra-utils",
    beaconId: "aaaabbbb",
    controlDispatchToken: "control-scoped-token",
    targetDispatchToken: TARGET_DISPATCH_TOKEN,
    relaySigningKey: RELAY_SIGNING_KEY,
    ctrlOwner: "control-org",
    ctrlRepo: "control-repo",
    proxyInstallationId: 12345,
    dataDir,
    _octokit: octokit,
    ...overrides,
  };
}

describe("proxy templates", () => {
  it("prints all four workflows with explicit repository placement", async () => {
    const lines: string[] = [];
    await proxyCreate(
      { owner: "decoy-org", repo: "decoy", innerKind: "issues" },
      (line) => lines.push(line),
    );
    const output = lines.join("\n");
    for (const name of [
      "helper.yml",
      "sync-helper.yml",
      "process-checkin.yml",
      "forward-replies.yml",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).toContain("two distinct repositories");
    expect(output).toContain("NODE_ROUTE_MAP");
  });

  it("imports the canonical repository templates without drift", () => {
    const root = resolve(import.meta.dir, "../../../templates/proxy");
    expect(TEMPLATE_HELPER).toBe(readFileSync(join(root, "helper.yml"), "utf8"));
    expect(TEMPLATE_SYNC_HELPER).toBe(
      readFileSync(join(root, "sync-helper.yml"), "utf8"),
    );
    expect(TEMPLATE_PROCESS_CHECKIN).toBe(
      readFileSync(join(root, "process-checkin.yml"), "utf8"),
    );
    expect(TEMPLATE_FORWARD_REPLIES).toBe(
      readFileSync(join(root, "forward-replies.yml"), "utf8"),
    );
  });

  it("rejects invalid inner kinds", async () => {
    await expect(
      proxyCreate({ owner: "acme", repo: "decoy", innerKind: "invalid" }),
    ).rejects.toThrow(/inner-kind/);
  });
});

describe("proxy route configuration", () => {
  it("lists only route metadata from recovery policies", async () => {
    const previous = process.env.OCTOC2_RECOVERY_POLICIES;
    process.env.OCTOC2_RECOVERY_POLICIES = JSON.stringify({
      [BEACON_ID]: {
        controllerToken: "must-not-be-printed",
        proxyRepos: [
          {
            owner: "acme",
            repo: "decoy",
            innerKind: "issues",
            decoyIssue: 7,
          },
        ],
      },
    });
    try {
      const lines: string[] = [];
      await proxyList((line) => lines.push(line));
      const output = lines.join("\n");
      expect(output).toContain(BEACON_ID);
      expect(output).toContain("acme/decoy");
      expect(output).toContain("OCTOC2_RECOVERY_POLICIES");
      expect(output).not.toContain("must-not-be-printed");
    } finally {
      if (previous === undefined) {
        delete process.env.OCTOC2_RECOVERY_POLICIES;
      } else {
        process.env.OCTOC2_RECOVERY_POLICIES = previous;
      }
    }
  });

  it("rejects credential fields embedded in recovery proxy routes", async () => {
    const previous = process.env.OCTOC2_RECOVERY_POLICIES;
    process.env.OCTOC2_RECOVERY_POLICIES = JSON.stringify({
      [BEACON_ID]: {
        proxyRepos: [
          {
            owner: "acme",
            repo: "decoy",
            innerKind: "issues",
            decoyIssue: 7,
            tokenLease: { token: "unsafe" },
          },
        ],
      },
    });
    try {
      const lines: string[] = [];
      await proxyList((line) => lines.push(line));
      const output = lines.join("\n");
      expect(output).toContain("must not contain credential field");
      expect(output).not.toContain("unsafe");
    } finally {
      if (previous === undefined) {
        delete process.env.OCTOC2_RECOVERY_POLICIES;
      } else {
        process.env.OCTOC2_RECOVERY_POLICIES = previous;
      }
    }
  });

  it("rejects credential material in rotation input", async () => {
    await expect(
      proxyRotate({
        beaconId: BEACON_ID,
        newProxyRepos: JSON.stringify([
          {
            owner: "acme",
            repo: "decoy",
            innerKind: "issues",
            decoyIssue: 7,
            token: "must-not-be-accepted",
          },
        ]),
      }),
    ).rejects.toThrow(/credential field/);
  });

  it("rejects more than one proxy route for a beacon", async () => {
    await expect(
      proxyRotate({
        beaconId: BEACON_ID,
        newProxyRepos: JSON.stringify([
          {
            owner: "acme",
            repo: "first",
            innerKind: "issues",
            decoyIssue: 7,
          },
          {
            owner: "acme",
            repo: "second",
            innerKind: "issues",
            decoyIssue: 8,
          },
        ]),
      }),
    ).rejects.toThrow(/at most one proxy route/);
  });

  it("prints recovery and App policy guidance instead of an unsigned drop", async () => {
    const lines: string[] = [];
    await proxyRotate(
      {
        beaconId: BEACON_ID,
        newProxyRepos: JSON.stringify([
          {
            owner: "acme",
            repo: "decoy",
            innerKind: "issues",
            decoyIssue: 7,
          },
        ]),
      },
      (line) => lines.push(line),
    );
    const output = lines.join("\n");
    expect(output).toContain("OCTOC2_RECOVERY_POLICIES");
    expect(output).toContain("OCTOC2_GITHUB_APP_POLICIES");
    expect(output).toContain("signed, sealed recovery record");
    expect(output).not.toContain("type\": \"proxy-rotate");
  });
});

describe("proxy provisioning", () => {
  it("provisions both repositories without exposing persistent beacon credentials", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    const lines: string[] = [];
    await proxyProvision(
      provisionOptions(dataDir, buildMockOctokit(calls)),
      (line) => lines.push(line),
    );

    const workflowCalls = (calls.files as Array<Record<string, unknown>>)
      .filter((call) => String(call.path).startsWith(".github/workflows/"));
    expect(workflowCalls).toHaveLength(4);
    expect(
      workflowCalls.map((call) => `${call.owner}/${call.repo}:${call.path}`),
    ).toEqual([
      "decoy-org/infra-utils:.github/workflows/helper.yml",
      "decoy-org/infra-utils:.github/workflows/sync-helper.yml",
      "control-org/control-repo:.github/workflows/process-checkin.yml",
      "control-org/control-repo:.github/workflows/forward-replies.yml",
    ]);

    const secretCalls = calls.secrets as Array<Record<string, unknown>>;
    expect(secretCalls).toHaveLength(7);
    expect(secretCalls.map((call) => call.secret_name)).toEqual(
      expect.arrayContaining([
        "CONTROL_TOKEN",
        "CONTROL_OWNER",
        "CONTROL_REPO",
        "NODE_ID",
        "TARGET_TOKEN",
        "RELAY_SIGNING_KEY",
      ]),
    );
    expect(calls.publicKeys).toHaveLength(2);

    const variables = calls.createVariables as Array<Record<string, unknown>>;
    expect(variables.map((call) => call.name)).toEqual([
      "FORWARD_ISSUE",
      "MONITORING_PUBKEY",
      "NODE_ROUTE_MAP",
      CONTROL_FINGERPRINT_VARIABLE,
    ]);
    expect(
      variables.find((call) => call.name === "MONITORING_PUBKEY")?.value,
    ).toBe(MONITORING_PUBLIC_KEY);
    expect(
      variables.find(
        (call) => call.name === CONTROL_FINGERPRINT_VARIABLE,
      )?.value,
    ).toBe(credentialFingerprints());
    const routeMap = JSON.parse(
      String(variables.find((call) => call.name === "NODE_ROUTE_MAP")?.value),
    ) as Record<string, Record<string, unknown>>;
    expect(routeMap[BEACON_ID]).toEqual({
      controlIssue: 42,
      decoyRepository: "decoy-org/infra-utils",
      decoyIssue: 7,
    });

    const record = JSON.parse(
      await readFile(
        join(
          dataDir,
          "proxies",
          BEACON_ID,
          "decoy-org--infra-utils.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(record.proxyInstallationId).toBe(12345);
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("appConfig");
    expect(record).not.toHaveProperty("relaySigningKey");

    const output = lines.join("\n");
    expect(output).toContain("OCTOC2_RECOVERY_POLICIES");
    expect(output).toContain("OCTOC2_GITHUB_APP_POLICIES");
    expect(output).not.toContain("control-scoped-token");
    expect(output).not.toContain("target-scoped-token");
    expect(output).not.toContain("test-relay-signing-key");
    expect(output).not.toContain("SVC_PROXY_REPOS");
  });

  it("merges the new route into an existing control route map", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    const existing = {
      "existing-beacon": {
        controlIssue: 1,
        decoyRepository: "other/decoy",
        decoyIssue: 2,
      },
    };
    await proxyProvision(
      provisionOptions(
        dataDir,
        buildMockOctokit(calls, {
          routeMap: JSON.stringify(existing),
          controlFingerprints: credentialFingerprints(),
        }),
      ),
      () => {},
    );
    const variables = calls.createVariables as Array<Record<string, unknown>>;
    const routeMap = JSON.parse(
      String(variables.find((call) => call.name === "NODE_ROUTE_MAP")?.value),
    ) as Record<string, unknown>;
    expect(routeMap["existing-beacon"]).toEqual(existing["existing-beacon"]);
    expect(routeMap[BEACON_ID]).toBeDefined();
  });

  it("fails closed on legacy routes without credential fingerprints", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    await expect(
      proxyProvision(
        provisionOptions(
          dataDir,
          buildMockOctokit(calls, {
            routeMap: JSON.stringify({
              legacy: {
                controlIssue: 1,
                decoyRepository: "other/decoy",
                decoyIssue: 2,
              },
            }),
          }),
        ),
      ),
    ).rejects.toThrow(CONTROL_FINGERPRINT_VARIABLE);
    expect(calls.issues).toBeUndefined();
  });

  it("requires a valid control MONITORING_PUBKEY before mutation", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    await expect(
      proxyProvision(
        provisionOptions(
          dataDir,
          buildMockOctokit(calls, { monitoringPublicKey: "invalid" }),
        ),
      ),
    ).rejects.toThrow(/MONITORING_PUBKEY/);
    expect(calls.issues).toBeUndefined();
  });

  it("adds two beacon routes only with stable shared control credentials", async () => {
    const dataDir = await createRegistry([
      { beaconId: BEACON_ID, issueNumber: 42 },
      { beaconId: SECOND_BEACON_ID, issueNumber: 43 },
    ]);
    const variables = new Map<string, string>([[
      "control-org/control-repo:MONITORING_PUBKEY",
      MONITORING_PUBLIC_KEY,
    ]]);
    const calls: Record<string, unknown[]> = {};
    const octokit = buildMockOctokit(calls, {
      variables,
      issueNumberByRepo: {
        "infra-one": 7,
        "infra-two": 8,
      },
    });

    await proxyProvision(
      provisionOptions(dataDir, octokit, {
        beaconId: BEACON_ID,
        decoyRepo: "infra-one",
      }),
      () => {},
    );
    await proxyProvision(
      provisionOptions(dataDir, octokit, {
        beaconId: SECOND_BEACON_ID,
        decoyRepo: "infra-two",
      }),
      () => {},
    );

    const routeMap = JSON.parse(
      variables.get("control-org/control-repo:NODE_ROUTE_MAP")!,
    ) as Record<string, Record<string, unknown>>;
    expect(routeMap[BEACON_ID]).toEqual({
      controlIssue: 42,
      decoyRepository: "decoy-org/infra-one",
      decoyIssue: 7,
    });
    expect(routeMap[SECOND_BEACON_ID]).toEqual({
      controlIssue: 43,
      decoyRepository: "decoy-org/infra-two",
      decoyIssue: 8,
    });
    expect(
      variables.get(
        `control-org/control-repo:${CONTROL_FINGERPRINT_VARIABLE}`,
      ),
    ).toBe(credentialFingerprints());

    await expect(
      proxyProvision(
        provisionOptions(dataDir, octokit, {
          beaconId: BEACON_ID,
          decoyRepo: "different-decoy",
        }),
      ),
    ).rejects.toThrow(/already has a proxy route/);

    await expect(
      proxyProvision(
        provisionOptions(dataDir, octokit, {
          beaconId: SECOND_BEACON_ID,
          decoyRepo: "infra-two",
          relaySigningKey: `${RELAY_SIGNING_KEY}-changed`,
        }),
      ),
    ).rejects.toThrow(/stable credentials/);
  });

  it("updates existing variables after GitHub returns 422", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    await proxyProvision(
      provisionOptions(
        dataDir,
        buildMockOctokit(calls, { variableAlreadyExists: true }),
      ),
      () => {},
    );
    expect(calls.updateVariables).toHaveLength(4);
  });

  it("rejects same-repository relays and shared dispatch credentials", async () => {
    const dataDir = await createRegistry();
    const base = provisionOptions(dataDir, buildMockOctokit({}));
    await expect(
      proxyProvision({
        ...base,
        ctrlOwner: base.decoyOwner,
        ctrlRepo: base.decoyRepo,
      }),
    ).rejects.toThrow(/must be distinct/);
    await expect(
      proxyProvision({
        ...base,
        targetDispatchToken: base.controlDispatchToken,
      }),
    ).rejects.toThrow(/credentials must be distinct/);
  });

  it("can create and scaffold only the decoy repository", async () => {
    const dataDir = await createRegistry();
    const calls: Record<string, unknown[]> = {};
    await proxyProvision(
      {
        ...provisionOptions(dataDir, buildMockOctokit(calls)),
        createRepo: true,
        scaffold: true,
      },
      () => {},
    );
    expect(calls.createRepo).toHaveLength(1);
    const paths = (calls.files as Array<Record<string, unknown>>).map(
      (call) => call.path,
    );
    expect(paths).toContain("README.md");
    expect(paths).toContain(".gitignore");
  });

  it("fails closed when the beacon is unknown", async () => {
    await expect(
      proxyProvision({
        ...provisionOptions(
          join(tmpdir(), "octoc2-missing-registry"),
          buildMockOctokit({}),
        ),
      }),
    ).rejects.toThrow(/Beacon not found/);
  });
});
