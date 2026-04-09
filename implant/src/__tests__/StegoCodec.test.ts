import { describe, it, expect } from "bun:test";
import { StegoCodec } from "../lib/StegoCodec.ts";

// Helper: create a zeroed RGBA pixel buffer for `n` pixels
function makePixels(n: number): Uint8Array {
  return new Uint8Array(n * 4);
}

// Helper: create a pixel buffer filled with a repeating pattern
// (non-zero alpha so we can verify non-alpha channels are untouched)
function makeFilledPixels(n: number): Uint8Array {
  const buf = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    buf[i * 4 + 0] = 0xde; // R
    buf[i * 4 + 1] = 0xad; // G
    buf[i * 4 + 2] = 0xbe; // B
    buf[i * 4 + 3] = 0xef; // A — encode will only modify LSB of this
  }
  return buf;
}

describe("StegoCodec", () => {
  it("pixelsNeeded(0) === 32", () => {
    expect(StegoCodec.pixelsNeeded(0)).toBe(32);
  });

  it("pixelsNeeded(4) === 64", () => {
    expect(StegoCodec.pixelsNeeded(4)).toBe(64);
  });

  it("encode + decode round-trip — 1 byte payload", () => {
    const payload = new Uint8Array([0xab]);
    const pixels = makePixels(StegoCodec.pixelsNeeded(1));
    StegoCodec.encode(pixels, payload);
    const decoded = StegoCodec.decode(pixels);
    expect(decoded).not.toBeNull();
    expect(decoded!).toEqual(payload);
  });

  it("encode + decode round-trip — 100 byte payload", () => {
    const payload = new Uint8Array(100);
    for (let i = 0; i < 100; i++) payload[i] = (i * 37 + 13) & 0xff;
    const pixels = makePixels(StegoCodec.pixelsNeeded(100));
    StegoCodec.encode(pixels, payload);
    const decoded = StegoCodec.decode(pixels);
    expect(decoded).not.toBeNull();
    expect(decoded!).toEqual(payload);
  });

  it("encode throws when buffer too small", () => {
    const payload = new Uint8Array(10);
    // Provide only 1 pixel (4 bytes) — far too small
    const pixels = new Uint8Array(4);
    expect(() => StegoCodec.encode(pixels, payload)).toThrow();
  });

  it("decode returns null when buffer is too small for length header", () => {
    // Need 32 pixels (128 bytes) for the header; provide only 31 pixels
    const pixels = new Uint8Array(31 * 4);
    expect(StegoCodec.decode(pixels)).toBeNull();
  });

  it("decode returns null when embedded length exceeds maxPayloadBytes", () => {
    // Encode a 50-byte payload, then try to decode with maxPayloadBytes=10
    const payload = new Uint8Array(50).fill(0x55);
    const pixels = makePixels(StegoCodec.pixelsNeeded(50));
    StegoCodec.encode(pixels, payload);
    // The real length (50) exceeds our imposed limit (10)
    const decoded = StegoCodec.decode(pixels, 10);
    expect(decoded).toBeNull();
  });

  it("encode does not modify non-alpha channels", () => {
    const payload = new Uint8Array([0xff, 0x00, 0xaa]);
    const n = StegoCodec.pixelsNeeded(3);
    const pixels = makeFilledPixels(n);
    StegoCodec.encode(pixels, payload);

    // Verify R, G, B channels are unchanged for every pixel
    for (let i = 0; i < n; i++) {
      expect(pixels[i * 4 + 0]).toBe(0xde); // R unchanged
      expect(pixels[i * 4 + 1]).toBe(0xad); // G unchanged
      expect(pixels[i * 4 + 2]).toBe(0xbe); // B unchanged
      // Alpha channel LSB may differ — that's expected
    }
  });
});
