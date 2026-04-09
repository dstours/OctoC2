// dashboard/src/types/result.ts

import type { TentacleId } from './beacon';

/**
 * An encrypted result blob returned by a beacon.
 * The ciphertext is decrypted client-side using libsodium and the
 * operator's private key. Until decrypted, only metadata is visible.
 */
export interface TaskResult {
  /** ID of the task this result is responding to. */
  taskId: string;
  /** ID of the beacon that produced this result. */
  beaconId: string;
  /** ISO 8601 timestamp of when the result was received. */
  receivedAt: string;
  /** Which tentacle channel was used to return the result. */
  tentacle: TentacleId;
  /** Base64-encoded libsodium secretbox ciphertext. */
  ciphertext: string;
  /** Base64-encoded nonce used for encryption. */
  nonce: string;
  /** Byte length of the ciphertext (shown before decryption). */
  sizeBytes: number;
}

/**
 * Decrypted content of a TaskResult. Only exists in memory after the
 * operator supplies their private key. Never written to localStorage
 * or sent over the network.
 */
export interface DecryptedResult {
  taskId: string;
  /** ID of the beacon that produced this result — mirrors TaskResult.beaconId for standalone use. */
  beaconId: string;
  /** Exit code of the executed command (0 = success). Null for non-shell tasks. */
  exitCode: number | null;
  /** Standard output from the command. */
  stdout: string;
  /** Standard error from the command. */
  stderr: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** ISO 8601 timestamp of execution on the target. */
  executedAt: string;
  /** Arbitrary metadata the implant chose to include. */
  meta?: Record<string, unknown>;
}

/** Wraps a TaskResult with its decrypted content once the operator decrypts it. */
export interface DecryptResult {
  raw: TaskResult;
  decrypted: DecryptedResult;
}
