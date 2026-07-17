import { deflateSync, inflateSync } from "node:zlib";

const LENGTH_HEADER_BYTES = 4;
const BITS_PER_BYTE = 8;
const RGBA_BYTES_PER_PIXEL = 4;
const ALPHA_OFFSET = 3;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class StegoCodec {
  static pixelsNeeded(payloadLength: number): number {
    if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
      throw new RangeError("payloadLength must be a non-negative safe integer");
    }
    return (LENGTH_HEADER_BYTES + payloadLength) * BITS_PER_BYTE;
  }

  static encode(pixels: Uint8Array, payload: Uint8Array): Uint8Array {
    if (payload.length === 0) {
      throw new Error("StegoCodec.encode: empty payloads are not supported");
    }
    const requiredBytes =
      StegoCodec.pixelsNeeded(payload.length) * RGBA_BYTES_PER_PIXEL;
    if (
      pixels.length < requiredBytes ||
      pixels.length % RGBA_BYTES_PER_PIXEL !== 0
    ) {
      throw new Error(
        `StegoCodec.encode: RGBA buffer is too small; need ${requiredBytes} bytes, got ${pixels.length}`,
      );
    }

    const framed = new Uint8Array(LENGTH_HEADER_BYTES + payload.length);
    new DataView(framed.buffer).setUint32(0, payload.length, false);
    framed.set(payload, LENGTH_HEADER_BYTES);

    let pixel = 0;
    for (const byte of framed) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        const alpha = pixel * RGBA_BYTES_PER_PIXEL + ALPHA_OFFSET;
        pixels[alpha] = (pixels[alpha]! & 0xfe) | ((byte >>> bit) & 1);
        pixel += 1;
      }
    }
    return pixels;
  }

  static decode(
    pixels: Uint8Array,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  ): Uint8Array | null {
    if (
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes <= 0 ||
      pixels.length % RGBA_BYTES_PER_PIXEL !== 0 ||
      pixels.length <
        LENGTH_HEADER_BYTES * BITS_PER_BYTE * RGBA_BYTES_PER_PIXEL
    ) {
      return null;
    }

    const lengthBytes = readBytesFromAlphaLsb(
      pixels,
      0,
      LENGTH_HEADER_BYTES,
    );
    const payloadLength = new DataView(
      lengthBytes.buffer,
      lengthBytes.byteOffset,
      lengthBytes.byteLength,
    ).getUint32(0, false);
    if (payloadLength === 0 || payloadLength > maxPayloadBytes) return null;

    const requiredBytes =
      StegoCodec.pixelsNeeded(payloadLength) * RGBA_BYTES_PER_PIXEL;
    if (requiredBytes > pixels.length) return null;
    return readBytesFromAlphaLsb(
      pixels,
      LENGTH_HEADER_BYTES * BITS_PER_BYTE,
      payloadLength,
    );
  }
}

function readBytesFromAlphaLsb(
  pixels: Uint8Array,
  startingPixel: number,
  byteLength: number,
): Uint8Array {
  const output = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    let value = 0;
    for (let bit = 7; bit >= 0; bit -= 1) {
      const pixel = startingPixel + index * BITS_PER_BYTE + (7 - bit);
      const alpha = pixel * RGBA_BYTES_PER_PIXEL + ALPHA_OFFSET;
      value |= (pixels[alpha]! & 1) << bit;
    }
    output[index] = value;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1
        ? 0xedb88320 ^ (crc >>> 1)
        : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return output;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export interface StegoPng {
  pixels: Uint8Array;
  width: number;
  height: number;
}

export function makeStegoPixelBuffer(payloadLength: number): StegoPng {
  const pixelsNeeded = StegoCodec.pixelsNeeded(payloadLength);
  const width = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(pixelsNeeded))));
  const height = Math.ceil(pixelsNeeded / width);
  const pixels = new Uint8Array(width * height * RGBA_BYTES_PER_PIXEL);
  for (
    let alpha = ALPHA_OFFSET;
    alpha < pixels.length;
    alpha += RGBA_BYTES_PER_PIXEL
  ) {
    pixels[alpha] = 255;
  }
  return { pixels, width, height };
}

export function encodeRgbaPng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels.length !== width * height * RGBA_BYTES_PER_PIXEL
  ) {
    throw new Error("encodeRgbaPng: invalid RGBA dimensions");
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rowBytes = width * RGBA_BYTES_PER_PIXEL;
  const scanlines = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    const destination = row * (rowBytes + 1);
    scanlines[destination] = 0;
    scanlines.set(
      pixels.subarray(row * rowBytes, (row + 1) * rowBytes),
      destination + 1,
    );
  }

  return concatenate([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(scanlines))),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

export function decodeRgbaPng(
  png: Uint8Array,
  maxPixels = (DEFAULT_MAX_PAYLOAD_BYTES + LENGTH_HEADER_BYTES) * BITS_PER_BYTE,
): StegoPng {
  if (
    png.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((byte, index) => png[index] !== byte)
  ) {
    throw new Error("decodeRgbaPng: invalid PNG signature");
  }

  let width = 0;
  let height = 0;
  const idatParts: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0, false);
    if (offset + 12 + length > png.length) {
      throw new Error("decodeRgbaPng: truncated PNG chunk");
    }
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (
        length !== 13 ||
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error(
          "decodeRgbaPng: only non-interlaced 8-bit RGBA PNGs are supported",
        );
      }
      const dimensions = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      width = dimensions.getUint32(0, false);
      height = dimensions.getUint32(4, false);
      if (
        width === 0 ||
        height === 0 ||
        width > maxPixels ||
        height > Math.ceil(maxPixels / width)
      ) {
        throw new Error(
          "decodeRgbaPng: image dimensions exceed the configured limit",
        );
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idatParts.length === 0) {
    throw new Error("decodeRgbaPng: missing required PNG chunks");
  }

  const rowBytes = width * RGBA_BYTES_PER_PIXEL;
  const expectedInflatedBytes = height * (rowBytes + 1);
  const inflated = new Uint8Array(
    inflateSync(concatenate(idatParts), {
      maxOutputLength: expectedInflatedBytes,
    }),
  );
  if (inflated.length !== expectedInflatedBytes) {
    throw new Error("decodeRgbaPng: unexpected decompressed image size");
  }
  const pixels = new Uint8Array(width * height * RGBA_BYTES_PER_PIXEL);
  for (let row = 0; row < height; row += 1) {
    const source = row * (rowBytes + 1);
    if (inflated[source] !== 0) {
      throw new Error("decodeRgbaPng: only PNG filter type 0 is supported");
    }
    pixels.set(
      inflated.subarray(source + 1, source + 1 + rowBytes),
      row * rowBytes,
    );
  }
  return { pixels, width, height };
}

export function encodeStegoPng(payload: Uint8Array): Uint8Array {
  const image = makeStegoPixelBuffer(payload.length);
  StegoCodec.encode(image.pixels, payload);
  return encodeRgbaPng(image.pixels, image.width, image.height);
}

export function decodeStegoPng(
  png: Uint8Array,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): Uint8Array | null {
  const { pixels } = decodeRgbaPng(
    png,
    StegoCodec.pixelsNeeded(DEFAULT_MAX_PAYLOAD_BYTES),
  );
  return StegoCodec.decode(pixels, maxPayloadBytes);
}
