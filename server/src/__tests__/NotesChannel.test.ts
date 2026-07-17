import { describe, expect, it } from "bun:test";
import type { CheckinPayload, TaskResult } from "@octoc2/shared";
import { NotesChannel } from "../channels/NotesChannel.ts";
import {
  createSignedChannelFixture,
  type SignedChannelFixture,
} from "./helpers/SignedChannelFixture.ts";

const BEACON_ID = "a07e5afe-1234-5678-90ab-cdef12345678";
const POLL_SCOPE = "repo:owner/repo";

class FakeNotesRepository {
  readonly ackPageRequests: number[] = [];
  readonly resultPageRequests: number[] = [];
  readonly createdBlobs: any[] = [];
  readonly updatedRefs: any[] = [];
  readonly createdRefs: any[] = [];
  readonly deletedRefs: string[] = [];
  private readonly blobs = new Map<string, string>();
  private firstAckRef: any | null = null;
  private laterAckRef: any | null = null;
  private resultRef: any | null = null;

  readonly octokit = {
    rest: {
      git: {
        listMatchingRefs: async ({ ref, page }: any) => {
          if (String(ref).includes("svc-a-")) {
            this.ackPageRequests.push(page);
            if (page === 1 && this.firstAckRef) {
              return {
                data: Array.from(
                  { length: 100 },
                  () => this.firstAckRef,
                ),
              };
            }
            if (page === 2 && this.laterAckRef) {
              return { data: [this.laterAckRef] };
            }
            return { data: [] };
          }
          this.resultPageRequests.push(page);
          return {
            data: page === 1 && this.resultRef ? [this.resultRef] : [],
          };
        },
        getBlob: async ({ file_sha }: any) => {
          const content = this.blobs.get(file_sha);
          if (content === undefined) {
            throw new Error(`unknown blob ${file_sha}`);
          }
          return { data: { content, encoding: "utf-8" } };
        },
        createBlob: async (input: any) => {
          this.createdBlobs.push(input);
          return { data: { sha: `task-blob-${this.createdBlobs.length}` } };
        },
        updateRef: async (input: any) => {
          this.updatedRefs.push(input);
          return {};
        },
        createRef: async (input: any) => {
          this.createdRefs.push(input);
          return {};
        },
        deleteRef: async ({ ref }: any) => {
          this.deletedRefs.push(ref);
          if (this.resultRef?.ref.replace("refs/", "") === ref) {
            this.resultRef = null;
          }
          return {};
        },
      },
    },
  } as any;

  putAcks(
    fixture: SignedChannelFixture,
    first: CheckinPayload,
    later: CheckinPayload,
  ): void {
    const ref = `refs/notes/svc-a-${fixture.id8}`;
    this.firstAckRef = { ref, object: { sha: "ack-sha-1" } };
    this.laterAckRef = { ref, object: { sha: "ack-sha-2" } };
    this.blobs.set("ack-sha-1", JSON.stringify(first));
    this.blobs.set("ack-sha-2", JSON.stringify(later));
  }

  putAck(
    fixture: SignedChannelFixture,
    checkin: CheckinPayload,
    sha: string,
  ): void {
    const ref = `refs/notes/svc-a-${fixture.id8}`;
    this.firstAckRef = { ref, object: { sha } };
    this.laterAckRef = null;
    this.blobs.set(sha, JSON.stringify(checkin));
  }

  putMalformedAck(fixture: SignedChannelFixture): void {
    const ref = `refs/notes/svc-a-${fixture.id8}`;
    this.firstAckRef = { ref, object: { sha: "ack-poison-sha" } };
    this.blobs.set("ack-poison-sha", "{");
  }

  putResult(
    fixture: SignedChannelFixture,
    result: TaskResult,
    sealed: string,
  ): void {
    const ref = `refs/notes/svc-r-${fixture.id8}-${
      result.taskId.slice(0, 8)
    }`;
    this.resultRef = { ref, object: { sha: "result-sha" } };
    this.blobs.set("result-sha", sealed);
  }

  get result(): any {
    return this.resultRef;
  }
}

describe("NotesChannel signed durable integration", () => {
  it("advances through a later-page signed ACK, updates a task ref, and consumes a signed result once", async () => {
    const fixture = await createSignedChannelFixture("notes", BEACON_ID);
    try {
      const github = new FakeNotesRepository();
      const firstCheckin = await fixture.createCheckin(1, {
        hostname: "notes-page-one",
      });
      const laterCheckin = await fixture.createCheckin(2, {
        hostname: "notes-page-two",
      });
      github.putAcks(fixture, firstCheckin, laterCheckin);
      const channel = createChannel(fixture, github);
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "shell",
        { cmd: "hostname" },
        "notes",
      );

      await (channel as any).poll();

      expect(github.ackPageRequests).toContain(2);
      expect(fixture.registry.get(fixture.beaconId)).toMatchObject({
        hostname: "notes-page-two",
        lastSeq: 2,
        activeTentacle: 11,
      });
      expect(
        fixture.store.getProcessedMessage(
          "notes-ack-poll",
          `ack:refs/notes/svc-a-${fixture.id8}:ack-sha-2`,
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("notes-ack-poll", POLL_SCOPE)?.cursor,
      ).toBe("ack-sha-2");
      expect(github.createdBlobs).toHaveLength(1);
      expect(github.updatedRefs).toEqual([
        {
          owner: "owner",
          repo: "repo",
          ref: `notes/svc-t-${fixture.id8}`,
          sha: "task-blob-1",
          force: true,
        },
      ]);
      expect(github.createdRefs).toHaveLength(0);
      expect(await fixture.decryptTasks(github.createdBlobs[0].content))
        .toEqual([
          {
            taskId: task.taskId,
            kind: "shell",
            args: { cmd: "hostname" },
            ref: task.ref,
          },
        ]);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");

      const result = await fixture.createResult(task.taskId, 3, {
        output: "notes-page-two",
      });
      github.putResult(
        fixture,
        result,
        await fixture.sealResult(result),
      );
      const resultRef = github.result.ref;

      await (channel as any).poll();

      expect(fixture.queue.getTask(task.taskId)?.state).toBe("completed");
      expect(fixture.store.getTaskResult(task.taskId)?.canonicalResult)
        .toContain("notes-page-two");
      expect(github.deletedRefs).toEqual([
        resultRef.replace("refs/", ""),
      ]);
      expect(
        fixture.store.getProcessedMessage(
          "notes-result-poll",
          `result:${resultRef}:result-sha`,
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("notes-result-poll", POLL_SCOPE)?.cursor,
      ).toBe("result-sha");

      await (createChannel(fixture, github) as any).poll();

      expect(github.deletedRefs).toEqual([
        resultRef.replace("refs/", ""),
      ]);
      expect(github.createdBlobs).toHaveLength(1);
      expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);
      expect(fixture.registry.get(fixture.beaconId)?.lastSeq).toBe(3);
    } finally {
      fixture.close();
    }
  });

  it("durably rejects a malformed immutable ACK blob", async () => {
    const fixture = await createSignedChannelFixture(
      "notes-poison",
      BEACON_ID,
    );
    try {
      const github = new FakeNotesRepository();
      github.putMalformedAck(fixture);
      const channel = createChannel(fixture, github);
      const messageId =
        `ack:refs/notes/svc-a-${fixture.id8}:ack-poison-sha`;

      await (channel as any).poll();
      const rejected = fixture.store.getProcessedMessage(
        "notes-ack-poll",
        messageId,
      );
      expect(rejected).toMatchObject({ outcome: "rejected" });

      await (channel as any).poll();
      expect(fixture.store.getProcessedMessage(
        "notes-ack-poll",
        messageId,
      )?.processedAt).toBe(rejected?.processedAt);
    } finally {
      fixture.close();
    }
  });

  it("requires a newly accepted or gap ACK before updating the task ref", async () => {
    const fixture = await createSignedChannelFixture("notes-replay", BEACON_ID);
    try {
      const github = new FakeNotesRepository();
      const checkin = await fixture.createCheckin(1);
      github.putAck(fixture, checkin, "ack-replay-1");
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

      await (createChannel(fixture, github, services) as any).poll();
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "notes",
      );

      const restarted = createChannel(fixture, github, services);
      await (restarted as any).poll();
      expect(github.createdBlobs).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      github.putAck(fixture, checkin, "ack-replay-2");
      await (restarted as any).poll();
      expect(github.createdBlobs).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      github.putAck(
        fixture,
        await fixture.createCheckin(2, {
          checkinAt: fixture.timestamp(3),
        }),
        "ack-replay-3",
      );
      await (restarted as any).poll();
      expect(github.createdBlobs).toHaveLength(1);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      fixture.close();
    }
  });
});

function createChannel(
  fixture: SignedChannelFixture,
  github: FakeNotesRepository,
  services: any = fixture.services,
): NotesChannel {
  return new NotesChannel(
    fixture.registry,
    fixture.queue,
    {
      owner: "owner",
      repo: "repo",
      token: "local-test-token",
      operatorSecretKey: fixture.operatorKeys.secretKey,
      pollIntervalMs: 60_000,
      octokit: github.octokit,
    },
    services,
  );
}
