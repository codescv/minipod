import type { PermanentRedirect, RedirectHop } from '../types';

function isHttpToIdenticalHttps(fromUrl: string, toUrl: string): boolean {
  if (!/^http:\/\//i.test(fromUrl) || !/^https:\/\//i.test(toUrl)) {
    return false;
  }
  const directUpgrade = fromUrl.replace(/^http:\/\//i, 'https://');
  if (directUpgrade === toUrl) return true;

  try {
    const u1 = new URL(fromUrl);
    const u2 = new URL(toUrl);
    return (
      u1.protocol === 'http:' &&
      u2.protocol === 'https:' &&
      u1.hostname.toLowerCase() === u2.hostname.toLowerCase() &&
      (u1.port === '' || u1.port === '80') &&
      (u2.port === '' || u2.port === '443') &&
      u1.pathname === u2.pathname &&
      u1.search === u2.search
    );
  } catch {
    return false;
  }
}

function classifyHop(hop: RedirectHop): PermanentRedirect['reason'] | undefined {
  if (hop.status === 301) return '301';
  if (hop.status === 308) return '308';
  if (isHttpToIdenticalHttps(hop.url, hop.location)) return 'http-to-https';
  return undefined;
}

/**
 * Port of AntennaPod's `RedirectChecker.getNewUrlIfPermanentRedirect`.
 *
 * Inspects a redirect chain in order and walks all consecutive permanent redirects
 * (`301`, `308`, or non-permanent `http://` -> identical `https://` upgrade) starting
 * from the initial request URL, stopping before any temporary redirect (e.g. a 302 CDN hop).
 */
export function analyseRedirects(chain: readonly RedirectHop[]): PermanentRedirect | undefined {
  if (chain.length === 0) return undefined;

  const firstHop = chain[0]!;
  const firstReason = classifyHop(firstHop);
  if (!firstReason) return undefined;

  const from = firstHop.url;
  let to = firstHop.location;
  let reason: PermanentRedirect['reason'] = firstReason;

  for (let i = 1; i < chain.length; i++) {
    const hop = chain[i]!;
    const hopReason = classifyHop(hop);
    if (!hopReason) {
      // Stop before temporary redirect so temporary CDN URLs are never persisted as the feed URL.
      break;
    }
    to = hop.location;
    if (reason === 'http-to-https' && (hopReason === '301' || hopReason === '308')) {
      reason = hopReason;
    } else if (hopReason === '301' || hopReason === '308') {
      reason = hopReason;
    }
  }

  if (from === to) return undefined;
  return { from, to, reason };
}

export const RedirectRecorder = {
  analyse: analyseRedirects,
  isHttpToIdenticalHttps,
} as const;
