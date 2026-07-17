import {
  afterEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OctoStore } from "../store/index.ts";
import { TaskQueue } from "../TaskQueue.ts";

interface RestartFixture {
  pendingTaskId: string;
  completedTaskId: string;
  completionInput: {
    taskId: string;
    beaconId: string;
    canonicalResult: string;
    signature: string;
    signatureKeyId: string;
    signatureVerified: true;
  };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("forced controller-state restart", () => {
  it("preserves pending tasks and completed results without duplication", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "octoc2-forced-restart-"));
    temporaryDirectories.push(dataDir);
    const readyFile = join(dataDir, "ready.json");
    const storeModule = new URL("../store/index.ts", import.meta.url).href;
    const queueModule = new URL("../TaskQueue.ts", import.meta.url).href;
    const childScript = `
      import { join } from "node:path";
      import { OctoStore } from ${JSON.stringify(storeModule)};
      import { TaskQueue } from ${JSON.stringify(queueModule)};

      const dataDir = process.env.OCTOC2_RESTART_DATA_DIR;
      if (!dataDir) throw new Error("missing data directory");
      const store = OctoStore.open({ dataDir, importLegacyRegistry: false });
      const queue = new TaskQueue(store);
      const beaconId = "forced-restart-beacon";
      const signingKeyId = "forced-restart-signing-key";
      const timestamp = "2026-07-16T12:00:00.000Z";
      store.upsertBeacon({
        beaconId,
        issueNumber: null,
        x25519PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        hostname: "restart-host",
        username: "tester",
        os: "linux",
        arch: "x64",
        firstSeen: timestamp,
        lastSeen: timestamp,
        status: "dormant",
        lastSeq: 0,
        activeTentacle: null,
      });
      store.provisionIdentityKey({
        keyId: signingKeyId,
        beaconId,
        publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        provisionedBy: "forced-restart-test",
        provisionedAt: timestamp,
      });
      const pending = queue.queueTask(
        beaconId,
        "shell",
        { cmd: "whoami" },
        "issues",
      );
      const completed = queue.queueTask(
        beaconId,
        "ping",
        {},
        "issues",
      );
      queue.markDelivered(completed.taskId);
      const canonicalResult = JSON.stringify({
        taskId: completed.taskId,
        beaconId,
        success: true,
        output: "pong",
        completedAt: timestamp,
      });
      const completionInput = {
        taskId: completed.taskId,
        beaconId,
        canonicalResult,
        signature: "verified-test-signature",
        signatureKeyId: signingKeyId,
        signatureVerified: true,
      };
      const completion = store.completeTaskResult(completionInput);
      if (completion.status !== "completed") {
        throw new Error("failed to persist completion: " + completion.status);
      }
      await Bun.write(join(dataDir, "ready.json"), JSON.stringify({
        pendingTaskId: pending.taskId,
        completedTaskId: completed.taskId,
        completionInput,
      }));
      setInterval(() => {}, 60_000);
    `;
    const child = Bun.spawn(
      [process.execPath, "--eval", childScript],
      {
        env: {
          ...process.env,
          OCTOC2_RESTART_DATA_DIR: dataDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    for (let attempt = 0; attempt < 250 && !existsSync(readyFile); attempt += 1) {
      await Bun.sleep(20);
    }
    if (!existsSync(readyFile)) {
      child.kill("SIGKILL");
      const stderr = await new Response(child.stderr).text();
      throw new Error(`restart fixture did not become ready: ${stderr}`);
    }
    const fixtureJson = readFileSync(readyFile, "utf8");
    child.kill("SIGKILL");
    await child.exited;
    const fixture = JSON.parse(fixtureJson) as RestartFixture;

    let store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    let queue = new TaskQueue(store);
    expect(queue.getTask(fixture.pendingTaskId)?.state).toBe("pending");
    expect(queue.getTask(fixture.completedTaskId)?.state).toBe("completed");
    expect(store.getTaskResult(fixture.completedTaskId)?.canonicalResult)
      .toBe(fixture.completionInput.canonicalResult);
    expect(store.completeTaskResult(fixture.completionInput).status)
      .toBe("exact_duplicate");
    store.close();

    store = OctoStore.open({ dataDir, importLegacyRegistry: false });
    queue = new TaskQueue(store);
    expect(queue.getTask(fixture.pendingTaskId)?.state).toBe("pending");
    expect(queue.getTask(fixture.completedTaskId)?.state).toBe("completed");
    expect(store.getTaskResult(fixture.completedTaskId)?.signature)
      .toBe(fixture.completionInput.signature);
    store.close();
  });
});
