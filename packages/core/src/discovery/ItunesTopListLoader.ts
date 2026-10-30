import { MiniPodError } from '../errors';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import {
  COUNTRY_CODE_UNSET,
  TOP_CHARTS_LIMIT,
  type CountryCode,
  type HttpClient,
  type SearchResult,
  type TopListLoader,
} from '../types';

export interface ItunesTopListLoaderDeps {
  readonly http: HttpClient;
  /** Locale-derived 2-letter country code when caller passes `COUNTRY_CODE_UNSET` (`'99'`). Defaults to `'US'`. */
  readonly defaultCountry?: CountryCode;
  readonly userAgent?: string;
}

interface RssLabelNode {
  readonly label?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

interface ItunesRssEntry {
  readonly 'im:name'?: RssLabelNode;
  readonly 'im:artist'?: RssLabelNode;
  readonly 'im:image'?: readonly RssLabelNode[];
  readonly id?: RssLabelNode;
}

interface ItunesTopPodcastsJson {
  readonly feed?: {
    readonly entry?: readonly ItunesRssEntry[] | ItunesRssEntry;
  };
}

export const TOP_CHART_COUNTRIES: readonly { readonly code: CountryCode; readonly name: string }[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'JP', name: 'Japan' },
  { code: 'CN', name: 'China' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'SG', name: 'Singapore' },
  { code: 'KR', name: 'South Korea' },
  { code: 'IN', name: 'India' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
];

function selectCoverImage(images: readonly RssLabelNode[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;
  let bestUrl: string | undefined;
  let bestHeight = -1;
  for (const img of images) {
    const url = img.label?.trim();
    if (!url) continue;
    const h = Number.parseInt(img.attributes?.['height'] ?? '0', 10);
    const height = Number.isFinite(h) ? h : 0;
    if (height >= bestHeight) {
      bestHeight = height;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/**
 * Port of AntennaPod's `ItunesTopListLoader`.
 *
 * Fallback rule: falls back to `'US'` ONLY when `country` is `'99'` (`COUNTRY_CODE_UNSET`) or empty.
 * An explicit country whose chart fails or has no data rejects with `feed-not-found` ("iTunes has no data for this country").
 */
export class ItunesTopListLoader implements TopListLoader {
  private readonly http: HttpClient;
  private readonly defaultCountry: CountryCode;
  private readonly userAgent: string;

  constructor(deps: ItunesTopListLoaderDeps) {
    this.http = deps.http;
    this.defaultCountry =
      deps.defaultCountry && deps.defaultCountry !== COUNTRY_CODE_UNSET
        ? deps.defaultCountry.toUpperCase()
        : 'US';
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  async topPodcasts(
    country: CountryCode = COUNTRY_CODE_UNSET,
    limit: number = TOP_CHARTS_LIMIT,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const trimmed = country.trim();
    const isUnset = trimmed === '' || trimmed === COUNTRY_CODE_UNSET;
    const targetCountry = (isUnset ? this.defaultCountry : trimmed).toUpperCase();
    const clampedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));

    try {
      return await this.fetchForCountry(targetCountry, clampedLimit, signal);
    } catch (err) {
      if (err instanceof MiniPodError && err.code === 'cancelled') {
        throw err;
      }
      if (isUnset && targetCountry !== 'US') {
        return this.fetchForCountry('US', clampedLimit, signal);
      }
      throw err;
    }
  }

  private async fetchForCountry(
    cc: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    if (!/^[A-Z]{2}$/.test(cc)) {
      throw new MiniPodError('invalid-argument', `Invalid ISO country code: ${cc}`, {
        details: { country: cc },
      });
    }

    const url = `https://itunes.apple.com/${cc.toLowerCase()}/rss/toppodcasts/limit=${limit}/explicit=true/json`;
    const resp = await this.http({
      url,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
      ...(signal ? { signal } : {}),
    });

    if (resp.status === 400 || resp.status === 404) {
      throw new MiniPodError('feed-not-found', `iTunes has no data for country ${cc}`, {
        details: { country: cc, status: resp.status },
      });
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `iTunes top charts failed with HTTP ${resp.status}`, {
        details: { country: cc, status: resp.status },
      });
    }

    let parsed: ItunesTopPodcastsJson;
    try {
      parsed = JSON.parse(await resp.text()) as ItunesTopPodcastsJson;
    } catch (err) {
      throw new MiniPodError('network', 'Invalid JSON from iTunes top charts', { cause: err });
    }

    const rawEntries = parsed.feed?.entry;
    if (!rawEntries) {
      throw new MiniPodError('feed-not-found', `iTunes has no data for country ${cc}`, {
        details: { country: cc },
      });
    }
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    if (entries.length === 0) {
      throw new MiniPodError('feed-not-found', `iTunes has no data for country ${cc}`, {
        details: { country: cc },
      });
    }

    const results: SearchResult[] = [];
    for (const entry of entries as readonly ItunesRssEntry[]) {
      const id = entry.id?.attributes?.['im:id']?.trim();
      if (!id) continue;
      const title = entry['im:name']?.label?.trim() || 'Unknown';
      const author = entry['im:artist']?.label?.trim();
      const imageUrl = selectCoverImage(entry['im:image']);
      results.push({
        title,
        feedUrl: `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`,
        source: 'apple',
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      });
    }
    return results.slice(0, limit);
  }
}

/**
 * Port of AntennaPod's `ItunesTopListLoader.removeSubscribed`: filters out suggestions
 * matching any subscribed feed's title and caps at `limit`.
 */
export function filterOutSubscribed(
  suggestions: readonly SearchResult[],
  subscribedTitles: readonly (string | undefined)[],
  limit: number = TOP_CHARTS_LIMIT,
): SearchResult[] {
  const titleSet = new Set(
    subscribedTitles.map((t) => t?.trim()).filter((t): t is string => Boolean(t)),
  );
  const out: SearchResult[] = [];
  for (const s of suggestions) {
    if (titleSet.has(s.title.trim())) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export function createItunesTopListLoader(deps: ItunesTopListLoaderDeps): TopListLoader {
  return new ItunesTopListLoader(deps);
}
