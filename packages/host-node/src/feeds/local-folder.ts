/**
 * Desktop Local Folder virtual podcast feed scanner (`ARCHITECTURE.md §4.2` "Local Folders",
 * `docs/ANTENNAPOD_SOURCES.md §9`).
 *
 * Scans a `node:fs` directory directly into a `ParsedFeed` (no synthetic XML):
 * - Cover art precedence: `folder.jpg` -> `folder.jpeg` -> `folder.png` -> `cover.jpg` -> `cover.png`
 *   -> first image in directory -> first episode with embedded ID3 `APIC` cover.
 * - Filters audio/video files by MIME (`inferMediaMimeType` + `isMediaMime`).
 * - Reads leading tag bytes via `readLocalFileSliceSync` and parses ID3 / Vorbis / FLAC / MP4
 *   tags & chapters via `@minipod/core`'s `parseMediaMetadata`.
 * - Skips re-parsing unchanged files on rescan when `(mtimeMs, size)` matches existing DB row.
 */
import {
  classifyMediaType,
  inferMediaMimeType,
  isImageMime,
  isMediaMime,
  LOCAL_FOLDER_URL_PREFIX,
  localFolderFeedKey,
  MiniPodError,
  parseMediaMetadata,
  readId3TotalTagSize,
  sniffMediaFormat,
  type FeedKey,
  type ParsedEpisode,
  type ParsedFeed,
} from '@minipod/core';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { readLocalFileSliceSync } from '../net/range-proxy';

const TAG_PROBE_BYTES = 256 * 1024;
const MAX_ID3_TAG_BYTES = 2 * 1024 * 1024;

const PREFERRED_COVER_NAMES = [
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
];

export interface ExistingLocalEpisodeHint {
  readonly identity: string;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly episode: ParsedEpisode;
}

export interface LocalFolderScanResult {
  readonly feedKey: FeedKey;
  readonly folderPath: string;
  readonly feedUrl: string;
  readonly parsed: ParsedFeed;
  /** Path to image file (or `audio:<path>` marker when using embedded audio cover). */
  readonly localCoverSpec: string | null;
  readonly mtimeByIdentity: ReadonlyMap<string, number>;
  readonly presentIdentities: ReadonlySet<string>;
}

function stripExtension(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

export function scanLocalFolder(
  rawFolderPath: string,
  options?: {
    readonly displayName?: string | undefined;
    readonly existingByIdentity?: ReadonlyMap<string, ExistingLocalEpisodeHint>;
  },
): LocalFolderScanResult {
  const folderPath = resolve(rawFolderPath);
  if (!existsSync(folderPath)) {
    throw new MiniPodError('not-found', `Local folder does not exist: ${folderPath}`);
  }
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(folderPath);
  } catch (err) {
    throw new MiniPodError('not-found', `Cannot access local folder: ${folderPath}`, { cause: err });
  }
  if (!dirStat.isDirectory()) {
    throw new MiniPodError('invalid-argument', `Path is not a directory: ${folderPath}`);
  }

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(folderPath);
  } catch (err) {
    throw new MiniPodError('sync-auth', `Permission denied reading folder: ${folderPath}`, {
      cause: err,
    });
  }

  const key = localFolderFeedKey(folderPath);
  const feedUrl = `${LOCAL_FOLDER_URL_PREFIX}${folderPath}`;

  const byLowerName = new Map<string, string>();
  const firstImageCandidates: string[] = [];
  const mediaFiles: Array<{
    readonly fileName: string;
    readonly fullPath: string;
    readonly mime: string;
    readonly size: number;
    readonly mtimeMs: number;
  }> = [];

  const sortedNames = [...dirEntries].sort((a, b) => a.localeCompare(b));
  for (const name of sortedNames) {
    if (name.startsWith('.')) continue;
    const fullPath = join(folderPath, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    byLowerName.set(name.toLowerCase(), fullPath);
    const mime = inferMediaMimeType(undefined, name);
    if (isImageMime(mime)) {
      firstImageCandidates.push(fullPath);
    } else if (isMediaMime(mime) && mime) {
      mediaFiles.push({
        fileName: name,
        fullPath,
        mime,
        size: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
      });
    }
  }

  let localCoverSpec: string | null = null;
  for (const pref of PREFERRED_COVER_NAMES) {
    const match = byLowerName.get(pref);
    if (match) {
      localCoverSpec = match;
      break;
    }
  }
  if (!localCoverSpec && firstImageCandidates.length > 0) {
    localCoverSpec = firstImageCandidates[0]!;
  }

  const episodes: ParsedEpisode[] = [];
  const mtimeByIdentity = new Map<string, number>();
  const presentIdentities = new Set<string>();
  let fallbackAudioCoverPath: string | null = null;
  let inferredAuthor: string | undefined;
  let inferredAlbum: string | undefined;

  for (const file of mediaFiles) {
    const identity = file.fileName;
    presentIdentities.add(identity);
    mtimeByIdentity.set(identity, file.mtimeMs);

    const existing = options?.existingByIdentity?.get(identity);
    if (
      existing &&
      existing.mtimeMs === file.mtimeMs &&
      existing.size === file.size
    ) {
      episodes.push(existing.episode);
      continue;
    }

    let headSlice = readLocalFileSliceSync(file.fullPath, 0, TAG_PROBE_BYTES - 1);
    if (sniffMediaFormat(headSlice) === 'ID3') {
      const id3Total = readId3TotalTagSize(headSlice);
      if (id3Total && id3Total > headSlice.byteLength && id3Total <= MAX_ID3_TAG_BYTES) {
        headSlice = readLocalFileSliceSync(file.fullPath, 0, id3Total - 1);
      }
    }

    const meta = parseMediaMetadata(headSlice, 0);
    if (!inferredAuthor && meta.artist) inferredAuthor = meta.artist;
    if (!inferredAlbum && meta.album) inferredAlbum = meta.album;
    if (!localCoverSpec && !fallbackAudioCoverPath && meta.coverImage) {
      fallbackAudioCoverPath = file.fullPath;
    }

    const title = meta.title?.trim() || stripExtension(file.fileName);
    const pubDate = meta.pubDate ?? file.mtimeMs;
    const mediaType = classifyMediaType(file.mime, file.fileName);

    episodes.push({
      identity,
      guid: identity,
      title,
      enclosureUrl: file.fullPath,
      enclosureMime: file.mime,
      enclosureSize: file.size,
      mediaType,
      pubDate,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta.chapters.length > 0 ? { chapters: meta.chapters } : {}),
    });
  }

  if (!localCoverSpec && fallbackAudioCoverPath) {
    localCoverSpec = `audio:${fallbackAudioCoverPath}`;
  }

  // Sort newest pubDate / filename descending for consistent display
  episodes.sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0));

  const folderDisplayTitle =
    options?.displayName?.trim() || basename(folderPath) || inferredAlbum || 'Local Folder';

  const parsed: ParsedFeed = {
    type: 'rss20',
    title: folderDisplayTitle,
    description: folderPath,
    episodes,
    ...(inferredAuthor ? { author: inferredAuthor } : {}),
    ...(localCoverSpec ? { imageUrl: `/api/feeds/${encodeURIComponent(key)}/cover` } : {}),
  };

  return {
    feedKey: key,
    folderPath,
    feedUrl,
    parsed,
    localCoverSpec,
    mtimeByIdentity,
    presentIdentities,
  };
}
