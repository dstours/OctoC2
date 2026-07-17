import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  signEnvelope,
} from "@octoc2/shared";
import { encodeStegoPng } from "@octoc2/shared/stego";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { ActionsChannel } from "../channels/ActionsChannel.ts";
import { BranchChannel } from "../channels/BranchChannel.ts";
import { GistChannel } from "../channels/GistChannel.ts";
import { IssuesChannel } from "../channels/IssuesChannel.ts";
import { NotesChannel } from "../channels/NotesChannel.ts";
import { PagesChannel } from "../channels/PagesChannel.ts";
import { SecretsChannel } from "../channels/SecretsChannel.ts";
import { SteganographyChannel } from "../channels/SteganographyChannel.ts";
import {
  parseCheckinPayload,
  parseTaskResult,
} from "../channels/ChannelServices.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore } from "../store/index.ts";

describe("secure GitHub channel wiring", () => {
  let dataDir: string;
  let store: OctoStore;
  let registry: BeaconRegistry;
  let queue: TaskQueue;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "octoc2-channels-"));
    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    registry = new BeaconRegistry(store);
    queue = new TaskQueue(store);
  });

  afterEach(async () => {
    await registry.shutdown();
    store.close();
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  });

  it("requires signed checkins and signed task results at the parser boundary", () => {
    expect(() => parseCheckinPayload(JSON.stringify({
      beaconId: "beacon-a",
      publicKey: "key",
      hostname: "host",
      username: "user",
      os: "linux",
      arch: "x64",
      pid: 1,
      checkinAt: new Date().toISOString(),
    }))).toThrow("signed checkin identity is required");
    expect(() => parseTaskResult(JSON.stringify({
      taskId: "task-a",
      beaconId: "beacon-a",
      success: true,
      output: "ok",
      completedAt: new Date().toISOString(),
    }))).toThrow("complete signed task result is required");
  });

  it("constructs every enabled GitHub channel with the same central services", async () => {
    const identities = new BeaconIdentityService(store, registry);
    const tasks = new TaskService(store, registry, queue);
    const services = { store, identities, tasks };
    const octokit = {} as any;
    const common = {
      owner: "owner",
      repo: "repo",
      token: "server-token",
      operatorSecretKey: new Uint8Array(32),
      pollIntervalMs: 60_000,
      octokit,
    };

    const channels = [
      new IssuesChannel(registry, queue, {
        ...common,
        operatorPublicKey: new Uint8Array(32),
      }, services),
      new BranchChannel(registry, queue, {
        ...common,
        services,
      }),
      new ActionsChannel(registry, queue, common, services),
      new PagesChannel(registry, queue, {
        ...common,
        services,
      }),
      new GistChannel(registry, queue, common, services),
      new SecretsChannel(registry, queue, common, services),
      new NotesChannel(registry, queue, common, services),
      new SteganographyChannel(registry, queue, common, services),
    ];

    expect(channels).toHaveLength(8);
    await Promise.all(channels.map((channel) => channel.stop()));
  });

  it("registers a first-use Stego branch from a signed PNG ACK", async () => {
    const identities = new BeaconIdentityService(store, registry);
    const tasks = new TaskService(store, registry, queue);
    const services = { store, identities, tasks };
    const signingKeys = await generateEd25519KeyPair();
    const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
    const beaconId = "a1b2c3d4-stego-test";
    const encryptionPublicKey = encodeBase64Url(
      new Uint8Array(32).fill(9),
    );
    const checkinAt = new Date().toISOString();
    await identities.enroll({
      version: 1,
      beaconId,
      encryptionPublicKey,
      signingPublicKey: encodeBase64Url(signingKeys.publicKey),
      signingKeyId,
      createdAt: checkinAt,
    });
    await registry.load();
    const identity = await signEnvelope(createUnsignedEnvelope({
      kind: "checkin",
      signerId: beaconId,
      keyId: signingKeyId,
      issuedAt: checkinAt,
      sequence: 1,
      payload: {
        beaconId,
        encryptionPublicKey,
        signingPublicKey: encodeBase64Url(signingKeys.publicKey),
        hostname: "stego-host",
        username: "stego-user",
        os: "linux",
        arch: "x64",
        pid: 42,
        checkinAt,
      },
    }), signingKeys.secretKey);
    const png = encodeStegoPng(new TextEncoder().encode(JSON.stringify({
      beaconId,
      publicKey: encryptionPublicKey,
      hostname: "stego-host",
      username: "stego-user",
      os: "linux",
      arch: "x64",
      pid: 42,
      checkinAt,
      identity,
    })));
    const octokit = {
      rest: {
        git: {
          listMatchingRefs: async () => ({
            data: [{
              ref: "refs/heads/infra-cache-a1b2c3d4",
              object: { sha: "branch-head" },
            }],
          }),
          getRef: async () => ({ data: { object: { sha: "branch-head" } } }),
          getCommit: async () => ({ data: { tree: { sha: "tree-head" } } }),
          getTree: async () => ({ data: { tree: [] } }),
        },
        repos: {
          getContent: async () => ({
            data: {
              type: "file",
              sha: "ack-sha",
              content: Buffer.from(png).toString("base64"),
            },
          }),
        },
      },
    } as any;
    const channel = new SteganographyChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "server-token",
      operatorSecretKey: new Uint8Array(32),
      pollIntervalMs: 60_000,
      octokit,
    }, services);

    await channel.poll();
    expect(registry.get(beaconId)).toMatchObject({
      hostname: "stego-host",
      activeTentacle: 9,
      lastSeq: 1,
    });
    expect(store.getProcessedMessage(
      "stego-ack-poll",
      "ack:refs/heads/infra-cache-a1b2c3d4:ack-sha",
    )?.outcome).toBe("accepted");
  });
});
