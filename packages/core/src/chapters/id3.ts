import type { Chapter } from '../types';
import { decodeIso88591 } from '../util/base64';

const utf8Decoder = new TextDecoder('utf-8');
const utf16LeDecoder = new TextDecoder('utf-16le');
const utf16BeDecoder = new TextDecoder('utf-16be');

const ENCODING_ISO = 0;
const ENCODING_UTF16_BOM = 1;
const ENCODING_UTF16_BE = 2;
const ENCODING_UTF8 = 3;

const IMAGE_TYPE_COVER = 3;

export interface Id3Metadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly comment?: string;
  readonly date?: string;
  readonly durationMs?: number;
  readonly coverImage?: { readonly offset: number; readonly length: number; readonly mime: string };
}

function readSynchsafeInt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! & 0x7f) << 21) |
    ((bytes[offset + 1]! & 0x7f) << 14) |
    ((bytes[offset + 2]! & 0x7f) << 7) |
    (bytes[offset + 3]! & 0x7f)
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function removeUnsynchronisation(bytes: Uint8Array): Uint8Array {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    count++;
    if (bytes[i] === 0xff && i + 1 < bytes.length && bytes[i + 1] === 0x00) {
      i++;
    }
  }
  if (count === bytes.length) return bytes;
  const out = new Uint8Array(count);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[w++] = bytes[i]!;
    if (bytes[i] === 0xff && i + 1 < bytes.length && bytes[i + 1] === 0x00) {
      i++;
    }
  }
  return out;
}

/**
 * Returns the total byte size of the leading ID3v2 tag (`10 + tagPayloadSize`),
 * or `undefined` if `bytes` does not start with a valid 10-byte ID3v2 header.
 */
export function readId3TotalTagSize(bytes: Uint8Array): number | undefined {
  if (bytes.length < 10) return undefined;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return undefined;
  const payloadSize = readSynchsafeInt(bytes, 6);
  return 10 + payloadSize;
}

function readNullTerminatedIso(
  bytes: Uint8Array,
  start: number,
  end: number,
): { value: string; nextOffset: number } {
  let pos = start;
  while (pos < end && bytes[pos] !== 0) {
    pos++;
  }
  const value = decodeIso88591(bytes.subarray(start, pos));
  return { value, nextOffset: pos < end ? pos + 1 : end };
}

function decodeEncodedSlice(encoding: number, slice: Uint8Array): string {
  if (slice.length === 0) return '';
  if (encoding === ENCODING_UTF8) {
    return utf8Decoder.decode(slice);
  }
  if (encoding === ENCODING_UTF16_BOM) {
    if (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) {
      return utf16BeDecoder.decode(slice.subarray(2));
    }
    if (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) {
      return utf16LeDecoder.decode(slice.subarray(2));
    }
    return utf16LeDecoder.decode(slice);
  }
  if (encoding === ENCODING_UTF16_BE) {
    return utf16BeDecoder.decode(slice);
  }
  return decodeIso88591(slice);
}

function readEncodedNullTerminated(
  bytes: Uint8Array,
  encoding: number,
  start: number,
  end: number,
): { value: string; nextOffset: number } {
  if (encoding === ENCODING_UTF16_BOM || encoding === ENCODING_UTF16_BE) {
    let pos = start;
    while (pos + 1 < end) {
      if (bytes[pos] === 0 && bytes[pos + 1] === 0) {
        return {
          value: decodeEncodedSlice(encoding, bytes.subarray(start, pos)),
          nextOffset: pos + 2,
        };
      }
      pos += 2;
    }
    return {
      value: decodeEncodedSlice(encoding, bytes.subarray(start, end)),
      nextOffset: end,
    };
  }

  let pos = start;
  while (pos < end && bytes[pos] !== 0) {
    pos++;
  }
  return {
    value: decodeEncodedSlice(encoding, bytes.subarray(start, pos)),
    nextOffset: pos < end ? pos + 1 : end,
  };
}

function readTextFrameValue(bytes: Uint8Array, start: number, end: number): string {
  if (start >= end) return '';
  const encoding = bytes[start]!;
  const { value } = readEncodedNullTerminated(bytes, encoding, start + 1, end);
  return value.replace(/\0+$/g, '').trim();
}

function isValidFrameIdChar(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a);
}

interface ParsedFrameHeader {
  readonly id: string;
  readonly payloadOffset: number;
  readonly payloadLength: number;
  readonly nextFrameOffset: number;
  readonly frameUnsynced: boolean;
}

function readFrameHeader(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  majorVersion: number,
): ParsedFrameHeader | undefined {
  if (offset + 10 > limit) return undefined;
  if (
    !isValidFrameIdChar(bytes[offset]!) ||
    !isValidFrameIdChar(bytes[offset + 1]!) ||
    !isValidFrameIdChar(bytes[offset + 2]!) ||
    !isValidFrameIdChar(bytes[offset + 3]!)
  ) {
    return undefined;
  }

  const id = decodeIso88591(bytes.subarray(offset, offset + 4));
  let frameSize: number;
  if (majorVersion >= 4) {
    const synch = readSynchsafeInt(bytes, offset + 4);
    const raw = readUint32BE(bytes, offset + 4);
    // Tolerate broken encoders that write non-synchsafe sizes in ID3v2.4
    const hasHighBit =
      (bytes[offset + 4]! & 0x80) !== 0 ||
      (bytes[offset + 5]! & 0x80) !== 0 ||
      (bytes[offset + 6]! & 0x80) !== 0 ||
      (bytes[offset + 7]! & 0x80) !== 0;
    if (hasHighBit) {
      frameSize = raw;
    } else if (
      synch !== raw &&
      offset + 10 + synch < limit &&
      !isValidFrameIdChar(bytes[offset + 10 + synch]!) &&
      bytes[offset + 10 + synch] !== 0 &&
      offset + 10 + raw <= limit &&
      (offset + 10 + raw === limit ||
        bytes[offset + 10 + raw] === 0 ||
        isValidFrameIdChar(bytes[offset + 10 + raw]!))
    ) {
      frameSize = raw;
    } else {
      frameSize = synch;
    }
  } else {
    frameSize = readUint32BE(bytes, offset + 4);
  }

  if (frameSize < 0) return undefined;

  const flags2 = bytes[offset + 9]!;
  const frameUnsynced = majorVersion >= 4 && (flags2 & 0x02) !== 0;
  const hasDataLenIndicator = majorVersion >= 4 && (flags2 & 0x01) !== 0;

  const rawEnd = Math.min(limit, offset + 10 + frameSize);
  const payloadOffset = hasDataLenIndicator ? Math.min(rawEnd, offset + 14) : offset + 10;
  const payloadLength = Math.max(0, rawEnd - payloadOffset);

  return {
    id,
    payloadOffset,
    payloadLength,
    nextFrameOffset: rawEnd,
    frameUnsynced,
  };
}

function safeDecodeLatin1Url(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    // Match AntennaPod URLDecoder.decode(url, "ISO-8859-1") when percent-encoded
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

interface ParsedChapEntry {
  readonly elementId: string;
  readonly chapter: Chapter;
}

function parseChapFrame(
  buf: Uint8Array,
  start: number,
  end: number,
  majorVersion: number,
  baseFileOffset: number,
  canSliceDirectly: boolean,
): ParsedChapEntry | undefined {
  const idRes = readNullTerminatedIso(buf, start, end);
  if (idRes.nextOffset + 16 > end) return undefined;

  const startMs = readUint32BE(buf, idRes.nextOffset);
  // Skip startTime (4) + endTime (4) + startOffset (4) + endOffset (4) = 16 bytes
  let subPos = idRes.nextOffset + 16;

  let title: string | undefined;
  let link: string | undefined;
  let imageUrl: string | undefined;
  let embeddedImage: { offset: number; length: number; mime: string } | undefined;

  while (subPos + 10 <= end) {
    const subHdr = readFrameHeader(buf, subPos, end, majorVersion);
    if (!subHdr) break;

    const pStart = subHdr.payloadOffset;
    const pEnd = pStart + subHdr.payloadLength;

    if (subHdr.id === 'TIT2') {
      const t = readTextFrameValue(buf, pStart, pEnd);
      if (t) title = t;
    } else if (subHdr.id === 'WXXX') {
      if (pStart < pEnd) {
        const enc = buf[pStart]!;
        const desc = readEncodedNullTerminated(buf, enc, pStart + 1, pEnd);
        const urlRes = readNullTerminatedIso(buf, desc.nextOffset, pEnd);
        const decoded = safeDecodeLatin1Url(urlRes.value);
        if (decoded) link = decoded;
      }
    } else if (subHdr.id === 'WCOM' || subHdr.id === 'WOAR' || subHdr.id === 'WOAS') {
      const urlRes = readNullTerminatedIso(buf, pStart, pEnd);
      const decoded = safeDecodeLatin1Url(urlRes.value);
      if (decoded && !link) link = decoded;
    } else if (subHdr.id === 'APIC') {
      if (pStart + 2 < pEnd) {
        const enc = buf[pStart]!;
        const mimeRes = readNullTerminatedIso(buf, pStart + 1, pEnd);
        const mime = mimeRes.value.trim() || 'image/jpeg';
        if (mimeRes.nextOffset < pEnd) {
          const picType = buf[mimeRes.nextOffset]!;
          const descRes = readEncodedNullTerminated(buf, enc, mimeRes.nextOffset + 1, pEnd);
          const dataStart = descRes.nextOffset;
          if (mime === '-->') {
            const linkRes = readNullTerminatedIso(buf, dataStart, pEnd);
            const url = linkRes.value.trim();
            if (url && (!imageUrl || picType === IMAGE_TYPE_COVER)) {
              imageUrl = url;
              embeddedImage = undefined;
            }
          } else if (dataStart < pEnd && canSliceDirectly) {
            const length = pEnd - dataStart;
            if ((!embeddedImage && !imageUrl) || picType === IMAGE_TYPE_COVER) {
              embeddedImage = {
                offset: baseFileOffset + dataStart,
                length,
                mime,
              };
            }
          }
        }
      }
    }

    if (subHdr.nextFrameOffset <= subPos) break;
    subPos = subHdr.nextFrameOffset;
  }

  return {
    elementId: idRes.value,
    chapter: {
      startMs,
      source: 'ID3',
      ...(title ? { title } : {}),
      ...(link ? { link } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(embeddedImage ? { embeddedImage } : {}),
    },
  };
}

interface ParsedCtoc {
  readonly topLevel: boolean;
  readonly ordered: boolean;
  readonly childIds: readonly string[];
}

function parseCtocFrame(buf: Uint8Array, start: number, end: number): ParsedCtoc | undefined {
  const idRes = readNullTerminatedIso(buf, start, end);
  if (idRes.nextOffset + 2 > end) return undefined;
  const flags = buf[idRes.nextOffset]!;
  const entryCount = buf[idRes.nextOffset + 1]!;
  let pos = idRes.nextOffset + 2;
  const childIds: string[] = [];
  for (let i = 0; i < entryCount && pos < end; i++) {
    const child = readNullTerminatedIso(buf, pos, end);
    childIds.push(child.value);
    pos = child.nextOffset;
  }
  return {
    topLevel: (flags & 0x02) !== 0,
    ordered: (flags & 0x01) !== 0,
    childIds,
  };
}

/**
 * Port of AntennaPod's `ChapterReader` (`https://id3.org/id3v2-chapters-1.0`).
 * Parses ID3v2.3 / ID3v2.4 `CHAP` & `CTOC` frames including `TIT2`, `WXXX`, and `APIC`
 * byte-slice offsets (`{ offset, length, mime }`).
 */
export function parseId3Chapters(bytes: Uint8Array, baseOffset: number = 0): Chapter[] {
  if (bytes.length < 10) return [];
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return [];

  const majorVersion = bytes[3]!;
  if (majorVersion < 3 || majorVersion > 4) return [];

  const tagFlags = bytes[5]!;
  const tagUnsynced = (tagFlags & 0x80) !== 0;
  const hasExtendedHeader = (tagFlags & 0x40) !== 0;
  const declaredTagSize = readSynchsafeInt(bytes, 6);
  const tagLimit = Math.min(bytes.length, 10 + declaredTagSize);

  let workBuf = bytes;
  let pos = 10;
  let limit = tagLimit;
  let effectiveBaseOffset = baseOffset;
  let canSliceDirectly = !tagUnsynced;

  if (tagUnsynced) {
    workBuf = removeUnsynchronisation(bytes.subarray(10, tagLimit));
    pos = 0;
    limit = workBuf.length;
    effectiveBaseOffset = 0;
  }

  if (hasExtendedHeader && pos + 4 <= limit) {
    if (majorVersion === 3) {
      const extSize = readUint32BE(workBuf, pos);
      // ID3v2.3 extended header size excludes the 4 size bytes themselves (6 or 10)
      pos += 4 + extSize;
    } else {
      const extSize = readSynchsafeInt(workBuf, pos);
      pos += Math.max(4, extSize);
    }
  }

  const chapEntries: ParsedChapEntry[] = [];
  let topLevelCtoc: ParsedCtoc | undefined;

  while (pos + 10 <= limit) {
    if (workBuf[pos] === 0) break; // Padding reached
    const hdr = readFrameHeader(workBuf, pos, limit, majorVersion);
    if (!hdr) break;

    if (hdr.id === 'CHAP') {
      if (hdr.frameUnsynced) {
        const unsyncPayload = removeUnsynchronisation(
          workBuf.subarray(hdr.payloadOffset, hdr.payloadOffset + hdr.payloadLength),
        );
        const parsed = parseChapFrame(unsyncPayload, 0, unsyncPayload.length, majorVersion, 0, false);
        if (parsed) chapEntries.push(parsed);
      } else {
        const parsed = parseChapFrame(
          workBuf,
          hdr.payloadOffset,
          hdr.payloadOffset + hdr.payloadLength,
          majorVersion,
          effectiveBaseOffset,
          canSliceDirectly,
        );
        if (parsed) chapEntries.push(parsed);
      }
    } else if (hdr.id === 'CTOC') {
      const ctocBuf = hdr.frameUnsynced
        ? removeUnsynchronisation(workBuf.subarray(hdr.payloadOffset, hdr.payloadOffset + hdr.payloadLength))
        : workBuf;
      const cStart = hdr.frameUnsynced ? 0 : hdr.payloadOffset;
      const cEnd = hdr.frameUnsynced ? ctocBuf.length : hdr.payloadOffset + hdr.payloadLength;
      const parsedCtoc = parseCtocFrame(ctocBuf, cStart, cEnd);
      if (parsedCtoc?.topLevel && !topLevelCtoc) {
        topLevelCtoc = parsedCtoc;
      }
    }

    if (hdr.nextFrameOffset <= pos) break;
    pos = hdr.nextFrameOffset;
  }

  let selected: Chapter[];
  if (topLevelCtoc && topLevelCtoc.childIds.length > 0) {
    const byId = new Map<string, Chapter>();
    for (const entry of chapEntries) {
      if (!byId.has(entry.elementId)) {
        byId.set(entry.elementId, entry.chapter);
      }
    }
    const matched = topLevelCtoc.childIds
      .map((id) => byId.get(id))
      .filter((c): c is Chapter => c !== undefined);
    selected = matched.length > 0 ? matched : chapEntries.map((e) => e.chapter);
  } else {
    selected = chapEntries.map((e) => e.chapter);
  }

  return selected
    .filter((c) => c.startMs >= 0 && Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Extracts general ID3v2 tag metadata (`TIT2`, `TPE1`, `TALB`, `COMM`, `TDRC`/`TYER`, `TLEN`, `APIC`)
 * used by Local Folder virtual feeds.
 */
export function parseId3Metadata(bytes: Uint8Array, baseOffset: number = 0): Id3Metadata {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return {};
  }
  const majorVersion = bytes[3]!;
  if (majorVersion < 3 || majorVersion > 4) return {};

  const tagFlags = bytes[5]!;
  const tagUnsynced = (tagFlags & 0x80) !== 0;
  const hasExtendedHeader = (tagFlags & 0x40) !== 0;
  const declaredTagSize = readSynchsafeInt(bytes, 6);
  const tagLimit = Math.min(bytes.length, 10 + declaredTagSize);

  const workBuf = tagUnsynced ? removeUnsynchronisation(bytes.subarray(10, tagLimit)) : bytes;
  let pos = tagUnsynced ? 0 : 10;
  const limit = tagUnsynced ? workBuf.length : tagLimit;

  if (hasExtendedHeader && pos + 4 <= limit) {
    pos += majorVersion === 3 ? 4 + readUint32BE(workBuf, pos) : Math.max(4, readSynchsafeInt(workBuf, pos));
  }

  let title: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  let comment: string | undefined;
  let date: string | undefined;
  let durationMs: number | undefined;
  let coverImage: { offset: number; length: number; mime: string } | undefined;

  while (pos + 10 <= limit) {
    if (workBuf[pos] === 0) break;
    const hdr = readFrameHeader(workBuf, pos, limit, majorVersion);
    if (!hdr) break;

    const pStart = hdr.payloadOffset;
    const pEnd = pStart + hdr.payloadLength;

    if (hdr.id === 'TIT2') {
      title = readTextFrameValue(workBuf, pStart, pEnd) || title;
    } else if (hdr.id === 'TPE1') {
      artist = readTextFrameValue(workBuf, pStart, pEnd) || artist;
    } else if (hdr.id === 'TALB') {
      album = readTextFrameValue(workBuf, pStart, pEnd) || album;
    } else if (hdr.id === 'TDRC' || hdr.id === 'TYER') {
      date = readTextFrameValue(workBuf, pStart, pEnd) || date;
    } else if (hdr.id === 'TLEN') {
      const lenVal = Number.parseInt(readTextFrameValue(workBuf, pStart, pEnd), 10);
      if (Number.isFinite(lenVal) && lenVal > 0) durationMs = lenVal;
    } else if (hdr.id === 'COMM' && pStart + 4 <= pEnd) {
      const enc = workBuf[pStart]!;
      // 1 byte encoding + 3 bytes language + null-terminated short content description + full text
      const shortDesc = readEncodedNullTerminated(workBuf, enc, pStart + 4, pEnd);
      const body = decodeEncodedSlice(enc, workBuf.subarray(shortDesc.nextOffset, pEnd))
        .replace(/\0+$/g, '')
        .trim();
      if (body && (!comment || body.length > comment.length)) {
        comment = body;
      }
    } else if (hdr.id === 'APIC' && !tagUnsynced && !hdr.frameUnsynced && pStart + 2 < pEnd) {
      const enc = workBuf[pStart]!;
      const mimeRes = readNullTerminatedIso(workBuf, pStart + 1, pEnd);
      if (mimeRes.nextOffset < pEnd && mimeRes.value !== '-->') {
        const picType = workBuf[mimeRes.nextOffset]!;
        const descRes = readEncodedNullTerminated(workBuf, enc, mimeRes.nextOffset + 1, pEnd);
        if (descRes.nextOffset < pEnd && (!coverImage || picType === IMAGE_TYPE_COVER)) {
          coverImage = {
            offset: baseOffset + descRes.nextOffset,
            length: pEnd - descRes.nextOffset,
            mime: mimeRes.value.trim() || 'image/jpeg',
          };
        }
      }
    }

    if (hdr.nextFrameOffset <= pos) break;
    pos = hdr.nextFrameOffset;
  }

  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(comment ? { comment } : {}),
    ...(date ? { date } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(coverImage ? { coverImage } : {}),
  };
}
