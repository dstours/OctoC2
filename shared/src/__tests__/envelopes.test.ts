import { describe, expect, it } from "bun:test";
import {
  createTaskResultSignaturePayload,
  createUnsignedEnvelope,
  ed25519KeyId,
  generateEd25519KeyPair,
  parseSignedEnvelope,
  serializeSignedEnvelope,
  signEnvelope,
  verifyEnvelope,
} from "../envelopes.ts";

const NOW = "2026-07-16T12:00:00.000Z";

describe("Ed25519 signed envelopes", () => {
  it("signs and verifies every canonical envelope kind", async () => {
    const keys = await generateEd25519KeyPair();
    const keyId = await ed25519KeyId(keys.publicKey);

    const envelopes = [
      createUnsignedEnvelope({
        kind: "checkin",
        signerId: "beacon-1",
        keyId,
        issuedAt: NOW,
        sequence: 1,
        payload: {
          beaconId: "beacon-1",
          encryptionPublicKey: "x25519-public",
          signingPublicKey: "ed25519-public",
          hostname: "host",
          username: "user",
          os: "linux",
          arch: "x64",
          pid: 42,
          checkinAt: NOW,
        },
      }),
      createUnsignedEnvelope({
        kind: "registration",
        signerId: "beacon-1",
        keyId,
        issuedAt: NOW,
        sequence: 2,
        payload: {
          beaconId: "beacon-1",
          encryptionPublicKey: "x25519-public",
          signingPublicKey: "ed25519-public",
          hostname: "host",
          username: "user",
          os: "linux",
          arch: "x64",
          provisionedAt: NOW,
        },
      }),
      createUnsignedEnvelope({
        kind: "registration-ack",
        signerId: "server-1",
        keyId,
        issuedAt: NOW,
        sequence: 3,
        payload: {
          beaconId: "beacon-1",
          registrationHash: "registration-hash",
          acceptedAt: NOW,
          serverId: "server-1",
        },
      }),
      createUnsignedEnvelope({
        kind: "task-result",
        signerId: "beacon-1",
        keyId,
        issuedAt: NOW,
        sequence: 4,
        payload: {
          taskId: "task-1",
          beaconId: "beacon-1",
          success: true,
          outputHash: "output-hash",
          dataHash: null,
          metadataHash: null,
          completedAt: NOW,
        },
      }),
      createUnsignedEnvelope({
        kind: "recovery",
        signerId: "server-1",
        keyId,
        issuedAt: NOW,
        sequence: 5,
        payload: {
          beaconId: "beacon-1",
          generation: 7,
          expiresAt: "2026-07-16T12:05:00.000Z",
          configurationHash: "configuration-hash",
        },
      }),
    ] as const;

    for (const envelope of envelopes) {
      const signed = await signEnvelope(envelope, keys.secretKey);
      expect(await verifyEnvelope(signed, keys.publicKey)).toBe(true);
    }
  });

  it("rejects tampering and the wrong identity", async () => {
    const signer = await generateEd25519KeyPair();
    const attacker = await generateEd25519KeyPair();
    const keyId = await ed25519KeyId(signer.publicKey);
    const unsigned = createUnsignedEnvelope({
      kind: "recovery",
      signerId: "server-1",
      keyId,
      issuedAt: NOW,
      sequence: 8,
      payload: {
        beaconId: "beacon-1",
        generation: 1,
        expiresAt: "2026-07-16T12:05:00.000Z",
        configurationHash: "original",
      },
    });
    const signed = await signEnvelope(unsigned, signer.secretKey);
    expect(await verifyEnvelope(signed, signer.publicKey)).toBe(true);
    expect(await verifyEnvelope(signed, attacker.publicKey)).toBe(false);

    const tampered = {
      ...signed,
      payload: { ...signed.payload, configurationHash: "tampered" },
    };
    expect(await verifyEnvelope(tampered, signer.publicKey)).toBe(false);
  });

  it("round-trips canonical serialized envelopes", async () => {
    const keys = await generateEd25519KeyPair();
    const keyId = await ed25519KeyId(keys.publicKey);
    const signed = await signEnvelope(
      createUnsignedEnvelope({
        kind: "registration-ack",
        signerId: "server-1",
        keyId,
        issuedAt: NOW,
        sequence: 1,
        payload: {
          beaconId: "beacon-1",
          registrationHash: "hash",
          acceptedAt: NOW,
          serverId: "server-1",
        },
      }),
      keys.secretKey,
    );

    const serialized = serializeSignedEnvelope(signed);
    const parsed = parseSignedEnvelope(serialized);
    expect(parsed).toEqual(signed);
    expect(await verifyEnvelope(parsed, keys.publicKey)).toBe(true);
  });

  it("hashes large result fields instead of embedding them in the signed payload", async () => {
    const payload = await createTaskResultSignaturePayload({
      taskId: "task-1",
      beaconId: "beacon-1",
      success: true,
      output: "x".repeat(100_000),
      data: "base64-payload",
      metadata: { exitCode: 0, shellInvoked: true },
      completedAt: NOW,
    });

    expect(payload.outputHash.length).toBeGreaterThan(20);
    expect(payload.dataHash?.length).toBeGreaterThan(20);
    expect(payload.metadataHash?.length).toBeGreaterThan(20);
    expect(JSON.stringify(payload)).not.toContain("x".repeat(100));
    expect(JSON.stringify(payload)).not.toContain("base64-payload");
  });
});
