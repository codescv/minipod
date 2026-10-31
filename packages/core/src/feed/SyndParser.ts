import type { ParsedEpisode, ParsedFeed } from '../types';
import { episodeIdentity } from './identity';
import { classifyMediaType } from './mime';
import {
  AtomNamespace,
  ContentNamespace,
  DublinCoreNamespace,
  ItunesNamespace,
  MediaNamespace,
  PodcastIndexNamespace,
  RdfNamespace,
  Rss20Namespace,
  SimpleChaptersNamespace,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './namespace';
import { detectFeedType } from './TypeDetector';
import { escapeXml, getAttr, tokenizeXml } from './xml/tokenizer';

const ALL_HANDLERS: readonly NamespaceHandler[] = [
  AtomNamespace,
  RdfNamespace,
  ItunesNamespace,
  PodcastIndexNamespace,
  ContentNamespace,
  MediaNamespace,
  SimpleChaptersNamespace,
  DublinCoreNamespace,
];

const URI_MAP = new Map<string, NamespaceHandler>();
const PREFIX_MAP = new Map<string, NamespaceHandler>();

for (const handler of ALL_HANDLERS) {
  for (const uri of handler.uris) {
    URI_MAP.set(uri, handler);
    URI_MAP.set(uri.toLowerCase(), handler);
  }
  if (handler.prefixes) {
    for (const p of handler.prefixes) {
      PREFIX_MAP.set(p.toLowerCase(), handler);
    }
  }
}

export interface ParseFeedOptions {
  readonly baseUrl?: string;
}

function resolveHandler(
  uri: string,
  prefix: string,
  feedType: ParsedFeed['type'],
): NamespaceHandler | undefined {
  if (uri) {
    const byUri = URI_MAP.get(uri) ?? URI_MAP.get(uri.toLowerCase());
    if (byUri) return byUri;
  }
  if (prefix) {
    const byPrefix = PREFIX_MAP.get(prefix.toLowerCase());
    if (byPrefix) return byPrefix;
  }
  if (!uri && !prefix) {
    if (feedType === 'atom') return AtomNamespace;
    if (feedType === 'rdf') return RdfNamespace;
    return Rss20Namespace;
  }
  return undefined;
}

/**
 * Pure-TS streaming feed parser supporting RSS 2.0 / 0.91 / 0.92, Atom 1.0, and RDF / RSS 1.0
 * with full namespace support (`itunes`, `podcast`, `content`, `media`, `psc`, `dc`, `atom`).
 */
export function parseFeed(xmlText: string, options?: ParseFeedOptions): ParsedFeed {
  const feedType = detectFeedType(xmlText);

  const state: FeedParseState = {
    baseUrl: options?.baseUrl,
    feed: {
      type: feedType,
      alternateFeedUrls: {},
      episodes: [],
    },
    stack: [],
    currentItem: null,
  };

  let xhtmlCaptureDepth = 0;
  let xhtmlTargetEntry: StackEntry | null = null;

  for (const event of tokenizeXml(xmlText)) {
    if (event.type === 'startElement') {
      if (xhtmlCaptureDepth > 0 && xhtmlTargetEntry) {
        xhtmlCaptureDepth++;
        if (xhtmlCaptureDepth > 2 || event.localName.toLowerCase() !== 'div') {
          const attrsSerialized = event.attributes
            .map((a) => ` ${a.rawName}="${escapeXml(a.value)}"`)
            .join('');
          xhtmlTargetEntry.textBuffer += `<${event.localName}${attrsSerialized}>`;
        }
        continue;
      }

      const entry: StackEntry = {
        localName: event.localName,
        uri: event.uri,
        prefix: event.prefix,
        attributes: event.attributes,
        textBuffer: '',
      };
      state.stack.push(entry);

      const handler = resolveHandler(event.uri, event.prefix, feedType);
      handler?.onStartElement?.(entry, state);

      // Start XHTML subtree serialization for Atom `<content type="xhtml">` / `<summary type="xhtml">`
      if (
        handler === AtomNamespace &&
        (event.localName === 'content' || event.localName === 'summary' || event.localName === 'title' || event.localName === 'subtitle') &&
        getAttr(event.attributes, 'type')?.trim().toLowerCase() === 'xhtml'
      ) {
        xhtmlCaptureDepth = 1;
        xhtmlTargetEntry = entry;
      }
    } else if (event.type === 'text') {
      if (xhtmlCaptureDepth > 0 && xhtmlTargetEntry) {
        xhtmlTargetEntry.textBuffer += event.cdata ? event.text : escapeXml(event.text);
      } else if (state.stack.length > 0) {
        state.stack[state.stack.length - 1]!.textBuffer += event.text;
      }
    } else if (event.type === 'endElement') {
      if (xhtmlCaptureDepth > 1 && xhtmlTargetEntry) {
        if (xhtmlCaptureDepth > 2 || event.localName.toLowerCase() !== 'div') {
          xhtmlTargetEntry.textBuffer += `</${event.localName}>`;
        }
        xhtmlCaptureDepth--;
        continue;
      }
      if (xhtmlCaptureDepth === 1) {
        xhtmlCaptureDepth = 0;
        xhtmlTargetEntry = null;
      }

      const top = state.stack[state.stack.length - 1];
      if (!top) continue;

      const handler = resolveHandler(top.uri, top.prefix, feedType);
      handler?.onEndElement?.(top, state);
      state.stack.pop();
    }
  }

  const parsedEpisodes: ParsedEpisode[] = state.feed.episodes.map((ep) => {
    const title = ep.title?.trim() || 'Untitled';
    const identity = episodeIdentity({
      guid: ep.guid,
      enclosureUrl: ep.enclosureUrl,
      title,
      pubDate: ep.pubDate,
    });
    const mediaType =
      ep.mediaType ??
      (ep.enclosureUrl ? classifyMediaType(ep.enclosureMime, ep.enclosureUrl) : 'UNKNOWN');

    const sortedChapters =
      ep.chapters && ep.chapters.length > 0
        ? [...ep.chapters].sort((a, b) => a.startMs - b.startMs)
        : undefined;

    const effectiveLink = ep.link ?? ep.socialInteractUrl;
    const normalizedEpImage = ep.imageUrl?.trim() || undefined;

    return {
      identity,
      title,
      mediaType,
      ...(ep.guid !== undefined ? { guid: ep.guid } : {}),
      ...(ep.description !== undefined ? { description: ep.description } : {}),
      ...(effectiveLink !== undefined ? { link: effectiveLink } : {}),
      ...(normalizedEpImage !== undefined ? { imageUrl: normalizedEpImage } : {}),
      ...(ep.pubDate !== undefined ? { pubDate: ep.pubDate } : {}),
      ...(ep.durationMs !== undefined ? { durationMs: ep.durationMs } : {}),
      ...(ep.enclosureUrl !== undefined ? { enclosureUrl: ep.enclosureUrl } : {}),
      ...(ep.enclosureMime !== undefined ? { enclosureMime: ep.enclosureMime } : {}),
      ...(ep.enclosureSize !== undefined ? { enclosureSize: ep.enclosureSize } : {}),
      ...(ep.chaptersUrl !== undefined ? { chaptersUrl: ep.chaptersUrl } : {}),
      ...(ep.chaptersType !== undefined ? { chaptersType: ep.chaptersType } : {}),
      ...(ep.transcriptUrl !== undefined ? { transcriptUrl: ep.transcriptUrl } : {}),
      ...(ep.transcriptType !== undefined ? { transcriptType: ep.transcriptType } : {}),
      ...(sortedChapters !== undefined ? { chapters: sortedChapters } : {}),
    };
  });

  const altKeys = Object.keys(state.feed.alternateFeedUrls);
  const normalizedFeedImage = state.feed.imageUrl?.trim() || undefined;

  return {
    type: state.feed.type,
    episodes: parsedEpisodes,
    ...(state.feed.title !== undefined ? { title: state.feed.title } : {}),
    ...(state.feed.author !== undefined ? { author: state.feed.author } : {}),
    ...(state.feed.description !== undefined ? { description: state.feed.description } : {}),
    ...(state.feed.link !== undefined ? { link: state.feed.link } : {}),
    ...(normalizedFeedImage !== undefined ? { imageUrl: normalizedFeedImage } : {}),
    ...(state.feed.language !== undefined ? { language: state.feed.language } : {}),
    ...(state.feed.fundingUrl !== undefined ? { fundingUrl: state.feed.fundingUrl } : {}),
    ...(state.feed.redirectUrl !== undefined ? { redirectUrl: state.feed.redirectUrl } : {}),
    ...(state.feed.nextPageUrl !== undefined ? { nextPageUrl: state.feed.nextPageUrl } : {}),
    ...(altKeys.length > 0 ? { alternateFeedUrls: state.feed.alternateFeedUrls } : {}),
  };
}

export const SyndParser = {
  parse: parseFeed,
} as const;
