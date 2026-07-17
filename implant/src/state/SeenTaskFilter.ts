import { createHash } from "node:crypto";

export interface SeenTaskFilterData {
  version: 1;
  bitCount: 262_144;
  hashCount: 7;
  bits: string;
}

const BIT_COUNT = 262_144;
const BYTE_COUNT = BIT_COUNT / 8;
const HASH_COUNT = 7;

/**
 * Fixed-size, append-only task-ID membership filter.
 *
 * It deliberately permits false positives (which fail closed by refusing a
 * fresh task) but never false negatives for IDs successfully added to the
 * persisted filter. This lets detailed result records remain bounded without
 * forgetting that an older command already began execution.
 */
export class SeenTaskFilter {
  private constructor(private readonly bytes: Uint8Array) {}

  static empty(): SeenTaskFilter {
    return new SeenTaskFilter(new Uint8Array(BYTE_COUNT));
  }

  static fromJSON(value: unknown): SeenTaskFilter {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error("seenTaskFilter must be an object");
    }
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    const expectedKeys = ["bitCount", "bits", "hashCount", "version"];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new Error("seenTaskFilter fields are invalid");
    }
    if (
      candidate["version"] !== 1 ||
      candidate["bitCount"] !== BIT_COUNT ||
      candidate["hashCount"] !== HASH_COUNT ||
      typeof candidate["bits"] !== "string"
    ) {
      throw new Error("seenTaskFilter parameters are invalid");
    }
    const decoded = Buffer.from(candidate["bits"], "base64url");
    if (
      decoded.length !== BYTE_COUNT ||
      decoded.toString("base64url") !== candidate["bits"]
    ) {
      throw new Error("seenTaskFilter bits are invalid");
    }
    return new SeenTaskFilter(new Uint8Array(decoded));
  }

  has(taskId: string): boolean {
    this.requireTaskId(taskId);
    return this.indexes(taskId).every((index) =>
      (this.bytes[index >>> 3]! & (1 << (index & 7))) !== 0
    );
  }

  add(taskId: string): void {
    this.requireTaskId(taskId);
    for (const index of this.indexes(taskId)) {
      this.bytes[index >>> 3] =
        this.bytes[index >>> 3]! | (1 << (index & 7));
    }
  }

  toJSON(): SeenTaskFilterData {
    return {
      version: 1,
      bitCount: BIT_COUNT,
      hashCount: HASH_COUNT,
      bits: Buffer.from(this.bytes).toString("base64url"),
    };
  }

  private indexes(taskId: string): number[] {
    const digest = createHash("sha256").update(taskId, "utf8").digest();
    return Array.from(
      { length: HASH_COUNT },
      (_, index) => digest.readUInt32BE(index * 4) % BIT_COUNT,
    );
  }

  private requireTaskId(taskId: string): void {
    if (!taskId.trim()) throw new Error("taskId must be non-empty");
  }
}
