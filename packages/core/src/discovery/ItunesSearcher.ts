import { FeedUrlNotFoundError, MiniPodError } from '../errors';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import type { HttpClient, PodcastSearcher, SearchResult } from '../types';

export interface ItunesSearcherDeps {
  readonly http: HttpClient;
  readonly userAgent?: string;
}

const APPLE_PODCAST_URL_REGEX = /.*\/podcasts\.apple\.com\/.*\/id(\d+).*/i;
const ITUNES_ID_IN_PATH_REGEX = /\/id(\d+)/i;

function extractItunesId(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    const qId = u.searchParams.get('id');
    if (qId && /^\d+$/.test(qId)) return qId;
  } catch {
    // Fall through to regex extraction
  }
  const appleMatch = APPLE_PODCAST_URL_REGEX.exec(rawUrl);
  if (appleMatch?.[1]) return appleMatch[1];

  const pathMatch = ITUNES_ID_IN_PATH_REGEX.exec(rawUrl);
  return pathMatch?.[1];
}

interface ItunesSearchEntryJson {
  readonly collectionName?: string;
  readonly trackName?: string;
  readonly artistName?: string;
  readonly artworkUrl100?: string;
  readonly artworkUrl600?: string;
  readonly feedUrl?: string;
}

interface ItunesResponseJson {
  readonly resultCount?: number;
  readonly results?: readonly ItunesSearchEntryJson[];
}

export class ItunesSearcher implements PodcastSearcher {
  readonly id = 'apple' as const;
  readonly displayName = 'Apple Podcasts';
  readonly combinedWeight = 1.0;

  private readonly http: HttpClient;
  private readonly userAgent: string;

  constructor(deps: ItunesSearcherDeps) {
    this.http = deps.http;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = `https://itunes.apple.com/search?media=podcast&term=${encodeURIComponent(trimmed)}`;
    const resp = await this.http({
      url,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
      ...(signal ? { signal } : {}),
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `Apple Podcasts search failed with HTTP ${resp.status}`, {
        details: { status: resp.status },
      });
    }

    let parsed: ItunesResponseJson;
    try {
      parsed = JSON.parse(await resp.text()) as ItunesResponseJson;
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from Apple Podcasts search', { cause: err });
    }

    const out: SearchResult[] = [];
    for (const item of parsed.results ?? []) {
      const feedUrl = item.feedUrl?.trim();
      if (!feedUrl) continue;
      const title = item.collectionName?.trim() || item.trackName?.trim() || 'Unknown';
      const author = item.artistName?.trim();
      const imageUrl = item.artworkUrl100?.trim() || item.artworkUrl600?.trim();
      out.push({
        title,
        feedUrl,
        source: 'apple',
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      });
    }
    return out;
  }

  urlNeedsLookup(url: string): boolean {
    return url.includes('itunes.apple.com') || APPLE_PODCAST_URL_REGEX.test(url);
  }

  async lookupUrl(url: string, signal?: AbortSignal): Promise<string> {
    const id = extractItunesId(url);
    if (!id) {
      throw new MiniPodError('invalid-url', `Could not extract Apple Podcasts ID from URL: ${url}`);
    }

    const lookupEndpoint = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`;
    const resp = await this.http({
      url: lookupEndpoint,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
      ...(signal ? { signal } : {}),
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `Apple Podcasts lookup failed with HTTP ${resp.status}`, {
        details: { status: resp.status, id },
      });
    }

    let parsed: ItunesResponseJson;
    try {
      parsed = JSON.parse(await resp.text()) as ItunesResponseJson;
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from Apple Podcasts lookup', { cause: err });
    }

    const first = parsed.results?.[0];
    if (!first) {
      throw new MiniPodError('feed-not-found', `No podcast found for Apple ID ${id}`, { details: { id } });
    }

    const feedUrl = first.feedUrl?.trim();
    if (!feedUrl) {
      throw new FeedUrlNotFoundError(
        first.artistName?.trim() ?? '',
        first.trackName?.trim() || first.collectionName?.trim() || '',
      );
    }

    return feedUrl;
  }
}

export function createItunesSearcher(deps: ItunesSearcherDeps): PodcastSearcher {
  return new ItunesSearcher(deps);
}
