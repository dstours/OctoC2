/**
 * OctoC2 — StegoCodec
 *
 * LSB (Least Significant Bit) steganography codec.
 * Hides arbitrary bytes inside a raw RGBA pixel buffer by encoding
 * each payload bit into the least-significant bit of the alpha channel
 * of successive pixels.
 *
 * Format:
 *   Bytes 0-3  — 32-bit big-endian payload length (in bytes)
 *   Bytes 4-N  — payload bytes
 *
 * Each payload byte uses 8 pixels (one bit per alpha LSB).
 * The header uses 32 pixels. Total pixels needed = 32 + payloadLen * 8.
 *
 * OPSEC: alpha channel changes of ±1 per pixel are visually imperceptible
 * in images with any transparency variation, and indistinguishable from
 * standard image compression artefacts in opaque images.
 */

export class StegoCodec {
  /**
   * Encode `payload` bytes into an RGBA pixel buffer.
   * Modifies `pixels` in-place. Returns the modified buffer.
   * Throws if the buffer is too small to hold the payload.
   *
   * @param pixels  Uint8Array of RGBA pixels (4 bytes per pixel, length = width*height*4)
   * @param payload Bytes to hide
   */
  static encode(pixels: Uint8Array, payload: Uint8Array): Uint8Array {
    const needed = StegoCodec.pixelsNeeded(payload.length);
    if (pixels.length < needed * 4) {
      throw new Error(
        `StegoCodec.encode: pixel buffer too small — need ${needed * 4} bytes for ${payload.length}-byte payload, got ${pixels.length}`
      );
    }

    // Build the full bit stream: 4-byte big-endian length header + payload
    const lenHeader = new Uint8Array(4);
    const view = new DataView(lenHeader.buffer);
    view.setUint32(0, payload.length, false); // big-endian

    const allBytes = new Uint8Array(4 + payload.length);
    allBytes.set(lenHeader, 0);
    allBytes.set(payload, 4);

    // Encode one bit per pixel alpha channel LSB
    // Bit 7 (MSB) of byte 0 goes into pixel 0, bit 6 into pixel 1, ...
    let pixelIndex = 0;
    for (let i = 0; i < allBytes.length; i++) {
      const byte = allBytes[i]!;
      for (let bit = 7; bit >= 0; bit--) {
        const bitValue = (byte >>> bit) & 1;
        const alphaIndex = pixelIndex * 4 + 3;
        // Set LSB of alpha to the bit value
        pixels[alphaIndex] = (pixels[alphaIndex]! & 0xfe) | bitValue;
        pixelIndex++;
      }
    }

    return pixels;
  }

  /**
   * Decode a payload from an RGBA pixel buffer.
   * Returns the hidden payload bytes, or null if the buffer is too small
   * or the length header is invalid.
   *
   * @param pixels  Uint8Array of RGBA pixels
   * @param maxPayloadBytes  Maximum expected payload size (sanity check)
   */
  static decode(pixels: Uint8Array, maxPayloadBytes?: number): Uint8Array | null {
    const maxAllowed = maxPayloadBytes ?? 1024 * 1024; // default 1 MB

    // Need at least 32 pixels (4 bytes * 8 bits/byte) for the length header
    if (pixels.length < 32 * 4) {
      return null;
    }

    // Read 32 bits from alpha LSBs to reconstruct the 4-byte length header
    const lenBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      let byte = 0;
      for (let bit = 7; bit >= 0; bit--) {
        const pixelIndex = i * 8 + (7 - bit);
        const alphaIndex = pixelIndex * 4 + 3;
        const lsb = pixels[alphaIndex]! & 1;
        byte |= lsb << bit;
      }
      lenBytes[i] = byte;
    }

    const lenView = new DataView(lenBytes.buffer);
    const payloadLen = lenView.getUint32(0, false); // big-endian

    // Sanity checks
    if (payloadLen === 0 || payloadLen > maxAllowed) {
      return null;
    }

    // Verify there are enough pixels for the full payload
    const totalPixelsNeeded = StegoCodec.pixelsNeeded(payloadLen);
    if (pixels.length < totalPixelsNeeded * 4) {
      return null;
    }

    // Read payloadLen * 8 more bits starting at pixel 32
    const payload = new Uint8Array(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      let byte = 0;
      for (let bit = 7; bit >= 0; bit--) {
        const pixelIndex = 32 + i * 8 + (7 - bit);
        const alphaIndex = pixelIndex * 4 + 3;
        const lsb = pixels[alphaIndex]! & 1;
        byte |= lsb << bit;
      }
      payload[i] = byte;
    }

    return payload;
  }

  /** Returns the minimum pixel count needed to store payloadLen bytes. */
  static pixelsNeeded(payloadLen: number): number {
    return 32 + payloadLen * 8; // 32 for 4-byte length header, 8 per payload byte
  }
}
