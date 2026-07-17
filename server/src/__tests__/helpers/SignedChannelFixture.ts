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
import { BeaconRegistry } from "../../BeaconRegistry.ts";
import { TaskQueue } from "../../TaskQueue.ts";
import {
  generateOperatorKeyPair,
  sealBox,
} from "../../crypto/sodium.ts";
import { BeaconIdentityService } from "../../services/BeaconIdentityService.ts";
import { TaskService } from "../../services/TaskService.ts";
import { OctoStore } from "../../store/index.ts";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof _SodiumModule;

export interface SignedChannelFixture {
  beaconId: string;
  id8: string;
  store: OctoStore;
  registry: BeaconRegistry;
  queue: TaskQueue;
  identities: BeaconIdentityService;
  tasks: TaskService;
  services: {
    store: OctoStore;
    identities: BeaconIdentityService;
    tasks: TaskService;
    queue: TaskQueue;
  };
  operatorKeys: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  beaconKeys: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  signingKeys: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  signingKeyId: string;
  createdAt: string;
  createCheckin(
    sequence: number,
    options?: {
      checkinAt?: string;
      hostname?: string;
      username?: string;
    },
  ): Promise<CheckinPayload>;
  createResult(
    taskId: string,
    sequence: number,
    options?: {
      completedAt?: string;
      output?: string;
      success?: boolean;
    },
  ): Promise<TaskResult>;
  sealResult(result: TaskResult): Promise<string>;
  decryptTasks(serializedEnvelope: string): Promise<Array<{
    taskId: string;
    kind: string;
    args: Record<string, unknown>;
    ref: string;
  }>>;
  timestamp(sequence: number): string;
  close(): void;
}

export async function createSignedChannelFixture(
  label: string,
  beaconId: string,
): Promise<SignedChannelFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), `octoc2-${label}-`));
  const store = OctoStore.open({ dataDir });
  const registry = new BeaconRegistry(store);
  const queue = new TaskQueue(store);
  const identities = new BeaconIdentityService(store, registry);
  const tasks = new TaskService(store, registry, queue);
  const signingKeys = await generateEd25519KeyPair();
  const signingKeyId = await ed25519KeyId(signingKeys.publicKey);
  const beaconKeys = await generateOperatorKeyPair();
  const operatorKeys = await generateOperatorKeyPair();
  const epoch = Date.now() - 60_000;
  const createdAt = new Date(epoch - 1_000).toISOString();
  let closed = false;

  const timestamp = (sequence: number): string =>
    new Date(epoch + sequence * 1_000).toISOString();

  await identities.enroll({
    version: 1,
    beaconId,
    encryptionPublicKey: encodeBase64Url(beaconKeys.publicKey),
    signingPublicKey: encodeBase64Url(signingKeys.publicKey),
    signingKeyId,
    createdAt,
  });
  await registry.load();

  const fixture: SignedChannelFixture = {
    beaconId,
    id8: beaconId.slice(0, 8),
    store,
    registry,
    queue,
    identities,
    tasks,
    services: { store, identities, tasks, queue },
    operatorKeys,
    beaconKeys,
    signingKeys,
    signingKeyId,
    createdAt,
    timestamp,
    async createCheckin(sequence, options = {}) {
      const checkinAt = options.checkinAt ?? timestamp(sequence);
      const hostname = options.hostname ?? `${label}-host`;
      const username = options.username ?? `${label}-user`;
      const publicKey = encodeBase64Url(beaconKeys.publicKey);
      const identity = await signEnvelope(
        createUnsignedEnvelope({
          kind: "checkin",
          signerId: beaconId,
          keyId: signingKeyId,
          issuedAt: checkinAt,
          sequence,
          payload: {
            beaconId,
            encryptionPublicKey: publicKey,
            signingPublicKey: encodeBase64Url(signingKeys.publicKey),
            hostname,
            username,
            os: "linux",
            arch: "x64",
            pid: 42,
            checkinAt,
          },
        }),
        signingKeys.secretKey,
      );
      return {
        beaconId,
        publicKey,
        hostname,
        username,
        os: "linux",
        arch: "x64",
        pid: 42,
        checkinAt,
        identity,
      };
    },
    async createResult(taskId, sequence, options = {}) {
      const completedAt = options.completedAt ?? timestamp(sequence);
      const unsignedResult: Omit<TaskResult, "signature"> = {
        taskId,
        beaconId,
        success: options.success ?? true,
        output: options.output ?? `${label}-result`,
        completedAt,
      };
      const signature = await signEnvelope(
        createUnsignedEnvelope({
          kind: "task-result",
          signerId: beaconId,
          keyId: signingKeyId,
          issuedAt: completedAt,
          sequence,
          payload: await createTaskResultSignaturePayload(unsignedResult),
        }),
        signingKeys.secretKey,
      );
      return {
        ...unsignedResult,
        signature: serializeSignedEnvelope(signature),
      };
    },
    async sealResult(result) {
      return sealBox(JSON.stringify(result), operatorKeys.publicKey);
    },
    async decryptTasks(serializedEnvelope) {
      const envelope = JSON.parse(serializedEnvelope) as {
        ciphertext: string;
        nonce: string;
      };
      await sodium.ready;
      const plaintext = sodium.crypto_box_open_easy(
        await decodeBase64Url(envelope.ciphertext),
        await decodeBase64Url(envelope.nonce),
        operatorKeys.publicKey,
        beaconKeys.secretKey,
      );
      if (!plaintext) throw new Error("Could not decrypt delivered tasks");
      return JSON.parse(
        new TextDecoder().decode(plaintext),
      ) as Array<{
        taskId: string;
        kind: string;
        args: Record<string, unknown>;
        ref: string;
      }>;
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch (error: any) {
        if (error?.code !== "EBUSY") throw error;
      }
    },
  };

  return fixture;
}
