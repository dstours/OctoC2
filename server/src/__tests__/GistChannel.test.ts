import { describe, expect, it } from "bun:test";
import type { CheckinPayload, TaskResult } from "@octoc2/shared";
import { GistChannel } from "../channels/GistChannel.ts";
import { sha256Hex } from "../store/index.ts";
import {
  createSignedChannelFixture,
  type SignedChannelFixture,
} from "./helpers/SignedChannelFixture.ts";

const BEACON_ID = "6157cafe-1234-5678-90ab-cdef12345678";
const POLL_SCOPE = "repo:owner/repo";

class FakeGistRepository {
  readonly pageRequests: number[] = [];
  readonly createdGists: any[] = [];
  readonly deletedGists: string[] = [];
  private readonly contents = new Map<string, Record<string, string>>();
  private ackGist: any | null = null;
  private resultGist: any | null = null;

  readonly octokit = {
    rest: {
      gists: {
        list: async ({ page }: any) => {
          this.pageRequests.push(page);
          if (page === 1) {
            return {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: `unrelated-${index}`,
                files: { [`unrelated-${index}.txt`]: {} },
              })),
            };
          }
          if (page === 2) {
            return {
              data: [
                ...(this.ackGist ? [this.ackGist] : []),
                ...(this.resultGist ? [this.resultGist] : []),
              ],
            };
          }
          return { data: [] };
        },
        get: async ({ gist_id }: any) => {
          const files = this.contents.get(gist_id);
          if (!files) throw new Error(`unknown gist ${gist_id}`);
          return {
            data: {
              id: gist_id,
              files: Object.fromEntries(
                Object.entries(files).map(([name, content]) => [
                  name,
                  { filename: name, content },
                ]),
              ),
            },
          };
        },
        create: async (input: any) => {
          this.createdGists.push(input);
          return { data: { id: `created-${this.createdGists.length}` } };
        },
        delete: async ({ gist_id }: any) => {
          this.deletedGists.push(gist_id);
          if (this.resultGist?.id === gist_id) {
            this.resultGist = null;
          }
          this.contents.delete(gist_id);
          return {};
        },
      },
    },
  } as any;

  putAck(fixture: SignedChannelFixture, checkin: CheckinPayload): void {
    const filename = `svc-a-${fixture.id8}.json`;
    const id = "ack-page-two";
    this.contents.set(id, { [filename]: JSON.stringify(checkin) });
    this.ackGist = {
      id,
      files: { [filename]: { filename } },
      updated_at: checkin.checkinAt,
    };
  }

  touchAck(updatedAt: string): void {
    if (!this.ackGist) throw new Error("ACK gist is unavailable");
    this.ackGist = { ...this.ackGist, updated_at: updatedAt };
  }

  putMalformedAck(
    fixture: SignedChannelFixture,
    updatedAt: string,
  ): void {
    const filename = `svc-a-${fixture.id8}.json`;
    const id = "ack-page-two";
    this.contents.set(id, { [filename]: "{" });
    this.ackGist = {
      id,
      files: { [filename]: { filename } },
      updated_at: updatedAt,
    };
  }

  putResult(
    fixture: SignedChannelFixture,
    result: TaskResult,
    sealed: string,
  ): void {
    const filename = `svc-r-${fixture.id8}.json`;
    const id = "result-page-two";
    this.contents.set(id, { [filename]: sealed });
    this.resultGist = {
      id,
      files: { [filename]: { filename } },
      updated_at: result.completedAt,
    };
  }
}

describe("GistChannel signed durable integration", () => {
  it("registers a later-page ACK, creates a private encrypted task gist, and consumes a signed result once", async () => {
    const fixture = await createSignedChannelFixture("gist", BEACON_ID);
    try {
      const github = new FakeGistRepository();
      const checkin = await fixture.createCheckin(1);
      github.putAck(fixture, checkin);
      const channel = createChannel(fixture, github);
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "exec",
        { cmd: "/usr/bin/id", args: ["-u"] },
        "gist",
      );

      await (channel as any).poll();

      expect(github.pageRequests).toContain(2);
      expect(fixture.registry.get(fixture.beaconId)).toMatchObject({
        hostname: "gist-host",
        lastSeq: 1,
        activeTentacle: 6,
      });
      expect(
        fixture.store.getProcessedMessage(
          "gist-ack-poll",
          `ack:ack-page-two:${checkin.checkinAt}:` +
            sha256Hex(JSON.stringify(checkin)),
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("gist-ack-poll", POLL_SCOPE)?.cursor,
      ).toBe(checkin.checkinAt);
      expect(github.createdGists).toHaveLength(1);
      expect(github.createdGists[0].public).toBe(false);
      const taskFilename = `svc-t-${fixture.id8}.json`;
      expect(Object.keys(github.createdGists[0].files)).toEqual([taskFilename]);
      expect(
        await fixture.decryptTasks(
          github.createdGists[0].files[taskFilename].content,
        ),
      ).toEqual([
          {
            taskId: task.taskId,
            kind: "exec",
            args: { cmd: "/usr/bin/id", args: ["-u"] },
          ref: task.ref,
        },
      ]);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");

      const result = await fixture.createResult(task.taskId, 2, {
        output: "1000",
      });
      github.putResult(
        fixture,
        result,
        await fixture.sealResult(result),
      );

      await (channel as any).poll();

      expect(fixture.queue.getTask(task.taskId)?.state).toBe("completed");
      expect(fixture.store.getTaskResult(task.taskId)?.canonicalResult)
        .toContain("1000");
      expect(github.deletedGists).toEqual(["result-page-two"]);
      expect(
        fixture.store.getProcessedMessage(
          "gist-result-poll",
          `result:result-page-two:${result.completedAt}`,
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("gist-result-poll", POLL_SCOPE)?.cursor,
      ).toBe(result.completedAt);

      await (createChannel(fixture, github) as any).poll();

      expect(github.deletedGists).toEqual(["result-page-two"]);
      expect(github.createdGists).toHaveLength(1);
      expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);
      expect(fixture.registry.get(fixture.beaconId)?.lastSeq).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("rejects one malformed gist revision without poisoning a later valid edit", async () => {
    const fixture = await createSignedChannelFixture(
      "gist-poison",
      BEACON_ID,
    );
    try {
      const github = new FakeGistRepository();
      const malformedAt = fixture.timestamp(1);
      github.putMalformedAck(fixture, malformedAt);
      const channel = createChannel(fixture, github);

      await (channel as any).poll();
      expect(fixture.store.getProcessedMessage(
        "gist-ack-poll",
        `ack:ack-page-two:${malformedAt}:${sha256Hex("{")}`,
      )).toMatchObject({ outcome: "rejected" });

      const checkin = await fixture.createCheckin(1, {
        checkinAt: fixture.timestamp(2),
      });
      github.putAck(fixture, checkin);
      await (channel as any).poll();

      expect(fixture.store.getProcessedMessage(
        "gist-ack-poll",
        `ack:ack-page-two:${checkin.checkinAt}:` +
          sha256Hex(JSON.stringify(checkin)),
      )).toMatchObject({ outcome: "accepted" });
      expect(fixture.registry.get(fixture.beaconId)?.activeTentacle).toBe(6);
    } finally {
      fixture.close();
    }
  });

  it("requires a newly accepted or gap ACK before creating task gists", async () => {
    const fixture = await createSignedChannelFixture("gist-replay", BEACON_ID);
    try {
      const github = new FakeGistRepository();
      const checkin = await fixture.createCheckin(1);
      github.putAck(fixture, checkin);
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
        "gist",
      );

      const restarted = createChannel(fixture, github, services);
      await (restarted as any).poll();
      expect(github.createdGists).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      github.touchAck(fixture.timestamp(2));
      await (restarted as any).poll();
      expect(github.createdGists).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      github.putAck(fixture, await fixture.createCheckin(2, {
        checkinAt: fixture.timestamp(3),
      }));
      await (restarted as any).poll();
      expect(github.createdGists).toHaveLength(1);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      fixture.close();
    }
  });

  it("distinguishes two ACK gist revisions with the same GitHub update timestamp", async () => {
    const fixture = await createSignedChannelFixture(
      "gist-same-tick",
      BEACON_ID,
    );
    try {
      const github = new FakeGistRepository();
      const updatedAt = fixture.timestamp(1);
      const first = await fixture.createCheckin(1, {
        checkinAt: updatedAt,
      });
      github.putAck(fixture, first);
      const channel = createChannel(fixture, github);
      await (channel as any).poll();

      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "gist",
      );
      const second = await fixture.createCheckin(2, {
        checkinAt: updatedAt,
      });
      github.putAck(fixture, second);
      await (channel as any).poll();

      expect(fixture.registry.get(fixture.beaconId)?.lastSeq).toBe(2);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
      expect(github.createdGists).toHaveLength(1);
      expect(fixture.store.getProcessedMessage(
        "gist-ack-poll",
        `ack:ack-page-two:${updatedAt}:` +
          sha256Hex(JSON.stringify(first)),
      )).toBeDefined();
      expect(fixture.store.getProcessedMessage(
        "gist-ack-poll",
        `ack:ack-page-two:${updatedAt}:` +
          sha256Hex(JSON.stringify(second)),
      )).toBeDefined();
    } finally {
      fixture.close();
    }
  });
});

function createChannel(
  fixture: SignedChannelFixture,
  github: FakeGistRepository,
  services: any = fixture.services,
): GistChannel {
  return new GistChannel(
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
