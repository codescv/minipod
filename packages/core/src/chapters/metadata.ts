import type { Chapter, EpochMs } from '../types';
import { parsePubDateMs } from '../util/time';
import { parseId3Chapters, parseId3Metadata } from './id3';
import { parseMp4Chapters, parseMp4Metadata } from './mp4';
import { sniffMediaFormat, type SniffedMediaFormat } from './sniff';
import { parseVorbisChapters, parseVorbisMetadata } from './vorbis';

export interface ParsedMediaMetadata {
  readonly format: SniffedMediaFormat;
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly description?: string;
  readonly date?: string;
  readonly pubDate?: EpochMs;
  readonly durationMs?: number;
  readonly coverImage?: { readonly offset: number; readonly length: number; readonly mime: string };
  readonly hasEmbeddedPicture?: boolean;
  readonly chapters: readonly Chapter[];
}

/**
 * Unified tag & chapter extractor over leading media bytes for Local Folder feeds
 * (dispatches `ID3`, Ogg Vorbis/Opus, native FLAC, and MP4/M4A).
 */
export function parseMediaMetadata(bytes: Uint8Array, baseOffset: number = 0): ParsedMediaMetadata {
  const format = sniffMediaFormat(bytes);

  if (format === 'ID3') {
    const meta = parseId3Metadata(bytes, baseOffset);
    const chapters = parseId3Chapters(bytes, baseOffset);
    const pubDate = meta.date ? parsePubDateMs(meta.date) : undefined;
    return {
      format,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.artist ? { artist: meta.artist } : {}),
      ...(meta.album ? { album: meta.album } : {}),
      ...(meta.comment ? { description: meta.comment } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      ...(pubDate !== undefined ? { pubDate } : {}),
      ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta.coverImage ? { coverImage: meta.coverImage, hasEmbeddedPicture: true } : {}),
      chapters,
    };
  }

  if (format === 'OGG' || format === 'FLAC') {
    const meta = parseVorbisMetadata(bytes);
    const chapters = parseVorbisChapters(bytes);
    const pubDate = meta.date ? parsePubDateMs(meta.date) : undefined;
    return {
      format,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.artist ? { artist: meta.artist } : {}),
      ...(meta.album ? { album: meta.album } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      ...(pubDate !== undefined ? { pubDate } : {}),
      chapters,
    };
  }

  if (format === 'MP4') {
    const meta = parseMp4Metadata(bytes);
    const chapters = parseMp4Chapters(bytes);
    const pubDate = meta.date ? parsePubDateMs(meta.date) : undefined;
    return {
      format,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.artist ? { artist: meta.artist } : {}),
      ...(meta.album ? { album: meta.album } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      ...(pubDate !== undefined ? { pubDate } : {}),
      ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta.hasEmbeddedPicture ? { hasEmbeddedPicture: true } : {}),
      chapters,
    };
  }

  return {
    format: 'UNKNOWN',
    chapters: [],
  };
}
