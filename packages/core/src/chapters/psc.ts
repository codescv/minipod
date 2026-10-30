import { SIMPLE_CHAPTERS_URI, SIMPLE_CHAPTERS_URI_SLASH } from '../feed/namespace/SimpleChapters';
import { getAttr, tokenizeXml } from '../feed/xml/tokenizer';
import type { Chapter } from '../types';
import { parseChapterTimestampMs } from '../util/time';
import { resolveRelativeUrl } from '../util/url';

function resolveMaybe(href: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  if (!baseUrl) return trimmed;
  try {
    return resolveRelativeUrl(trimmed, baseUrl);
  } catch {
    return trimmed;
  }
}

/**
 * Standalone Podlove Simple Chapters (`<psc:chapters>`) XML parser.
 */
export function parsePscChapters(xmlText: string, baseUrl?: string): Chapter[] {
  const out: Chapter[] = [];
  for (const event of tokenizeXml(xmlText)) {
    if (event.type !== 'startElement') continue;
    const isPsc =
      event.uri === SIMPLE_CHAPTERS_URI ||
      event.uri === SIMPLE_CHAPTERS_URI_SLASH ||
      event.prefix === 'psc' ||
      event.prefix === 'sc' ||
      (event.uri === '' && event.prefix === '');
    if (!isPsc || event.localName !== 'chapter') continue;

    const startRaw = getAttr(event.attributes, 'start');
    if (!startRaw) continue;
    const startMs = parseChapterTimestampMs(startRaw);
    if (startMs === undefined || startMs < 0) continue;

    const title = getAttr(event.attributes, 'title')?.trim();
    const link = resolveMaybe(getAttr(event.attributes, 'href'), baseUrl);
    const imageUrl = resolveMaybe(getAttr(event.attributes, 'image'), baseUrl);

    out.push({
      startMs,
      source: 'PSC',
      ...(title ? { title } : {}),
      ...(link ? { link } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}
