import { MiniPodError } from '../errors';
import { LOCAL_FOLDER_URL_PREFIX, type EpochMs, type FeedKind, type OpmlCandidate } from '../types';
import { formatRfc822Date } from '../util/time';
import { escapeXml, getAttr, tokenizeXml } from './xml/tokenizer';

/**
 * Port of AntennaPod's `OpmlReader`: parses OPML 1.0 / 2.0 XML and flattens all `<outline>`
 * elements possessing an `xmlUrl` attribute.
 */
export function parseOpml(xml: string): OpmlCandidate[] {
  const trimmed = xml.trim();
  if (!trimmed) {
    throw new MiniPodError('unsupported-feed', 'Empty OPML document');
  }

  let sawOpmlRoot = false;
  const candidates: OpmlCandidate[] = [];

  for (const event of tokenizeXml(trimmed)) {
    if (event.type !== 'startElement') continue;
    const tag = event.localName.toLowerCase();

    if (!sawOpmlRoot) {
      if (tag !== 'opml') {
        throw new MiniPodError('unsupported-feed', `Expected <opml> root element, got <${event.rawName}>`);
      }
      sawOpmlRoot = true;
      continue;
    }

    if (tag === 'outline') {
      const xmlUrl = getAttr(event.attributes, 'xmlUrl')?.trim();
      if (!xmlUrl) continue;

      const title =
        getAttr(event.attributes, 'title')?.trim() ||
        getAttr(event.attributes, 'text')?.trim() ||
        xmlUrl;
      const htmlUrl = getAttr(event.attributes, 'htmlUrl')?.trim();
      const type = getAttr(event.attributes, 'type')?.trim();

      candidates.push({
        title,
        xmlUrl,
        ...(htmlUrl ? { htmlUrl } : {}),
        ...(type ? { type } : {}),
      });
    }
  }

  if (!sawOpmlRoot) {
    throw new MiniPodError('unsupported-feed', 'No <opml> root element found');
  }

  return candidates;
}

/** Alias matching `OpmlReader.readDocument` / brief `readOpml`. */
export const readOpml = parseOpml;

export interface OpmlExportableFeed {
  readonly url: string;
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly kind?: FeedKind | undefined;
  readonly subscribed?: boolean | undefined;
}

export interface WriteOpmlOptions {
  readonly title?: string;
  readonly dateCreatedMs?: EpochMs;
}

/**
 * Port of AntennaPod's `OpmlWriter`: serializes subscribed RSS/Atom feeds as UTF-8 OPML 2.0,
 * excluding unsubscribed stubs and `local-folder:` feeds.
 */
export function writeOpml(
  feeds: readonly OpmlExportableFeed[],
  options?: WriteOpmlOptions,
): string {
  const docTitle = options?.title ?? 'MiniPod Subscriptions';
  const dateCreated = formatRfc822Date(options?.dateCreatedMs ?? Date.now());

  const outlines: string[] = [];
  for (const feed of feeds) {
    if (feed.subscribed === false) continue;
    if (feed.kind === 'LOCAL' || feed.url.startsWith(LOCAL_FOLDER_URL_PREFIX)) continue;
    const xmlUrl = feed.url.trim();
    if (!xmlUrl) continue;

    const feedTitle = (feed.title?.trim() || xmlUrl);
    const htmlAttr = feed.link?.trim() ? ` htmlUrl="${escapeXml(feed.link.trim())}"` : '';
    outlines.push(
      `    <outline text="${escapeXml(feedTitle)}" title="${escapeXml(feedTitle)}" type="rss" xmlUrl="${escapeXml(xmlUrl)}"${htmlAttr} />`,
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(docTitle)}</title>`,
    `    <dateCreated>${escapeXml(dateCreated)}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...outlines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

export const Opml = {
  parse: parseOpml,
  read: readOpml,
  write: writeOpml,
} as const;
