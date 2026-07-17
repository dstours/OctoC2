import {
  afterEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurablePollState,
  PollRunner,
} from "../lib/PollRunner.ts";
import { OctoStore } from "../store/index.ts";

const stores: Array<{ store: OctoStore; dataDir: string }> = [];

afterEach(() => {
  for (const fixture of stores.splice(0)) {
    fixture.store.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

function openStore(): OctoStore {
  const dataDir = mkdtempSync(join(tmpdir(), "octoc2-poll-"));
  const store = OctoStore.open({ dataDir, importLegacyRegistry: false });
  stores.push({ store, dataDir });
  return store;
}

function reopenStore(store: OctoStore): OctoStore {
  const fixture = stores.find((candidate) => candidate.store === store);
  if (!fixture) throw new Error("poll store fixture was not registered");
  store.close();
  const reopened = OctoStore.open({
    dataDir: fixture.dataDir,
    importLegacyRegistry: false,
  });
  fixture.store = reopened;
  return reopened;
}

describe("PollRunner", () => {
  it("joins concurrent triggers instead of overlapping polls", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new PollRunner({
      name: "test",
      intervalMs: 60_000,
      poll: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await blocked;
        active -= 1;
      },
    });

    const first = runner.runOnce();
    const second = runner.runOnce();
    await Bun.sleep(5);
    expect(maximumActive).toBe(1);
    release();

    expect(await first).toBe("started");
    expect(await second).toBe("joined");
    expect(maximumActive).toBe(1);
  });

  it("continues scheduling after an observed poll failure", async () => {
    let calls = 0;
    let errors = 0;
    const runner = new PollRunner({
      name: "retry",
      intervalMs: 10,
      poll: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
      onError: () => {
        errors += 1;
      },
    });
    runner.start();
    await Bun.sleep(35);
    await runner.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(errors).toBe(1);
  });

  it("drains an in-flight poll and never schedules another after stop", async () => {
    let calls = 0;
    let release!: () => void;
    const runner = new PollRunner({
      name: "drain",
      intervalMs: 10,
      poll: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    runner.start();
    const activeRun = runner.runOnce();
    await Bun.sleep(0);
    expect(calls).toBe(1);

    let stopped = false;
    const draining = runner.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    release();
    await Promise.all([activeRun, draining]);
    await Bun.sleep(20);
    expect(stopped).toBe(true);
    expect(calls).toBe(1);
    expect(runner.isRunning).toBe(false);
  });
});

describe("DurablePollState", () => {
  it("commits the message and cursor only after successful processing", async () => {
    const store = openStore();
    const state = new DurablePollState(
      store,
      "issues",
      "repo:owner/repo",
      5_000,
    );
    const artifact = {
      messageId: "comment:42",
      payload: "payload",
      cursor: "2026-07-16T12:00:00.000Z",
    };

    await expect(state.process(artifact, async () => {
      throw new Error("transient");
    })).rejects.toThrow("transient");
    expect(state.cursor).toBeUndefined();
    expect(store.getProcessedMessage("issues", "comment:42")).toBeUndefined();

    await expect(state.process(artifact, async () => {})).resolves.toEqual({
      status: "processed",
    });
    expect(state.cursor).toBe(artifact.cursor);
    expect(state.timestampSince("fallback")).toBe(
      "2026-07-16T11:59:55.000Z",
    );
  });

  it("retries transient processing after a real SQLite close and reopen", async () => {
    const channel = "issues";
    const scope = "repo:owner/restart";
    const earlierArtifact = {
      messageId: "comment:41",
      payload: "earlier",
      cursor: "2026-07-16T12:00:00.000Z",
    };
    const retryArtifact = {
      messageId: "comment:42",
      payload: "retry-me",
      cursor: "2026-07-16T12:00:10.000Z",
    };

    const initialStore = openStore();
    const initialState = new DurablePollState(
      initialStore,
      channel,
      scope,
      5_000,
    );
    await expect(
      initialState.process(earlierArtifact, async () => {}),
    ).resolves.toEqual({ status: "processed" });
    expect(initialState.cursor).toBe(earlierArtifact.cursor);

    let failedAttempts = 0;
    await expect(initialState.process(retryArtifact, async () => {
      failedAttempts += 1;
      throw new Error("transient");
    })).rejects.toThrow("transient");
    expect(failedAttempts).toBe(1);
    expect(initialState.cursor).toBe(earlierArtifact.cursor);
    expect(
      initialStore.getProcessedMessage(channel, retryArtifact.messageId),
    ).toBeUndefined();

    const reopenedStore = reopenStore(initialStore);
    const reopenedState = new DurablePollState(
      reopenedStore,
      channel,
      scope,
      5_000,
    );
    expect(reopenedState.cursor).toBe(earlierArtifact.cursor);
    expect(
      reopenedStore.getProcessedMessage(channel, retryArtifact.messageId),
    ).toBeUndefined();

    let successfulCommits = 0;
    await expect(reopenedState.process(retryArtifact, async () => {
      successfulCommits += 1;
    })).resolves.toEqual({ status: "processed" });
    await expect(reopenedState.process(retryArtifact, async () => {
      successfulCommits += 1;
    })).resolves.toEqual({ status: "exact_duplicate" });

    expect(successfulCommits).toBe(1);
    expect(reopenedState.cursor).toBe(retryArtifact.cursor);
    const committed = reopenedStore.getProcessedMessage(
      channel,
      retryArtifact.messageId,
    );
    expect(committed?.payloadDigest).toHaveLength(64);
  });

  it("deduplicates exact artifacts and rejects ID reuse with new content", async () => {
    const store = openStore();
    const state = new DurablePollState(store, "gist", "account:test");
    let calls = 0;

    expect(await state.process({
      messageId: "gist:1",
      payload: "one",
      cursor: "2026-07-16T12:00:00.000Z",
    }, async () => {
      calls += 1;
    })).toEqual({ status: "processed" });
    expect(await state.process({
      messageId: "gist:1",
      payload: "one",
      cursor: "2026-07-16T12:00:01.000Z",
    }, async () => {
      calls += 1;
    })).toEqual({ status: "exact_duplicate" });
    expect(await state.process({
      messageId: "gist:1",
      payload: "two",
      cursor: "2026-07-16T12:00:02.000Z",
    }, async () => {
      calls += 1;
    })).toEqual({ status: "conflicting_duplicate" });
    expect(calls).toBe(1);
  });
});
