import type { DeviceId } from '../types';

const encoder = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : input;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_TABLE[bytes[i]!];
  }
  return out;
}

/**
 * Computes raw 20-byte SHA-1 digest via WebCrypto `crypto.subtle.digest('SHA-1')`.
 */
export async function sha1Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = toBytes(input);
  const digest = await crypto.subtle.digest('SHA-1', toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

/**
 * Computes lowercase 40-char hexadecimal SHA-1 digest via `crypto.subtle.digest('SHA-1')`.
 */
export async function sha1Hex(input: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha1Bytes(input));
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/**
 * Pure-TS FIPS 180-4 SHA-1 implementation for synchronous identity derivation
 * (`feedKey`, `episodeKey`) in synchronous store transactions. Produces identical
 * output to `await sha1Hex(input)`.
 */
export function sha1HexSync(input: string | Uint8Array): string {
  const msg = toBytes(input);
  const msgLen = msg.length;
  const bitLenHi = Math.floor((msgLen * 8) / 0x1_0000_0000);
  const bitLenLo = (msgLen * 8) >>> 0;

  // Pad message: 0x80 + 0x00... + 64-bit big-endian bit length
  const totalBytes = Math.ceil((msgLen + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(msg);
  padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, bitLenHi, false);
  view.setUint32(totalBytes - 4, bitLenLo, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5a827999;
      } else if (i < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8f1bbcdc;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return bytesToHex(out);
}

/**
 * Generates a unique install-level device ID: `"d_" + 16 random bytes hex`.
 */
export function generateDeviceId(): DeviceId {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `d_${bytesToHex(bytes)}`;
}
