import sodium from "libsodium-wrappers";

const HASH_BYTES = 32;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const textEncoder = new TextEncoder();

export class CanonicalizationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`cannot canonicalize ${path}: ${message}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

function serializeCanonical(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(path, "numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalizationError(path, `unsupported ${typeof value} value`);
    case "object":
      break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new CanonicalizationError(path, "cyclic references are not supported");
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new CanonicalizationError(
            `${path}[${index}]`,
            "sparse array entries are not supported",
          );
        }
        elements.push(
          serializeCanonical(value[index], `${path}[${index}]`, ancestors),
        );
      }
      return `[${elements.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        path,
        "only plain objects and arrays are supported",
      );
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const serialized = serializeCanonical(
          record[key],
          `${path}.${key}`,
          ancestors,
        );
        return `${JSON.stringify(key)}:${serialized}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

/**
 * Deterministic JSON with lexicographically sorted object keys.
 *
 * Undefined values, non-finite numbers, sparse arrays, class instances, and
 * cycles are rejected instead of being silently coerced or dropped.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, "$", new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}

async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    encoded += BASE64URL_ALPHABET[(combined >>> 18) & 63];
    encoded += BASE64URL_ALPHABET[(combined >>> 12) & 63];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[(combined >>> 6) & 63];
    }
    if (third !== undefined) {
      encoded += BASE64URL_ALPHABET[combined & 63];
    }
  }
  return encoded;
}

export async function decodeBase64Url(value: string): Promise<Uint8Array> {
  const api = await ready();
  return api.from_base64(
    value.trim(),
    api.base64_variants.URLSAFE_NO_PADDING,
  );
}

export async function hashBytes(value: Uint8Array): Promise<string> {
  const api = await ready();
  const digest = api.crypto_generichash(HASH_BYTES, value, null);
  return api.to_base64(digest, api.base64_variants.URLSAFE_NO_PADDING);
}

export async function hashText(value: string): Promise<string> {
  return hashBytes(textEncoder.encode(value));
}

export async function hashCanonical(value: unknown): Promise<string> {
  return hashBytes(canonicalJsonBytes(value));
}
