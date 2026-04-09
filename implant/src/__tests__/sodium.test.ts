/**
 * OctoC2 — sodium.ts unit tests
 *
 * Covers: generateKeyPair, sealBox/openSealBox roundtrip,
 * encryptBox/decryptBox roundtrip, sign/verify, and
 * authentication-failure paths.
 */

import { describe, it, expect } from "bun:test";
import { createRequire } from "node:module";
import type _SodiumType from "libsodium-wrappers";
// Force CJS resolution (same fix as sodium.ts — avoids broken .mjs entrypoint)
const _sodiumLib = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumType;

import {
  generateKeyPair,
  sealBox,
  openSealBox,
  encryptBox,
  decryptBox,
  sign,
  verify,
  bytesToBase64,
  base64ToBytes,
} from "../crypto/sodium.ts";

describe("generateKeyPair", () => {
  it("returns publicKey and secretKey as Uint8Arrays", async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);  // X25519 public key = 32 bytes
    expect(kp.secretKey.length).toBe(32);
  });

  it("each call produces a unique key pair", async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
  });
});

// ── sealBox / openSealBox ──────────────────────────────────────────────────────

describe("sealBox / openSealBox", () => {
  it("roundtrip: string message", async () => {
    const recipient = await generateKeyPair();
    const message   = "hello from the beacon";

    const sealed    = await sealBox(message, recipient.publicKey);
    const recovered = await openSealBox(sealed, recipient.publicKey, recipient.secretKey);

    expect(new TextDecoder().decode(recovered)).toBe(message);
  });

  it("roundtrip: Uint8Array message", async () => {
    const recipient = await generateKeyPair();
    const message   = new Uint8Array([0x00, 0xff, 0x42, 0x13]);

    const sealed    = await sealBox(message, recipient.publicKey);
    const recovered = await openSealBox(sealed, recipient.publicKey, recipient.secretKey);

    expect(recovered).toEqual(message);
  });

  it("roundtrip: JSON payload (typical beacon checkin)", async () => {
    const recipient = await generateKeyPair();
    const payload   = { beaconId: "abc-123", hostname: "web-01", os: "linux" };

    const sealed    = await sealBox(JSON.stringify(payload), recipient.publicKey);
    const recovered = await openSealBox(sealed, recipient.publicKey, recipient.secretKey);
    const parsed    = JSON.parse(new TextDecoder().decode(recovered));

    expect(parsed).toEqual(payload);
  });

  it("returns a non-empty base64url string", async () => {
    const recipient = await generateKeyPair();
    const sealed = await sealBox("test", recipient.publicKey);

    expect(typeof sealed).toBe("string");
    expect(sealed.length).toBeGreaterThan(0);
    // URL-safe base64: no + or /
    expect(sealed).not.toMatch(/[+/]/);
  });

  it("each call produces a different ciphertext (ephemeral sender key)", async () => {
    const recipient = await generateKeyPair();
    const sealed1   = await sealBox("same message", recipient.publicKey);
    const sealed2   = await sealBox("same message", recipient.publicKey);
    // crypto_box_seal uses an ephemeral key pair each time → different output
    expect(sealed1).not.toBe(sealed2);
  });

  it("throws on wrong recipient secret key", async () => {
    const recipient = await generateKeyPair();
    const attacker  = await generateKeyPair();
    const sealed    = await sealBox("secret", recipient.publicKey);

    expect(
      openSealBox(sealed, recipient.publicKey, attacker.secretKey)
    ).rejects.toThrow();
  });

  it("throws on truncated/corrupted ciphertext", async () => {
    const recipient = await generateKeyPair();
    const sealed    = await sealBox("test", recipient.publicKey);
    const corrupted = sealed.slice(0, 10); // truncate

    expect(
      openSealBox(corrupted, recipient.publicKey, recipient.secretKey)
    ).rejects.toThrow();
  });
});

// ── encryptBox / decryptBox ────────────────────────────────────────────────────

describe("encryptBox / decryptBox", () => {
  it("roundtrip: server encrypts task, beacon decrypts", async () => {
    const operator = await generateKeyPair(); // operator key pair
    const beacon   = await generateKeyPair(); // beacon key pair

    const tasks = [{ id: "task-001", kind: "shell", args: { cmd: "whoami" } }];

    // Server side: encrypt to beacon's public key with operator's secret key
    const { nonce, ciphertext } = await encryptBox(
      JSON.stringify(tasks),
      beacon.publicKey,
      operator.secretKey
    );

    // Beacon side: decrypt with operator's public key and beacon's secret key
    const plaintext = await decryptBox(ciphertext, nonce, operator.publicKey, beacon.secretKey);
    const recovered = JSON.parse(new TextDecoder().decode(plaintext));

    expect(recovered).toEqual(tasks);
  });

  it("nonce and ciphertext are non-empty base64url strings", async () => {
    const kp = await generateKeyPair();
    const { nonce, ciphertext } = await encryptBox("test", kp.publicKey, kp.secretKey);

    expect(typeof nonce).toBe("string");
    expect(typeof ciphertext).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(nonce).not.toMatch(/[+/]/);
    expect(ciphertext).not.toMatch(/[+/]/);
  });

  it("throws on wrong sender public key", async () => {
    const sender    = await generateKeyPair();
    const recipient = await generateKeyPair();
    const attacker  = await generateKeyPair();

    const { nonce, ciphertext } = await encryptBox("secret", recipient.publicKey, sender.secretKey);

    expect(
      decryptBox(ciphertext, nonce, attacker.publicKey, recipient.secretKey)
    ).rejects.toThrow();
  });
});

// ── sign / verify ──────────────────────────────────────────────────────────────

describe("sign / verify", () => {
  it("sign + verify roundtrip", async () => {
    // Ed25519: crypto_sign_keypair() returns { privateKey, publicKey }
    await _sodiumLib.ready;
    const signingKp = _sodiumLib.crypto_sign_keypair();

    const message = "task-001:success:2026-03-27T00:00:00Z";
    const sigB64  = await sign(message, signingKp.privateKey);
    const valid   = await verify(message, sigB64, signingKp.publicKey);

    expect(valid).toBe(true);
  });

  it("rejects tampered message", async () => {
    await _sodiumLib.ready;
    const signingKp = _sodiumLib.crypto_sign_keypair();

    const message  = "task-001:success:2026-03-27";
    const sigB64   = await sign(message, signingKp.privateKey);
    const tampered = message + "X";
    const valid    = await verify(tampered, sigB64, signingKp.publicKey);

    expect(valid).toBe(false);
  });
});

// ── Key serialization helpers ─────────────────────────────────────────────────

describe("bytesToBase64 / base64ToBytes", () => {
  it("roundtrip: key → base64url → key", async () => {
    const kp   = await generateKeyPair();
    const b64  = await bytesToBase64(kp.publicKey);
    const back = await base64ToBytes(b64);

    expect(back).toEqual(kp.publicKey);
  });

  it("produces URL-safe no-padding base64 (no +, /, or =)", async () => {
    for (let i = 0; i < 20; i++) {
      const kp  = await generateKeyPair();
      const b64 = await bytesToBase64(kp.publicKey);
      expect(b64).not.toMatch(/[+/=]/);
    }
  });
});
