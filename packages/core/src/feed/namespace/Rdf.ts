import { RDF_SYNTAX_URI } from '../TypeDetector';
import { getAttr, stripHtmlCompact } from '../xml/tokenizer';
import {
  parentTag,
  resolveFeedUrlMaybe,
  setDescriptionIfLonger,
  type FeedParseState,
  type MutableEpisode,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const RSS10_URI = 'http://purl.org/rss/1.0/';
export const RSS10_ENC_URI = 'http://purl.oclc.org/net/rss_2.0/enc#';

/**
 * Guarded RDF / RSS 1.0 (`<rdf:RDF>` + `http://purl.org/rss/1.0/`) namespace handler.
 * Note that in RSS 1.0, `<channel>`, `<image>`, and `<item>` are direct children of `<rdf:RDF>`.
 */
export const RdfNamespace: NamespaceHandler = {
  uris: [RSS10_URI, RDF_SYNTAX_URI, RSS10_ENC_URI],
  prefixes: ['rdf', 'enc'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    const parent = parentTag(state);
    if (entry.localName === 'item' && (parent?.localName === 'RDF' || parent?.localName === 'channel')) {
      const about = getAttr(entry.attributes, 'about', RDF_SYNTAX_URI) ?? getAttr(entry.attributes, 'about');
      const ep: MutableEpisode = {};
      if (about?.trim()) {
        ep.guid = about.trim();
      }
      state.currentItem = ep;
      state.feed.episodes.push(ep);
      return;
    }

    if (entry.localName === 'enclosure' && state.currentItem) {
      const rawUrl =
        getAttr(entry.attributes, 'resource', RDF_SYNTAX_URI) ??
        getAttr(entry.attributes, 'url');
      const resolved = resolveFeedUrlMaybe(rawUrl, state.baseUrl);
      if (resolved && !state.currentItem.enclosureUrl) {
        state.currentItem.enclosureUrl = resolved;
        const type = getAttr(entry.attributes, 'type');
        state.currentItem.enclosureMime = type || 'audio/*';
        state.currentItem.mediaType = type?.startsWith('video/') ? 'VIDEO' : 'AUDIO';
      }
    }
  },

  onEndElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'item') {
      if (state.currentItem) {
        if (!state.currentItem.title && state.currentItem.description) {
          state.currentItem.title = stripHtmlCompact(state.currentItem.description);
        }
        if (!state.currentItem.link && state.currentItem.guid && /^https?:\/\//i.test(state.currentItem.guid)) {
          state.currentItem.link = state.currentItem.guid;
        }
      }
      state.currentItem = null;
      return;
    }

    const parent = parentTag(state);
    if (!parent) return;

    const trimmed = entry.textBuffer.trim();
    if (!trimmed) return;

    if (entry.localName === 'title') {
      const clean = stripHtmlCompact(trimmed);
      if (parent.localName === 'item' && state.currentItem && clean) {
        state.currentItem.title = clean;
      } else if (parent.localName === 'channel' && clean) {
        state.feed.title = clean;
      }
    } else if (entry.localName === 'link') {
      const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
      if (parent.localName === 'item' && state.currentItem && resolved) {
        state.currentItem.link = resolved;
      } else if (parent.localName === 'channel' && resolved) {
        state.feed.link = resolved;
      }
    } else if (entry.localName === 'description') {
      if (parent.localName === 'item' && state.currentItem) {
        setDescriptionIfLonger(state.currentItem, trimmed);
      } else if (parent.localName === 'channel') {
        state.feed.description = stripHtmlCompact(trimmed);
      }
    } else if (entry.localName === 'url' && parent.localName === 'image' && !state.currentItem) {
      if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
        const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
        if (resolved) state.feed.imageUrl = resolved;
      }
    }
  },
};
