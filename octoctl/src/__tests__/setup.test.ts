import { describe, expect, test } from "bun:test";
import { maskToken } from "../commands/setup/prompts.ts";
import {
  parsePATScopes,
  validateRepoConfig,
} from "../commands/setup/validate.ts";
import {
  generateEnvFile,
  normalizeRecoveryTentaclePriority,
  parseSetupProxyPolicies,
  type EnvFileInput,
} from "../commands/setup/phases.ts";
import { stateFromEnv } from "../commands/setup.ts";

describe("maskToken", () => {
  test("masks the middle of a credential", () => {
    expect(maskToken("github_pat_11ABCDEF1234567890abcdef"))
      .toBe("github_pat_11ABC…cdef");
  });

  test("returns full string if shorter than 8 chars", () => {
    expect(maskToken("short")).toBe("short");
  });
});

describe("parsePATScopes", () => {
  test("extracts scopes from x-oauth-scopes header", () => {
    expect(parsePATScopes("repo, gist, read:org"))
      .toEqual(["repo", "gist", "read:org"]);
  });

  test("returns empty array for missing header", () => {
    expect(parsePATScopes("")).toEqual([]);
    expect(parsePATScopes(undefined)).toEqual([]);
  });
});

describe("validateRepoConfig", () => {
  test("returns errors for missing fields", () => {
    const result = validateRepoConfig({ owner: "", repo: "", token: "" });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Token is required");
    expect(result).toContain("Repo owner is required");
    expect(result).toContain("Repo name is required");
  });

  test("returns empty array for valid fields", () => {
    expect(validateRepoConfig({
      owner: "org",
      repo: "c2",
      token: "github_pat_operator",
    })).toEqual([]);
  });
});

function input(
  overrides: Partial<EnvFileInput> = {},
): EnvFileInput {
  return {
    operatorGitHubToken: "github_pat_operator",
    serverGitHubToken: "github_pat_server",
    owner: "myorg",
    repo: "c2-repo",
    operatorSecret: "base64secret",
    operatorPublicKey: "base64public",
    operatorApiToken: "operator-api-token",
    beaconControllerToken: "beacon-controller-token",
    beaconId: "11111111-2222-4333-8444-555555555555",
    enrollmentDir: "/opt/octoc2/enrollment",
    appId: 12345,
    installationId: 67890,
    appPrivateKeyFile: "/run/secrets/github-app.pem",
    recoveryRepoOwner: "myorg",
    recoveryRepoName: "octoc2-recovery",
    recoveryRepoRef: "main",
    recoveryWriteToken: "github_pat_recovery_writer",
    recoverySigningSecretFile: "/run/secrets/recovery-signing.key",
    recoverySigningPublicKey: "recovery-public",
    recoverySigningKeyId: `ed25519:${"a".repeat(64)}`,
    ...overrides,
  };
}

function parseEnv(content: string): Record<string, string> {
  return Object.fromEntries(
    content.split("\n").flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const separator = trimmed.indexOf("=");
      if (separator < 0) return [];
      const key = trimmed.slice(0, separator);
      let value = trimmed.slice(separator + 1);
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      return [[key, value]];
    }),
  );
}

describe("generateEnvFile", () => {
  test("writes separated controller roles and deterministic recovery policy", () => {
    const env = generateEnvFile(input());

    expect(env).toContain(
      "OCTOC2_OPERATOR_GITHUB_TOKEN=github_pat_operator",
    );
    expect(env).toContain(
      "OCTOC2_SERVER_GITHUB_TOKEN=github_pat_server",
    );
    expect(env).toContain(
      "OCTOC2_OPERATOR_API_TOKEN=operator-api-token",
    );
    expect(env).toContain(
      "OCTOC2_BEACON_API_TOKENS='{",
    );
    expect(env).toContain("OCTOC2_OPERATOR_SECRET=base64secret");
    expect(env).toContain("MONITORING_PUBKEY=base64public");
    expect(env).toContain("OCTOC2_GITHUB_APP_ID=12345");
    expect(env).toContain(
      "OCTOC2_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem",
    );
    expect(env).toContain("OCTOC2_RECOVERY_PUBLISH_ENABLED=true");
    expect(env).toContain(
      '"11111111-2222-4333-8444-555555555555"',
    );
    expect(env).toContain('"controllerToken":"beacon-controller-token"');
    expect(env).toContain('"installationId":67890');
    expect(env).toContain('"tentaclePriority":["notes","stego"');
    expect(env).toContain("OCTOC2_SERVER_URL=https://127.0.0.1:8080");
    expect(env).toContain("OCTOC2_HTTP_ENABLED=false");
    expect(env).toContain("OCTOC2_HTTP_SERVER_CERT=");
    expect(env).toContain("OCTOC2_HTTP_SERVER_KEY=");
    expect(env).toContain("OCTOC2_HTTP_CA_CERT=");
    expect(env).toContain("OCTOC2_GRPC_ENABLED=false");
    expect(env).toContain("OCTOC2_GRPC_CA_CERT=");
    expect(env).toContain("OCTOC2_GRPC_SERVER_CERT=");
    expect(env).toContain("OCTOC2_GRPC_SERVER_KEY=");
    expect(env).toContain("OCTOC2_GRPC_CLIENT_CERT_FINGERPRINTS=");
  });

  test("never emits legacy shared or beacon-side App credentials", () => {
    const env = generateEnvFile(input());

    expect(env).not.toContain("\nOCTOC2_GITHUB_TOKEN=");
    expect(env).not.toContain("SVC_GITHUB_TOKEN");
    expect(env).not.toContain("SVC_APP_ID");
    expect(env).not.toContain("SVC_INSTALLATION_ID");
    expect(env).not.toContain("SVC_APP_PRIVATE_KEY");
    expect(env).not.toContain("SVC_PROXY_REPOS");
  });

  test("turns proxy metadata into server App policy without static tokens", () => {
    const env = generateEnvFile(input({
      tentaclePriority: "notes,issues",
      proxyRepos: JSON.stringify([{
        owner: "decoy",
        repo: "relay",
        installationId: 9988,
        innerKind: "issues",
        decoyIssue: 7,
      }]),
    }));
    const vars = parseEnv(env);
    const appPolicies = JSON.parse(
      vars["OCTOC2_GITHUB_APP_POLICIES"]!,
    ) as Record<string, {
      proxyRepositories: Array<{
        installationId: number;
        repository: { owner: string; repo: string };
        permissions: Record<string, string>;
      }>;
    }>;
    const recoveryPolicies = JSON.parse(
      vars["OCTOC2_RECOVERY_POLICIES"]!,
    ) as Record<string, {
      tentaclePriority: string[];
      proxyRepos: Array<Record<string, unknown>>;
    }>;
    const beaconId = "11111111-2222-4333-8444-555555555555";

    expect(appPolicies[beaconId]!.proxyRepositories[0])
      .toEqual({
        installationId: 9988,
        repository: { owner: "decoy", repo: "relay" },
        permissions: {
          metadata: "read",
          issues: "write",
          variables: "read",
        },
      });
    expect(recoveryPolicies[beaconId]!.tentaclePriority)
      .toEqual(["notes", "issues", "proxy"]);
    expect(recoveryPolicies[beaconId]!.proxyRepos[0])
      .toEqual({
        owner: "decoy",
        repo: "relay",
        innerKind: "issues",
        decoyIssue: 7,
      });
    expect(env).not.toContain('"token"');
  });

  test("rejects credential reuse across trust boundaries", () => {
    expect(() => generateEnvFile(input({
      recoveryWriteToken: "github_pat_server",
    }))).toThrow("must be distinct");
  });
});

describe("recovery channel policy", () => {
  test("rejects Gist because App installation tokens cannot authorize it", () => {
    expect(() => normalizeRecoveryTentaclePriority("gist,issues", false))
      .toThrow("unsupported channel");
  });

  test("rejects multiple proxy routes for one beacon", () => {
    expect(() => parseSetupProxyPolicies(JSON.stringify([
      {
        owner: "decoy",
        repo: "one",
        installationId: 1,
        innerKind: "issues",
        decoyIssue: 7,
      },
      {
        owner: "decoy",
        repo: "two",
        installationId: 2,
        innerKind: "issues",
        decoyIssue: 8,
      },
    ]))).toThrow("at most one route");
  });
});

describe("stateFromEnv", () => {
  test("imports a modern single-beacon setup", () => {
    const state = stateFromEnv(parseEnv(generateEnvFile(input())));

    expect(state.operatorGitHubToken).toBe("github_pat_operator");
    expect(state.serverGitHubToken).toBe("github_pat_server");
    expect(state.beaconId).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(state.installationId).toBe(67890);
    expect(state.beaconControllerToken).toBe("beacon-controller-token");
  });

  test("rejects a legacy shared-token/App-key setup", () => {
    expect(() => stateFromEnv({
      OCTOC2_GITHUB_TOKEN: "shared",
      SVC_APP_PRIVATE_KEY: "private",
    })).toThrow("Legacy setup fields are not importable");
  });
});
