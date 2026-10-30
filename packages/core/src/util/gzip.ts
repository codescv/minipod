import { MiniPodError } from '../errors';

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function runTransformStream(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();

  // Write and read concurrently so large (>800 KB) buffers never deadlock on stream backpressure.
  const writePromise = (async () => {
    const slice =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await writer.write(slice as unknown as BufferSource);
    await writer.close();
  })();

  const readPromise = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    return concatChunks(chunks, total);
  })();

  try {
    const [, output] = await Promise.all([writePromise, readPromise]);
    return output;
  } catch (err) {
    throw new MiniPodError('sync-schema', 'Failed to process gzip stream', { cause: err });
  }
}

/**
 * Compresses raw bytes with gzip via standard `CompressionStream('gzip')`.
 */
export async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new MiniPodError('unsupported', 'CompressionStream is not available in this runtime');
  }
  return runTransformStream(bytes, new CompressionStream('gzip'));
}

/**
 * Decompresses gzip bytes via standard `DecompressionStream('gzip')`.
 */
export async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new MiniPodError('unsupported', 'DecompressionStream is not available in this runtime');
  }
  return runTransformStream(bytes, new DecompressionStream('gzip'));
}

/** Checks for gzip magic header bytes (`0x1f 0x8b`). */
export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Checks if a string starts with Base64-encoded gzip magic (`H4sI`). */
export function isGzipBase64(content: string): boolean {
  return content.trimStart().startsWith('H4sI');
}
