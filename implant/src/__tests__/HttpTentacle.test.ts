import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpTentacle } from "../tentacles/HttpTentacle.ts";
import type {
  BeaconConfig,
  CheckinPayload,
  TaskResult,
} from "../types.ts";

class ErrorFrameWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { wasClean: boolean; code: number }) => void) | null = null;

  private closed = false;

  constructor(
    readonly url: string,
    readonly options?: unknown,
  ) {
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    const request = JSON.parse(data) as { type?: string };
    queueMicrotask(() => this.onmessage?.({
      data: JSON.stringify({
        type: "error",
        message: `rejected ${request.type ?? "request"}`,
      }),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ wasClean: true, code: 1000 }));
  }
}

const CONFIG: BeaconConfig = {
  id: "http-beacon",
  repo: { owner: "owner", name: "repo" },
  token: "github-token",
  controllerToken: "controller-token",
  serverUrl: "https://controller.example",
  tentaclePriority: ["http"],
  sleepSeconds: 60,
  jitter: 0,
  operatorPublicKey: new Uint8Array(32),
  beaconKeyPair: {
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32),
  },
};

const CHECKIN: CheckinPayload = {
  beaconId: CONFIG.id,
  publicKey: "beacon-public-key",
  hostname: "host",
  username: "user",
  os: "linux",
  arch: "x64",
  pid: 1234,
  checkinAt: "2026-07-16T12:00:00.000Z",
};

const RESULT: TaskResult = {
  taskId: "task-1",
  beaconId: CONFIG.id,
  success: false,
  output: "failed",
  completedAt: "2026-07-16T12:01:00.000Z",
};

async function rejectionWithin(
  promise: Promise<unknown>,
  timeoutMs = 250,
): Promise<Error> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timed-out" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") {
    throw new Error(`WebSocket operation did not reject: ${outcome.kind}`);
  }
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error;
}

describe("HttpTentacle WebSocket server error frames", () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      ErrorFrameWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      originalWebSocket;
  });

  it("rejects a checkin error frame immediately", async () => {
    const tentacle = new HttpTentacle(CONFIG);

    const error = await rejectionWithin(
      (tentacle as any).wsCheckin(CONFIG.serverUrl, CHECKIN),
    );

    expect(error.message).toBe(
      "WS checkin server error: rejected checkin",
    );
  });

  it("rejects a submit-result error frame immediately", async () => {
    const tentacle = new HttpTentacle(CONFIG);

    const error = await rejectionWithin(
      (tentacle as any).wsSubmitResult(CONFIG.serverUrl, RESULT),
    );

    expect(error.message).toBe(
      "WS submitResult server error: rejected submit-result",
    );
  });
});

describe("HttpTentacle controller URL policy", () => {
  it("refuses plaintext HTTP before attempting either transport", async () => {
    const tentacle = new HttpTentacle({
      ...CONFIG,
      serverUrl: "http://127.0.0.1:8080",
    });

    expect(await tentacle.isAvailable()).toBe(false);
    await expect(tentacle.checkin(CHECKIN)).rejects.toThrow("must use HTTPS");
    await expect(tentacle.submitResult(RESULT)).rejects.toThrow("must use HTTPS");
  });
});
