export type SniffedMediaFormat = 'ID3' | 'OGG' | 'FLAC' | 'MP4' | 'UNKNOWN';

/**
 * Port of AntennaPod's `MediaFormatDetector`: inspects the first up to 64 magic bytes
 * of an audio/video stream without relying on file extensions.
 */
export function sniffMediaFormat(bytes: Uint8Array): SniffedMediaFormat {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // "ID3"
    return 'ID3';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    // "OggS"
    return 'OGG';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    // "fLaC"
    return 'FLAC';
  }
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    // "....ftyp"
    return 'MP4';
  }
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x6d &&
    bytes[5] === 0x6f &&
    bytes[6] === 0x6f &&
    bytes[7] === 0x76
  ) {
    // "....moov"
    return 'MP4';
  }
  return 'UNKNOWN';
}
