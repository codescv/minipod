import { MiniPodError } from '../errors';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import type { HttpClient, PodcastSearcher, SearchResult } from '../types';

export interface GpodderSearcherDeps {
  readonly http: HttpClient;
  readonly baseUrl?: string;
  readonly userAgent?: string;
}

interface GpodderPodcastJson {
  readonly title?: string;
  readonly author?: string;
  readonly url?: string;
  readonly logo_url?: string;
  readonly scaled_logo_url?: string;
}

/**
 * Port of AntennaPod's legacy `GpodnetPodcastSearcher` (`https://gpodder.net/search.json`).
 * Kept at `combinedWeight = 0.0` so gpodder.net instability never delays federated search.
 */
export class GpodderSearcher implements PodcastSearcher {
  readonly id = 'gpodder' as const;
  readonly displayName = 'gpodder.net';
  readonly combinedWeight = 0.0;

  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(deps: GpodderSearcherDeps) {
    this.http = deps.http;
    this.baseUrl = (deps.baseUrl ?? 'https://gpodder.net').replace(/\/+$/, '');
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = `${this.baseUrl}/search.json?q=${encodeURIComponent(trimmed)}`;
    return this.fetchList(url, signal);
  }

  async topList(limit: number = 50, signal?: AbortSignal): Promise<SearchResult[]> {
    const clamped = Math.max(1, Math.min(100, Math.trunc(limit)));
    const url = `${this.baseUrl}/toplist/${clamped}.json`;
    return this.fetchList(url, signal);
  }

  private async fetchList(url: string, signal?: AbortSignal): Promise<SearchResult[]> {
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
      throw new MiniPodError('network', `gpodder.net request failed with HTTP ${resp.status}`, {
        details: { status: resp.status },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await resp.text());
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from gpodder.net', { cause: err });
    }

    if (!Array.isArray(parsed)) return [];

    const out: SearchResult[] = [];
    for (const item of parsed as readonly GpodderPodcastJson[]) {
      const feedUrl = item?.url?.trim();
      if (!feedUrl) continue;
      const title = item.title?.trim() || 'Unknown';
      const author = item.author?.trim();
      const imageUrl = item.scaled_logo_url?.trim() || item.logo_url?.trim();
      out.push({
        title,
        feedUrl,
        source: 'gpodder',
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      });
    }
    return out;
  }
}

export function createGpodderSearcher(deps: GpodderSearcherDeps): PodcastSearcher {
  return new GpodderSearcher(deps);
}
