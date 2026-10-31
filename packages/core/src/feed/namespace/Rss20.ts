import { parsePubDateMs } from '../../util/time';
import { classifyMediaType, inferMediaMimeType, isImageMime, isMediaMime } from '../mime';
import { getAttr, stripHtmlCompact, XML_NAMESPACE_URI } from '../xml/tokenizer';
import {
  grandparentTag,
  parentTag,
  resolveFeedUrlMaybe,
  setDescriptionIfLonger,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

const SUSPICIOUS_ENCLOSURE_MIN_BYTES = 16_384;

export const Rss20Namespace: NamespaceHandler = {
  uris: [''],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    const parent = parentTag(state);
    if (entry.localName === 'rss' || entry.localName === 'channel') {
      const xmlLang = getAttr(entry.attributes, 'lang', XML_NAMESPACE_URI);
      if (xmlLang && !state.feed.language) {
        state.feed.language = xmlLang.trim().toLowerCase();
      }
    }

    if (entry.localName === 'item' && parent?.localName === 'channel') {
      const ep = {};
      state.currentItem = ep;
      state.feed.episodes.push(ep);
      return;
    }

    if (entry.localName === 'image') {
      const rawHref = getAttr(entry.attributes, 'href') ?? getAttr(entry.attributes, 'url');
      const resolvedHref = resolveFeedUrlMaybe(rawHref, state.baseUrl);
      if (resolvedHref) {
        if (state.currentItem && parent?.localName === 'item') {
          if (!state.currentItem.itunesImageSet && !state.currentItem.imageUrl) {
            state.currentItem.imageUrl = resolvedHref;
          }
        } else if (!state.currentItem && parent?.localName === 'channel') {
          if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
            state.feed.imageUrl = resolvedHref;
          }
        }
      }
    }

    if (entry.localName === 'enclosure' && state.currentItem && parent?.localName === 'item') {
      const rawUrl = getAttr(entry.attributes, 'url');
      const resolvedUrl = resolveFeedUrlMaybe(rawUrl, state.baseUrl);
      if (!resolvedUrl) return;

      const rawType = getAttr(entry.attributes, 'type');
      let mime = inferMediaMimeType(rawType, resolvedUrl);
      let validMedia = isMediaMime(mime);
      if (!validMedia && !isImageMime(mime) && !state.currentItem.enclosureUrl) {
        validMedia = true;
        mime = 'audio/*';
      }

      if (validMedia && !state.currentItem.enclosureUrl) {
        state.currentItem.enclosureUrl = resolvedUrl;
        if (mime) state.currentItem.enclosureMime = mime;
        state.currentItem.mediaType = classifyMediaType(mime, resolvedUrl);

        const lenStr = getAttr(entry.attributes, 'length')?.trim();
        if (lenStr && /^\d+$/.test(lenStr)) {
          const parsedLen = Number.parseInt(lenStr, 10);
          if (Number.isSafeInteger(parsedLen) && parsedLen >= SUSPICIOUS_ENCLOSURE_MIN_BYTES) {
            state.currentItem.enclosureSize = parsedLen;
          }
        }
      }
    }
  },

  onEndElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'item') {
      if (state.currentItem && !state.currentItem.title && state.currentItem.description) {
        state.currentItem.title = stripHtmlCompact(state.currentItem.description);
      }
      state.currentItem = null;
      return;
    }

    const parent = parentTag(state);
    const grandparent = grandparentTag(state);
    if (!parent) return;

    const rawText = entry.textBuffer;
    const trimmed = rawText.trim();
    if (!trimmed) return;

    if (entry.localName === 'guid' && parent.localName === 'item' && state.currentItem) {
      state.currentItem.guid = trimmed;
      const isPermaLink = getAttr(entry.attributes, 'isPermaLink');
      if (
        !state.currentItem.link &&
        (isPermaLink === undefined || isPermaLink.toLowerCase() === 'true') &&
        /^https?:\/\//i.test(trimmed)
      ) {
        state.currentItem.link = trimmed;
      }
    } else if (entry.localName === 'title') {
      const cleanTitle = stripHtmlCompact(trimmed);
      if (parent.localName === 'item' && state.currentItem && cleanTitle) {
        state.currentItem.title = cleanTitle;
      } else if (parent.localName === 'channel' && cleanTitle) {
        state.feed.title = cleanTitle;
      }
    } else if (entry.localName === 'link') {
      const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
      if (parent.localName === 'channel' && resolved) {
        state.feed.link = resolved;
      } else if (parent.localName === 'item' && state.currentItem && resolved) {
        state.currentItem.link = resolved;
      }
    } else if (
      (entry.localName === 'pubDate' || entry.localName === 'pubdate') &&
      parent.localName === 'item' &&
      state.currentItem
    ) {
      const ms = parsePubDateMs(trimmed);
      if (ms !== undefined) {
        state.currentItem.pubDate = ms;
        state.currentItem.pubDateExplicit = true;
      }
    } else if (entry.localName === 'url' && parent.localName === 'image') {
      if (grandparent?.localName === 'channel') {
        if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
          const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
          if (resolved) state.feed.imageUrl = resolved;
        }
      } else if (grandparent?.localName === 'item' && state.currentItem) {
        if (!state.currentItem.itunesImageSet && !state.currentItem.imageUrl) {
          const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
          if (resolved) state.currentItem.imageUrl = resolved;
        }
      }
    } else if (entry.localName === 'image' && parent.localName === 'item' && state.currentItem) {
      if (!state.currentItem.itunesImageSet && !state.currentItem.imageUrl) {
        const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
        if (resolved && /^https?:\/\//i.test(resolved)) {
          state.currentItem.imageUrl = resolved;
        }
      }
    } else if (entry.localName === 'description') {
      if (parent.localName === 'channel') {
        const cleanDesc = stripHtmlCompact(trimmed);
        if (cleanDesc) state.feed.description = cleanDesc;
      } else if (parent.localName === 'item' && state.currentItem) {
        setDescriptionIfLonger(state.currentItem, trimmed);
      }
    } else if (entry.localName === 'language' && parent.localName === 'channel') {
      state.feed.language = trimmed.toLowerCase();
    }
  },
};
