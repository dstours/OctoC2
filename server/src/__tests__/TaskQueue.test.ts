import { describe, it, expect } from "bun:test";
import { TaskQueue } from "../TaskQueue.ts";

describe("TaskQueue O(1) lookups", () => {
  const queue = new TaskQueue();

  it("getTask returns the correct task by taskId", () => {
    const task = queue.queueTask("beacon-1", "shell", { cmd: "whoami" });
    expect(queue.getTask(task.taskId)).toBe(task);
  });

  it("getTaskByRef returns the correct task by ref", () => {
    const task = queue.queueTask("beacon-1", "ping");
    expect(queue.getTaskByRef(task.ref)).toBe(task);
  });

  it("getTask returns undefined for unknown taskId", () => {
    expect(queue.getTask("unknown-id")).toBeUndefined();
  });

  it("getTaskByRef returns undefined for unknown ref", () => {
    expect(queue.getTaskByRef("unknown-ref")).toBeUndefined();
  });

  it("markDelivered updates state and works via O(1) lookup", () => {
    const task = queue.queueTask("beacon-2", "exec", { cmd: "id" });
    const ok = queue.markDelivered(task.taskId);
    expect(ok).toBe(true);
    expect(queue.getTask(task.taskId)!.state).toBe("delivered");
  });

  it("markCompleted updates state and result", () => {
    const task = queue.queueTask("beacon-3", "shell", { cmd: "echo ok" });
    queue.markDelivered(task.taskId);
    const ok = queue.markCompleted(task.taskId, "ok output");
    expect(ok).toBe(true);
    expect(queue.getTask(task.taskId)!.state).toBe("completed");
    expect(queue.getTask(task.taskId)!.result).toBe("ok output");
  });

  it("handles many tasks without performance degradation", () => {
    const q = new TaskQueue();
    const tasks: ReturnType<typeof q.queueTask>[] = [];
    for (let i = 0; i < 1000; i++) {
      tasks.push(q.queueTask("beacon-bulk", "ping"));
    }
    // All lookups should be O(1)
    for (const t of tasks) {
      expect(q.getTask(t.taskId)).toBe(t);
      expect(q.getTaskByRef(t.ref)).toBe(t);
    }
  });
});
