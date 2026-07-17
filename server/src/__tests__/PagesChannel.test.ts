import { afterEach, describe, expect, it } from "bun:test";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  decodeBase64Url,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  serializeSignedEnvelope,
  signEnvelope,
  type CheckinPayload,
  type TaskResult,
} from "@octoc2/shared";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type _SodiumModule from "libsodium-wrappers";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { PagesChannel } from "../channels/PagesChannel.ts";
import {
  generateOperatorKeyPair,
  sealBox,
} from "../crypto/sodium.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore } from "../store/index.ts";
import { createSignedChannelFixture } from "./helpers/SignedChannelFixture.ts";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof _SodiumModule;
const BEACON_ID = "feedface-1234-5678-90ab-cdef12345678";
const ID8 = BEACON_ID.slice(0, 8);

class FakePagesRepository {
  readonly deployments: any[] = [];
  readonly createdDeployments: any[] = [];
  readonly statuses: any[] = [];
  private nextId = 100;

  readonly octokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "release" } }),
        listDeployments: async ({ environment }: any) => ({
          data: environment
            ? this.deployments.filter(
              (deployment) => deployment.environment === environment,
            )
            : [...this.deployments],
        }),
        createDeployment: async (input: any) => {
          const deployment = { id: this.nextId++, ...input };
          this.deployments.unshift(deployment);
          this.createdDeployments.push(deployment);
          return { data: deployment };
        },
        createDeploymentStatus: async (input: any) => {
          this.statuses.push(input);
          return { data: input };
        },
      },
    },
  } as any;

  put(deployment: any): void {
    this.deployments.unshift(deployment);
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error: any) {
      if (error?.code !== "EBUSY") throw error;
    }
  }
});

describe("PagesChannel signed integration", () => {
  it("registers, delivers, and completes through the repository default branch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "octoc2-pages-"));
    temporaryDirectories.push(dataDir);
    const store = OctoStore.open({ dataDir });
    try {
      const registry = new BeaconRegistry(store);
      const queue = new TaskQueue(store);
      const identities = new BeaconIdentityService(store, registry);
      const tasks = new TaskService(store, registry, queue);
      const signingKeys = await generateEd25519KeyPair();
      const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
      const beaconKeys = await generateOperatorKeyPair();
      const operatorKeys = await generateOperatorKeyPair();
      const now = new Date(Date.now() - 1_000).toISOString();

      await identities.enroll({
        version: 1,
        beaconId: BEACON_ID,
        encryptionPublicKey: encodeBase64Url(beaconKeys.publicKey),
        signingPublicKey: encodeBase64Url(signingKeys.publicKey),
        signingKeyId,
        createdAt: now,
      });
      await registry.load();

      const checkin = await signedCheckin({
        signingKeyId,
        signingPublicKey: signingKeys.publicKey,
        signingSecretKey: signingKeys.secretKey,
        encryptionPublicKey: beaconKeys.publicKey,
        issuedAt: now,
      });
      const github = new FakePagesRepository();
      github.put({
        id: 1,
        environment: `ci-${ID8}`,
        description: "ack",
        payload: checkin,
      });
      const channel = new PagesChannel(registry, queue, {
        owner: "owner",
        repo: "repo",
        token: "server-token",
        operatorSecretKey: operatorKeys.secretKey,
        pollIntervalMs: 60_000,
        octokit: github.octokit,
        services: { store, identities, tasks, queue },
      });
      const task = queue.queueTask(
        BEACON_ID,
        "shell",
        { cmd: "whoami" },
        "pages",
      );

      await channel.poll();

      expect(registry.get(BEACON_ID)?.activeTentacle).toBe(5);
      const taskDeployment = github.createdDeployments.find(
        (deployment) => deployment.environment === `ci-t-${ID8}`,
      );
      expect(taskDeployment).toBeDefined();
      expect(taskDeployment.ref).toBe("release");
      expect(queue.getTask(task.taskId)?.state).toBe("delivered");

      const encrypted = JSON.parse(String(taskDeployment.payload));
      await sodium.ready;
      const plaintext = sodium.crypto_box_open_easy(
        await decodeBase64Url(encrypted.ciphertext),
        await decodeBase64Url(encrypted.nonce),
        operatorKeys.publicKey,
        beaconKeys.secretKey,
      );
      expect(plaintext).not.toBeNull();
      expect(
        JSON.parse(new TextDecoder().decode(plaintext!))[0].taskId,
      ).toBe(task.taskId);

      const result = await signedResult({
        taskId: task.taskId,
        signingKeyId,
        signingSecretKey: signingKeys.secretKey,
        completedAt: new Date().toISOString(),
      });
      github.put({
        id: 2,
        environment: `ci-r-${ID8}`,
        description: "result",
        payload: await sealBox(
          JSON.stringify(result),
          operatorKeys.publicKey,
        ),
      });

      await channel.poll();

      expect(queue.getTask(task.taskId)?.state).toBe("completed");
      expect(store.getTaskResult(task.taskId)?.canonicalResult).toContain(
        "pages-user",
      );
      expect(github.statuses).toContainEqual({
        owner: "owner",
        repo: "repo",
        deployment_id: 2,
        state: "inactive",
      });
    } finally {
      store.close();
    }
  });

  it("durably rejects a malformed immutable ACK deployment", async () => {
    const fixture = await createSignedChannelFixture(
      "pages-poison",
      BEACON_ID,
    );
    try {
      const github = new FakePagesRepository();
      github.put({
        id: 77,
        environment: `ci-${fixture.id8}`,
        description: "poison",
        payload: "{",
      });
      const channel = new PagesChannel(fixture.registry, fixture.queue, {
        owner: "owner",
        repo: "repo",
        token: "server-token",
        operatorSecretKey: fixture.operatorKeys.secretKey,
        pollIntervalMs: 60_000,
        octokit: github.octokit,
        services: fixture.services,
      });
      const messageId = "ack:deployment:77";

      await channel.poll();
      const rejected = fixture.store.getProcessedMessage(
        "pages",
        messageId,
      );
      expect(rejected).toMatchObject({ outcome: "rejected" });

      await channel.poll();
      expect(fixture.store.getProcessedMessage(
        "pages",
        messageId,
      )?.processedAt).toBe(rejected?.processedAt);
    } finally {
      fixture.close();
    }
  });

  it("requires a newly accepted or gap ACK before creating task deployments", async () => {
    const fixture = await createSignedChannelFixture("pages-replay", BEACON_ID);
    try {
      const github = new FakePagesRepository();
      const checkin = await fixture.createCheckin(1);
      github.put({
        id: 801,
        environment: `ci-${fixture.id8}`,
        description: "ack",
        payload: checkin,
      });
      let forcedStatus: "stale_duplicate" | null = null;
      const services = {
        ...fixture.services,
        identities: {
          verifyAndRegisterCheckin: async (...args: any[]) =>
            forcedStatus ??
            await (fixture.identities.verifyAndRegisterCheckin as any).call(
              fixture.identities,
              ...args,
            ),
        },
      } as any;
      const create = () => new PagesChannel(
        fixture.registry,
        fixture.queue,
        {
          owner: "owner",
          repo: "repo",
          token: "server-token",
          operatorSecretKey: fixture.operatorKeys.secretKey,
          pollIntervalMs: 60_000,
          octokit: github.octokit,
          services,
        },
      );

      await create().poll();
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "pages",
      );

      const restarted = create();
      await restarted.poll();
      expect(github.createdDeployments).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      github.put({
        id: 802,
        environment: `ci-${fixture.id8}`,
        description: "replayed ack",
        payload: checkin,
      });
      await restarted.poll();
      expect(github.createdDeployments).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      github.put({
        id: 803,
        environment: `ci-${fixture.id8}`,
        description: "fresh ack",
        payload: await fixture.createCheckin(2, {
          checkinAt: fixture.timestamp(3),
        }),
      });
      await restarted.poll();
      expect(github.createdDeployments).toHaveLength(1);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      fixture.close();
    }
  });
});

async function signedCheckin(input: {
  signingKeyId: string;
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  issuedAt: string;
}): Promise<CheckinPayload> {
  const identity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: BEACON_ID,
      keyId: input.signingKeyId,
      issuedAt: input.issuedAt,
      sequence: 1,
      payload: {
        beaconId: BEACON_ID,
        encryptionPublicKey: encodeBase64Url(input.encryptionPublicKey),
        signingPublicKey: encodeBase64Url(input.signingPublicKey),
        hostname: "pages-host",
        username: "pages-user",
        os: "linux",
        arch: "x64",
        pid: 42,
        checkinAt: input.issuedAt,
      },
    }),
    input.signingSecretKey,
  );
  return {
    beaconId: BEACON_ID,
    publicKey: encodeBase64Url(input.encryptionPublicKey),
    hostname: "pages-host",
    username: "pages-user",
    os: "linux",
    arch: "x64",
    pid: 42,
    checkinAt: input.issuedAt,
    identity,
  };
}

async function signedResult(input: {
  taskId: string;
  signingKeyId: string;
  signingSecretKey: Uint8Array;
  completedAt: string;
}): Promise<TaskResult> {
  const unsignedResult: Omit<TaskResult, "signature"> = {
    taskId: input.taskId,
    beaconId: BEACON_ID,
    success: true,
    output: "pages-user",
    completedAt: input.completedAt,
  };
  const signature = await signEnvelope(
    createUnsignedEnvelope({
      kind: "task-result",
      signerId: BEACON_ID,
      keyId: input.signingKeyId,
      issuedAt: input.completedAt,
      sequence: 2,
      payload: await createTaskResultSignaturePayload(unsignedResult),
    }),
    input.signingSecretKey,
  );
  return {
    ...unsignedResult,
    signature: serializeSignedEnvelope(signature),
  };
}
