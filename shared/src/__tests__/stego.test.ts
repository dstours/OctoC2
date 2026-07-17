import { describe, expect, it } from "bun:test";
import {
  StegoCodec,
  decodeRgbaPng,
  decodeStegoPng,
  encodeRgbaPng,
  encodeStegoPng,
  makeStegoPixelBuffer,
} from "../stego.ts";

describe("shared steganography transport", () => {
  it("round-trips binary payloads through codec and PNG", () => {
    const payload = new Uint8Array(8_193);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 73 + 19) & 0xff;
    }
    expect(decodeStegoPng(encodeStegoPng(payload))).toEqual(payload);
  });

  it("preserves RGBA pixels through the PNG codec", () => {
    const image = makeStegoPixelBuffer(256);
    StegoCodec.encode(
      image.pixels,
      new TextEncoder().encode("shared codec"),
    );
    const decoded = decodeRgbaPng(
      encodeRgbaPng(image.pixels, image.width, image.height),
    );
    expect(decoded.width).toBe(image.width);
    expect(decoded.height).toBe(image.height);
    expect(decoded.pixels).toEqual(image.pixels);
  });

  it("rejects malformed headers and configured size violations", () => {
    expect(StegoCodec.decode(new Uint8Array(31 * 4))).toBeNull();

    const payload = new TextEncoder().encode("payload");
    const png = encodeStegoPng(payload);
    expect(decodeStegoPng(png, payload.length - 1)).toBeNull();

    const corrupt = png.slice();
    corrupt[0] = 0;
    expect(() => decodeStegoPng(corrupt)).toThrow("invalid PNG signature");
  });
});
