/**
 * octoctl — crypto helpers
 *
 * Minimal libsodium wrapper for the operator CLI.
 * Same CJS workaround as implant/server to avoid the broken .mjs entrypoint.
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

// ── Key generation ─────────────────────────────────────────────────────────────

export async function generateOperatorKeyPair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const sodium = await getSodium();
  const kp     = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ── Encryption (server → beacon) ──────────────────────────────────────────────

export async function encryptForBeacon(
  plaintext:        string | Uint8Array,
  beaconPublicKey:  Uint8Array,
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

// ── Decryption (beacon → server) — for reading results ────────────────────────

export async function openSealBox(
  sealedB64:         string,
  operatorPublicKey:  Uint8Array,
  operatorSecretKey:  Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const sealed = sodium.from_base64(sealedB64, _sodium.base64_variants.URLSAFE_NO_PADDING);
  const plain  = sodium.crypto_box_seal_open(sealed, operatorPublicKey, operatorSecretKey);
  if (!plain) throw new Error("Seal open failed — wrong key or corrupted ciphertext");
  return plain;
}

/** Seal a message to a recipient's public key (anonymous sender). */
export async function sealBox(
  message: Uint8Array | string,
  recipientPublicKey: Uint8Array,
): Promise<string> {
  const sodium = await getSodium();
  const msg = typeof message === "string" ? sodium.from_string(message) : message;
  const sealed = sodium.crypto_box_seal(msg, recipientPublicKey);
  return sodium.to_base64(sealed, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

// ── Key serialization ──────────────────────────────────────────────────────────

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

// ── GitHub Secrets API encryption ─────────────────────────────────────────────

/**
 * Encrypt a plaintext secret for the GitHub Secrets API.
 * GitHub provides the repo key as standard base64; returns standard base64 ciphertext.
 */
export async function encryptGitHubSecret(
  plaintext: string,
  repoPublicKeyBase64: string,
): Promise<string> {
  const sodium = await getSodium();
  const keyBytes = Buffer.from(repoPublicKeyBase64, 'base64');
  const msgBytes = sodium.from_string(plaintext);
  const sealed   = sodium.crypto_box_seal(msgBytes, keyBytes);
  return Buffer.from(sealed).toString('base64');
}
