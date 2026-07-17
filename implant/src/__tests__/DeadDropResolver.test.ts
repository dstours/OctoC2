import { beforeAll, describe, expect, it } from "bun:test";
import {
  GITHUB_TOKEN_LEASE_VERSION,
  createRecoveryRecord,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  recoveryDropPath,
  type RecoveryConfigurationV2,
  type RecoveryRecordV2,
} from "@octoc2/shared";
import {
  DeadDropResolver,
  type DeadDropSource,
  type FetchLike,
} from "../recovery/DeadDropResolver.ts";
import {
  bytesToBase64,
  generateKeyPair,
  sealBox,
} from "../crypto/sodium.ts";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const SOURCE: DeadDropSource = {
  owner: "public-recovery",
  repo: "drops",
  ref: "main",
};

describe("DeadDropResolver", () => {
  let beaconKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let signingKeys: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
  let signingKeyId: string;

  beforeAll(async () => {
    beaconKeys = await generateKeyPair();
    signingKeys = await generateEd25519KeyPair();
    signingKeyId = await ed25519KeyId(signingKeys.publicKey);
  });

  async function record(
    beaconId: string,
    generation = 7,
    expiresAt = "2026-07-16T13:00:00.000Z",
  ): Promise<RecoveryRecordV2> {
    const monitoringKeys = await generateKeyPair();
    const renewAfter = new Date(
      NOW.getTime() + (Date.parse(expiresAt) - NOW.getTime()) / 2,
    ).toISOString();
    const configuration: RecoveryConfigurationV2 = {
      serverUrl: "https://controller.example.test",
      controllerToken: "controller-token",
      monitoringPublicKey: await bytesToBase64(monitoringKeys.publicKey),
      recoverySigningPublicKey: encodeBase64Url(signingKeys.publicKey),
      recoverySigningKeyId: signingKeyId,
      github: {
        owner: "octo",
        repo: "c2",
        tokenLease: {
          version: GITHUB_TOKEN_LEASE_VERSION,
          leaseId: `lease-${generation}`,
          beaconId,
          installationId: 123,
          token: `ghs_lease_${generation}`,
          repository: { owner: "octo", repo: "c2" },
          permissions: {
            metadata: "read",
            contents: "write",
            issues: "write",
            variables: "read",
          },
          issuedAt: NOW.toISOString(),
          renewAfter,
          expiresAt,
        },
      },
      tentaclePriority: ["issues", "branch"],
      relayConsortium: [],
      proxyRepos: [],
      sleepSeconds: 60,
      jitter: 0.2,
    };
    return createRecoveryRecord({
      beaconId,
      generation,
      issuedAt: NOW.toISOString(),
      expiresAt,
      signingKeyId,
      signingSecretKey: signingKeys.secretKey,
      configuration,
    });
  }

  function contentsFetch(
    sealed: string,
    seen?: (request: Request) => void,
  ): FetchLike {
    return async (input, init) => {
      const request = new Request(input.toString(), init);
      seen?.(request);
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(`${sealed}\n`, "utf8").toString("base64"),
      });
    };
  }

  it("reads anonymously from the deterministic path and verifies the record", async () => {
    const beaconId = "beacon-deterministic";
    const signed = await record(beaconId);
    const sealed = await sealBox(
      JSON.stringify(signed),
      beaconKeys.publicKey,
    );
    let request: Request | undefined;
    const resolver = new DeadDropResolver(SOURCE, {
      apiBase: "https://github.test",
      fetchImpl: contentsFetch(sealed, (value) => {
        request = value;
      }),
    });

    const result = await resolver.resolve(beaconId, beaconKeys.secretKey, {
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    });

    expect(result?.generation).toBe(7);
    expect(result?.configuration.github.tokenLease.token).toBe("ghs_lease_7");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(new URL(request!.url).pathname).toBe(
      `/repos/public-recovery/drops/contents/${await recoveryDropPath(beaconId)}`,
    );
  });

  it("rejects stale generations", async () => {
    const beaconId = "beacon-stale";
    const sealed = await sealBox(
      JSON.stringify(await record(beaconId, 9)),
      beaconKeys.publicKey,
    );
    const resolver = new DeadDropResolver(SOURCE, {
      fetchImpl: contentsFetch(sealed),
    });

    expect(await resolver.resolve(beaconId, beaconKeys.secretKey, {
      minimumGenerationExclusive: 9,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    })).toBeNull();
    expect(resolver.lastFailureReason).toBe("stale_generation");
  });

  it("rejects tampered signed configuration", async () => {
    const beaconId = "beacon-tampered";
    const signed = await record(beaconId);
    signed.configuration.serverUrl = "https://attacker.example.test";
    const sealed = await sealBox(
      JSON.stringify(signed),
      beaconKeys.publicKey,
    );
    const resolver = new DeadDropResolver(SOURCE, {
      fetchImpl: contentsFetch(sealed),
    });

    expect(await resolver.resolve(beaconId, beaconKeys.secretKey, {
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    })).toBeNull();
    expect(resolver.lastFailureReason).toBe("configuration_mismatch");
  });

  it("rejects expired records and leases", async () => {
    const beaconId = "beacon-expired";
    const sealed = await sealBox(
      JSON.stringify(
        await record(beaconId, 10, "2026-07-16T12:30:00.000Z"),
      ),
      beaconKeys.publicKey,
    );
    const resolver = new DeadDropResolver(SOURCE, {
      fetchImpl: contentsFetch(sealed),
    });

    expect(await resolver.resolve(beaconId, beaconKeys.secretKey, {
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: new Date("2026-07-16T12:31:00.000Z"),
    })).toBeNull();
    expect(resolver.lastFailureReason).toBe("expired");
  });

  it("returns null for ciphertext sealed to another beacon", async () => {
    const otherKeys = await generateKeyPair();
    const beaconId = "beacon-wrong-key";
    const sealed = await sealBox(
      JSON.stringify(await record(beaconId)),
      otherKeys.publicKey,
    );
    const resolver = new DeadDropResolver(SOURCE, {
      fetchImpl: contentsFetch(sealed),
    });

    expect(await resolver.resolve(beaconId, beaconKeys.secretKey, {
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    })).toBeNull();
    expect(resolver.lastFailureReason).toBe("decrypt_failed");
  });

  it("treats a missing deterministic path as best-effort recovery failure", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("not found", { status: 404 });
    const resolver = new DeadDropResolver(SOURCE, { fetchImpl });

    expect(await resolver.resolve("missing", beaconKeys.secretKey, {
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    })).toBeNull();
    expect(resolver.lastFailureReason).toBe("not_found");
  });
});
