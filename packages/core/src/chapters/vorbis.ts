import type { Chapter } from '../types';
import { parseChapterTimestampMs } from '../util/time';

const utf8Decoder = new TextDecoder('utf-8');
const CHAPTER_PREFIX_LEN = 'chapterxxx'.length; // 10

export interface VorbisMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly description?: string;
  readonly date?: string;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function readUint24BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
}

/**
 * Extracts raw Vorbis Comment block bytes (`vendor_length` + `vendor` + `count` + `comments[]`)
 * from either an Ogg bitstream (`OggS` containing Vorbis `\x03vorbis` or Opus `OpusTags`)
 * or a native FLAC stream (`fLaC` metadata block type 4).
 */
function extractVorbisCommentBlock(bytes: Uint8Array): Uint8Array | undefined {
  // 1. Native FLAC (`fLaC`)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    let pos = 4;
    while (pos + 4 <= bytes.length) {
      const headerByte = bytes[pos]!;
      const isLast = (headerByte & 0x80) !== 0;
      const blockType = headerByte & 0x7f;
      const blockLen = readUint24BE(bytes, pos + 1);
      pos += 4;
      if (blockType === 4) {
        return bytes.subarray(pos, Math.min(bytes.length, pos + blockLen));
      }
      if (isLast || pos + blockLen > bytes.length) break;
      pos += blockLen;
    }
    return undefined;
  }

  // 2. Ogg container (`OggS`) — reassemble packets across page segments
  if (
    bytes.length >= 27 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    const packets: Uint8Array[] = [];
    let currentChunks: Uint8Array[] = [];
    let currentLen = 0;

    let pos = 0;
    while (pos + 27 <= bytes.length) {
      if (
        bytes[pos] !== 0x4f ||
        bytes[pos + 1] !== 0x67 ||
        bytes[pos + 2] !== 0x67 ||
        bytes[pos + 3] !== 0x53
      ) {
        break;
      }
      const numSegments = bytes[pos + 26]!;
      if (pos + 27 + numSegments > bytes.length) break;

      const segmentTableOffset = pos + 27;
      let dataOffset = segmentTableOffset + numSegments;

      for (let s = 0; s < numSegments; s++) {
        const segSize = bytes[segmentTableOffset + s]!;
        const avail = Math.min(segSize, Math.max(0, bytes.length - dataOffset));
        if (avail > 0) {
          currentChunks.push(bytes.subarray(dataOffset, dataOffset + avail));
          currentLen += avail;
        }
        dataOffset += avail;

        // A segment < 255 terminates the current Ogg packet
        if (segSize < 255) {
          const pkt = concatPacketChunks(currentChunks, currentLen);
          currentChunks = [];
          currentLen = 0;
          const commentSlice = inspectOggPacketForComments(pkt);
          if (commentSlice) return commentSlice;
          packets.push(pkt);
          if (packets.length >= 8) return undefined;
        }
      }

      pos = dataOffset;
    }

    if (currentLen > 0) {
      const partialPkt = concatPacketChunks(currentChunks, currentLen);
      const commentSlice = inspectOggPacketForComments(partialPkt);
      if (commentSlice) return commentSlice;
    }
  }

  return undefined;
}

function concatPacketChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function inspectOggPacketForComments(pkt: Uint8Array): Uint8Array | undefined {
  // Vorbis comment header: `[0x03, 'v','o','r','b','i','s', ...]`
  if (
    pkt.length >= 15 &&
    pkt[0] === 0x03 &&
    pkt[1] === 0x76 &&
    pkt[2] === 0x6f &&
    pkt[3] === 0x72 &&
    pkt[4] === 0x62 &&
    pkt[5] === 0x69 &&
    pkt[6] === 0x73
  ) {
    return pkt.subarray(7);
  }
  // Opus comment header: `['O','p','u','s','T','a','g','s', ...]`
  if (
    pkt.length >= 16 &&
    pkt[0] === 0x4f &&
    pkt[1] === 0x70 &&
    pkt[2] === 0x75 &&
    pkt[3] === 0x73 &&
    pkt[4] === 0x54 &&
    pkt[5] === 0x61 &&
    pkt[6] === 0x67 &&
    pkt[7] === 0x73
  ) {
    return pkt.subarray(8);
  }
  // FLAC-in-Ogg Vorbis Comment block (`0x04` or `0x84`)
  if (pkt.length >= 12 && ((pkt[0]! & 0x7f) === 4)) {
    const len = readUint24BE(pkt, 1);
    if (4 + len <= pkt.length) {
      return pkt.subarray(4, 4 + len);
    }
  }
  return undefined;
}

export function readVorbisCommentPairs(
  bytes: Uint8Array,
): { readonly key: string; readonly value: string }[] {
  const block = extractVorbisCommentBlock(bytes);
  if (!block || block.length < 8) return [];

  let pos = 0;
  const vendorLen = readUint32LE(block, pos);
  pos += 4 + vendorLen;
  if (pos + 4 > block.length) return [];

  const commentCount = readUint32LE(block, pos);
  pos += 4;

  const pairs: { key: string; value: string }[] = [];
  const safeMax = Math.min(commentCount, 10_000);

  for (let i = 0; i < safeMax && pos + 4 <= block.length; i++) {
    const entryLen = readUint32LE(block, pos);
    pos += 4;
    if (entryLen > block.length - pos) break;
    const raw = utf8Decoder.decode(block.subarray(pos, pos + entryLen));
    pos += entryLen;

    const eqIdx = raw.indexOf('=');
    if (eqIdx <= 0) continue;
    pairs.push({
      key: raw.slice(0, eqIdx),
      value: raw.slice(eqIdx + 1),
    });
  }

  return pairs;
}

interface MutableVorbisChapter {
  startMs?: number;
  title?: string;
  link?: string;
  imageUrl?: string;
}

/**
 * Parses Vorbis Comment chapters (`CHAPTER001=00:00:12.850`, `CHAPTER001NAME=...`, `CHAPTER001URL=...`)
 * from Ogg Vorbis, Ogg Opus, or native FLAC byte slices.
 *
 * Fixes both upstream AntennaPod quirks:
 * 1. Parses the 3-digit chapter ID via `key.substring(7, 10)` so chapters >= 100 do not collide.
 * 2. Preserves full sub-second float millisecond accuracy (`HH:MM:SS.mmm` -> ms).
 */
export function parseVorbisChapters(bytes: Uint8Array): Chapter[] {
  const pairs = readVorbisCommentPairs(bytes);
  if (pairs.length === 0) return [];

  const byId = new Map<number, MutableVorbisChapter>();

  for (const { key, value } of pairs) {
    const lowerKey = key.trim().toLowerCase();
    if (!/^chapter\d{3}/.test(lowerKey)) continue;

    // `"chapter".length === 7`, `CHAPTERXXX_LENGTH === 10` -> 3 digits `[7, 10)`
    const idStr = lowerKey.substring(7, CHAPTER_PREFIX_LEN);
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id < 0) continue;

    const attr = lowerKey.substring(CHAPTER_PREFIX_LEN);
    let entry = byId.get(id);
    if (!entry) {
      entry = {};
      byId.set(id, entry);
    }

    if (attr === '') {
      // First timestamp for a given ID wins (matches upstream duplicate check without aborting whole stream)
      if (entry.startMs === undefined) {
        const ms = parseChapterTimestampMs(value);
        if (ms !== undefined && ms >= 0) {
          entry.startMs = ms;
        }
      }
    } else if (attr === 'name') {
      const trimmed = value.trim();
      if (trimmed) entry.title = trimmed;
    } else if (attr === 'url') {
      const trimmed = value.trim();
      if (trimmed) entry.link = trimmed;
    } else if (attr === 'image') {
      const trimmed = value.trim();
      if (trimmed) entry.imageUrl = trimmed;
    }
  }

  const out: Chapter[] = [];
  for (const [, ch] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
    if (ch.startMs === undefined || ch.startMs < 0) continue;
    out.push({
      startMs: ch.startMs,
      source: 'VORBIS',
      ...(ch.title ? { title: ch.title } : {}),
      ...(ch.link ? { link: ch.link } : {}),
      ...(ch.imageUrl ? { imageUrl: ch.imageUrl } : {}),
    });
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Extracts general Vorbis Comment metadata (`TITLE`, `ARTIST`, `ALBUM`, `DESCRIPTION`/`COMMENT`, `DATE`)
 * for Local Folder virtual feeds.
 */
export function parseVorbisMetadata(bytes: Uint8Array): VorbisMetadata {
  const pairs = readVorbisCommentPairs(bytes);
  let title: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  let description: string | undefined;
  let date: string | undefined;

  for (const { key, value } of pairs) {
    const k = key.trim().toLowerCase();
    const v = value.trim();
    if (!v) continue;
    if (k === 'title' && !title) title = v;
    else if (k === 'artist' && !artist) artist = v;
    else if (k === 'album' && !album) album = v;
    else if ((k === 'description' || k === 'comment') && (!description || v.length > description.length)) {
      description = v;
    } else if (k === 'date' && !date) {
      date = v;
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(description ? { description } : {}),
    ...(date ? { date } : {}),
  };
}
