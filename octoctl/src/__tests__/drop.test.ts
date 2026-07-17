import { describe, expect, it } from "bun:test";
import {
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  recoveryDropPath,
  verifyRecoveryRecord,
  type RecoveryConfigurationV2,
} from "@octoc2/shared";
import {
  buildDropPayload,
  publishRecoveryDrop,
} from "../commands/drop.ts";
import {
  bytesToBase64,
  generateOperatorKeyPair,
  openSealBox,
} from "../lib/crypto.ts";

const BEACON_ID = "beacon-drop-test";
const ISSUED_AT = "2026-07-16T12:00:00.000Z";
const EXPIRES_AT = "2026-07-16T13:00:00.000Z";

async function fixture() {
  const beacon = await generateOperatorKeyPair();
  const monitoring = await generateOperatorKeyPair();
  const signing = await generateEd25519KeyPair();
  const signingKeyId = await ed25519KeyId(signing.publicKey);
  const configuration: RecoveryConfigurationV2 = {
    serverUrl: "https://controller.example.test",
    controllerToken: "controller-token",
    monitoringPublicKey: await bytesToBase64(monitoring.publicKey),
    recoverySigningPublicKey: encodeBase64Url(signing.publicKey),
    recoverySigningKeyId: signingKeyId,
    github: {
      owner: "octo",
      repo: "c2",
      tokenLease: {
        version: 1,
        leaseId: "lease-drop",
        beaconId: BEACON_ID,
        installationId: 77,
        token: "ghs_drop_token",
        repository: { owner: "octo", repo: "c2" },
        permissions: {
          metadata: "read",
          contents: "write",
          issues: "write",
          variables: "read",
        },
        issuedAt: "2026-07-16T11:50:00.000Z",
        renewAfter: "2026-07-16T12:50:00.000Z",
        expiresAt: EXPIRES_AT,
      },
    },
    tentaclePriority: ["issues", "branch"],
    relayConsortium: [],
    proxyRepos: [],
    sleepSeconds: 60,
    jitter: 0.2,
  };
  return { beacon, signing, signingKeyId, configuration };
}

describe("buildDropPayload", () => {
  it("signs a complete recovery record and seals it to the beacon", async () => {
    const { beacon, signing, signingKeyId, configuration } = await fixture();
    const ciphertext = await buildDropPayload({
      beaconId: BEACON_ID,
      beaconPublicKeyB64: await bytesToBase64(beacon.publicKey),
      generation: 4,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      recoverySigningKeyId: signingKeyId,
      recoverySigningPublicKeyB64: encodeBase64Url(signing.publicKey),
      recoverySigningSecretKeyB64: encodeBase64Url(signing.secretKey),
      configuration,
    });

    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    const plaintext = await openSealBox(
      ciphertext,
      beacon.publicKey,
      beacon.secretKey,
    );
    const record: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    const verification = await verifyRecoveryRecord(record, {
      beaconId: BEACON_ID,
      minimumGenerationExclusive: 3,
      signingPublicKey: signing.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: new Date(ISSUED_AT),
    });
    expect(verification.valid).toBe(true);
    if (verification.valid) {
      expect(verification.configuration.serverUrl).toBe(
        "https://controller.example.test",
      );
      expect(verification.configuration.github.tokenLease.token).toBe(
        "ghs_drop_token",
      );
    }
  });

  it("rejects mismatched signing key material before publishing", async () => {
    const { beacon, signingKeyId, configuration } = await fixture();
    const publicPair = await generateEd25519KeyPair();
    const secretPair = await generateEd25519KeyPair();

    await expect(buildDropPayload({
      beaconId: BEACON_ID,
      beaconPublicKeyB64: await bytesToBase64(beacon.publicKey),
      generation: 4,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      recoverySigningKeyId: signingKeyId,
      recoverySigningPublicKeyB64: encodeBase64Url(publicPair.publicKey),
      recoverySigningSecretKeyB64: encodeBase64Url(secretPair.secretKey),
      configuration,
    })).rejects.toThrow("self-verification failed");
  });
});

describe("publishRecoveryDrop", () => {
  it("creates the exact deterministic path without code search or gists", async () => {
    const requests: Request[] = [];
    const published = await publishRecoveryDrop({
      beaconId: BEACON_ID,
      ciphertext: "sealed-record",
      writerToken: "operator-writer-token",
      target: { owner: "recovery", repo: "drops", ref: "main" },
      apiBase: "https://github.test",
      fetchImpl: async (input, init) => {
        const request = new Request(input.toString(), init);
        requests.push(request);
        if (
          request.method === "GET" &&
          !request.url.includes("/contents/")
        ) {
          return Response.json({ private: false });
        }
        if (request.method === "GET") {
          return new Response("missing", { status: 404 });
        }
        return Response.json({
          content: { html_url: "https://github.test/recovery/drops/blob/main/drop" },
        }, { status: 201 });
      },
    });

    const expectedPath = await recoveryDropPath(BEACON_ID);
    expect(published.path).toBe(expectedPath);
    expect(published.updated).toBe(false);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toBe(
      "https://github.test/repos/recovery/drops",
    );
    expect(requests[1]?.url).toContain(
      `/repos/recovery/drops/contents/${expectedPath}?ref=main`,
    );
    expect(requests[1]?.url).not.toContain("/search/");
    expect(requests[1]?.url).not.toContain("/gists");
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer operator-writer-token",
    );
    const body = await requests[2]?.json() as {
      content: string;
      branch: string;
      sha?: string;
    };
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe(
      "sealed-record\n",
    );
    expect(body.branch).toBe("main");
    expect(body.sha).toBeUndefined();
  });

  it("updates the same path with the current blob SHA", async () => {
    const requests: Request[] = [];
    const published = await publishRecoveryDrop({
      beaconId: BEACON_ID,
      ciphertext: "new-record",
      writerToken: "writer",
      target: { owner: "recovery", repo: "drops", ref: "stable" },
      apiBase: "https://github.test",
      fetchImpl: async (input, init) => {
        const request = new Request(input.toString(), init);
        requests.push(request);
        if (
          request.method === "GET" &&
          !request.url.includes("/contents/")
        ) {
          return Response.json({ private: false });
        }
        return request.method === "GET"
          ? Response.json({ sha: "old-sha" })
          : Response.json({ content: {} });
      },
    });

    expect(published.updated).toBe(true);
    const body = await requests[2]?.json() as { sha?: string };
    expect(body.sha).toBe("old-sha");
  });

  it("rejects a private recovery repository before reading or writing drops", async () => {
    const requests: Request[] = [];
    await expect(publishRecoveryDrop({
      beaconId: BEACON_ID,
      ciphertext: "sealed-record",
      writerToken: "writer",
      target: { owner: "recovery", repo: "drops", ref: "release/stable" },
      apiBase: "https://github.test",
      fetchImpl: async (input, init) => {
        const request = new Request(input.toString(), init);
        requests.push(request);
        return Response.json({ private: true });
      },
    })).rejects.toThrow("must be public");
    expect(requests).toHaveLength(1);
  });
});
