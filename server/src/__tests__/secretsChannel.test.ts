import { describe, expect, it } from "bun:test";
import type { CheckinPayload, TaskResult } from "@octoc2/shared";
import { SecretsChannel } from "../channels/SecretsChannel.ts";
import { sha256Hex } from "../store/index.ts";
import {
  createSignedChannelFixture,
  type SignedChannelFixture,
} from "./helpers/SignedChannelFixture.ts";

const BEACON_ID = "5ec2e750-1234-5678-90ab-cdef12345678";
const POLL_SCOPE = "repo:owner/repo";

class FakeSecretsRepository {
  readonly pageRequests: number[] = [];
  readonly taskVariables: any[] = [];
  readonly deletedVariables: string[] = [];
  private ackVariable: any | null = null;
  private resultVariable: any | null = null;

  readonly octokit = {
    rest: {
      actions: {
        listRepoVariables: async ({ page }: any) => {
          this.pageRequests.push(page);
          if (page === 1) {
            return {
              data: {
                variables: Array.from({ length: 100 }, (_, index) => ({
                  name: `IGNORED_SECRET_${index}`,
                  value: "ignored",
                })),
              },
            };
          }
          if (page === 2) {
            return {
              data: {
                variables: [
                  ...(this.ackVariable ? [this.ackVariable] : []),
                  ...(this.resultVariable ? [this.resultVariable] : []),
                ],
              },
            };
          }
          return { data: { variables: [] } };
        },
        updateRepoVariable: async (input: any) => {
          this.taskVariables.push(input);
          return {};
        },
        createRepoVariable: async (input: any) => {
          this.taskVariables.push(input);
          return {};
        },
        deleteRepoVariable: async ({ name }: any) => {
          this.deletedVariables.push(name);
          if (this.resultVariable?.name === name) {
            this.resultVariable = null;
          }
          return {};
        },
      },
    },
  } as any;

  putAck(fixture: SignedChannelFixture, checkin: CheckinPayload): void {
    this.ackVariable = {
      name: `INFRA_CFG_${fixture.id8.toUpperCase()}`,
      value: Buffer.from(JSON.stringify(checkin), "utf8").toString("base64"),
      updated_at: checkin.checkinAt,
    };
  }

  touchAck(updatedAt: string): void {
    if (!this.ackVariable) throw new Error("ACK variable is unavailable");
    this.ackVariable = { ...this.ackVariable, updated_at: updatedAt };
  }

  putMalformedAck(
    fixture: SignedChannelFixture,
    updatedAt: string,
  ): void {
    this.ackVariable = {
      name: `INFRA_CFG_${fixture.id8.toUpperCase()}`,
      value: Buffer.from("{", "utf8").toString("base64"),
      updated_at: updatedAt,
    };
  }

  putResult(
    result: TaskResult,
    sealed: string,
  ): void {
    this.resultVariable = {
      name: `INFRA_LOG_${result.taskId.slice(0, 8).toUpperCase()}`,
      value: sealed,
      updated_at: result.completedAt,
    };
  }

  get ack(): any {
    return this.ackVariable;
  }

  get result(): any {
    return this.resultVariable;
  }
}

describe("SecretsChannel signed durable integration", () => {
  it("registers a later-page base64 ACK, delivers encrypted state, and consumes a signed result once", async () => {
    const fixture = await createSignedChannelFixture("secrets", BEACON_ID);
    try {
      const github = new FakeSecretsRepository();
      const checkin = await fixture.createCheckin(1);
      github.putAck(fixture, checkin);
      const channel = createChannel(fixture, github);
      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "secrets",
      );

      await (channel as any).poll();

      expect(github.pageRequests).toContain(2);
      expect(fixture.registry.get(fixture.beaconId)).toMatchObject({
        hostname: "secrets-host",
        lastSeq: 1,
        activeTentacle: "7b",
      });
      expect(
        fixture.store.getProcessedMessage(
          "secrets-ack-poll",
          `ack:${github.ack.name}:${checkin.checkinAt}:` +
            sha256Hex(github.ack.value),
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("secrets-ack-poll", POLL_SCOPE)?.cursor,
      ).toBe(checkin.checkinAt);
      expect(github.taskVariables).toHaveLength(1);
      expect(github.taskVariables[0].name).toBe(
        `INFRA_STATE_${fixture.id8.toUpperCase()}`,
      );
      expect(await fixture.decryptTasks(github.taskVariables[0].value))
        .toEqual([
          {
            taskId: task.taskId,
            kind: "ping",
            args: {},
            ref: task.ref,
          },
        ]);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");

      const result = await fixture.createResult(task.taskId, 2, {
        output: "pong",
      });
      github.putResult(result, await fixture.sealResult(result));
      const resultVariableName = github.result.name;

      await (channel as any).poll();

      expect(fixture.queue.getTask(task.taskId)?.state).toBe("completed");
      expect(fixture.store.getTaskResult(task.taskId)?.canonicalResult)
        .toContain("pong");
      expect(github.deletedVariables).toEqual([resultVariableName]);
      expect(
        fixture.store.getProcessedMessage(
          "secrets-result-poll",
          `result:${resultVariableName}:${result.completedAt}`,
        ),
      ).toBeDefined();
      expect(
        fixture.store.getPollCursor("secrets-result-poll", POLL_SCOPE)?.cursor,
      ).toBe(result.completedAt);

      await (createChannel(fixture, github) as any).poll();

      expect(github.deletedVariables).toEqual([resultVariableName]);
      expect(github.taskVariables).toHaveLength(1);
      expect(fixture.store.listDeliveryAttempts(task.taskId)).toHaveLength(1);
      expect(fixture.registry.get(fixture.beaconId)?.lastSeq).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("durably rejects a malformed ACK variable instead of reparsing it forever", async () => {
    const fixture = await createSignedChannelFixture(
      "secrets-poison",
      BEACON_ID,
    );
    try {
      const github = new FakeSecretsRepository();
      const updatedAt = fixture.timestamp(1);
      github.putMalformedAck(fixture, updatedAt);
      const channel = createChannel(fixture, github);
      const messageId =
        `ack:INFRA_CFG_${fixture.id8.toUpperCase()}:${updatedAt}:` +
        sha256Hex(github.ack.value);

      await (channel as any).poll();
      const rejected = fixture.store.getProcessedMessage(
        "secrets-ack-poll",
        messageId,
      );
      expect(rejected).toMatchObject({ outcome: "rejected" });

      await (channel as any).poll();
      expect(fixture.store.getProcessedMessage(
        "secrets-ack-poll",
        messageId,
      )?.processedAt).toBe(rejected?.processedAt);
    } finally {
      fixture.close();
    }
  });

  it("requires a newly accepted or gap ACK before delivering secret state", async () => {
    const fixture = await createSignedChannelFixture(
      "secrets-replay",
      BEACON_ID,
    );
    try {
      const github = new FakeSecretsRepository();
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
        "secrets",
      );

      const restarted = createChannel(fixture, github, services);
      await (restarted as any).poll();
      expect(github.taskVariables).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = "stale_duplicate";
      github.touchAck(fixture.timestamp(2));
      await (restarted as any).poll();
      expect(github.taskVariables).toHaveLength(0);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("pending");

      forcedStatus = null;
      github.putAck(fixture, await fixture.createCheckin(2, {
        checkinAt: fixture.timestamp(3),
      }));
      await (restarted as any).poll();
      expect(github.taskVariables).toHaveLength(1);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
    } finally {
      fixture.close();
    }
  });

  it("distinguishes two signed ACK payloads with the same GitHub update timestamp", async () => {
    const fixture = await createSignedChannelFixture(
      "secrets-same-tick",
      BEACON_ID,
    );
    try {
      const github = new FakeSecretsRepository();
      const updatedAt = fixture.timestamp(1);
      const first = await fixture.createCheckin(1, {
        checkinAt: updatedAt,
      });
      github.putAck(fixture, first);
      const firstEncoded = github.ack.value;
      const channel = createChannel(fixture, github);
      await (channel as any).poll();

      const task = fixture.queue.queueTask(
        fixture.beaconId,
        "ping",
        {},
        "secrets",
      );
      const second = await fixture.createCheckin(2, {
        checkinAt: updatedAt,
      });
      github.putAck(fixture, second);
      const secondEncoded = github.ack.value;
      await (channel as any).poll();

      expect(fixture.registry.get(fixture.beaconId)?.lastSeq).toBe(2);
      expect(fixture.queue.getTask(task.taskId)?.state).toBe("delivered");
      expect(github.taskVariables).toHaveLength(1);
      expect(fixture.store.getProcessedMessage(
        "secrets-ack-poll",
        `ack:${github.ack.name}:${updatedAt}:${sha256Hex(firstEncoded)}`,
      )).toBeDefined();
      expect(fixture.store.getProcessedMessage(
        "secrets-ack-poll",
        `ack:${github.ack.name}:${updatedAt}:${sha256Hex(secondEncoded)}`,
      )).toBeDefined();
    } finally {
      fixture.close();
    }
  });
});

function createChannel(
  fixture: SignedChannelFixture,
  github: FakeSecretsRepository,
  services: any = fixture.services,
): SecretsChannel {
  return new SecretsChannel(
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
