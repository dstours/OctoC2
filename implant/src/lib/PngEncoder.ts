/**
 * OctoC2 — PngEncoder
 *
 * Pure-TypeScript PNG encode/decode using node:zlib for deflate/inflate.
 * Produces minimal RGBA PNGs suitable for LSB steganography via StegoCodec.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { StegoCodec } from "./StegoCodec.ts";

// ── CRC32 table ──────────────────────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false); // length
  chunk.set(typeBytes, 4);               // type
  chunk.set(data, 8);                    // data
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput), false); // CRC
  return chunk;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Encode RGBA pixels (width×height×4 bytes) into a minimal PNG file */
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  // PNG signature
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = writeChunk("IHDR", ihdrData);

  // Raw image data: each row has a filter byte (0 = None) + row pixels
  const rowSize = width * 4;
  const rawData = new Uint8Array(height * (1 + rowSize));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + rowSize)] = 0; // filter byte: None
    rawData.set(pixels.subarray(y * rowSize, (y + 1) * rowSize), y * (1 + rowSize) + 1);
  }

  // IDAT chunk: zlib-compressed raw data
  const compressed = deflateSync(Buffer.from(rawData));
  const idat = writeChunk("IDAT", new Uint8Array(compressed));

  // IEND chunk
  const iend = writeChunk("IEND", new Uint8Array(0));

  // Concatenate all parts
  const total = sig.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of [sig, ihdr, idat, iend]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** Decode a PNG file (encoded by encodePng) back to RGBA pixels */
export function decodePng(pngBytes: Uint8Array): { pixels: Uint8Array; width: number; height: number } {
  // Skip 8-byte PNG signature
  let pos = 8;
  let width = 0, height = 0;
  let idatData: Uint8Array | null = null;

  while (pos < pngBytes.length - 12) {
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset + pos);
    const chunkLen = view.getUint32(0, false);
    const type = String.fromCharCode(
      pngBytes[pos + 4]!, pngBytes[pos + 5]!, pngBytes[pos + 6]!, pngBytes[pos + 7]!
    );
    const dataStart = pos + 8;

    if (type === "IHDR") {
      const ihdrView = new DataView(pngBytes.buffer, pngBytes.byteOffset + dataStart);
      width  = ihdrView.getUint32(0, false);
      height = ihdrView.getUint32(4, false);
    } else if (type === "IDAT") {
      idatData = pngBytes.subarray(dataStart, dataStart + chunkLen);
    } else if (type === "IEND") {
      break;
    }

    pos += 12 + chunkLen; // length(4) + type(4) + data(chunkLen) + crc(4)
  }

  if (!idatData || width === 0 || height === 0) {
    throw new Error("decodePng: invalid or unsupported PNG");
  }

  // Decompress IDAT
  const rawData = new Uint8Array(inflateSync(Buffer.from(idatData)));

  // Strip filter bytes (first byte of each row)
  const rowSize = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcOff = y * (1 + rowSize) + 1;
    pixels.set(rawData.subarray(srcOff, srcOff + rowSize), y * rowSize);
  }

  return { pixels, width, height };
}

/** Create a pixel buffer large enough to hold payloadLen bytes */
export function makePixelBuffer(payloadLen: number): { pixels: Uint8Array; width: number; height: number } {
  const pixelsNeeded = StegoCodec.pixelsNeeded(payloadLen);
  const width = 100;
  const height = Math.ceil(pixelsNeeded / width) + 1; // +1 for rounding safety
  const pixels = new Uint8Array(width * height * 4);
  // Fill alpha to 255 so stego LSB flips don't make fully transparent
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return { pixels, width, height };
}
