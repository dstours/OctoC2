import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { BranchChannel } from "../channels/BranchChannel.ts";
import {
  bytesToBase64,
  generateOperatorKeyPair,
  sealBox,
} from "../crypto/sodium.ts";
import { createSignedChannelFixture } from "./helpers/SignedChannelFixture.ts";

const BEACON_ID = "a1b2c3d4-1234-5678-90ab-cdef12345678";
const ID8 = BEACON_ID.slice(0, 8);

function encodeText(value: string): string {
  return btoa(value);
}

describe("BranchChannel signed service routing", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKeys: Awaited<ReturnType<typeof generateOperatorKeyPair>>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "octoc2-branch-channel-"));
    registry = new BeaconRegistry(dataDir);
    queue = new TaskQueue();
    operatorKeys = await generateOperatorKeyPair();
  });

  afterEach(async () => {
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  function services(
    identities: any = {
      verifyAndRegisterCheckin: mock(async () => "accepted"),
    },
    tasks: any = {
      acceptSignedResult: mock(async () => ({ status: "completed" })),
    },
  ) {
    const leases = new Map<string, string>();
    return {
      store: {
        getProcessedMessage: mock(() => undefined),
        getPollCursor: mock(() => undefined),
        commitChannelProgress: mock(() => ({ status: "committed" })),
        claimDelivery: mock((input: any) => {
          const leaseToken = `lease:${input.taskId}`;
          leases.set(leaseToken, input.taskId);
          return {
            status: "claimed",
            lease: {
              taskId: input.taskId,
              beaconId: input.beaconId,
              leaseToken,
              channel: input.channel,
              workerId: input.workerId,
              leasedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + input.leaseDurationMs).toISOString(),
              attemptNumber: 1,
            },
          };
        }),
        finishDelivery: mock((input: any) => {
          const taskId = leases.get(input.leaseToken);
          if (taskId && input.outcome === "delivered") queue.markDelivered(taskId);
        }),
      } as any,
      identities,
      tasks,
    };
  }

  it("routes the complete signed ACK through BeaconIdentityService", async () => {
    const checkin = {
      beaconId: BEACON_ID,
      publicKey: await bytesToBase64(
        (await generateOperatorKeyPair()).publicKey,
      ),
      hostname: "host",
      username: "user",
      os: "linux",
      arch: "x64",
      pid: 7,
      checkinAt: new Date().toISOString(),
      identity: { kind: "checkin", sequence: 9 },
    };
    const verifyAndRegisterCheckin = mock(async (payload: any) => {
      registry.register({
        beaconId: payload.beaconId,
        issueNumber: 0,
        publicKey: payload.publicKey,
        hostname: payload.hostname,
        username: payload.username,
        os: payload.os,
        arch: payload.arch,
        seq: payload.identity.sequence,
        tentacleId: 2,
      });
      return "accepted";
    });
    const octokit = {
      rest: {
        git: {
          listMatchingRefs: mock(async () => ({
            data: [{ ref: `refs/heads/infra-sync-${ID8}` }],
          })),
        },
        repos: {
          getContent: mock(async () => ({
            data: {
              type: "file",
              content: encodeText(JSON.stringify(checkin)),
              sha: "ack-sha",
            },
          })),
        },
      },
    } as any;
    const channel = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
      services: services({ verifyAndRegisterCheckin } as any),
    });

    await (channel as any).processAckFiles("owner", "repo");

    expect(verifyAndRegisterCheckin).toHaveBeenCalledTimes(1);
    const identityCalls = verifyAndRegisterCheckin.mock.calls as any;
    expect(identityCalls[0][0]).toEqual(checkin);
    expect(identityCalls[0][2]).toBe(2);
    expect((channel as any).branchBeacons.get(BEACON_ID)).toBe(ID8);
  });

  it("routes results through TaskService and rejects branch ownership mismatches before deletion", async () => {
    registry.register({
      beaconId: BEACON_ID,
      issueNumber: 0,
      publicKey: await bytesToBase64(
        (await generateOperatorKeyPair()).publicKey,
      ),
      hostname: "h",
      username: "u",
      os: "linux",
      arch: "x64",
      seq: 0,
    });
    const task = queue.queueTask(BEACON_ID, "ping", {});
    queue.markDelivered(task.taskId);
    const accepted = {
      taskId: task.taskId,
      beaconId: BEACON_ID,
      success: true,
      output: "pong",
      completedAt: new Date().toISOString(),
      signature: "signed-envelope",
    };
    const sealed = await sealBox(
      JSON.stringify(accepted),
      operatorKeys.publicKey,
    );
    const acceptSignedResult = mock(async () => ({ status: "completed" }));
    const updateRef = mock(async () => ({}));
    const octokit = resultOctokit(sealed, updateRef, task.taskId);
    const channel = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
      services: services(undefined, { acceptSignedResult } as any),
    });
    (channel as any).branchBeacons.set(BEACON_ID, ID8);

    await (channel as any).processResultFiles("owner", "repo");

    expect(acceptSignedResult).toHaveBeenCalledTimes(1);
    const resultCalls = acceptSignedResult.mock.calls as any;
    expect(resultCalls[0][1]).toBe(BEACON_ID);
    expect(updateRef).toHaveBeenCalledTimes(1);

    const wrongOwner = { ...accepted, beaconId: "ffffffff-other" };
    const wrongOwnerSealed = await sealBox(
      JSON.stringify(wrongOwner),
      operatorKeys.publicKey,
    );
    const rejectedService = mock(async () => ({ status: "completed" }));
    const rejectedDelete = mock(async () => ({}));
    const rejected = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit: resultOctokit(
        wrongOwnerSealed,
        rejectedDelete,
        task.taskId,
      ),
      services: services(
        undefined,
        { acceptSignedResult: rejectedService } as any,
      ),
    });
    (rejected as any).branchBeacons.set(BEACON_ID, ID8);
    await (rejected as any).processResultFiles("owner", "repo");
    expect(rejectedService).not.toHaveBeenCalled();
    expect(rejectedDelete).not.toHaveBeenCalled();
  });

  it("bootstraps a missing per-beacon branch from the repository default branch", async () => {
    const beaconKeys = await generateOperatorKeyPair();
    registry.register({
      beaconId: BEACON_ID,
      issueNumber: 0,
      publicKey: await bytesToBase64(beaconKeys.publicKey),
      hostname: "h",
      username: "u",
      os: "linux",
      arch: "x64",
      seq: 0,
    });
    queue.queueTask(BEACON_ID, "ping", {}, "branch");
    const getRef = mock(async ({ ref }: any) => {
      if (ref === `heads/infra-sync-${ID8}`) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (ref === "heads/release") {
        return { data: { object: { sha: "default-head" } } };
      }
      throw new Error(`unexpected ref ${ref}`);
    });
    const createCommit = mock(async (input: any) => {
      expect(input.parents).toEqual(["default-head"]);
      return { data: { sha: "task-commit" } };
    });
    const createRef = mock(async () => ({}));
    const octokit = {
      rest: {
        repos: {
          get: mock(async () => ({ data: { default_branch: "release" } })),
        },
        git: {
          getRef,
          getCommit: mock(async () => ({
            data: { tree: { sha: "default-tree" } },
          })),
          createBlob: mock(async () => ({ data: { sha: "blob" } })),
          createTree: mock(async (input: any) => {
            expect(input.base_tree).toBe("default-tree");
            return { data: { sha: "tree" } };
          }),
          createCommit,
          createRef,
          updateRef: mock(async () => ({})),
        },
      },
    } as any;
    const channel = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
      services: services(),
    });
    (channel as any).branchBeacons.set(BEACON_ID, ID8);

    await (channel as any).deliverPendingTasks(
      "owner",
      "repo",
      new Map([[BEACON_ID, ID8]]),
    );

    expect(createRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: `refs/heads/infra-sync-${ID8}`,
      sha: "task-commit",
    });
  });

  it("retries a branch-create race from the winner's latest tree without forcing the ref", async () => {
    let branchReads = 0;
    const getRef = mock(async ({ ref }: any) => {
      if (ref === `heads/infra-sync-${ID8}`) {
        branchReads += 1;
        if (branchReads === 1) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        return { data: { object: { sha: "winner-head" } } };
      }
      if (ref === "heads/release") {
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
          get: mock(async () => ({ data: { default_branch: "release" } })),
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
    const channel = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
      services: services(),
    });

    await (channel as any).writeFileOnBranch(
      "owner",
      "repo",
      ID8,
      "task.json",
      "{}",
      "update",
    );

    expect(createBlob).toHaveBeenCalledTimes(1);
    expect(createRef).toHaveBeenCalledTimes(1);
    expect(updateRef).toHaveBeenCalledTimes(1);
    expect(((updateRef.mock.calls[0] as any)[0] as any).force).toBe(false);
    expect(
      (createCommit.mock.calls as any).map((call: any) => call[0].parents),
    ).toEqual([["default-head"], ["winner-head"]]);
  });

  it("retries a conflicting result deletion from the latest branch tree", async () => {
    const getRef = mock()
      .mockResolvedValueOnce({ data: { object: { sha: "head-before-race" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "head-after-race" } } });
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
    const channel = new BranchChannel(registry, queue, {
      owner: "owner",
      repo: "repo",
      token: "token",
      operatorSecretKey: operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit,
      services: services(),
    });

    await (channel as any).deleteFileFromBranch(
      "owner",
      "repo",
      ID8,
      "result-task.json",
    );

    expect(updateRef).toHaveBeenCalledTimes(2);
    for (const call of updateRef.mock.calls as any) {
      expect(call[0].force).toBe(false);
    }
    expect(
      (createCommit.mock.calls as any).map((call: any) => call[0].parents),
    ).toEqual([["head-before-race"], ["head-after-race"]]);
  });

  it("durably rejects a malformed immutable ACK file", async () => {
    const fixture = await createSignedChannelFixture(
      "branch-poison",
      BEACON_ID,
    );
    try {
      const ref = `refs/heads/infra-sync-${fixture.id8}`;
      const octokit = {
        rest: {
          git: {
            listMatchingRefs: mock(async () => ({
              data: [{ ref, object: { sha: "branch-head" } }],
            })),
          },
          repos: {
            getContent: mock(async () => ({
              data: {
                type: "file",
                content: encodeText("{"),
                sha: "ack-poison-sha",
              },
            })),
          },
        },
      } as any;
      const channel = new BranchChannel(fixture.registry, fixture.queue, {
        owner: "owner",
        repo: "repo",
        token: "token",
        operatorSecretKey: fixture.operatorKeys.secretKey,
        pollIntervalMs: 60_000,
        octokit,
        services: fixture.services,
      });
      const messageId = `ack:${ref}:ack-poison-sha`;

      await (channel as any).processAckFiles("owner", "repo");
      const rejected = fixture.store.getProcessedMessage(
        "branch",
        messageId,
      );
      expect(rejected).toMatchObject({ outcome: "rejected" });

      await (channel as any).processAckFiles("owner", "repo");
      expect(fixture.store.getProcessedMessage(
        "branch",
        messageId,
      )?.processedAt).toBe(rejected?.processedAt);
    } finally {
      fixture.close();
    }
  });

  it("requires a newly accepted or gap ACK before writing task files", async () => {
    const fixture = await createSignedChannelFixture(
      "branch-replay",
      BEACON_ID,
    );
    try {
      let checkin = await fixture.createCheckin(1);
      let sha = "ack-replay-1";
      let forcedStatus: "stale_duplicate" | null = null;
      const octokit = {
        rest: {
          git: {
            listMatchingRefs: mock(async () => ({
              data: [{ ref: `refs/heads/infra-sync-${fixture.id8}` }],
            })),
          },
          repos: {
            getContent: mock(async () => ({
              data: {
                type: "file",
                content: encodeText(JSON.stringify(checkin)),
                sha,
              },
            })),
          },
        },
      } as any;
      const channelServices = {
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
      const create = () => new BranchChannel(
        fixture.registry,
        fixture.queue,
        {
          owner: "owner",
          repo: "repo",
          token: "token",
          operatorSecretKey: fixture.operatorKeys.secretKey,
          pollIntervalMs: 60_000,
          octokit,
          services: channelServices,
        },
      );

      await (create() as any).processAckFiles("owner", "repo");
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "branch",
      );

      const restarted = create();
      const exactEligible = await (restarted as any).processAckFiles(
        "owner",
        "repo",
      );
      expect(exactEligible.size).toBe(0);
      await (restarted as any).deliverPendingTasks(
        "owner",
        "repo",
        exactEligible,
      );
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      sha = "ack-replay-2";
      const staleEligible = await (restarted as any).processAckFiles(
        "owner",
        "repo",
      );
      expect(staleEligible.size).toBe(0);
      await (restarted as any).deliverPendingTasks(
        "owner",
        "repo",
        staleEligible,
      );
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      checkin = await fixture.createCheckin(2, {
        checkinAt: fixture.timestamp(3),
      });
      sha = "ack-replay-3";
      const acceptedEligible = await (restarted as any).processAckFiles(
        "owner",
        "repo",
      );
      expect([...acceptedEligible]).toEqual([[fixture.beaconId, fixture.id8]]);
      const writeFileOnBranch = mock(async () => {});
      (restarted as any).writeFileOnBranch = writeFileOnBranch;
      await (restarted as any).deliverPendingTasks(
        "owner",
        "repo",
        acceptedEligible,
      );
      expect(writeFileOnBranch).toHaveBeenCalledTimes(1);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      fixture.close();
    }
  });
});

function resultOctokit(
  sealed: string,
  updateRef: ReturnType<typeof mock>,
  taskId: string,
): any {
  return {
    rest: {
      repos: {
        getContent: mock(async () => ({
          data: {
            type: "file",
            content: encodeText(sealed),
            sha: "result-sha",
          },
        })),
      },
      git: {
        getRef: mock(async () => ({
          data: { object: { sha: "branch-head" } },
        })),
        getCommit: mock(async () => ({
          data: { tree: { sha: "tree-head" } },
        })),
        getTree: mock(async () => ({
          data: {
            tree: [{
              path: `result-${taskId.slice(0, 8)}.json`,
              sha: "result-sha",
            }],
          },
        })),
        createTree: mock(async () => ({ data: { sha: "delete-tree" } })),
        createCommit: mock(async () => ({
          data: { sha: "delete-commit" },
        })),
        updateRef,
      },
    },
  };
}
