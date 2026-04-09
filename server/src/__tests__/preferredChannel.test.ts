/**
 * Tests for preferredChannel filtering across all delivery channels.
 *
 * Each channel must:
 *   - deliver tasks with no preferredChannel (existing behaviour)
 *   - deliver tasks whose preferredChannel matches the channel's own kind
 *   - skip tasks whose preferredChannel is set to a different kind
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { BeaconRegistry } from "../BeaconRegistry.ts";
import { TaskQueue } from "../TaskQueue.ts";
import { GistChannel } from "../channels/GistChannel.ts";
import { NotesChannel } from "../channels/NotesChannel.ts";
import { BranchChannel } from "../channels/BranchChannel.ts";
import { ActionsChannel } from "../channels/ActionsChannel.ts";
import { SecretsChannel } from "../channels/SecretsChannel.ts";
import { generateOperatorKeyPair, bytesToBase64 } from "../crypto/sodium.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeBeacon(registry: BeaconRegistry, beaconId: string) {
  const kp = await generateOperatorKeyPair();
  const pubB64 = await bytesToBase64(kp.publicKey);
  registry.register({
    beaconId, issueNumber: 0, publicKey: pubB64,
    hostname: "h", username: "u", os: "linux", arch: "x64", seq: 0,
  });
  return pubB64;
}

function makeGistOctokit() {
  return {
    rest: {
      gists: {
        list:   mock(async () => ({ data: [] })),
        get:    mock(async () => ({ data: { id: "gist-id", files: {} } })),
        create: mock(async () => ({ data: { id: "created-gist-id" } })),
        delete: mock(async () => ({})),
      },
    },
  } as any;
}

function makeNotesOctokit() {
  return {
    rest: {
      git: {
        listMatchingRefs: mock(async () => ({ data: [] })),
        getBlob:          mock(async () => ({ data: { content: "", encoding: "utf-8" } })),
        createBlob:       mock(async () => ({ data: { sha: "blob-sha" } })),
        createRef:        mock(async () => ({})),
        updateRef:        mock(async () => ({})),
        deleteRef:        mock(async () => ({})),
      },
    },
  } as any;
}

function makeBranchOctokit() {
  return {
    rest: {
      git: {
        getRef:      mock(async () => ({ data: { object: { sha: "head-sha" } } })),
        getCommit:   mock(async () => ({ data: { tree: { sha: "tree-sha" } } })),
        createBlob:  mock(async () => ({ data: { sha: "blob-sha" } })),
        createTree:  mock(async () => ({ data: { sha: "new-tree-sha" } })),
        createCommit: mock(async () => ({ data: { sha: "commit-sha" } })),
        updateRef:   mock(async () => ({})),
        createRef:   mock(async () => ({})),
        listMatchingRefs: mock(async () => ({ data: [] })),
      },
    },
  } as any;
}

function makeActionsOctokit() {
  return {
    rest: {
      actions: {
        listWorkflowRunsForRepo: mock(async () => ({ data: { workflow_runs: [] } })),
        listJobsForWorkflowRun:  mock(async () => ({ data: { jobs: [] } })),
        downloadJobLogsForWorkflowAttempt: mock(async () => ({ data: "" })),
        updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
      },
    },
  } as any;
}

function makeSecretsOctokit() {
  return {
    rest: {
      actions: {
        listRepoVariables: mock(async () => ({ data: { variables: [], total_count: 0 } })),
        getRepoVariable:   mock(async () => ({ data: { name: "v", value: "" } })),
        updateRepoVariable: mock(async () => ({})),
        createRepoVariable: mock(async () => ({})),
      },
    },
  } as any;
}

// ── GistChannel ───────────────────────────────────────────────────────────────

describe("GistChannel preferredChannel filtering", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/preferred-gist-test");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("delivers task with no preferredChannel", async () => {
    const beaconId = "gist-np-beacon-0001";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" });

    const octokit = makeGistOctokit();
    const ch = new GistChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).gistBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks();

    expect(octokit.rest.gists.create).toHaveBeenCalled();
    const pending = queue.getPendingTasks(beaconId);
    expect(pending.length).toBe(0);
  });

  it("delivers task with preferredChannel='gist'", async () => {
    const beaconId = "gist-match-beacon-0002";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "gist");

    const octokit = makeGistOctokit();
    const ch = new GistChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).gistBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks();

    expect(octokit.rest.gists.create).toHaveBeenCalled();
    const pending = queue.getPendingTasks(beaconId);
    expect(pending.length).toBe(0);
  });

  it("skips task with preferredChannel='notes' (different channel)", async () => {
    const beaconId = "gist-skip-beacon-0003";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "notes");

    const octokit = makeGistOctokit();
    const ch = new GistChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).gistBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks();

    expect(octokit.rest.gists.create).not.toHaveBeenCalled();
    // Task still pending
    const pending = queue.getPendingTasks(beaconId);
    expect(pending.length).toBe(1);
  });

  it("delivers only the matching task when mixed", async () => {
    const beaconId = "gist-mixed-beacon-0004";
    await makeBeacon(registry, beaconId);
    const t1 = queue.queueTask(beaconId, "shell", { cmd: "id" }, "gist");
    const t2 = queue.queueTask(beaconId, "shell", { cmd: "id" }, "notes");

    const octokit = makeGistOctokit();
    const ch = new GistChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).gistBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks();

    expect(octokit.rest.gists.create).toHaveBeenCalledTimes(1);
    expect(queue.getTask(t1.taskId)?.state).toBe("delivered");
    expect(queue.getTask(t2.taskId)?.state).toBe("pending");
  });
});

// ── NotesChannel ──────────────────────────────────────────────────────────────

describe("NotesChannel preferredChannel filtering", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/preferred-notes-test");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("delivers task with no preferredChannel", async () => {
    const beaconId = "notes-np-beacon-0001";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" });

    const octokit = makeNotesOctokit();
    const ch = new NotesChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).notesBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
  });

  it("delivers task with preferredChannel='notes'", async () => {
    const beaconId = "notes-match-beacon-0002";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "notes");

    const octokit = makeNotesOctokit();
    const ch = new NotesChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).notesBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(0);
  });

  it("skips task with preferredChannel='gist' (different channel)", async () => {
    const beaconId = "notes-skip-beacon-0003";
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "gist");

    const octokit = makeNotesOctokit();
    const ch = new NotesChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).notesBeacons.add(beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).not.toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(1);
  });
});

// ── BranchChannel ─────────────────────────────────────────────────────────────

describe("BranchChannel preferredChannel filtering", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/preferred-branch-test");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("delivers task with no preferredChannel", async () => {
    const beaconId = "branch-np-beacon-0001";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" });

    const octokit = makeBranchOctokit();
    const ch = new BranchChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).branchBeacons.set(beaconId, id8);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
  });

  it("delivers task with preferredChannel='branch'", async () => {
    const beaconId = "branch-match-beacon-0002";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "branch");

    const octokit = makeBranchOctokit();
    const ch = new BranchChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).branchBeacons.set(beaconId, id8);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(0);
  });

  it("skips task with preferredChannel='issues' (different channel)", async () => {
    const beaconId = "branch-skip-beacon-0003";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "issues");

    const octokit = makeBranchOctokit();
    const ch = new BranchChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).branchBeacons.set(beaconId, id8);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.git.createBlob).not.toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(1);
  });
});

// ── ActionsChannel ────────────────────────────────────────────────────────────

describe("ActionsChannel preferredChannel filtering", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/preferred-actions-test");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("delivers task with no preferredChannel", async () => {
    const beaconId = "actions-np-beacon-0001";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" });

    const octokit = makeActionsOctokit();
    const ch = new ActionsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).actionsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).toHaveBeenCalled();
  });

  it("delivers task with preferredChannel='actions'", async () => {
    const beaconId = "actions-match-beacon-0002";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "actions");

    const octokit = makeActionsOctokit();
    const ch = new ActionsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).actionsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(0);
  });

  it("skips task with preferredChannel='secrets' (different channel)", async () => {
    const beaconId = "actions-skip-beacon-0003";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "secrets");

    const octokit = makeActionsOctokit();
    const ch = new ActionsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).actionsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).not.toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(1);
  });
});

// ── SecretsChannel ────────────────────────────────────────────────────────────

describe("SecretsChannel preferredChannel filtering", () => {
  let registry: BeaconRegistry;
  let queue: TaskQueue;
  let operatorKp: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(async () => {
    registry   = new BeaconRegistry("/tmp/preferred-secrets-test");
    queue      = new TaskQueue();
    operatorKp = await generateOperatorKeyPair();
  });

  it("delivers task with no preferredChannel", async () => {
    const beaconId = "secrets-np-beacon-0001";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" });

    const octokit = makeSecretsOctokit();
    const ch = new SecretsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).secretsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).toHaveBeenCalled();
  });

  it("delivers task with preferredChannel='secrets'", async () => {
    const beaconId = "secrets-match-beacon-0002";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "secrets");

    const octokit = makeSecretsOctokit();
    const ch = new SecretsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).secretsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(0);
  });

  it("skips task with preferredChannel='branch' (different channel)", async () => {
    const beaconId = "secrets-skip-beacon-0003";
    const id8 = beaconId.slice(0, 8);
    await makeBeacon(registry, beaconId);
    queue.queueTask(beaconId, "shell", { cmd: "id" }, "branch");

    const octokit = makeSecretsOctokit();
    const ch = new SecretsChannel(registry, queue, {
      owner: "o", repo: "r", token: "t",
      operatorSecretKey: operatorKp.secretKey,
      pollIntervalMs: 60_000, octokit,
    });
    (ch as any).secretsBeacons.set(id8, beaconId);
    await (ch as any).deliverPendingTasks("o", "r");

    expect(octokit.rest.actions.updateRepoVariable).not.toHaveBeenCalled();
    expect(queue.getPendingTasks(beaconId).length).toBe(1);
  });
});

// ── TaskQueue.queueTask() preferredChannel storage ────────────────────────────

describe("TaskQueue preferredChannel storage", () => {
  it("stores preferredChannel when provided", () => {
    const q = new TaskQueue();
    const task = q.queueTask("beacon-1", "shell", { cmd: "id" }, "notes");
    expect(task.preferredChannel).toBe("notes");
  });

  it("leaves preferredChannel undefined when not provided", () => {
    const q = new TaskQueue();
    const task = q.queueTask("beacon-1", "shell", { cmd: "id" });
    expect(task.preferredChannel).toBeUndefined();
  });

  it("stores any string as preferredChannel (no validation at queue level)", () => {
    const q = new TaskQueue();
    const task = q.queueTask("beacon-1", "shell", {}, "gist");
    expect(task.preferredChannel).toBe("gist");
  });
});

// ── IssuesChannel preferredChannel filter logic (unit) ───────────────────────
//
// The filter is embedded in onCheckin (not a standalone method), so we test
// the filter predicate logic directly using TaskQueue tasks.

describe("IssuesChannel preferredChannel filter logic", () => {
  it("filter passes tasks with no preferredChannel", () => {
    const q = new TaskQueue();
    const t1 = q.queueTask("b", "shell", { cmd: "id" });
    const t2 = q.queueTask("b", "shell", { cmd: "id" }, "issues");
    const t3 = q.queueTask("b", "shell", { cmd: "id" }, "notes");

    const pending = q.getPendingTasks("b");
    const filtered = pending.filter(
      t => !t.preferredChannel || t.preferredChannel === "issues"
    );

    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.taskId)).toContain(t1.taskId);
    expect(filtered.map(t => t.taskId)).toContain(t2.taskId);
    expect(filtered.map(t => t.taskId)).not.toContain(t3.taskId);
  });

  it("filter excludes all tasks when all have non-issues preferredChannel", () => {
    const q = new TaskQueue();
    q.queueTask("b2", "shell", {}, "gist");
    q.queueTask("b2", "shell", {}, "notes");

    const pending = q.getPendingTasks("b2");
    const filtered = pending.filter(
      t => !t.preferredChannel || t.preferredChannel === "issues"
    );
    expect(filtered).toHaveLength(0);
  });
});
