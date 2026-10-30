import { MiniPodError } from '../errors';
import type { HttpBasicCredentials } from '../types';

/**
 * Extracts `username:password@` userInfo from an HTTP(S) URL if present,
 * returning the sanitized URL without credentials and the decoded credentials.
 */
export function extractUrlCredentials(rawUrl: string): {
  readonly cleanUrl: string;
  readonly credentials?: HttpBasicCredentials;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { cleanUrl: rawUrl };
  }

  if (parsed.username === '' && parsed.password === '') {
    return { cleanUrl: rawUrl };
  }

  const username = safeDecodeComponent(parsed.username);
  const password = safeDecodeComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return {
    cleanUrl: parsed.toString(),
    credentials: { username, password },
  };
}

export function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a possibly-relative `href` against an optional `baseUrl`.
 */
export function resolveRelativeUrl(href: string, baseUrl?: string): string {
  const trimmed = href.trim();
  if (!trimmed) {
    throw new MiniPodError('invalid-url', 'Empty URL');
  }
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch (err) {
    throw new MiniPodError('invalid-url', `Invalid URL: ${trimmed}`, { cause: err });
  }
}

/**
 * Extracts the first podcast/HTTP URL from arbitrary shared text (e.g. Android `ACTION_SEND`),
 * or returns `undefined` if none is present.
 */
export function extractUrlFromSharedText(text: string): string | undefined {
  const match =
    /(?:https?:\/\/|feed:\/\/|itpc:\/\/|pcast:\/\/|pcast:|antennapod-subscribe:\/\/)[^\s<>"')]+/i.exec(text);
  if (!match) return undefined;
  return match[0].replace(/[.,;:!?]+$/, '');
}

/**
 * Heuristic used by the unified Add/Search box to decide whether user input looks like
 * a feed/website/scheme URL rather than a keyword search query.
 */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  const lower = s.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('feed://') ||
    lower.startsWith('itpc://') ||
    lower.startsWith('pcast://') ||
    lower.startsWith('pcast:') ||
    lower.startsWith('antennapod-subscribe://') ||
    lower.includes('subscribeonandroid.com/') ||
    lower.includes('antennapod.org/deeplink/subscribe')
  ) {
    return true;
  }
  // Bare domain or domain/path such as `relay.fm/cortex` or `feeds.simplecast.com/abc`
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(s);
}
