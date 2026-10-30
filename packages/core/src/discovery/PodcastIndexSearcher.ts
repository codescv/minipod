import { MiniPodError } from '../errors';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import {
  DEFAULT_PODCASTINDEX_KEYS,
  type EpochMs,
  type HttpClient,
  type PodcastIndexKeys,
  type PodcastSearcher,
  type SearchResult,
} from '../types';
import { sha1Hex } from '../util/sha1';

export interface PodcastIndexSearcherDeps {
  readonly http: HttpClient;
  readonly keys?: PodcastIndexKeys;
  readonly now?: () => EpochMs;
  readonly userAgent?: string;
}

interface PodcastIndexFeedJson {
  readonly title?: string;
  readonly author?: string;
  readonly image?: string;
  readonly artwork?: string;
  readonly url?: string;
}

interface PodcastIndexResponseJson {
  readonly feeds?: readonly PodcastIndexFeedJson[];
}

/**
 * Port of AntennaPod's `PodcastIndexPodcastSearcher`.
 * Signs requests with `X-Auth-Key`, `X-Auth-Date` (UTC epoch seconds), and
 * `Authorization: sha1Hex(key + secret + epochSeconds)` via `crypto.subtle.digest('SHA-1')`.
 */
export class PodcastIndexSearcher implements PodcastSearcher {
  readonly id = 'podcastindex' as const;
  readonly displayName = 'PodcastIndex';
  readonly combinedWeight = 1.0;

  private readonly http: HttpClient;
  private readonly keys: PodcastIndexKeys;
  private readonly now: () => EpochMs;
  private readonly userAgent: string;

  constructor(deps: PodcastIndexSearcherDeps) {
    this.http = deps.http;
    this.keys =
      deps.keys && deps.keys.key.trim() && deps.keys.secret.trim()
        ? deps.keys
        : DEFAULT_PODCASTINDEX_KEYS;
    this.now = deps.now ?? Date.now;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const apiHeaderTime = String(Math.floor(this.now() / 1000));
    const authorization = await sha1Hex(`${this.keys.key}${this.keys.secret}${apiHeaderTime}`);

    const url = `https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(trimmed)}`;
    const resp = await this.http({
      url,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Auth-Date': apiHeaderTime,
        'X-Auth-Key': this.keys.key,
        Authorization: authorization,
        'User-Agent': this.userAgent,
      },
      ...(signal ? { signal } : {}),
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('auth-required', `PodcastIndex authentication failed (HTTP ${resp.status})`, {
        details: { status: resp.status },
      });
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `PodcastIndex search failed with HTTP ${resp.status}`, {
        details: { status: resp.status },
      });
    }

    let parsed: PodcastIndexResponseJson;
    try {
      parsed = JSON.parse(await resp.text()) as PodcastIndexResponseJson;
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from PodcastIndex search', { cause: err });
    }

    const out: SearchResult[] = [];
    for (const feed of parsed.feeds ?? []) {
      const feedUrl = feed.url?.trim();
      if (!feedUrl) continue;
      const title = feed.title?.trim() || 'Unknown';
      const author = feed.author?.trim();
      const imageUrl = feed.image?.trim() || feed.artwork?.trim();
      out.push({
        title,
        feedUrl,
        source: 'podcastindex',
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      });
    }
    return out;
  }
}

export function createPodcastIndexSearcher(deps: PodcastIndexSearcherDeps): PodcastSearcher {
  return new PodcastIndexSearcher(deps);
}
