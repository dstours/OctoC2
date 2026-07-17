import sodium from "libsodium-wrappers";
import {
  canonicalJson,
  canonicalJsonBytes,
  decodeBase64Url,
  encodeBase64Url,
  hashCanonical,
  hashText,
} from "./canonical.ts";
import type { TaskResult } from "./tasks.ts";

export const SIGNED_ENVELOPE_PROTOCOL = "octoc2" as const;
export const SIGNED_ENVELOPE_VERSION = 1 as const;
export const SIGNED_ENVELOPE_DOMAIN = "octoc2:signed-envelope:v1" as const;

const textEncoder = new TextEncoder();

export interface CheckinSignaturePayload {
  beaconId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  pid: number;
  checkinAt: string;
}

export interface RegistrationSignaturePayload {
  beaconId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  provisionedAt: string;
}

export interface RegistrationAckSignaturePayload {
  beaconId: string;
  registrationHash: string;
  acceptedAt: string;
  serverId: string;
}

export interface TaskResultSignaturePayload {
  taskId: string;
  beaconId: string;
  success: boolean;
  outputHash: string;
  dataHash: string | null;
  metadataHash: string | null;
  completedAt: string;
}

export interface RecoverySignaturePayload {
  beaconId: string;
  generation: number;
  expiresAt: string;
  configurationHash: string;
}

export interface SignedEnvelopePayloads {
  checkin: CheckinSignaturePayload;
  registration: RegistrationSignaturePayload;
  "registration-ack": RegistrationAckSignaturePayload;
  "task-result": TaskResultSignaturePayload;
  recovery: RecoverySignaturePayload;
}

export type SignedEnvelopeKind = keyof SignedEnvelopePayloads;

export interface UnsignedEnvelope<K extends SignedEnvelopeKind = SignedEnvelopeKind> {
  protocol: typeof SIGNED_ENVELOPE_PROTOCOL;
  version: typeof SIGNED_ENVELOPE_VERSION;
  kind: K;
  signerId: string;
  keyId: string;
  issuedAt: string;
  /** Monotonic per-signer sequence used by the verifier for replay rejection. */
  sequence: number;
  payload: SignedEnvelopePayloads[K];
}

export type SignedEnvelope<K extends SignedEnvelopeKind = SignedEnvelopeKind> =
  UnsignedEnvelope<K> & {
    signature: string;
  };

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `envelope fields must be exactly: ${sortedExpected.join(", ")}`,
    );
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertIsoTimestamp(value: unknown, name: string): asserts value is string {
  assertNonEmptyString(value, name);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO-8601 timestamp`);
  }
}

function isEnvelopeKind(value: unknown): value is SignedEnvelopeKind {
  return value === "checkin" ||
    value === "registration" ||
    value === "registration-ack" ||
    value === "task-result" ||
    value === "recovery";
}

function assertUnsignedEnvelope(
  value: unknown,
): asserts value is UnsignedEnvelope {
  if (!isPlainRecord(value)) {
    throw new TypeError("signed envelope must be a plain object");
  }
  assertExactKeys(value, [
    "protocol",
    "version",
    "kind",
    "signerId",
    "keyId",
    "issuedAt",
    "sequence",
    "payload",
  ]);
  if (value["protocol"] !== SIGNED_ENVELOPE_PROTOCOL) {
    throw new TypeError(`unsupported envelope protocol '${String(value["protocol"])}'`);
  }
  if (value["version"] !== SIGNED_ENVELOPE_VERSION) {
    throw new TypeError(`unsupported envelope version '${String(value["version"])}'`);
  }
  if (!isEnvelopeKind(value["kind"])) {
    throw new TypeError(`unsupported envelope kind '${String(value["kind"])}'`);
  }
  assertNonEmptyString(value["signerId"], "signerId");
  assertNonEmptyString(value["keyId"], "keyId");
  assertIsoTimestamp(value["issuedAt"], "issuedAt");
  if (
    !Number.isSafeInteger(value["sequence"]) ||
    (value["sequence"] as number) < 0
  ) {
    throw new TypeError("sequence must be a non-negative safe integer");
  }
  if (!isPlainRecord(value["payload"])) {
    throw new TypeError("payload must be a plain object");
  }
  canonicalJson(value["payload"]);
}

export function assertSignedEnvelope(
  value: unknown,
): asserts value is SignedEnvelope {
  if (!isPlainRecord(value)) {
    throw new TypeError("signed envelope must be a plain object");
  }
  assertExactKeys(value, [
    "protocol",
    "version",
    "kind",
    "signerId",
    "keyId",
    "issuedAt",
    "sequence",
    "payload",
    "signature",
  ]);
  assertNonEmptyString(value["signature"], "signature");
  const {
    protocol,
    version,
    kind,
    signerId,
    keyId,
    issuedAt,
    sequence,
    payload,
  } = value;
  assertUnsignedEnvelope({
    protocol,
    version,
    kind,
    signerId,
    keyId,
    issuedAt,
    sequence,
    payload,
  });
}

export function createUnsignedEnvelope<K extends SignedEnvelopeKind>(
  input: Omit<UnsignedEnvelope<K>, "protocol" | "version">,
): UnsignedEnvelope<K> {
  const envelope: UnsignedEnvelope<K> = {
    protocol: SIGNED_ENVELOPE_PROTOCOL,
    version: SIGNED_ENVELOPE_VERSION,
    kind: input.kind,
    signerId: input.signerId,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    sequence: input.sequence,
    payload: input.payload,
  };
  assertUnsignedEnvelope(envelope);
  return envelope;
}

function unsignedPart<K extends SignedEnvelopeKind>(
  envelope: SignedEnvelope<K>,
): UnsignedEnvelope<K> {
  const {
    protocol,
    version,
    kind,
    signerId,
    keyId,
    issuedAt,
    sequence,
    payload,
  } = envelope;
  return {
    protocol,
    version,
    kind,
    signerId,
    keyId,
    issuedAt,
    sequence,
    payload,
  };
}

export function envelopeSigningBytes(
  envelope: UnsignedEnvelope,
): Uint8Array {
  assertUnsignedEnvelope(envelope);
  const domain = textEncoder.encode(`${SIGNED_ENVELOPE_DOMAIN}\n`);
  const body = canonicalJsonBytes(envelope);
  const result = new Uint8Array(domain.length + body.length);
  result.set(domain, 0);
  result.set(body, domain.length);
  return result;
}

async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

function assertKeyLength(
  value: Uint8Array,
  expected: number,
  name: string,
): void {
  if (!(value instanceof Uint8Array) || value.length !== expected) {
    throw new TypeError(`${name} must contain exactly ${expected} bytes`);
  }
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const api = await ready();
  const pair = api.crypto_sign_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

export async function ed25519KeyId(publicKey: Uint8Array): Promise<string> {
  const api = await ready();
  assertKeyLength(publicKey, api.crypto_sign_PUBLICKEYBYTES, "publicKey");
  const digest = api.crypto_generichash(16, publicKey, null);
  return `ed25519:${api.to_base64(
    digest,
    api.base64_variants.URLSAFE_NO_PADDING,
  )}`;
}

export async function signEnvelope<K extends SignedEnvelopeKind>(
  envelope: UnsignedEnvelope<K>,
  secretKey: Uint8Array,
): Promise<SignedEnvelope<K>> {
  const api = await ready();
  assertUnsignedEnvelope(envelope);
  assertKeyLength(secretKey, api.crypto_sign_SECRETKEYBYTES, "secretKey");
  const signature = api.crypto_sign_detached(
    envelopeSigningBytes(envelope),
    secretKey,
  );
  return {
    ...envelope,
    signature: api.to_base64(
      signature,
      api.base64_variants.URLSAFE_NO_PADDING,
    ),
  };
}

export async function verifyEnvelope(
  envelope: unknown,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    const api = await ready();
    assertSignedEnvelope(envelope);
    assertKeyLength(publicKey, api.crypto_sign_PUBLICKEYBYTES, "publicKey");
    const signature = await decodeBase64Url(envelope.signature);
    if (signature.length !== api.crypto_sign_BYTES) return false;
    return api.crypto_sign_verify_detached(
      signature,
      envelopeSigningBytes(unsignedPart(envelope)),
      publicKey,
    );
  } catch {
    return false;
  }
}

export function serializeSignedEnvelope(envelope: SignedEnvelope): string {
  assertSignedEnvelope(envelope);
  return canonicalJson(envelope);
}

export function parseSignedEnvelope(serialized: string): SignedEnvelope {
  const parsed: unknown = JSON.parse(serialized);
  assertSignedEnvelope(parsed);
  return parsed;
}

export async function createTaskResultSignaturePayload(
  result: TaskResult,
): Promise<TaskResultSignaturePayload> {
  return {
    taskId: result.taskId,
    beaconId: result.beaconId,
    success: result.success,
    outputHash: await hashText(result.output),
    dataHash: result.data === undefined ? null : await hashText(result.data),
    metadataHash: result.metadata === undefined
      ? null
      : await hashCanonical(result.metadata),
    completedAt: result.completedAt,
  };
}

export { encodeBase64Url };
