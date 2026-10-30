import { MiniPodError } from '../errors';
import type { FeedType } from '../types';
import { getAttr, stripHtmlCompact, tokenizeXml } from './xml/tokenizer';

export const RDF_SYNTAX_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

function extractHtmlWebsiteTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const cleaned = stripHtmlCompact(match[1]!);
  return cleaned || undefined;
}

/**
 * Port of AntennaPod's `TypeGetter.getType`, plus guarded RDF/RSS 1.0 (`<rdf:RDF>`) support.
 *
 * Inspects the root element:
 * - `<feed>` -> `'atom'`
 * - `<rss version="2.0" | absent>` -> `'rss20'`
 * - `<rss version="0.91" | "0.92">` -> `'rss091'`
 * - `<rdf:RDF>` -> `'rdf'`
 * - `<html>` (or HTML doctype) -> throws `MiniPodError('unsupported-feed', ...)` with `details.isHtml = true` and `websiteTitle`
 * - Anything else -> throws `MiniPodError('unsupported-feed', ...)`
 */
export function detectFeedType(text: string): FeedType {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new MiniPodError('unsupported-feed', 'Empty feed response');
  }

  if (/^<!doctype\s+html\b/i.test(trimmed)) {
    const websiteTitle = extractHtmlWebsiteTitle(trimmed);
    throw new MiniPodError(
      'unsupported-feed',
      websiteTitle ? `Website title: "${websiteTitle}"` : 'Document is an HTML webpage, not a podcast feed',
      { details: { rootTag: 'html', isHtml: true, ...(websiteTitle ? { websiteTitle } : {}) } },
    );
  }

  for (const event of tokenizeXml(trimmed)) {
    if (event.type !== 'startElement') continue;

    const localLower = event.localName.toLowerCase();
    if (event.localName === 'feed' || (localLower === 'feed' && event.uri.includes('Atom'))) {
      return 'atom';
    }
    if (localLower === 'rss') {
      const version = getAttr(event.attributes, 'version')?.trim();
      if (!version || version === '2.0') {
        return 'rss20';
      }
      if (version === '0.91' || version === '0.92') {
        return 'rss091';
      }
      throw new MiniPodError('unsupported-feed', `Unsupported RSS version: ${version}`, {
        details: { rootTag: 'rss', version },
      });
    }
    if (
      event.localName === 'RDF' &&
      (event.uri === RDF_SYNTAX_URI || event.prefix.toLowerCase() === 'rdf' || event.uri !== '')
    ) {
      return 'rdf';
    }
    if (localLower === 'html') {
      const websiteTitle = extractHtmlWebsiteTitle(trimmed);
      throw new MiniPodError(
        'unsupported-feed',
        websiteTitle ? `Website title: "${websiteTitle}"` : 'Document is an HTML webpage, not a podcast feed',
        { details: { rootTag: 'html', isHtml: true, ...(websiteTitle ? { websiteTitle } : {}) } },
      );
    }

    throw new MiniPodError('unsupported-feed', `Unsupported root element <${event.rawName}>`, {
      details: { rootTag: event.localName },
    });
  }

  throw new MiniPodError('unsupported-feed', 'No XML root element found');
}

export const TypeDetector = {
  detect: detectFeedType,
} as const;
