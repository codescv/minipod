import type { Chapter } from '../types';
import { decodeIso88591 } from '../util/base64';

const utf8Decoder = new TextDecoder('utf-8');

export interface Mp4Metadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly description?: string;
  readonly date?: string;
  readonly durationMs?: number;
  readonly hasEmbeddedPicture?: boolean;
}

interface Mp4Box {
  readonly type: string;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly boxEnd: number;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function readUint64BEAsNumber(bytes: Uint8Array, offset: number): number {
  const hi = readUint32BE(bytes, offset);
  const lo = readUint32BE(bytes, offset + 4);
  return hi * 0x1_0000_0000 + lo;
}

function* iterateBoxes(bytes: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = readUint32BE(bytes, pos);
    const type = decodeIso88591(bytes.subarray(pos + 4, pos + 8));

    let headerLen = 8;
    let totalSize = size32;

    if (size32 === 1) {
      if (pos + 16 > end) break;
      totalSize = readUint64BEAsNumber(bytes, pos + 8);
      headerLen = 16;
    } else if (size32 === 0) {
      totalSize = end - pos;
    }

    if (totalSize < headerLen) break;
    const boxEnd = Math.min(end, pos + totalSize);
    yield {
      type,
      payloadStart: pos + headerLen,
      payloadEnd: boxEnd,
      boxEnd,
    };
    if (boxEnd <= pos) break;
    pos = boxEnd;
  }
}

/**
 * Inspects top-level MP4 boxes to locate `moov` if it resides at the tail of an un-faststarted file.
 */
export function locateMp4MoovBox(
  bytes: Uint8Array,
): { readonly found: boolean; readonly nextOffsetHint?: number } {
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size32 = readUint32BE(bytes, pos);
    const type = decodeIso88591(bytes.subarray(pos + 4, pos + 8));
    let totalSize = size32;
    if (size32 === 1) {
      if (pos + 16 > bytes.length) break;
      totalSize = readUint64BEAsNumber(bytes, pos + 8);
    } else if (size32 === 0) {
      break;
    }
    if (totalSize < 8) break;
    if (type === 'moov') {
      return { found: pos + totalSize <= bytes.length, nextOffsetHint: pos };
    }
    if (pos + totalSize > bytes.length) {
      return { found: false, nextOffsetHint: pos + totalSize };
    }
    pos += totalSize;
  }
  return { found: false };
}

function parseNeroChplPayload(bytes: Uint8Array, start: number, end: number): Chapter[] {
  if (start + 6 > end) return [];
  const version = bytes[start]!;

  let pos: number;
  let chapterCount: number;
  if (version === 0) {
    // Version 0: 1 byte version + 3 bytes flags + 1 byte count
    chapterCount = bytes[start + 4]!;
    pos = start + 5;
  } else {
    // Version 1 (standard Nero, matches AntennaPod `M4AChapterReader`):
    // 4 bytes version+flags + 1 reserved byte + 4-byte big-endian chapterCount
    if (start + 9 > end) return [];
    chapterCount = readUint32BE(bytes, start + 5);
    pos = start + 9;
  }

  if (chapterCount <= 0 || chapterCount > 10_000) return [];

  const chapters: Chapter[] = [];
  for (let i = 0; i < chapterCount && pos + 9 <= end; i++) {
    // 8-byte start time in 100-nanosecond units -> divide by 10_000 for milliseconds
    const raw100ns = readUint64BEAsNumber(bytes, pos);
    pos += 8;
    const nameLen = bytes[pos]!; // unsigned 0..255
    pos += 1;
    if (pos + nameLen > end) break;
    const title = utf8Decoder.decode(bytes.subarray(pos, pos + nameLen)).replace(/\0+$/g, '').trim();
    pos += nameLen;

    const startMs = Math.floor(raw100ns / 10_000);
    if (startMs >= 0 && Number.isFinite(startMs)) {
      chapters.push({
        startMs,
        source: 'MP4',
        ...(title ? { title } : {}),
      });
    }
  }

  return chapters.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Parses QuickTime chapter track (`tref.chap` -> referenced `trak`) when samples reside inside `bytes`.
 */
function parseQuickTimeChapTrack(
  fullFileBytes: Uint8Array,
  moovStart: number,
  moovEnd: number,
): Chapter[] {
  let chapTrackId: number | undefined;

  interface ParsedTrak {
    trackId: number;
    timescale: number;
    stts: { count: number; delta: number }[];
    stsc: { firstChunk: number; samplesPerChunk: number }[];
    chunkOffsets: number[];
    sampleSizes: number[];
    defaultSampleSize: number;
  }

  const tracks: ParsedTrak[] = [];

  for (const box of iterateBoxes(fullFileBytes, moovStart, moovEnd)) {
    if (box.type !== 'trak') continue;

    let trackId = 0;
    let timescale = 1000;
    const stts: { count: number; delta: number }[] = [];
    const stsc: { firstChunk: number; samplesPerChunk: number }[] = [];
    const chunkOffsets: number[] = [];
    const sampleSizes: number[] = [];
    let defaultSampleSize = 0;

    for (const tb of iterateBoxes(fullFileBytes, box.payloadStart, box.payloadEnd)) {
      if (tb.type === 'tkhd' && tb.payloadStart + 20 <= tb.payloadEnd) {
        const ver = fullFileBytes[tb.payloadStart]!;
        const idOff = ver === 1 ? tb.payloadStart + 20 : tb.payloadStart + 12;
        if (idOff + 4 <= tb.payloadEnd) {
          trackId = readUint32BE(fullFileBytes, idOff);
        }
      } else if (tb.type === 'tref') {
        for (const ref of iterateBoxes(fullFileBytes, tb.payloadStart, tb.payloadEnd)) {
          if (ref.type === 'chap' && ref.payloadStart + 4 <= ref.payloadEnd) {
            chapTrackId = readUint32BE(fullFileBytes, ref.payloadStart);
          }
        }
      } else if (tb.type === 'mdia') {
        for (const mb of iterateBoxes(fullFileBytes, tb.payloadStart, tb.payloadEnd)) {
          if (mb.type === 'mdhd' && mb.payloadStart + 16 <= mb.payloadEnd) {
            const ver = fullFileBytes[mb.payloadStart]!;
            const tsOff = ver === 1 ? mb.payloadStart + 20 : mb.payloadStart + 12;
            if (tsOff + 4 <= mb.payloadEnd) {
              const ts = readUint32BE(fullFileBytes, tsOff);
              if (ts > 0) timescale = ts;
            }
          } else if (mb.type === 'minf') {
            for (const mib of iterateBoxes(fullFileBytes, mb.payloadStart, mb.payloadEnd)) {
              if (mib.type !== 'stbl') continue;
              for (const sb of iterateBoxes(fullFileBytes, mib.payloadStart, mib.payloadEnd)) {
                if (sb.type === 'stts' && sb.payloadStart + 8 <= sb.payloadEnd) {
                  const entries = readUint32BE(fullFileBytes, sb.payloadStart + 4);
                  let p = sb.payloadStart + 8;
                  for (let i = 0; i < entries && p + 8 <= sb.payloadEnd; i++, p += 8) {
                    stts.push({
                      count: readUint32BE(fullFileBytes, p),
                      delta: readUint32BE(fullFileBytes, p + 4),
                    });
                  }
                } else if (sb.type === 'stsc' && sb.payloadStart + 8 <= sb.payloadEnd) {
                  const entries = readUint32BE(fullFileBytes, sb.payloadStart + 4);
                  let p = sb.payloadStart + 8;
                  for (let i = 0; i < entries && p + 12 <= sb.payloadEnd; i++, p += 12) {
                    stsc.push({
                      firstChunk: readUint32BE(fullFileBytes, p),
                      samplesPerChunk: readUint32BE(fullFileBytes, p + 4),
                    });
                  }
                } else if (sb.type === 'stco' && sb.payloadStart + 8 <= sb.payloadEnd) {
                  const entries = readUint32BE(fullFileBytes, sb.payloadStart + 4);
                  let p = sb.payloadStart + 8;
                  for (let i = 0; i < entries && p + 4 <= sb.payloadEnd; i++, p += 4) {
                    chunkOffsets.push(readUint32BE(fullFileBytes, p));
                  }
                } else if (sb.type === 'co64' && sb.payloadStart + 8 <= sb.payloadEnd) {
                  const entries = readUint32BE(fullFileBytes, sb.payloadStart + 4);
                  let p = sb.payloadStart + 8;
                  for (let i = 0; i < entries && p + 8 <= sb.payloadEnd; i++, p += 8) {
                    chunkOffsets.push(readUint64BEAsNumber(fullFileBytes, p));
                  }
                } else if (sb.type === 'stsz' && sb.payloadStart + 12 <= sb.payloadEnd) {
                  defaultSampleSize = readUint32BE(fullFileBytes, sb.payloadStart + 4);
                  const count = readUint32BE(fullFileBytes, sb.payloadStart + 8);
                  if (defaultSampleSize === 0) {
                    let p = sb.payloadStart + 12;
                    for (let i = 0; i < count && p + 4 <= sb.payloadEnd; i++, p += 4) {
                      sampleSizes.push(readUint32BE(fullFileBytes, p));
                    }
                  } else {
                    for (let i = 0; i < count && i < 10_000; i++) {
                      sampleSizes.push(defaultSampleSize);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    if (trackId > 0) {
      tracks.push({
        trackId,
        timescale,
        stts,
        stsc,
        chunkOffsets,
        sampleSizes,
        defaultSampleSize,
      });
    }
  }

  if (chapTrackId === undefined) return [];
  const chapTrack = tracks.find((t) => t.trackId === chapTrackId);
  if (!chapTrack || chapTrack.chunkOffsets.length === 0) return [];

  // Reconstruct sample timestamps
  const startTimesMs: number[] = [];
  let accTicks = 0;
  for (const entry of chapTrack.stts) {
    for (let i = 0; i < entry.count && startTimesMs.length < 10_000; i++) {
      startTimesMs.push(Math.round((accTicks * 1000) / chapTrack.timescale));
      accTicks += entry.delta;
    }
  }

  // Reconstruct sample file offsets
  const sampleOffsets: { offset: number; size: number }[] = [];
  let sampleIdx = 0;
  for (let chunkIdx = 0; chunkIdx < chapTrack.chunkOffsets.length; chunkIdx++) {
    const chunkNum = chunkIdx + 1;
    let spc = 1;
    for (const sc of chapTrack.stsc) {
      if (sc.firstChunk <= chunkNum) spc = sc.samplesPerChunk;
      else break;
    }
    let byteCursor = chapTrack.chunkOffsets[chunkIdx]!;
    for (let s = 0; s < spc && sampleIdx < chapTrack.sampleSizes.length; s++) {
      const sz = chapTrack.sampleSizes[sampleIdx]!;
      sampleOffsets.push({ offset: byteCursor, size: sz });
      byteCursor += sz;
      sampleIdx++;
    }
  }

  const out: Chapter[] = [];
  const total = Math.min(startTimesMs.length, sampleOffsets.length);
  for (let i = 0; i < total; i++) {
    const loc = sampleOffsets[i]!;
    if (loc.offset < 0 || loc.offset + 2 > fullFileBytes.length) continue;
    const textLen = (fullFileBytes[loc.offset]! << 8) | fullFileBytes[loc.offset + 1]!;
    if (loc.offset + 2 + textLen > fullFileBytes.length) continue;
    const rawSlice = fullFileBytes.subarray(loc.offset + 2, loc.offset + 2 + textLen);
    let title: string;
    if (rawSlice.length >= 2 && rawSlice[0] === 0xfe && rawSlice[1] === 0xff) {
      title = new TextDecoder('utf-16be').decode(rawSlice.subarray(2)).trim();
    } else if (rawSlice.length >= 2 && rawSlice[0] === 0xff && rawSlice[1] === 0xfe) {
      title = new TextDecoder('utf-16le').decode(rawSlice.subarray(2)).trim();
    } else {
      title = utf8Decoder.decode(rawSlice).trim();
    }
    out.push({
      startMs: startTimesMs[i]!,
      source: 'MP4',
      ...(title ? { title } : {}),
    });
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Port of AntennaPod's `M4AChapterReader`: parses `moov.udta.chpl` Nero chapters
 * (plus QuickTime `chap` track fallback when samples are within the buffer).
 */
export function parseMp4Chapters(bytes: Uint8Array): Chapter[] {
  for (const top of iterateBoxes(bytes, 0, bytes.length)) {
    if (top.type === 'chpl') {
      return parseNeroChplPayload(bytes, top.payloadStart, top.payloadEnd);
    }
    if (top.type !== 'moov') continue;

    for (const moovChild of iterateBoxes(bytes, top.payloadStart, top.payloadEnd)) {
      if (moovChild.type !== 'udta') continue;
      for (const udtaChild of iterateBoxes(bytes, moovChild.payloadStart, moovChild.payloadEnd)) {
        if (udtaChild.type === 'chpl') {
          const chpl = parseNeroChplPayload(bytes, udtaChild.payloadStart, udtaChild.payloadEnd);
          if (chpl.length > 0) return chpl;
        }
      }
    }

    const qtChapters = parseQuickTimeChapTrack(bytes, top.payloadStart, top.payloadEnd);
    if (qtChapters.length > 0) return qtChapters;
  }

  return [];
}

function readIlstDataText(bytes: Uint8Array, start: number, end: number): string | undefined {
  for (const child of iterateBoxes(bytes, start, end)) {
    if (child.type === 'data' && child.payloadStart + 8 <= child.payloadEnd) {
      const text = utf8Decoder.decode(bytes.subarray(child.payloadStart + 8, child.payloadEnd)).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Extracts MP4/M4A metadata (`mvhd` duration, iTunes `ilst` atoms `©nam`, `©ART`, `©alb`, `©cmt`/`desc`, `©day`, `covr`)
 * for Local Folder virtual feeds.
 */
export function parseMp4Metadata(bytes: Uint8Array): Mp4Metadata {
  let title: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  let description: string | undefined;
  let date: string | undefined;
  let durationMs: number | undefined;
  let hasEmbeddedPicture = false;

  for (const top of iterateBoxes(bytes, 0, bytes.length)) {
    if (top.type !== 'moov') continue;
    for (const mc of iterateBoxes(bytes, top.payloadStart, top.payloadEnd)) {
      if (mc.type === 'mvhd' && mc.payloadStart + 20 <= mc.payloadEnd) {
        const ver = bytes[mc.payloadStart]!;
        if (ver === 1 && mc.payloadStart + 28 <= mc.payloadEnd) {
          const timescale = readUint32BE(bytes, mc.payloadStart + 20);
          const dur = readUint64BEAsNumber(bytes, mc.payloadStart + 24);
          if (timescale > 0 && dur > 0) durationMs = Math.round((dur * 1000) / timescale);
        } else if (ver === 0 && mc.payloadStart + 20 <= mc.payloadEnd) {
          const timescale = readUint32BE(bytes, mc.payloadStart + 12);
          const dur = readUint32BE(bytes, mc.payloadStart + 16);
          if (timescale > 0 && dur > 0 && dur !== 0xffffffff) {
            durationMs = Math.round((dur * 1000) / timescale);
          }
        }
      } else if (mc.type === 'udta') {
        for (const uc of iterateBoxes(bytes, mc.payloadStart, mc.payloadEnd)) {
          // `meta` is a FullBox (4-byte version+flags before child boxes)
          if (uc.type !== 'meta' || uc.payloadStart + 4 > uc.payloadEnd) continue;
          for (const metc of iterateBoxes(bytes, uc.payloadStart + 4, uc.payloadEnd)) {
            if (metc.type !== 'ilst') continue;
            for (const item of iterateBoxes(bytes, metc.payloadStart, metc.payloadEnd)) {
              if (item.type === '\u00a9nam') {
                title = readIlstDataText(bytes, item.payloadStart, item.payloadEnd) ?? title;
              } else if (item.type === '\u00a9ART') {
                artist = readIlstDataText(bytes, item.payloadStart, item.payloadEnd) ?? artist;
              } else if (item.type === '\u00a9alb') {
                album = readIlstDataText(bytes, item.payloadStart, item.payloadEnd) ?? album;
              } else if (item.type === '\u00a9cmt' || item.type === 'desc' || item.type === 'ldes') {
                const candidate = readIlstDataText(bytes, item.payloadStart, item.payloadEnd);
                if (candidate && (!description || candidate.length > description.length)) {
                  description = candidate;
                }
              } else if (item.type === '\u00a9day') {
                date = readIlstDataText(bytes, item.payloadStart, item.payloadEnd) ?? date;
              } else if (item.type === 'covr') {
                hasEmbeddedPicture = true;
              }
            }
          }
        }
      }
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(description ? { description } : {}),
    ...(date ? { date } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(hasEmbeddedPicture ? { hasEmbeddedPicture: true } : {}),
  };
}
