import {
  createUnsignedEnvelope,
  ed25519KeyId,
  encodeBase64Url,
  generateEd25519KeyPair,
  signEnvelope,
} from "@octoc2/shared";
import type { BeaconConfig, CheckinPayload } from "../types.ts";

interface SigningContext {
  readonly keyPair: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
  readonly keyId: string;
  sequence: number;
}

const signingContexts = new WeakMap<BeaconConfig, SigningContext>();

async function signingContext(config: BeaconConfig): Promise<SigningContext> {
  const existing = signingContexts.get(config);
  if (existing) return existing;

  const keyPair = config.signingKeyPair ?? await generateEd25519KeyPair();
  const keyId = config.signingKeyId ?? await ed25519KeyId(keyPair.publicKey);
  config.signingKeyPair = keyPair;
  config.signingKeyId = keyId;

  const created = { keyPair, keyId, sequence: 0 };
  signingContexts.set(config, created);
  return created;
}

/**
 * Build the same canonical Ed25519 check-in envelope used by the implant
 * runtime. Each config keeps one signing identity and a monotonic sequence.
 */
export async function signedCheckin(
  config: BeaconConfig,
  overrides: Partial<CheckinPayload> = {},
): Promise<CheckinPayload> {
  const signing = await signingContext(config);
  const checkinAt = overrides.checkinAt ?? new Date().toISOString();
  const publicKey = encodeBase64Url(config.beaconKeyPair.publicKey);
  const checkin = {
    beaconId: config.id,
    publicKey,
    hostname: overrides.hostname ?? "host",
    username: overrides.username ?? "user",
    os: overrides.os ?? "linux",
    arch: overrides.arch ?? "x64",
    pid: overrides.pid ?? 1234,
    checkinAt,
  };
  const identity = await signEnvelope(
    createUnsignedEnvelope({
      kind: "checkin",
      signerId: config.id,
      keyId: signing.keyId,
      issuedAt: checkinAt,
      sequence: ++signing.sequence,
      payload: {
        beaconId: checkin.beaconId,
        encryptionPublicKey: checkin.publicKey,
        signingPublicKey: encodeBase64Url(signing.keyPair.publicKey),
        hostname: checkin.hostname,
        username: checkin.username,
        os: checkin.os,
        arch: checkin.arch,
        pid: checkin.pid,
        checkinAt: checkin.checkinAt,
      },
    }),
    signing.keyPair.secretKey,
  );

  return { ...checkin, identity };
}
