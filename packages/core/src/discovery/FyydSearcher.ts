import { MiniPodError } from '../errors';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import type { HttpClient, PodcastSearcher, SearchResult } from '../types';

export interface FyydSearcherDeps {
  readonly http: HttpClient;
  readonly count?: number;
  readonly userAgent?: string;
}

interface FyydPodcastJson {
  readonly title?: string;
  readonly author?: string;
  readonly thumbImageURL?: string;
  readonly imgURL?: string;
  readonly xmlURL?: string;
}

interface FyydResponseJson {
  readonly data?: readonly FyydPodcastJson[];
}

/**
 * Port of AntennaPod's `FyydPodcastSearcher` (`https://api.fyyd.de/0.2/search/podcast`).
 * Excluded from federated search by default (`combinedWeight = 0.0`), selectable standalone.
 */
export class FyydSearcher implements PodcastSearcher {
  readonly id = 'fyyd' as const;
  readonly displayName = 'fyyd';
  readonly combinedWeight = 0.0;

  private readonly http: HttpClient;
  private readonly count: number;
  private readonly userAgent: string;

  constructor(deps: FyydSearcherDeps) {
    this.http = deps.http;
    this.count = deps.count ?? 10;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = `https://api.fyyd.de/0.2/search/podcast?title=${encodeURIComponent(trimmed)}&count=${this.count}`;
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
      throw new MiniPodError('network', `fyyd search failed with HTTP ${resp.status}`, {
        details: { status: resp.status },
      });
    }

    let parsed: FyydResponseJson;
    try {
      parsed = JSON.parse(await resp.text()) as FyydResponseJson;
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from fyyd search', { cause: err });
    }

    const out: SearchResult[] = [];
    for (const item of parsed.data ?? []) {
      const feedUrl = item.xmlURL?.trim();
      if (!feedUrl) continue;
      const title = item.title?.trim() || 'Unknown';
      const author = item.author?.trim();
      const imageUrl = item.thumbImageURL?.trim() || item.imgURL?.trim();
      out.push({
        title,
        feedUrl,
        source: 'fyyd',
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      });
    }
    return out;
  }
}

export function createFyydSearcher(deps: FyydSearcherDeps): PodcastSearcher {
  return new FyydSearcher(deps);
}
