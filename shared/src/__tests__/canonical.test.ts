import { describe, expect, it } from "bun:test";
import {
  CanonicalizationError,
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  hashCanonical,
} from "../canonical.ts";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalJson({
        z: 1,
        a: { y: true, x: ["second", "first"] },
        n: null,
      }),
    ).toBe(
      '{"a":{"x":["second","first"],"y":true},"n":null,"z":1}',
    );
  });

  it("produces identical hashes for different insertion orders", async () => {
    const left = await hashCanonical({
      taskId: "task-1",
      success: true,
      metadata: { exitCode: 0, shellInvoked: true },
    });
    const right = await hashCanonical({
      metadata: { shellInvoked: true, exitCode: 0 },
      success: true,
      taskId: "task-1",
    });
    expect(left).toBe(right);
  });

  it("rejects ambiguous or lossy values", () => {
    expect(() => canonicalJson({ omitted: undefined })).toThrow(
      CanonicalizationError,
    );
    expect(() => canonicalJson({ infinite: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalizationError,
    );
    expect(() => canonicalJson(new Date())).toThrow(CanonicalizationError);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalizationError);

    const sparse = new Array<unknown>(1);
    expect(() => canonicalJson(sparse)).toThrow(CanonicalizationError);
  });

  it("encodes base64url safely before any explicit sodium initialization", async () => {
    const encoded = encodeBase64Url(new Uint8Array([1, 2, 3, 254, 255]));
    expect(encoded).toBe("AQID_v8");
    expect(await decodeBase64Url(encoded)).toEqual(
      new Uint8Array([1, 2, 3, 254, 255]),
    );
  });
});
