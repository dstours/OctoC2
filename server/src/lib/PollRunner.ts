import { sha256Hex, type OctoStore } from "../store/index.ts";

export interface PollRunnerOptions {
  name: string;
  intervalMs: number;
  poll: () => Promise<void>;
  onError?: (error: unknown) => void;
  runImmediately?: boolean;
}

export type PollRunDisposition = "started" | "joined" | "stopped";

/**
 * Schedules a poll only after the preceding poll has settled.
 *
 * `setInterval(async () => ...)` can overlap when a GitHub request takes
 * longer than the interval. PollRunner instead uses a trailing `setTimeout`
 * and makes concurrent manual triggers join the same in-flight promise.
 */
export class PollRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private stopped = true;

  constructor(private readonly options: PollRunnerOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs <= 0
    ) {
      throw new Error("poll interval must be a positive safe integer");
    }
    if (!options.name.trim()) throw new Error("poll runner name is required");
  }

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  start(): void {
    if (this.isStarted) return;
    this.started = true;
    this.stopped = false;
    this.schedule(this.options.runImmediately === false
      ? this.options.intervalMs
      : 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }

  /**
   * Trigger a poll immediately. If one is already active, callers await the
   * existing poll rather than starting another one.
   */
  async runOnce(): Promise<PollRunDisposition> {
    if (this.inFlight) {
      await this.inFlight;
      return "joined";
    }

    const run = this.options.poll()
      .catch((error) => {
        if (this.options.onError) {
          this.options.onError(error);
          return;
        }
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    await run;
    return "started";
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      void this.runOnce()
        .catch((error) => {
          // A configured onError already observed this error.
          if (!this.options.onError) {
            console.error(
              `[${this.options.name}] Poll error:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        })
        .finally(() => {
          this.schedule(this.options.intervalMs);
        });
    }, delayMs);
  }
}

export interface DurableArtifact {
  messageId: string;
  payload: string;
  cursor: string;
  beaconId?: string | null;
  taskId?: string | null;
}

export interface DurableArtifactOutcome {
  status:
    | "processed"
    | "exact_duplicate"
    | "conflicting_duplicate";
}

export interface DurableProcessingResult {
  outcome?: "accepted" | "duplicate" | "rejected";
  beaconId?: string | null;
  taskId?: string | null;
}

/**
 * Durable cursor/dedup facade for a single channel and repository scope.
 *
 * The handler runs before the transaction that stores both the immutable
 * message ID and its cursor. A thrown handler therefore leaves neither record
 * behind, so the artifact is retried after the next poll or process restart.
 */
export class DurablePollState {
  constructor(
    private readonly store: OctoStore,
    readonly channel: string,
    readonly scope: string,
    readonly overlapMs = 5_000,
  ) {
    if (!channel.trim()) throw new Error("channel is required");
    if (!scope.trim()) throw new Error("scope is required");
    if (
      !Number.isSafeInteger(overlapMs) ||
      overlapMs < 0
    ) {
      throw new Error("overlapMs must be a non-negative safe integer");
    }
  }

  get cursor(): string | undefined {
    return this.store.getPollCursor(this.channel, this.scope)?.cursor;
  }

  /**
   * Returns the persisted ISO timestamp minus the configured overlap window.
   * The overlap intentionally re-fetches boundary artifacts; durable message
   * IDs make that safe.
   */
  timestampSince(fallback: string): string {
    const cursor = this.cursor;
    if (!cursor) return fallback;
    const parsed = new Date(cursor).getTime();
    if (!Number.isFinite(parsed)) return fallback;
    return new Date(parsed - this.overlapMs).toISOString();
  }

  async process(
    artifact: DurableArtifact,
    handler: () => Promise<void | DurableProcessingResult>,
  ): Promise<DurableArtifactOutcome> {
    const digest = sha256Hex(artifact.payload);
    const existing = this.store.getProcessedMessage(
      this.channel,
      artifact.messageId,
    );
    if (existing) {
      return {
        status: existing.payloadDigest === digest
          ? "exact_duplicate"
          : "conflicting_duplicate",
      };
    }

    const result = await handler();
    const committed = this.store.commitChannelProgress({
      channel: this.channel,
      scope: this.scope,
      messageId: artifact.messageId,
      payloadDigest: digest,
      cursor: artifact.cursor,
      ...((result?.beaconId ?? artifact.beaconId) !== undefined && {
        beaconId: result?.beaconId ?? artifact.beaconId,
      }),
      ...((result?.taskId ?? artifact.taskId) !== undefined && {
        taskId: result?.taskId ?? artifact.taskId,
      }),
      ...(result?.outcome !== undefined && { outcome: result.outcome }),
    });
    return {
      status: committed.status === "committed"
        ? "processed"
        : committed.status,
    };
  }
}

export function repositoryPollScope(owner: string, repo: string): string {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = repo.trim().toLowerCase();
  if (!normalizedOwner || !normalizedRepo) {
    throw new Error("repository owner and name are required");
  }
  return `repo:${normalizedOwner}/${normalizedRepo}`;
}
