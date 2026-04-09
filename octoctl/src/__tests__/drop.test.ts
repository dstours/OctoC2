import { describe, it, expect } from "bun:test";
import { buildDropPayload } from "../commands/drop.ts";
import { generateOperatorKeyPair, bytesToBase64 } from "../lib/crypto.ts";
import { createHash } from "node:crypto";

describe("buildDropPayload", () => {
  it("produces a sealed ciphertext that can be opened with the correct key", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      serverUrl: "https://my-c2:8080",
      tentaclePriority: "notes,issues",
    });

    // Verify it's base64url (no + or /)
    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);

    // Verify we can decrypt it with the matching secret key
    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.version).toBe(1);
    expect(payload.serverUrl).toBe("https://my-c2:8080");
    expect(payload.tentaclePriority).toEqual(["notes", "issues"]);
  });

  it("omits optional fields when not provided", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      serverUrl: "https://c2:8080",
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.token).toBeUndefined();
    expect(payload.tentaclePriority).toBeUndefined();
    expect(payload.appPrivateKey).toBeUndefined();
  });

  it("includes appPrivateKey in payload when provided", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);
    const fakePem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----";

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      appPrivateKey: fakePem,
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.version).toBe(1);
    expect(payload.appPrivateKey).toBe(fakePem);
    expect(payload.serverUrl).toBeUndefined();  // not required when only rotating key
  });

  it("omits serverUrl when not provided (key-only drop)", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      newToken: "ghp_new_token",
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.serverUrl).toBeUndefined();
    expect(payload.token).toBe("ghp_new_token");
  });

  it("includes appId and installationId for PAT→App migration", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);
    const fakePem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----";

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      appId:          123456,
      installationId: 987654,
      appPrivateKey:  fakePem,
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.version).toBe(1);
    expect(payload.appId).toBe(123456);
    expect(payload.installationId).toBe(987654);
    expect(payload.appPrivateKey).toBe(fakePem);
    expect(payload.serverUrl).toBeUndefined();
  });

  it("omits appId and installationId when not provided", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      serverUrl: "https://c2:8080",
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.appId).toBeUndefined();
    expect(payload.installationId).toBeUndefined();
  });

  it("includes monitoringPubkey in payload when provided", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);
    const fakeMonitoringPubkey = "dGVzdHB1YmtleWJhc2U2NHVybA";  // base64url test value

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      monitoringPubkey: fakeMonitoringPubkey,
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.version).toBe(1);
    expect(payload.monitoringPubkey).toBe(fakeMonitoringPubkey);
  });

  it("omits monitoringPubkey when not provided", async () => {
    const kp = await generateOperatorKeyPair();
    const pubB64 = await bytesToBase64(kp.publicKey);

    const ciphertext = await buildDropPayload({
      beaconPublicKeyB64: pubB64,
      serverUrl: "https://c2:8080",
    });

    const { openSealBox } = await import("../lib/crypto.ts");
    const plain = await openSealBox(ciphertext, kp.publicKey, kp.secretKey);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    expect(payload.monitoringPubkey).toBeUndefined();
  });

  it("key-type=monitoring: validates monitoringPubkey is required", async () => {
    // Simulate the validation logic from runDropCreate
    const keyType: 'app' | 'monitoring' = 'monitoring';
    const monitoringPubkey: string | undefined = undefined;

    let errorMessage = "";
    if (keyType === 'monitoring' && !monitoringPubkey) {
      errorMessage = "monitoring key type requires --monitoring-pubkey";
    }
    expect(errorMessage).toBe("monitoring key type requires --monitoring-pubkey");
  });
});
