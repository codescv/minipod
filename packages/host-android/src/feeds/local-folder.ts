/**
 * Virtual podcast feed scanner over an Android SAF directory tree (`content://`)
 * (`ARCHITECTURE.md §3.2`, `§12` LocalFeedUpdater parity).
 *
 * Uses `MiniPodPlugin.saf.listTree` + `MiniPodPlugin.saf.readRange` (first 256 KiB)
 * to extract ID3 / Vorbis / FLAC / MP4 metadata and embedded chapters via `@minipod/core`,
 * resolving cover art (`folder.jpg`, `cover.png`, or embedded `APIC`) to a `data:` URL.
 */
import {
  decodeBase64,
  encodeBase64,
  LOCAL_FOLDER_URL_PREFIX,
  localFolderFeedKey,
  MiniPodError,
  parseMediaMetadata,
  type EpochMs,
  type FeedKey,
  type MediaType,
  type ParsedEpisode,
  type ParsedFeed,
} from '@minipod/core';
import type { MiniPodPlugin, SafTreeEntry } from '../plugin-types';

const PROBE_HEAD_BYTES = 256 * 1024;
const MAX_COVER_IMAGE_BYTES = 4 * 1024 * 1024;

const AUDIO_EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
};

const VIDEO_EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
};

const COVER_CANDIDATE_NAMES = [
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'folder.webp',
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'artwork.jpg',
  'artwork.png',
];

const IMAGE_EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface ExistingSafEpisodeHint {
  readonly identity: string;
  readonly mtimeMs?: EpochMs;
  readonly size?: number;
  readonly episode: ParsedEpisode;
}

export interface ScanSafLocalFolderOptions {
  readonly displayName?: string;
  readonly existingByIdentity?: ReadonlyMap<string, ExistingSafEpisodeHint>;
}

export interface ScannedSafLocalFolder {
  readonly feedKey: FeedKey;
  readonly feedUrl: string;
  readonly parsed: ParsedFeed;
  readonly coverDataUrl?: string;
  readonly presentIdentities: ReadonlySet<string>;
  readonly mtimeByIdentity: ReadonlyMap<string, EpochMs>;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function classifyMediaEntry(entry: SafTreeEntry): { mime: string; mediaType: MediaType } | null {
  const lowerMime = (entry.mime || '').toLowerCase();
  if (lowerMime.startsWith('audio/')) {
    return { mime: lowerMime, mediaType: 'AUDIO' };
  }
  if (lowerMime.startsWith('video/')) {
    return { mime: lowerMime, mediaType: 'VIDEO' };
  }
  const ext = extOf(entry.name);
  if (ext in AUDIO_EXT_TO_MIME) {
    return { mime: AUDIO_EXT_TO_MIME[ext]!, mediaType: 'AUDIO' };
  }
  if (ext in VIDEO_EXT_TO_MIME) {
    return { mime: VIDEO_EXT_TO_MIME[ext]!, mediaType: 'VIDEO' };
  }
  return null;
}

function pickCoverEntry(entries: readonly SafTreeEntry[]): SafTreeEntry | undefined {
  const files = entries.filter((e) => !e.isDirectory && !e.name.startsWith('.'));
  const byLower = new Map<string, SafTreeEntry>(files.map((f) => [f.name.toLowerCase(), f]));
  for (const candidate of COVER_CANDIDATE_NAMES) {
    const hit = byLower.get(candidate);
    if (hit && hit.size <= MAX_COVER_IMAGE_BYTES) return hit;
  }
  return files.find((f) => {
    const ext = extOf(f.name);
    return (ext in IMAGE_EXT_TO_MIME || f.mime.startsWith('image/')) && f.size <= MAX_COVER_IMAGE_BYTES;
  });
}

export async function scanSafLocalFolder(
  treeUri: string,
  plugin: Pick<MiniPodPlugin, 'saf'>,
  options?: ScanSafLocalFolderOptions,
): Promise<ScannedSafLocalFolder> {
  const trimmedUri = treeUri.trim();
  if (!trimmedUri) {
    throw new MiniPodError('invalid-argument', 'SAF tree URI must not be empty');
  }

  let entries: readonly SafTreeEntry[];
  try {
    const res = await plugin.saf.listTree({ treeUri: trimmedUri });
    entries = res.entries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MiniPodError('not-found', `Unable to read SAF folder (${trimmedUri}): ${msg}`, {
      cause: err,
    });
  }

  const fk = localFolderFeedKey(trimmedUri);
  const feedUrl = `${LOCAL_FOLDER_URL_PREFIX}${trimmedUri}`;
  const folderTitle = options?.displayName?.trim() || 'Local Folder';

  let coverDataUrl: string | undefined;
  const coverEntry = pickCoverEntry(entries);
  if (coverEntry) {
    try {
      const raw = await plugin.saf.read({ uri: coverEntry.uri });
      const mime = coverEntry.mime.startsWith('image/')
        ? coverEntry.mime
        : (IMAGE_EXT_TO_MIME[extOf(coverEntry.name)] ?? 'image/jpeg');
      if (raw.base64) {
        coverDataUrl = `data:${mime};base64,${raw.base64}`;
      }
    } catch {
      // Non-fatal: continue without folder image
    }
  }

  const mediaFiles = entries
    .filter((e) => !e.isDirectory && !e.name.startsWith('.'))
    .map((entry) => ({ entry, classified: classifyMediaEntry(entry) }))
    .filter((x): x is { entry: SafTreeEntry; classified: { mime: string; mediaType: MediaType } } =>
      x.classified !== null,
    )
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true }));

  const episodes: ParsedEpisode[] = [];
  const presentIdentities = new Set<string>();
  const mtimeByIdentity = new Map<string, EpochMs>();
  let inferredAlbum: string | undefined;
  let inferredArtist: string | undefined;

  for (const { entry, classified } of mediaFiles) {
    const identity = entry.name;
    presentIdentities.add(identity);
    mtimeByIdentity.set(identity, entry.mtimeMs);

    const existing = options?.existingByIdentity?.get(identity);
    if (
      existing &&
      existing.mtimeMs !== undefined &&
      Math.trunc(existing.mtimeMs) === Math.trunc(entry.mtimeMs) &&
      existing.size === entry.size
    ) {
      episodes.push(existing.episode);
      continue;
    }

    let title = stripExt(entry.name);
    let description: string | undefined;
    let pubDate: EpochMs = entry.mtimeMs || Date.now();
    let durationMs: number | undefined;
    let chapters: ParsedEpisode['chapters'];

    try {
      const readLen = Math.min(entry.size > 0 ? entry.size : PROBE_HEAD_BYTES, PROBE_HEAD_BYTES);
      if (readLen > 0) {
        const sliceRes = await plugin.saf.readRange({
          uri: entry.uri,
          start: 0,
          length: readLen,
        });
        const headBytes = decodeBase64(sliceRes.base64);
        const meta = parseMediaMetadata(headBytes, 0);
        if (meta.title?.trim()) title = meta.title.trim();
        if (meta.description?.trim()) description = meta.description.trim();
        if (meta.pubDate !== undefined) pubDate = meta.pubDate;
        if (meta.durationMs !== undefined && meta.durationMs > 0) durationMs = meta.durationMs;
        if (meta.chapters.length > 0) chapters = meta.chapters;
        if (!inferredAlbum && meta.album?.trim()) inferredAlbum = meta.album.trim();
        if (!inferredArtist && meta.artist?.trim()) inferredArtist = meta.artist.trim();

        if (!coverDataUrl && meta.coverImage) {
          const { offset, length, mime } = meta.coverImage;
          if (length > 0 && length <= MAX_COVER_IMAGE_BYTES) {
            if (offset + length <= headBytes.length) {
              const picSlice = headBytes.subarray(offset, offset + length);
              coverDataUrl = `data:${mime || 'image/jpeg'};base64,${encodeBase64(picSlice)}`;
            } else {
              const picRes = await plugin.saf.readRange({
                uri: entry.uri,
                start: offset,
                length,
              });
              if (picRes.base64) {
                coverDataUrl = `data:${mime || 'image/jpeg'};base64,${picRes.base64}`;
              }
            }
          }
        }
      }
    } catch {
      // Unreadable tag header -> fall back to filename & mtime
    }

    episodes.push({
      identity,
      guid: identity,
      title,
      pubDate,
      enclosureUrl: entry.uri,
      enclosureMime: classified.mime,
      enclosureSize: entry.size,
      mediaType: classified.mediaType,
      ...(description !== undefined ? { description } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(chapters !== undefined ? { chapters } : {}),
    });
  }

  episodes.sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0));

  const parsed: ParsedFeed = {
    type: 'rss20',
    title: options?.displayName?.trim() || inferredAlbum || folderTitle,
    description: `Local SAF folder: ${folderTitle}`,
    episodes,
    ...(inferredArtist !== undefined ? { author: inferredArtist } : {}),
    ...(coverDataUrl !== undefined ? { imageUrl: coverDataUrl } : {}),
  };

  return {
    feedKey: fk,
    feedUrl,
    parsed,
    presentIdentities,
    mtimeByIdentity,
    ...(coverDataUrl !== undefined ? { coverDataUrl } : {}),
  };
}
