import { describe, expect, it } from "bun:test";
import {
  bytesToBase64,
  encryptBox,
  generateKeyPair,
} from "../crypto/sodium.ts";
import { IssuesTentacle } from "../tentacles/IssuesTentacle.ts";

describe("IssuesTentacle explicit registration ACK", () => {
  it("accepts only the ACK bound to the current registration comment", async () => {
    const beaconId = "550e8400-e29b-41d4-a716-446655440001";
    const beaconKeys = await generateKeyPair();
    const operatorKeys = await generateKeyPair();
    const tentacle = new IssuesTentacle({
      id: beaconId,
      repo: { owner: "owner", name: "repo" },
      token: "test-token",
      tentaclePriority: ["issues"],
      sleepSeconds: 60,
      jitter: 0,
      operatorPublicKey: operatorKeys.publicKey,
      beaconKeyPair: beaconKeys,
    });
    (tentacle as any).state = {
      beaconId,
      regCommentId: 1234,
      keyPair: {
        secretKey: await bytesToBase64(beaconKeys.secretKey),
      },
    };
    (tentacle as any).operatorPublicKey = operatorKeys.publicKey;

    const accepted = await encryptBox(
      JSON.stringify({
        kind: "registration-ack",
        beaconId,
        registrationId: "1234",
        acceptedAt: "2026-07-16T12:00:00.000Z",
      }),
      beaconKeys.publicKey,
      operatorKeys.secretKey,
    );
    await expect((tentacle as any).decryptTaskComment({
      type: "deploy",
      seq: "reg-ack",
      ref: "reg-ack",
      ...accepted,
    })).resolves.toEqual([]);
    expect((tentacle as any).registrationAckReceived).toBe(true);

    (tentacle as any).registrationAckReceived = false;
    (tentacle as any).pendingRegistrationSequence = 41;
    const relayed = await encryptBox(
      JSON.stringify({
        kind: "registration-ack",
        beaconId,
        registrationId: "999",
        registrationSequence: 41,
        acceptedAt: "2026-07-16T12:00:00.000Z",
      }),
      beaconKeys.publicKey,
      operatorKeys.secretKey,
    );
    await expect((tentacle as any).decryptTaskComment({
      type: "deploy",
      seq: "reg-ack",
      ref: "reg-ack",
      ...relayed,
    })).resolves.toEqual([]);
    expect((tentacle as any).registrationAckReceived).toBe(true);

    (tentacle as any).registrationAckReceived = false;
    const stale = await encryptBox(
      JSON.stringify({
        kind: "registration-ack",
        beaconId,
        registrationId: "999",
        registrationSequence: 40,
        acceptedAt: "2026-07-16T12:00:00.000Z",
      }),
      beaconKeys.publicKey,
      operatorKeys.secretKey,
    );
    await expect((tentacle as any).decryptTaskComment({
      type: "deploy",
      seq: "reg-ack",
      ref: "reg-ack",
      ...stale,
    })).rejects.toThrow(
      "Decrypted task payload is neither a task array nor registration ACK",
    );
    expect((tentacle as any).registrationAckReceived).toBe(false);
  });
});
