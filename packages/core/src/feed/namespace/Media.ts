import { parseDurationMs } from '../../util/time';
import { classifyMediaType, inferMediaMimeType, isImageMime, isMediaMime } from '../mime';
import { getAttr } from '../xml/tokenizer';
import {
  resolveFeedUrlMaybe,
  setDescriptionIfLonger,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const MEDIA_RSS_URI = 'http://search.yahoo.com/mrss/';
export const MEDIA_RSS_URI_ALT = 'http://search.yahoo.com/mrss';

export const MediaNamespace: NamespaceHandler = {
  uris: [MEDIA_RSS_URI, MEDIA_RSS_URI_ALT],
  prefixes: ['media'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'content' && state.currentItem) {
      const url = resolveFeedUrlMaybe(getAttr(entry.attributes, 'url'), state.baseUrl);
      if (!url) return;

      const isDefault = getAttr(entry.attributes, 'isDefault')?.toLowerCase() === 'true';
      const medium = getAttr(entry.attributes, 'medium')?.toLowerCase();
      const rawType = getAttr(entry.attributes, 'type');
      let mime = inferMediaMimeType(rawType, url);

      let validMedia = false;
      let validImage = false;

      if (medium === 'audio') {
        validMedia = true;
        mime = mime && mime.startsWith('audio/') ? mime : 'audio/*';
      } else if (medium === 'video') {
        validMedia = true;
        mime = mime && mime.startsWith('video/') ? mime : 'video/*';
      } else if (
        medium === 'image' &&
        (!mime || (!mime.startsWith('audio/') && !mime.startsWith('video/')))
      ) {
        validImage = true;
        mime = mime ?? 'image/*';
      } else if (isMediaMime(mime)) {
        validMedia = true;
      } else if (isImageMime(mime)) {
        validImage = true;
      } else if (!state.currentItem.enclosureUrl) {
        validMedia = true;
        mime = 'audio/*';
      }

      if (validMedia && (!state.currentItem.enclosureUrl || isDefault)) {
        state.currentItem.enclosureUrl = url;
        if (mime) state.currentItem.enclosureMime = mime;
        state.currentItem.mediaType = classifyMediaType(mime, url);

        const sizeStr = getAttr(entry.attributes, 'fileSize')?.trim();
        if (sizeStr && /^\d+$/.test(sizeStr)) {
          const size = Number.parseInt(sizeStr, 10);
          if (Number.isSafeInteger(size) && size > 0) {
            state.currentItem.enclosureSize = size;
          }
        }

        const durMs = parseDurationMs(getAttr(entry.attributes, 'duration'));
        if (durMs !== undefined && state.currentItem.durationMs === undefined) {
          state.currentItem.durationMs = durMs;
        }
      } else if (validImage && !state.currentItem.itunesImageSet && !state.currentItem.imageUrl) {
        state.currentItem.imageUrl = url;
      }
    } else if (entry.localName === 'thumbnail') {
      const url = resolveFeedUrlMaybe(getAttr(entry.attributes, 'url'), state.baseUrl);
      if (!url) return;
      if (state.currentItem) {
        if (!state.currentItem.itunesImageSet) {
          state.currentItem.imageUrl = url;
        }
      } else if (!state.feed.itunesImageSet && !state.feed.imageUrl) {
        state.feed.imageUrl = url;
      }
    }
  },

  onEndElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'description' && state.currentItem) {
      setDescriptionIfLonger(state.currentItem, entry.textBuffer);
    }
  },
};
