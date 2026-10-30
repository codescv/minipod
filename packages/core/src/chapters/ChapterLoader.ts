import { fetchWithBasicAuth } from '../http/basicAuth';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import type { Chapter, Episode, HttpBasicCredentials, HttpClient } from '../types';
import { mergeAllChapterSources } from './ChapterMerger';
import { parseId3Chapters, readId3TotalTagSize } from './id3';
import { locateMp4MoovBox, parseMp4Chapters } from './mp4';
import { parsePodcastIndexChapters } from './podcastindex-json';
import { sniffMediaFormat } from './sniff';
import { parseVorbisChapters } from './vorbis';

const INITIAL_PROBE_BYTES = 256 * 1024; // 256 KiB covers >95% of ID3/Ogg/faststart-MP4 headers
const MAX_EMBEDDED_PROBE_BYTES = 2 * 1024 * 1024; // 2 MiB hard cap per ARCHITECTURE.md §1.2

export interface ChapterLoaderDeps {
  readonly http: HttpClient;
  readonly readLocalRange?: (path: string, start: number, endInclusive?: number) => Promise<Uint8Array>;
  readonly credentials?: HttpBasicCredentials;
  readonly userAgent?: string;
}

function parseContentRangeTotal(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(header);
  if (!match) return undefined;
  const total = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

export function parseEmbeddedChaptersFromBytes(bytes: Uint8Array, baseOffset: number = 0): Chapter[] {
  const format = sniffMediaFormat(bytes);
  switch (format) {
    case 'ID3':
      return parseId3Chapters(bytes, baseOffset);
    case 'OGG':
    case 'FLAC':
      return parseVorbisChapters(bytes);
    case 'MP4':
      return parseMp4Chapters(bytes);
    case 'UNKNOWN':
      return [];
  }
}

async function loadEmbeddedChapters(
  episode: Pick<Episode, 'enclosureUrl' | 'downloadState' | 'downloadPath'>,
  deps: ChapterLoaderDeps,
  signal?: AbortSignal,
): Promise<Chapter[]> {
  // 1. Local downloaded file path
  if (episode.downloadState === 'DONE' && episode.downloadPath && deps.readLocalRange) {
    try {
      const headSlice = await deps.readLocalRange(episode.downloadPath, 0, INITIAL_PROBE_BYTES - 1);
      const format = sniffMediaFormat(headSlice);
      if (format === 'ID3') {
        const totalId3 = readId3TotalTagSize(headSlice);
        if (totalId3 && totalId3 > headSlice.length && totalId3 <= MAX_EMBEDDED_PROBE_BYTES) {
          const fullId3 = await deps.readLocalRange(episode.downloadPath, 0, totalId3 - 1);
          return parseId3Chapters(fullId3, 0);
        }
        return parseId3Chapters(headSlice, 0);
      }
      if (format === 'OGG' || format === 'FLAC') {
        return parseVorbisChapters(headSlice);
      }
      if (format === 'MP4') {
        const ch = parseMp4Chapters(headSlice);
        if (ch.length > 0) return ch;
        const moovLoc = locateMp4MoovBox(headSlice);
        if (moovLoc.nextOffsetHint !== undefined) {
          const tailSlice = await deps.readLocalRange(
            episode.downloadPath,
            moovLoc.nextOffsetHint,
            moovLoc.nextOffsetHint + MAX_EMBEDDED_PROBE_BYTES - 1,
          );
          return parseMp4Chapters(tailSlice);
        }
      }
    } catch {
      // Fall back to remote or empty
    }
  }

  // 2. Remote enclosure via HTTP Byte-Range read
  if (!episode.enclosureUrl || !/^https?:\/\//i.test(episode.enclosureUrl)) {
    return [];
  }

  const ua = deps.userAgent ?? DEFAULT_USER_AGENT;

  try {
    const firstResp = await fetchWithBasicAuth(
      deps.http,
      {
        url: episode.enclosureUrl,
        method: 'GET',
        range: { start: 0, end: INITIAL_PROBE_BYTES - 1 },
        maxBodyBytes: MAX_EMBEDDED_PROBE_BYTES,
        headers: { 'User-Agent': ua },
        ...(signal ? { signal } : {}),
      },
      deps.credentials,
    );

    if (firstResp.status !== 206 && firstResp.status !== 200) {
      return [];
    }

    const headSlice = await firstResp.bytes();
    const format = sniffMediaFormat(headSlice);

    if (format === 'ID3') {
      const totalId3 = readId3TotalTagSize(headSlice);
      if (
        totalId3 &&
        totalId3 > headSlice.length &&
        totalId3 <= MAX_EMBEDDED_PROBE_BYTES &&
        firstResp.status === 206
      ) {
        const fullResp = await fetchWithBasicAuth(
          deps.http,
          {
            url: firstResp.finalUrl || episode.enclosureUrl,
            method: 'GET',
            range: { start: 0, end: totalId3 - 1 },
            maxBodyBytes: MAX_EMBEDDED_PROBE_BYTES,
            headers: { 'User-Agent': ua },
            ...(signal ? { signal } : {}),
          },
          deps.credentials,
        );
        if (fullResp.status === 206 || fullResp.status === 200) {
          return parseId3Chapters(await fullResp.bytes(), 0);
        }
      }
      return parseId3Chapters(headSlice, 0);
    }

    if (format === 'OGG' || format === 'FLAC') {
      return parseVorbisChapters(headSlice);
    }

    if (format === 'MP4') {
      const direct = parseMp4Chapters(headSlice);
      if (direct.length > 0) return direct;

      // Handle MP4 files whose `moov` atom sits after `mdat` at the end of the file
      const totalSize = parseContentRangeTotal(firstResp.headers['content-range']);
      const moovLoc = locateMp4MoovBox(headSlice);
      const tailStart =
        moovLoc.nextOffsetHint !== undefined && totalSize !== undefined && totalSize - moovLoc.nextOffsetHint <= MAX_EMBEDDED_PROBE_BYTES
          ? moovLoc.nextOffsetHint
          : totalSize !== undefined && totalSize > INITIAL_PROBE_BYTES
            ? Math.max(0, totalSize - INITIAL_PROBE_BYTES)
            : undefined;

      if (tailStart !== undefined && firstResp.status === 206) {
        const tailResp = await fetchWithBasicAuth(
          deps.http,
          {
            url: firstResp.finalUrl || episode.enclosureUrl,
            method: 'GET',
            range: {
              start: tailStart,
              ...(totalSize !== undefined ? { end: Math.min(totalSize - 1, tailStart + MAX_EMBEDDED_PROBE_BYTES - 1) } : {}),
            },
            maxBodyBytes: MAX_EMBEDDED_PROBE_BYTES,
            headers: { 'User-Agent': ua },
            ...(signal ? { signal } : {}),
          },
          deps.credentials,
        );
        if (tailResp.status === 206) {
          return parseMp4Chapters(await tailResp.bytes());
        }
      }
    }
  } catch {
    return [];
  }

  return [];
}

async function loadExternalJsonChapters(
  chaptersUrl: string | undefined,
  deps: ChapterLoaderDeps,
  signal?: AbortSignal,
): Promise<Chapter[]> {
  if (!chaptersUrl || !/^https?:\/\//i.test(chaptersUrl)) return [];
  try {
    const resp = await fetchWithBasicAuth(
      deps.http,
      {
        url: chaptersUrl,
        method: 'GET',
        headers: {
          Accept: 'application/json+chapters, application/json, */*;q=0.5',
          'User-Agent': deps.userAgent ?? DEFAULT_USER_AGENT,
        },
        ...(signal ? { signal } : {}),
      },
      deps.credentials,
    );
    if (resp.status < 200 || resp.status >= 300) return [];
    return parsePodcastIndexChapters(await resp.text());
  } catch {
    return [];
  }
}

/**
 * Port of AntennaPod's `ChapterUtils.loadChapters` + `ChapterMerger`:
 * Loads embedded (ID3 / Vorbis / MP4) and external Podcasting 2.0 JSON chapters in parallel
 * and merges them with feed-declared `psc:chapters` as `merge(merge(feed, embedded), external)`.
 */
export async function loadChapters(
  episode: Pick<Episode, 'enclosureUrl' | 'chaptersUrl' | 'downloadState' | 'downloadPath'>,
  deps: ChapterLoaderDeps & { readonly feedChapters?: readonly Chapter[]; readonly signal?: AbortSignal },
): Promise<Chapter[]> {
  const [embedded, external] = await Promise.all([
    loadEmbeddedChapters(episode, deps, deps.signal),
    loadExternalJsonChapters(episode.chaptersUrl, deps, deps.signal),
  ]);

  return mergeAllChapterSources({
    feed: deps.feedChapters,
    embedded,
    external,
  });
}

export const ChapterLoader = {
  load: loadChapters,
  parseEmbedded: parseEmbeddedChaptersFromBytes,
} as const;
