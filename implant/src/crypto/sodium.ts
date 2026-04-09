/**
 * OctoC2 — Crypto helpers (libsodium)
 *
 * All inter-beacon/operator messages are encrypted with libsodium
 * crypto_box (X25519 + XSalsa20-Poly1305). The operator holds the
 * master key pair; each beacon generates its own ephemeral key pair
 * on first run and registers the public key with the C2 server.
 *
 * Encryption flow (beacon → operator):
 *   1. Beacon generates nonce (24 random bytes).
 *   2. Beacon encrypts plaintext with crypto_box_easy(
 *        plaintext, nonce, operatorPublicKey, beaconSecretKey
 *      ).
 *   3. Sends: base64url(nonce) + "." + base64url(ciphertext).
 *
 * Decryption flow (operator → beacon):
 *   1. Operator encrypts task with beacon's registered public key.
 *   2. Beacon decrypts with its secret key.
 */

// libsodium-wrappers v0.7.16 ships two entrypoints:
//   ESM  — dist/modules-esm/libsodium-wrappers.mjs (imports ./libsodium.mjs, MISSING)
//   CJS  — dist/modules/libsodium-wrappers.js       (self-contained, works fine)
//
// Bun's ESM resolver prefers the "import" condition → picks the broken .mjs path.
// Importing via an explicit relative path bypasses the exports map entirely and
// forces bundling of the self-contained CJS build. This works with both
// `bun run` and `bun build --compile`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types for direct path import; uses default export shape of libsodium-wrappers
import _sodium from "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js";

let sodiumReady = false;

async function getSodium() {
  if (!sodiumReady) {
    await _sodium.ready;
    sodiumReady = true;
  }
  return _sodium;
}

export async function generateKeyPair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  // libsodium's runtime API uses 'privateKey'; normalize to 'secretKey' throughout
  // OctoC2 so callers never deal with the naming inconsistency.
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export async function encryptBox(
  plaintext: Uint8Array | string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array
): Promise<{ nonce: string; ciphertext: string }> {
  const sodium = await getSodium();

  const msg =
    typeof plaintext === "string"
      ? sodium.from_string(plaintext)
      : plaintext;

  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ciphertext = sodium.crypto_box_easy(
    msg,
    nonce,
    recipientPublicKey,
    senderSecretKey
  );

  return {
    nonce:      sodium.to_base64(nonce,      _sodium.base64_variants.URLSAFE_NO_PADDING),
    ciphertext: sodium.to_base64(ciphertext, _sodium.base64_variants.URLSAFE_NO_PADDING),
  };
}

export async function decryptBox(
  ciphertextB64: string,
  nonceB64: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();

  const ciphertext = sodium.from_base64(ciphertextB64, _sodium.base64_variants.URLSAFE_NO_PADDING);
  const nonce      = sodium.from_base64(nonceB64,      _sodium.base64_variants.URLSAFE_NO_PADDING);

  const plaintext = sodium.crypto_box_open_easy(
    ciphertext,
    nonce,
    senderPublicKey,
    recipientSecretKey
  );

  if (!plaintext) throw new Error("Decryption failed — authentication tag mismatch");
  return plaintext;
}

export async function sign(
  message: Uint8Array | string,
  secretKey: Uint8Array
): Promise<string> {
  const sodium = await getSodium();
  const msg =
    typeof message === "string" ? sodium.from_string(message) : message;
  const sig = sodium.crypto_sign_detached(msg, secretKey);
  return sodium.to_base64(sig, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function verify(
  message: Uint8Array | string,
  signatureB64: string,
  publicKey: Uint8Array
): Promise<boolean> {
  const sodium = await getSodium();
  const msg =
    typeof message === "string" ? sodium.from_string(message) : message;
  const sig = sodium.from_base64(signatureB64, _sodium.base64_variants.URLSAFE_NO_PADDING);
  return sodium.crypto_sign_verify_detached(sig, msg, publicKey);
}

// ── Sealed box (anonymous encryption, beacon → server direction) ──────────────
//
// crypto_box_seal encrypts a message to a recipient's public key without
// revealing the sender's identity. The nonce is derived internally by libsodium
// (ephemeral sender key pair + recipient public key → shared secret + nonce).
// No external nonce is needed or returned — the comment format uses "<!-- - -->"
// as a fixed placeholder to keep the format uniform with crypto_box comments.

export async function sealBox(
  message: Uint8Array | string,
  recipientPublicKey: Uint8Array
): Promise<string> {
  const sodium = await getSodium();
  const msg =
    typeof message === "string" ? sodium.from_string(message) : message;
  const sealed = sodium.crypto_box_seal(msg, recipientPublicKey);
  return sodium.to_base64(sealed, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

// openSealBox is used server-side (operator has both keys).
// Included here so the implant can verify its own sealed output in tests,
// and so this module is the single source of crypto truth for both sides.
export async function openSealBox(
  sealedB64: string,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const sealed = sodium.from_base64(sealedB64, _sodium.base64_variants.URLSAFE_NO_PADDING);
  const plaintext = sodium.crypto_box_seal_open(sealed, recipientPublicKey, recipientSecretKey);
  if (!plaintext) throw new Error("Seal decryption failed — invalid key or corrupted data");
  return plaintext;
}

export async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function base64ToBytes(b64: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(b64.trim(), _sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function sodiumBytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Semantic aliases kept for callers that deal specifically with keys
export const publicKeyToBase64 = bytesToBase64;
export const base64ToPublicKey = base64ToBytes;

/**
 * Derive the X25519 public key from its corresponding secret key.
 * Used by the operator side to re-derive a public key from a stored secret.
 */
export async function derivePublicKey(secretKey: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_scalarmult_base(secretKey);
}
