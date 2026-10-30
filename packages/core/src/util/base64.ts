const CHUNK_SIZE = 0x8000;

/**
 * Encodes a `Uint8Array` into standard RFC 4648 Base64 without line wrapping.
 * Safe for arbitrarily large buffers (avoids call-stack overflow).
 */
export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
    let binary = '';
    for (let i = 0; i < slice.length; i++) {
      binary += String.fromCharCode(slice[i]!);
    }
    chunks.push(binary);
  }
  return btoa(chunks.join(''));
}

/**
 * Decodes standard or URL-safe Base64 (ignoring ASCII whitespace) into a `Uint8Array`.
 */
export function decodeBase64(base64: string): Uint8Array {
  const cleaned = base64.replace(/[\r\n\s]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length === 0) return new Uint8Array(0);
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Encodes a string as ISO-8859-1 bytes matching Java `String.getBytes("ISO-8859-1")`
 * (code points > 0xFF map to `0x3F` `'?'`).
 */
export function encodeIso88591(input: string): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    out[i] = code <= 0xff ? code : 0x3f;
  }
  return out;
}

/**
 * Decodes ISO-8859-1 bytes into a JS string.
 */
export function decodeIso88591(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}
