import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processIncomingArtifact,
} from "../channels/ChannelRuntime.ts";
import { DurablePollState } from "../lib/PollRunner.ts";
import { OctoStore } from "../store/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function setup(channel: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "octoc2-artifact-"));
  temporaryDirectories.push(dataDir);
  const store = OctoStore.open({ dataDir, importLegacyRegistry: false });
  return {
    store,
    state: new DurablePollState(store, channel, "repo:owner/repo"),
    services: {
      store,
      identities: {} as any,
      tasks: {} as any,
    },
  };
}

describe("channel artifact durability classification", () => {
  it("commits a malformed immutable artifact once as rejected", async () => {
    const context = setup("poison-channel");
    let decodeCalls = 0;
    const artifact = {
      messageId: "artifact:sha-1",
      payload: "{",
      cursor: "sha-1",
    };

    try {
      const first = await processIncomingArtifact(
        context.services,
        context.state,
        artifact,
        "malformed test artifact",
        () => {
          decodeCalls += 1;
          return JSON.parse("{");
        },
        async () => {
          throw new Error("accept must not run");
        },
      );
      const duplicate = await processIncomingArtifact(
        context.services,
        context.state,
        artifact,
        "malformed test artifact",
        () => {
          decodeCalls += 1;
          return JSON.parse("{");
        },
        async () => {
          throw new Error("accept must not run");
        },
      );

      expect(first).toMatchObject({
        status: "processed",
        outcome: "rejected",
      });
      expect(duplicate).toMatchObject({
        status: "exact_duplicate",
        outcome: "rejected",
      });
      expect(decodeCalls).toBe(1);
      expect(context.store.getProcessedMessage(
        "poison-channel",
        artifact.messageId,
      )).toMatchObject({ outcome: "rejected" });
    } finally {
      context.store.close();
    }
  });

  it("leaves operational and SQLite failures uncommitted for retry", async () => {
    const context = setup("retry-channel");
    const artifact = {
      messageId: "artifact:sha-2",
      payload: "valid",
      cursor: "sha-2",
    };
    let failOperationally = true;

    try {
      await expect(processIncomingArtifact(
        context.services,
        context.state,
        artifact,
        "valid test artifact",
        () => ({ value: "ok" }),
        async () => {
          if (failOperationally) throw new Error("GitHub unavailable");
          return { outcome: "accepted" };
        },
      )).rejects.toThrow("GitHub unavailable");
      expect(context.store.getProcessedMessage(
        "retry-channel",
        artifact.messageId,
      )).toBeUndefined();

      failOperationally = false;
      const sabotage = new Database(context.store.databasePath);
      sabotage.exec(`
        CREATE TRIGGER fail_channel_progress
        BEFORE INSERT ON processed_channel_messages
        BEGIN
          SELECT RAISE(ABORT, 'simulated progress write failure');
        END;
      `);
      await expect(processIncomingArtifact(
        context.services,
        context.state,
        artifact,
        "valid test artifact",
        () => ({ value: "ok" }),
        async () => ({ outcome: "accepted" }),
      )).rejects.toThrow("simulated progress write failure");
      expect(context.store.getProcessedMessage(
        "retry-channel",
        artifact.messageId,
      )).toBeUndefined();
      sabotage.exec("DROP TRIGGER fail_channel_progress");
      sabotage.close();

      await expect(processIncomingArtifact(
        context.services,
        context.state,
        artifact,
        "valid test artifact",
        () => ({ value: "ok" }),
        async () => ({ outcome: "accepted" }),
      )).resolves.toMatchObject({
        status: "processed",
        outcome: "accepted",
      });
    } finally {
      context.store.close();
    }
  });
});
