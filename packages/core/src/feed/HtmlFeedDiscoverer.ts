import type { DiscoveredFeedLink } from '../types';
import { decodeXmlEntities } from './xml/tokenizer';

function parseHtmlTagAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrText)) !== null) {
    const key = m[1]!.toLowerCase();
    const rawVal = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeXmlEntities(rawVal);
  }
  return attrs;
}

/**
 * Port of AntennaPod's `FeedDiscoverer`: scans HTML `<link>` tags for RSS/Atom feeds
 * (`rel="alternate"` or `rel="feed"`, `type="application/rss+xml"` or `"application/atom+xml"`)
 * and resolves `href` against `pageUrl` via `new URL(href, pageUrl)`.
 */
export function discoverFeeds(html: string, pageUrl: string): DiscoveredFeedLink[] {
  if (!html) return [];

  // Strip HTML comments so commented-out `<link>` tags are ignored
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(cleaned);
  const scope = headMatch ? headMatch[1]! : cleaned;

  const results = scanLinkTags(scope, pageUrl);
  if (results.length > 0 || !headMatch) {
    return results;
  }
  // Fallback: scan entire HTML document if `<head>` had no feed links
  return scanLinkTags(cleaned, pageUrl);
}

function scanLinkTags(htmlChunk: string, pageUrl: string): DiscoveredFeedLink[] {
  const found: DiscoveredFeedLink[] = [];
  const seenUrls = new Set<string>();
  const linkRegex = /<link\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(htmlChunk)) !== null) {
    const attrs = parseHtmlTagAttributes(match[1]!);
    const relRaw = attrs['rel']?.trim().toLowerCase() ?? '';
    const relTokens = relRaw.split(/\s+/).filter(Boolean);
    if (!relTokens.includes('alternate') && !relTokens.includes('feed')) {
      continue;
    }

    const typeRaw = attrs['type']?.split(';')[0]?.trim().toLowerCase();
    if (typeRaw !== 'application/rss+xml' && typeRaw !== 'application/atom+xml') {
      continue;
    }

    const hrefRaw = attrs['href']?.trim();
    if (!hrefRaw) continue;

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(hrefRaw, pageUrl).toString();
    } catch {
      continue;
    }

    if (seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    const title = attrs['title']?.trim();
    found.push({
      url: resolvedUrl,
      type: typeRaw,
      ...(title ? { title } : {}),
    });
  }

  return found;
}

export const HtmlFeedDiscoverer = {
  discover: discoverFeeds,
} as const;
