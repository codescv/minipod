import { MiniPodError } from '../errors';
import { LOCAL_FOLDER_URL_PREFIX, type FeedKey } from '../types';
import { sha1Hex, sha1HexSync } from '../util/sha1';
import { safeDecodeComponent } from '../util/url';

const AP_SUBSCRIBE = 'antennapod-subscribe://';
const AP_SUBSCRIBE_DEEPLINK = 'antennapod.org/deeplink/subscribe';

/**
 * Port of AntennaPod's `UrlChecker.prepareUrl(url, base)`.
 *
 * Normalizes custom podcast schemes (`feed://`, `pcast://`, `pcast:`, `itpc://`,
 * `antennapod-subscribe://`), unwraps `antennapod.org/deeplink/subscribe?url=...`
 * and `subscribeonandroid.com/...`, resolves protocol-relative/path-relative URLs
 * against `base` when given, and defaults scheme-less URLs to `http://`.
 */
export function prepareUrl(rawUrl: string, baseUrl?: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new MiniPodError('invalid-url', 'URL must not be empty');
  }

  if (trimmed.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
    return trimmed;
  }

  if (baseUrl !== undefined && baseUrl.trim() !== '') {
    const preparedBase = prepareUrl(baseUrl);
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      trimmed.startsWith('?')
    ) {
      try {
        return new URL(trimmed, preparedBase).toString();
      } catch (err) {
        throw new MiniPodError('invalid-url', `Invalid relative URL: ${trimmed}`, { cause: err });
      }
    }
  }

  const lower = trimmed.toLowerCase();

  if (lower.startsWith('feed://')) {
    return prepareUrl(trimmed.slice('feed://'.length));
  }
  if (lower.startsWith('pcast://')) {
    return prepareUrl(trimmed.slice('pcast://'.length));
  }
  if (lower.startsWith('pcast:')) {
    return prepareUrl(trimmed.slice('pcast:'.length));
  }
  if (lower.startsWith('itpc://')) {
    return prepareUrl(trimmed.slice('itpc://'.length));
  }
  if (lower.startsWith('itpc:')) {
    return prepareUrl(trimmed.slice('itpc:'.length));
  }
  if (lower.startsWith(AP_SUBSCRIBE)) {
    return prepareUrl(trimmed.slice(AP_SUBSCRIBE.length));
  }
  if (lower.includes(AP_SUBSCRIBE_DEEPLINK)) {
    const normalizedDeeplink =
      lower.startsWith('http://') || lower.startsWith('https://') ? trimmed : `https://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(normalizedDeeplink);
    } catch (err) {
      throw new MiniPodError('invalid-url', `Invalid deeplink URL: ${trimmed}`, { cause: err });
    }
    const target = parsed.searchParams.get('url');
    if (!target) {
      throw new MiniPodError('invalid-url', 'AntennaPod subscribe deeplink is missing the "url" query parameter');
    }
    return prepareUrl(safeDecodeComponent(target));
  }
  if (lower.includes('subscribeonandroid.com/')) {
    // Handle both `https://subscribeonandroid.com/https://...` and `https://www.subscribeonandroid.com/example.com/rss`
    const nestedSchemeStripped = trimmed.replace(
      /^(?:https?:\/\/)?(?:www\.)?subscribeonandroid\.com\/(?=https?:\/\/|feed:\/\/|itpc:\/\/|pcast:)/i,
      '',
    );
    if (nestedSchemeStripped !== trimmed) {
      return prepareUrl(nestedSchemeStripped);
    }
    const stripped = trimmed.replace(/(?:www\.)?subscribeonandroid\.com\//i, '');
    return prepareUrl(stripped);
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

/**
 * Checks whether `url` is an `antennapod.org/deeplink/subscribe` link missing `?url=`.
 */
export function isDeeplinkWithoutUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().includes(AP_SUBSCRIBE_DEEPLINK)) return false;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return !u.searchParams.get('url');
  } catch {
    return true;
  }
}

/**
 * Produces the scheme-less canonical identity string for a feed URL (ARCHITECTURE.md §4.1.3):
 * 1. `prepareUrl(url)`
 * 2. Drop scheme (`http:` / `https:`) and `userInfo`
 * 3. Lowercase host; drop default ports (`80`, `443`) and `#fragment`
 * 4. Normalize path segments (drop empty segments and trailing slash; preserve segment case)
 * 5. Keep query verbatim (`?` empty === absent)
 *
 * Format: `host + "/" + path` (or `host + "/" + path + "?" + query` when query is non-empty).
 */
export function schemeLessCanonical(rawUrl: string): string {
  const prepared = prepareUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(prepared);
  } catch (err) {
    throw new MiniPodError('invalid-url', `Invalid feed URL: ${rawUrl}`, { cause: err });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new MiniPodError('invalid-url', `Feed URL has no host: ${rawUrl}`);
  }
  const port = parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '';
  const host = `${hostname}${port}`;

  // Preserve segment case (e.g. case-sensitive Simplecast/FeedBurner slugs) while collapsing empty/trailing slashes
  const segments = parsed.pathname.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  const resolvedSegments: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(seg);
    }
  }
  const path = resolvedSegments.join('/');

  // Raw query string without leading `?`; empty `?` is treated as absent
  const qIndex = prepared.indexOf('?');
  let query = '';
  if (qIndex >= 0) {
    const hashIndex = prepared.indexOf('#', qIndex);
    query = (hashIndex >= 0 ? prepared.slice(qIndex + 1, hashIndex) : prepared.slice(qIndex + 1)).trim();
  }

  return query.length > 0 ? `${host}/${path}?${query}` : `${host}/${path}`;
}

/**
 * Derives a deterministic `FeedKey` (`"f_" + sha1Hex(schemeLessCanonical(url))`,
 * or `"l_" + sha1Hex(folderRef)` for `local-folder:` URLs).
 */
export function feedKey(rawUrl: string): FeedKey {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
    return localFolderFeedKey(trimmed.slice(LOCAL_FOLDER_URL_PREFIX.length));
  }
  return `f_${sha1HexSync(schemeLessCanonical(trimmed))}`;
}

/**
 * Async WebCrypto (`crypto.subtle.digest('SHA-1')`) variant of `feedKey`.
 */
export async function feedKeyAsync(rawUrl: string): Promise<FeedKey> {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
    return `l_${await sha1Hex(trimmed.slice(LOCAL_FOLDER_URL_PREFIX.length))}`;
  }
  return `f_${await sha1Hex(schemeLessCanonical(trimmed))}`;
}

/**
 * Derives the local-only `FeedKey` (`"l_" + sha1Hex(folderRef)`) for a Local Folder feed.
 */
export function localFolderFeedKey(folderRef: string): FeedKey {
  return `l_${sha1HexSync(folderRef)}`;
}

/**
 * Port of AntennaPod's `UrlChecker.urlEquals` (scheme-agnostic feed URL equality).
 */
export function urlEquals(urlA: string, urlB: string): boolean {
  try {
    return feedKey(urlA) === feedKey(urlB);
  } catch {
    return urlA.trim() === urlB.trim();
  }
}

export const UrlNormalizer = {
  prepare: prepareUrl,
  isDeeplinkWithoutUrl,
  schemeLessCanonical,
  feedKey,
  feedKeyAsync,
  localFolderFeedKey,
  urlEquals,
} as const;
