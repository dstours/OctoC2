import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ModuleLoader } from "../modules/ModuleLoader.ts";
import { writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fetchModule ────────────────────────────────────────────────────────────────

describe("ModuleLoader.fetchModule", () => {
  it("fetches a binary from the server and returns a writable path", async () => {
    const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]);

    const mockServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(binary, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
    });

    try {
      const path = await ModuleLoader.fetchModule(
        "recon",
        `http://localhost:${mockServer.port}`,
        "test-token",
        "beacon123",
      );
      expect(path).toContain("svc-mod-beacon123-recon");
      const written = await Bun.file(path).bytes();
      expect(written).toEqual(binary);
    } finally {
      mockServer.stop();
    }
  });

  it("throws on non-200 response", async () => {
    const mockServer = Bun.serve({
      port: 0,
      fetch() { return new Response("not found", { status: 404 }); },
    });

    try {
      await expect(
        ModuleLoader.fetchModule("recon", `http://localhost:${mockServer.port}`, "tok", "b1")
      ).rejects.toThrow("ModuleLoader: fetch failed: 404");
    } finally {
      mockServer.stop();
    }
  });
});

// ── runModule ─────────────────────────────────────────────────────────────────

describe("ModuleLoader.runModule", () => {
  it("captures JSON stdout and returns success", async () => {
    const scriptPath = join(tmpdir(), "svc-test-mod-ok.sh");
    await writeFile(
      scriptPath,
      '#!/bin/sh\necho \'{"status":"ok","data":"hello from module"}\'\n'
    );
    await chmod(scriptPath, 0o755);

    const result = await ModuleLoader.runModule(scriptPath, 1234);
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello from module");

    await rm(scriptPath, { force: true });
  });

  it("returns failure for error status", async () => {
    const scriptPath = join(tmpdir(), "svc-test-mod-err.sh");
    await writeFile(
      scriptPath,
      '#!/bin/sh\necho \'{"status":"error","error":"something broke"}\'\n'
    );
    await chmod(scriptPath, 0o755);

    const result = await ModuleLoader.runModule(scriptPath, 1234);
    expect(result.success).toBe(false);
    expect(result.output).toBe("something broke");

    await rm(scriptPath, { force: true });
  });

  it("returns failure for non-JSON stdout", async () => {
    const scriptPath = join(tmpdir(), "svc-test-mod-bad.sh");
    await writeFile(scriptPath, '#!/bin/sh\necho "not json"\n');
    await chmod(scriptPath, 0o755);

    const result = await ModuleLoader.runModule(scriptPath, 1234);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not valid JSON");

    await rm(scriptPath, { force: true });
  });

  it("injects SVC_PID into subprocess env", async () => {
    const scriptPath = join(tmpdir(), "svc-test-mod-pid.sh");
    await writeFile(
      scriptPath,
      '#!/bin/sh\nprintf \'{"status":"ok","data":"%s"}\' "$SVC_PID"\necho\n'
    );
    await chmod(scriptPath, 0o755);

    const result = await ModuleLoader.runModule(scriptPath, 9999);
    expect(result.success).toBe(true);
    expect(result.output).toBe("9999");

    await rm(scriptPath, { force: true });
  });
});
