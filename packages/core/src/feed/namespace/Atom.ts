import { parsePubDateMs } from '../../util/time';
import { classifyMediaType, inferMediaMimeType, isImageMime, isMediaMime } from '../mime';
import { getAttr, stripHtmlCompact, XML_NAMESPACE_URI } from '../xml/tokenizer';
import {
  parentTag,
  resolveFeedUrlMaybe,
  setDescriptionIfLonger,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const ATOM_URI = 'http://www.w3.org/2005/Atom';

const FEED_CONTAINERS = new Set(['feed', 'channel']);
const ITEM_CONTAINERS = new Set(['entry', 'item']);

export const AtomNamespace: NamespaceHandler = {
  uris: [ATOM_URI],
  prefixes: ['atom'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'feed') {
      const xmlLang = getAttr(entry.attributes, 'lang', XML_NAMESPACE_URI);
      if (xmlLang && !state.feed.language) {
        state.feed.language = xmlLang.trim().toLowerCase();
      }
      return;
    }

    if (entry.localName === 'entry') {
      const ep = {};
      state.currentItem = ep;
      state.feed.episodes.push(ep);
      return;
    }

    if (entry.localName === 'link') {
      const rawHref = getAttr(entry.attributes, 'href');
      const href = resolveFeedUrlMaybe(rawHref, state.baseUrl);
      if (!href) return;

      const rel = getAttr(entry.attributes, 'rel')?.trim().toLowerCase();
      const type = getAttr(entry.attributes, 'type')?.split(';')[0]?.trim().toLowerCase();
      const title = getAttr(entry.attributes, 'title')?.trim();
      const parent = parentTag(state);
      if (!parent) return;

      if (ITEM_CONTAINERS.has(parent.localName) && state.currentItem) {
        if (!rel || rel === 'alternate') {
          state.currentItem.link = href;
        } else if (rel === 'enclosure') {
          let mime = inferMediaMimeType(type, href);
          let validMedia = isMediaMime(mime);
          if (!validMedia && !isImageMime(mime) && !state.currentItem.enclosureUrl) {
            validMedia = true;
            mime = 'audio/*';
          }
          if (validMedia && !state.currentItem.enclosureUrl) {
            state.currentItem.enclosureUrl = href;
            if (mime) state.currentItem.enclosureMime = mime;
            state.currentItem.mediaType = classifyMediaType(mime, href);
            const lenStr = getAttr(entry.attributes, 'length')?.trim();
            if (lenStr && /^\d+$/.test(lenStr)) {
              const size = Number.parseInt(lenStr, 10);
              if (Number.isSafeInteger(size) && size > 0) {
                state.currentItem.enclosureSize = size;
              }
            }
          }
        }
      } else if (FEED_CONTAINERS.has(parent.localName)) {
        if (!rel || rel === 'alternate') {
          if ((!type && !state.feed.link) || type === 'text/html' || type === 'application/xml+xhtml' || type === 'application/xhtml+xml') {
            state.feed.link = href;
          } else if (type === 'application/atom+xml' || type === 'application/rss+xml') {
            state.feed.alternateFeedUrls[title || href] = href;
          }
        } else if (rel === 'archives') {
          if (type === 'application/atom+xml' || type === 'application/rss+xml') {
            state.feed.alternateFeedUrls[title || href] = href;
          }
        } else if (rel === 'payment') {
          if (!state.feed.fundingUrl) state.feed.fundingUrl = href;
        } else if (rel === 'next') {
          state.feed.nextPageUrl = href;
        }
      }
    }
  },

  onEndElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'entry') {
      if (state.currentItem && !state.currentItem.title && state.currentItem.description) {
        state.currentItem.title = stripHtmlCompact(state.currentItem.description);
      }
      state.currentItem = null;
      return;
    }

    const parent = parentTag(state);
    if (!parent) return;

    const rawText = entry.textBuffer;
    const trimmed = rawText.trim();
    if (!trimmed) return;

    const textType = getAttr(entry.attributes, 'type')?.trim().toLowerCase();

    if (entry.localName === 'id') {
      if (parent.localName === 'entry' && state.currentItem) {
        state.currentItem.guid = trimmed;
      }
    } else if (entry.localName === 'title') {
      const processed = textType === 'html' || textType === 'xhtml' ? stripHtmlCompact(trimmed) : stripHtmlCompact(trimmed);
      if (parent.localName === 'feed' && processed) {
        state.feed.title = processed;
      } else if (parent.localName === 'entry' && state.currentItem && processed) {
        state.currentItem.title = processed;
      }
    } else if (entry.localName === 'subtitle' && parent.localName === 'feed') {
      state.feed.description = textType === 'html' ? stripHtmlCompact(trimmed) : trimmed;
    } else if ((entry.localName === 'content' || entry.localName === 'summary') && parent.localName === 'entry' && state.currentItem) {
      setDescriptionIfLonger(state.currentItem, trimmed);
    } else if (entry.localName === 'published' && parent.localName === 'entry' && state.currentItem) {
      const ms = parsePubDateMs(trimmed);
      if (ms !== undefined) {
        state.currentItem.pubDate = ms;
        state.currentItem.pubDateExplicit = true;
      }
    } else if (entry.localName === 'updated' && parent.localName === 'entry' && state.currentItem) {
      if (!state.currentItem.pubDateExplicit) {
        const ms = parsePubDateMs(trimmed);
        if (ms !== undefined) state.currentItem.pubDate = ms;
      }
    } else if (entry.localName === 'logo' && parent.localName === 'feed') {
      if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
        const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
        if (resolved) state.feed.imageUrl = resolved;
      }
    } else if (entry.localName === 'icon' && parent.localName === 'feed') {
      if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
        const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
        if (resolved) state.feed.imageUrl = resolved;
      }
    } else if (entry.localName === 'name' && parent.localName === 'author' && !state.currentItem) {
      state.feed.author = state.feed.author ? `${state.feed.author}, ${trimmed}` : trimmed;
    }
  },
};
