import { describe, expect, it } from "bun:test";
import {
  GITHUB_TOKEN_LEASE_VERSION,
  ed25519KeyId,
  generateEd25519KeyPair,
  recoveryDropPath,
  verifyRecoveryRecord,
  type GitHubTokenLease,
} from "@octoc2/shared";
import {
  bytesToBase64,
  generateOperatorKeyPair,
  openSealBox,
} from "../crypto/sodium.ts";
import {
  RecoveryPublisherService,
  parseRecoveryPublisherPolicies,
  type RecoveryPublisherStore,
} from "../services/RecoveryPublisherService.ts";
import type {
  CommitChannelProgressInput,
  PollCursor,
  StoredBeacon,
} from "../store/types.ts";

const NOW = new Date("2026-07-16T12:00:00.000Z");

class MemoryRecoveryStore implements RecoveryPublisherStore {
  cursor: PollCursor | undefined;
  readonly commits: CommitChannelProgressInput[] = [];

  constructor(private readonly beacon: StoredBeacon) {}

  getBeacon(beaconId: string): StoredBeacon | undefined {
    return beaconId === this.beacon.beaconId ? this.beacon : undefined;
  }

  getPollCursor(): PollCursor | undefined {
    return this.cursor;
  }

  commitChannelProgress(input: CommitChannelProgressInput) {
    this.commits.push(input);
    this.cursor = {
      channel: input.channel,
      scope: input.scope,
      cursor: input.cursor,
      updatedAt: input.processedAt ?? NOW.toISOString(),
    };
    return { status: "committed" as const };
  }
}

function lease(
  beaconId: string,
  repository = { owner: "octo", repo: "c2" },
): GitHubTokenLease {
  return {
    version: GITHUB_TOKEN_LEASE_VERSION,
    leaseId: "lease-1",
    beaconId,
    installationId: 1234,
    token: repository.repo === "c2"
      ? "ghs_short_lived"
      : "ghs_proxy_short_lived",
    repository,
    permissions: repository.repo === "c2"
      ? {
          metadata: "read",
          contents: "write",
          issues: "write",
          variables: "write",
        }
      : {
          metadata: "read",
          issues: "write",
          variables: "read",
        },
    issuedAt: NOW.toISOString(),
    renewAfter: "2026-07-16T12:50:00.000Z",
    expiresAt: "2026-07-16T13:00:00.000Z",
  };
}

describe("RecoveryPublisherService", () => {
  it("rejects multiple proxy routes in one recovery policy", async () => {
    await expect(parseRecoveryPublisherPolicies(JSON.stringify({
      beacon: {
        proxyRepos: [{}, {}],
      },
    }))).rejects.toThrow("at most one route");
  });

  it("publishes a signed sealed record only at the deterministic path", async () => {
    const beaconKeys = await generateOperatorKeyPair();
    const signingKeys = await generateEd25519KeyPair();
    const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
    const beaconId = "beacon-one";
    const store = new MemoryRecoveryStore({
      beaconId,
      issueNumber: null,
      x25519PublicKey: await bytesToBase64(beaconKeys.publicKey),
      hostname: "pre-enrolled",
      username: "pre-enrolled",
      os: "unknown",
      arch: "unknown",
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
      status: "dormant",
      lastSeq: 0,
      activeTentacle: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    const requests: Request[] = [];
    const mintedRepositories: Array<
      { owner: string; repo: string } | undefined
    > = [];
    let sealed = "";
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/repos/recovery/public-drops") {
        return Response.json({ private: false });
      }
      if (request.method === "GET" && url.pathname.includes("/contents/")) {
        return new Response("missing", { status: 404 });
      }
      if (request.method === "PUT" && url.pathname.includes("/contents/")) {
        const body = await request.json() as { content: string; branch: string };
        sealed = Buffer.from(body.content, "base64").toString("utf8").trim();
        expect(body.branch).toBe("main");
        return Response.json({ content: { sha: "new-sha" } }, { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const publisher = new RecoveryPublisherService({
      store,
      tokenMinter: {
        mintLease: async (_beaconId, repository) => {
          mintedRepositories.push(repository);
          return lease(beaconId, repository);
        },
      },
      policies: {
        [beaconId]: {
          serverUrl: "https://controller.example.test",
          controllerToken: "beacon-controller-token",
          monitoringPublicKey: await bytesToBase64(beaconKeys.publicKey),
          tentaclePriority: ["proxy", "issues"],
          relayConsortium: [],
          proxyRepos: [
            {
              owner: "decoy",
              repo: "proxy-repo",
              innerKind: "issues",
              decoyIssue: 7,
            },
          ],
          sleepSeconds: 60,
          jitter: 0.2,
        },
      },
      recoveryRepository: {
        owner: "recovery",
        repo: "public-drops",
        ref: "main",
      },
      recoveryWriteToken: "server-write-token",
      signingSecretKey: signingKeys.secretKey,
      signingPublicKey: signingKeys.publicKey,
      signingKeyId,
      apiBase: "https://github.test",
      fetchImpl,
      now: () => NOW,
    });

    const published = await publisher.publish(beaconId);
    expect(published.path).toBe(await recoveryDropPath(beaconId));
    expect(published.generation).toBe(NOW.getTime());
    expect(store.commits).toHaveLength(1);

    const put = requests.find((request) => request.method === "PUT");
    expect(put).toBeDefined();
    expect(new URL(put!.url).pathname).toBe(
      `/repos/recovery/public-drops/contents/${await recoveryDropPath(beaconId)}`,
    );
    expect(put!.headers.get("authorization")).toBe(
      "Bearer server-write-token",
    );

    const plain = await openSealBox(
      sealed,
      beaconKeys.publicKey,
      beaconKeys.secretKey,
    );
    const record: unknown = JSON.parse(new TextDecoder().decode(plain));
    const verified = await verifyRecoveryRecord(record, {
      beaconId,
      minimumGenerationExclusive: 0,
      signingPublicKey: signingKeys.publicKey,
      expectedSigningKeyId: signingKeyId,
      now: NOW,
    });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.configuration.github.tokenLease.token).toBe(
        "ghs_short_lived",
      );
      expect(verified.configuration.controllerToken).toBe(
        "beacon-controller-token",
      );
      expect(verified.configuration.proxyRepos[0]?.tokenLease).toEqual(
        expect.objectContaining({
          token: "ghs_proxy_short_lived",
          repository: { owner: "decoy", repo: "proxy-repo" },
        }),
      );
    }
    expect(mintedRepositories).toEqual([
      undefined,
      { owner: "decoy", repo: "proxy-repo" },
    ]);
    expect(JSON.stringify(record)).not.toContain("PRIVATE KEY");
  });

  it("rejects a private recovery repository before minting a lease", async () => {
    const beaconKeys = await generateOperatorKeyPair();
    const signingKeys = await generateEd25519KeyPair();
    const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
    const beaconId = "beacon-private-repo";
    const store = new MemoryRecoveryStore({
      beaconId,
      issueNumber: null,
      x25519PublicKey: await bytesToBase64(beaconKeys.publicKey),
      hostname: "pre-enrolled",
      username: "pre-enrolled",
      os: "unknown",
      arch: "unknown",
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
      status: "dormant",
      lastSeq: 0,
      activeTentacle: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    let mintCalls = 0;
    const fetchImpl = async () =>
      Response.json({ private: true });
    const publisher = new RecoveryPublisherService({
      store,
      tokenMinter: {
        mintLease: async () => {
          mintCalls += 1;
          return lease(beaconId);
        },
      },
      policies: {
        [beaconId]: {
          serverUrl: "https://controller.example.test",
          controllerToken: null,
          monitoringPublicKey: await bytesToBase64(beaconKeys.publicKey),
          tentaclePriority: ["issues"],
          relayConsortium: [],
          proxyRepos: [],
          sleepSeconds: 60,
          jitter: 0,
        },
      },
      recoveryRepository: {
        owner: "recovery",
        repo: "private-drops",
        ref: "main",
      },
      recoveryWriteToken: "server-write-token",
      signingSecretKey: signingKeys.secretKey,
      signingPublicKey: signingKeys.publicKey,
      signingKeyId,
      apiBase: "https://github.test",
      fetchImpl,
      now: () => NOW,
    });

    await expect(publisher.publish(beaconId)).rejects.toThrow(
      "must be public",
    );
    expect(mintCalls).toBe(0);
  });
});
