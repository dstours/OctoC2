import { afterEach, describe, expect, it, mock } from "bun:test";
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
import {
  decodeStegoPng,
  encodeStegoPng,
} from "@octoc2/shared/stego";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type _SodiumModule from "libsodium-wrappers";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { SteganographyChannel } from "../channels/SteganographyChannel.ts";
import {
  base64ToBytes,
  generateOperatorKeyPair,
  sealBox,
} from "../crypto/sodium.ts";
import { BeaconIdentityService } from "../services/BeaconIdentityService.ts";
import { TaskService } from "../services/TaskService.ts";
import { OctoStore } from "../store/index.ts";

const sodium = createRequire(import.meta.url)(
  "libsodium-wrappers",
) as typeof _SodiumModule;
const BEACON_ID = "deadbeef-1234-5678-90ab-cdef12345678";
const ID8 = BEACON_ID.slice(0, 8);
const STEGO_REF = `heads/infra-cache-${ID8}`;

class FakeGitHubRepository {
  readonly refs = new Map<string, string>();
  readonly files = new Map<string, Map<string, { bytes: Uint8Array; sha: string }>>();
  private readonly commitRef = new Map<string, string>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly trees = new Map<string, Map<string, { bytes: Uint8Array; sha: string }>>();
  private readonly commits = new Map<string, Map<string, { bytes: Uint8Array; sha: string }>>();
  private counter = 0;

  readonly octokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "trunk" } }),
        getContent: async (input: any) => {
          const ref = normalizeRef(String(input.ref));
          const file = this.files.get(ref)?.get(String(input.path));
          if (!file) throw Object.assign(new Error("not found"), { status: 404 });
          return {
            data: {
              type: "file",
              content: encodeBase64(file.bytes),
              sha: file.sha,
            },
          };
        },
      },
      git: {
        listMatchingRefs: async ({ ref }: any) => ({
          data: [...this.refs.keys()]
            .filter((candidate) => candidate.startsWith(String(ref)))
            .map((candidate) => ({
              ref: `refs/${candidate}`,
              object: { sha: this.refs.get(candidate)! },
            })),
        }),
        getRef: async ({ ref }: any) => {
          const sha = this.refs.get(normalizeRef(String(ref)));
          if (!sha) throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { object: { sha } } };
        },
        getCommit: async ({ commit_sha }: any) => ({
          data: { tree: { sha: `tree:${String(commit_sha)}` } },
        }),
        getTree: async ({ tree_sha }: any) => {
          const commit = String(tree_sha).replace(/^tree:/, "");
          const ref = this.commitRef.get(commit);
          const snapshot = ref
            ? this.files.get(ref)
            : this.commits.get(commit);
          return {
            data: {
              tree: [...(snapshot?.entries() ?? [])].map(([path, file]) => ({
                path,
                type: "blob",
                sha: file.sha,
              })),
            },
          };
        },
        createBlob: async ({ content }: any) => {
          const sha = this.next("blob");
          this.blobs.set(sha, decodeBase64(String(content)));
          return { data: { sha } };
        },
        createTree: async ({ base_tree, tree }: any) => {
          const baseCommit = String(base_tree).replace(/^tree:/, "");
          const baseRef = this.commitRef.get(baseCommit);
          const snapshot = cloneFiles(
            baseRef
              ? this.files.get(baseRef)
              : this.commits.get(baseCommit),
          );
          for (const entry of tree as any[]) {
            const path = String(entry.path);
            if (entry.sha === null) {
              snapshot.delete(path);
            } else {
              const bytes = this.blobs.get(String(entry.sha));
              if (!bytes) throw new Error("unknown blob");
              snapshot.set(path, { bytes, sha: String(entry.sha) });
            }
          }
          const sha = this.next("tree");
          this.trees.set(sha, snapshot);
          return { data: { sha } };
        },
        createCommit: async ({ tree }: any) => {
          const snapshot = this.trees.get(String(tree));
          if (!snapshot) throw new Error("unknown tree");
          const sha = this.next("commit");
          this.commits.set(sha, cloneFiles(snapshot));
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }: any) => {
          this.updateRef(normalizeRef(String(ref)), String(sha));
          return {};
        },
        createRef: async ({ ref, sha }: any) => {
          this.updateRef(normalizeRef(String(ref)), String(sha));
          return {};
        },
      },
    },
  } as any;

  constructor() {
    this.initializeRef("heads/trunk", "commit-default");
    this.initializeRef(STEGO_REF, "commit-stego");
  }

  put(path: string, bytes: Uint8Array): void {
    const files = this.files.get(STEGO_REF)!;
    files.set(path, { bytes, sha: this.next("file") });
  }

  get(path: string): Uint8Array | null {
    return this.files.get(STEGO_REF)?.get(path)?.bytes ?? null;
  }

  sha(path: string): string | null {
    return this.files.get(STEGO_REF)?.get(path)?.sha ?? null;
  }

  private initializeRef(ref: string, commit: string): void {
    this.refs.set(ref, commit);
    this.files.set(ref, new Map());
    this.commitRef.set(commit, ref);
  }

  private updateRef(ref: string, commit: string): void {
    const snapshot = this.commits.get(commit);
    if (!snapshot) throw new Error("unknown commit");
    this.refs.set(ref, commit);
    this.files.set(ref, cloneFiles(snapshot));
    this.commitRef.set(commit, ref);
  }

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error: any) {
      // Bun's Windows SQLite handle can be released just after the hook runs;
      // the OS temp directory is still an ephemeral test fixture.
      if (error?.code !== "EBUSY") throw error;
    }
  }
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "octoc2-stego-"));
  temporaryDirectories.push(dataDir);
  const store = OctoStore.open({ dataDir });
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

  const unsignedCheckin = createUnsignedEnvelope({
    kind: "checkin",
    signerId: BEACON_ID,
    keyId: signingKeyId,
    issuedAt: now,
    sequence: 1,
    payload: {
      beaconId: BEACON_ID,
      encryptionPublicKey: encodeBase64Url(beaconKeys.publicKey),
      signingPublicKey: encodeBase64Url(signingKeys.publicKey),
      hostname: "stego-host",
      username: "stego-user",
      os: "linux",
      arch: "x64",
      pid: 42,
      checkinAt: now,
    },
  });
  const checkin: CheckinPayload = {
    beaconId: BEACON_ID,
    publicKey: encodeBase64Url(beaconKeys.publicKey),
    hostname: "stego-host",
    username: "stego-user",
    os: "linux",
    arch: "x64",
    pid: 42,
    checkinAt: now,
    identity: await signEnvelope(unsignedCheckin, signingKeys.secretKey),
  };

  const github = new FakeGitHubRepository();
  github.put(
    `infra-${ID8}-a.png`,
    encodeStegoPng(new TextEncoder().encode(JSON.stringify(checkin))),
  );
  const channel = new SteganographyChannel(registry, queue, {
    owner: "owner",
    repo: "repo",
    token: "server-token",
    operatorSecretKey: operatorKeys.secretKey,
    pollIntervalMs: 60_000,
    octokit: github.octokit,
  }, { store, identities, tasks, queue });
  return {
    store,
    registry,
    queue,
    identities,
    tasks,
    signingKeys,
    signingKeyId,
    beaconKeys,
    operatorKeys,
    github,
    channel,
    checkin,
  };
}

async function signedResult(
  context: Awaited<ReturnType<typeof setup>>,
  result: Omit<TaskResult, "signature">,
  sequence: number,
  signingSecretKey = context.signingKeys.secretKey,
): Promise<TaskResult> {
  const envelope = await signEnvelope(
    createUnsignedEnvelope({
      kind: "task-result",
      signerId: result.beaconId,
      keyId: context.signingKeyId,
      issuedAt: result.completedAt,
      sequence,
      payload: await createTaskResultSignaturePayload(result),
    }),
    signingSecretKey,
  );
  return {
    ...result,
    signature: serializeSignedEnvelope(envelope),
  };
}

async function resultPng(
  context: Awaited<ReturnType<typeof setup>>,
  result: TaskResult,
): Promise<Uint8Array> {
  return encodeStegoPng(
    new TextEncoder().encode(
      await sealBox(JSON.stringify(result), context.operatorKeys.publicKey),
    ),
  );
}

describe("SteganographyChannel signed local round trip", () => {
  it("retries a branch-create race from the winner's latest tree without forcing the ref", async () => {
    const context = await setup();
    try {
      let branchReads = 0;
      const getRef = mock(async ({ ref }: any) => {
        if (ref === STEGO_REF) {
          branchReads += 1;
          if (branchReads === 1) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          return { data: { object: { sha: "winner-head" } } };
        }
        if (ref === "heads/trunk") {
          return { data: { object: { sha: "default-head" } } };
        }
        throw new Error(`unexpected ref ${ref}`);
      });
      const createCommit = mock(async ({ parents }: any) => ({
        data: { sha: `commit-from-${parents[0]}` },
      }));
      const createRef = mock(async () => {
        throw Object.assign(new Error("ref already exists"), { status: 422 });
      });
      const updateRef = mock(async () => ({}));
      const createBlob = mock(async () => ({ data: { sha: "task-blob" } }));
      const octokit = {
        rest: {
          repos: {
            get: mock(async () => ({ data: { default_branch: "trunk" } })),
          },
          git: {
            getRef,
            getCommit: mock(async ({ commit_sha }: any) => ({
              data: { tree: { sha: `tree-of-${commit_sha}` } },
            })),
            createBlob,
            createTree: mock(async ({ base_tree }: any) => ({
              data: { sha: `next-${base_tree}` },
            })),
            createCommit,
            createRef,
            updateRef,
          },
        },
      } as any;
      const channel = new SteganographyChannel(
        context.registry,
        context.queue,
        {
          owner: "owner",
          repo: "repo",
          token: "server-token",
          operatorSecretKey: context.operatorKeys.secretKey,
          pollIntervalMs: 60_000,
          octokit,
        },
        {
          store: context.store,
          identities: context.identities,
          tasks: context.tasks,
          queue: context.queue,
        },
      );

      await (channel as any).writeFile(
        ID8,
        `infra-${ID8}-t.png`,
        new Uint8Array([1, 2, 3]),
        "update cache artifact",
      );

      expect(createBlob).toHaveBeenCalledTimes(1);
      expect(createRef).toHaveBeenCalledTimes(1);
      expect(updateRef).toHaveBeenCalledTimes(1);
      expect(((updateRef.mock.calls[0] as any)[0] as any).force).toBe(false);
      expect(
        (createCommit.mock.calls as any).map((call: any) => call[0].parents),
      ).toEqual([["default-head"], ["winner-head"]]);
    } finally {
      context.store.close();
    }
  });

  it("retries a conflicting result deletion from the latest branch tree", async () => {
    const context = await setup();
    try {
      const getRef = mock()
        .mockResolvedValueOnce({
          data: { object: { sha: "head-before-race" } },
        })
        .mockResolvedValueOnce({
          data: { object: { sha: "head-after-race" } },
        });
      const createCommit = mock(async ({ parents }: any) => ({
        data: { sha: `delete-from-${parents[0]}` },
      }));
      const updateRef = mock()
        .mockRejectedValueOnce(
          Object.assign(new Error("not a fast forward"), { status: 409 }),
        )
        .mockResolvedValueOnce({});
      const octokit = {
        rest: {
          git: {
            getRef,
            getCommit: mock(async ({ commit_sha }: any) => ({
              data: { tree: { sha: `tree-of-${commit_sha}` } },
            })),
            createTree: mock(async ({ base_tree }: any) => ({
              data: { sha: `next-${base_tree}` },
            })),
            createCommit,
            updateRef,
          },
        },
      } as any;
      const channel = new SteganographyChannel(
        context.registry,
        context.queue,
        {
          owner: "owner",
          repo: "repo",
          token: "server-token",
          operatorSecretKey: context.operatorKeys.secretKey,
          pollIntervalMs: 60_000,
          octokit,
        },
        {
          store: context.store,
          identities: context.identities,
          tasks: context.tasks,
          queue: context.queue,
        },
      );

      await (channel as any).deleteFile(
        `refs/${STEGO_REF}`,
        `infra-${ID8}-r-task.png`,
      );

      expect(updateRef).toHaveBeenCalledTimes(2);
      for (const call of updateRef.mock.calls as any) {
        expect(call[0].force).toBe(false);
      }
      expect(
        (createCommit.mock.calls as any).map((call: any) => call[0].parents),
      ).toEqual([["head-before-race"], ["head-after-race"]]);
    } finally {
      context.store.close();
    }
  });

  it("registers a signed ACK, delivers a decryptable PNG task, and accepts only signed results", async () => {
    const context = await setup();
    try {
      const task = context.queue.queueTask(
        BEACON_ID,
        "shell",
        { cmd: "whoami" },
        "stego",
      );
      await context.channel.poll();

      expect(context.registry.get(BEACON_ID)?.activeTentacle).toBe(9);
      const taskPng = context.github.get(`infra-${ID8}-t.png`);
      expect(taskPng).not.toBeNull();
      const embedded = decodeStegoPng(taskPng!);
      expect(embedded).not.toBeNull();
      const encrypted = JSON.parse(new TextDecoder().decode(embedded!));
      await sodium.ready;
      const plaintext = sodium.crypto_box_open_easy(
        await decodeBase64Url(encrypted.ciphertext),
        await decodeBase64Url(encrypted.nonce),
        context.operatorKeys.publicKey,
        context.beaconKeys.secretKey,
      );
      expect(plaintext).not.toBeNull();
      expect(JSON.parse(new TextDecoder().decode(plaintext!))[0].taskId).toBe(
        task.taskId,
      );

      const completedAt = new Date().toISOString();
      const result = await signedResult(
        context,
        {
          taskId: task.taskId,
          beaconId: BEACON_ID,
          success: true,
          output: "stego-user",
          completedAt,
        },
        2,
      );
      const resultPath = `infra-${ID8}-r-${task.taskId.slice(0, 8)}.png`;
      const png = await resultPng(context, result);
      context.github.put(resultPath, png);
      await context.channel.poll();

      expect(context.queue.getTask(task.taskId)?.state).toBe("completed");
      expect(context.github.get(resultPath)).toBeNull();

      context.github.put(resultPath, png);
      await context.channel.poll();
      expect(context.github.get(resultPath)).toBeNull();

      const conflicting = await signedResult(
        context,
        { ...result, output: "tampered", signature: undefined } as any,
        3,
      );
      context.github.put(resultPath, await resultPng(context, conflicting));
      await context.channel.poll();
      expect(context.github.get(resultPath)).not.toBeNull();
      expect(context.store.getTaskResult(task.taskId)?.canonicalResult).toContain(
        "stego-user",
      );
    } finally {
      context.store.close();
    }
  });

  it("leaves wrong-owner and invalid-signature results unconsumed", async () => {
    const context = await setup();
    try {
      const task = context.queue.queueTask(
        BEACON_ID,
        "ping",
        {},
        "stego",
      );
      await context.channel.poll();
      const attacker = await generateEd25519KeyPair();
      const invalid = await signedResult(
        context,
        {
          taskId: task.taskId,
          beaconId: BEACON_ID,
          success: true,
          output: "forged",
          completedAt: new Date().toISOString(),
        },
        2,
        attacker.secretKey,
      );
      const path = `infra-${ID8}-r-${task.taskId.slice(0, 8)}.png`;
      context.github.put(path, await resultPng(context, invalid));
      const invalidSha = context.github.sha(path)!;
      await context.channel.poll();
      expect(context.queue.getTask(task.taskId)?.state).toBe("delivered");
      expect(context.github.get(path)).not.toBeNull();
      const rejected = context.store.getProcessedMessage(
        "stego-result-poll",
        `result:refs/${STEGO_REF}:${invalidSha}`,
      );
      expect(rejected).toMatchObject({ outcome: "rejected" });

      await context.channel.poll();
      expect(context.github.get(path)).not.toBeNull();
      expect(context.store.getProcessedMessage(
        "stego-result-poll",
        `result:refs/${STEGO_REF}:${invalidSha}`,
      )?.processedAt).toBe(rejected?.processedAt);

      const wrongOwner = await signedResult(
        context,
        {
          taskId: task.taskId,
          beaconId: "cafebabe-1234-5678-90ab-cdef12345678",
          success: true,
          output: "wrong owner",
          completedAt: new Date(Date.now() + 1_000).toISOString(),
        },
        3,
      );
      const wrongOwnerPath = `infra-${ID8}-r-ownerbad.png`;
      context.github.put(
        wrongOwnerPath,
        await resultPng(context, wrongOwner),
      );
      await context.channel.poll();
      expect(context.github.get(wrongOwnerPath)).not.toBeNull();
      expect(context.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      context.store.close();
    }
  });

  it("requires a newly accepted or gap ACK before writing a task PNG", async () => {
    const context = await setup();
    try {
      await context.channel.poll();
      const task = context.queue.queueTask(
        BEACON_ID,
        "ping",
        {},
        "stego",
      );
      let forcedStatus: "stale_duplicate" | null = null;
      const services = {
        store: context.store,
        tasks: context.tasks,
        queue: context.queue,
        identities: {
          verifyAndRegisterCheckin: async (...args: any[]) =>
            forcedStatus ??
            await (context.identities.verifyAndRegisterCheckin as any).call(
              context.identities,
              ...args,
            ),
        },
      } as any;
      const restarted = new SteganographyChannel(
        context.registry,
        context.queue,
        {
          owner: "owner",
          repo: "repo",
          token: "server-token",
          operatorSecretKey: context.operatorKeys.secretKey,
          pollIntervalMs: 60_000,
          octokit: context.github.octokit,
        },
        services,
      );

      await restarted.poll();
      expect(context.github.get(`infra-${ID8}-t.png`)).toBeNull();
      expect(context.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      context.github.put(
        `infra-${ID8}-a.png`,
        encodeStegoPng(
          new TextEncoder().encode(JSON.stringify(context.checkin)),
        ),
      );
      await restarted.poll();
      expect(context.github.get(`infra-${ID8}-t.png`)).toBeNull();
      expect(context.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      const checkinAt = new Date(Date.now() + 1_000).toISOString();
      const freshCheckin: CheckinPayload = {
        ...context.checkin,
        checkinAt,
        identity: await signEnvelope(
          createUnsignedEnvelope({
            kind: "checkin",
            signerId: BEACON_ID,
            keyId: context.signingKeyId,
            issuedAt: checkinAt,
            sequence: 2,
            payload: {
              beaconId: BEACON_ID,
              encryptionPublicKey: encodeBase64Url(
                context.beaconKeys.publicKey,
              ),
              signingPublicKey: encodeBase64Url(
                context.signingKeys.publicKey,
              ),
              hostname: context.checkin.hostname,
              username: context.checkin.username,
              os: context.checkin.os,
              arch: context.checkin.arch,
              pid: context.checkin.pid,
              checkinAt,
            },
          }),
          context.signingKeys.secretKey,
        ),
      };
      context.github.put(
        `infra-${ID8}-a.png`,
        encodeStegoPng(
          new TextEncoder().encode(JSON.stringify(freshCheckin)),
        ),
      );
      await restarted.poll();
      expect(context.github.get(`infra-${ID8}-t.png`)).not.toBeNull();
      expect(context.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      context.store.close();
    }
  });
});

function normalizeRef(ref: string): string {
  return ref.replace(/^refs\//, "");
}

function cloneFiles(
  source?: Map<string, { bytes: Uint8Array; sha: string }>,
): Map<string, { bytes: Uint8Array; sha: string }> {
  return new Map(
    [...(source?.entries() ?? [])].map(([path, file]) => [
      path,
      { bytes: file.bytes.slice(), sha: file.sha },
    ]),
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
