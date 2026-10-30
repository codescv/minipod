import { parseDurationMs } from '../../util/time';
import { getAttr, stripHtmlCompact } from '../xml/tokenizer';
import {
  parentTag,
  resolveFeedUrlMaybe,
  setDescriptionIfLonger,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const ITUNES_URI = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
export const ITUNES_URI_LEGACY = 'http://www.itunes.com/DTDs/Podcast-1.0.dtd';

export const ItunesNamespace: NamespaceHandler = {
  uris: [ITUNES_URI, ITUNES_URI_LEGACY],
  prefixes: ['itunes'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'image') {
      const href = resolveFeedUrlMaybe(getAttr(entry.attributes, 'href'), state.baseUrl);
      if (!href) return;
      if (state.currentItem) {
        state.currentItem.imageUrl = href;
        state.currentItem.itunesImageSet = true;
      } else {
        state.feed.imageUrl = href;
        state.feed.itunesImageSet = true;
      }
    }
  },

  onEndElement(entry: StackEntry, state: FeedParseState): void {
    const trimmed = entry.textBuffer.trim();
    if (!trimmed) return;

    const parent = parentTag(state);

    if (entry.localName === 'image') {
      // Fallback for non-compliant feeds putting URL in `<itunes:image>https://...</itunes:image>`
      const resolved = resolveFeedUrlMaybe(trimmed, state.baseUrl);
      if (resolved && /^https?:\/\//i.test(resolved)) {
        if (state.currentItem && !state.currentItem.imageUrl) {
          state.currentItem.imageUrl = resolved;
          state.currentItem.itunesImageSet = true;
        } else if (!state.currentItem && !state.feed.imageUrl) {
          state.feed.imageUrl = resolved;
          state.feed.itunesImageSet = true;
        }
      }
    } else if (entry.localName === 'author') {
      if (!state.currentItem && state.stack.length <= 3) {
        const clean = stripHtmlCompact(trimmed);
        if (clean) state.feed.author = clean;
      }
    } else if (entry.localName === 'title') {
      const clean = stripHtmlCompact(trimmed);
      if (clean) {
        if (state.currentItem && !state.currentItem.title) {
          state.currentItem.title = clean;
        } else if (!state.currentItem && !state.feed.title) {
          state.feed.title = clean;
        }
      }
    } else if (entry.localName === 'duration' && state.currentItem) {
      const durationMs = parseDurationMs(trimmed);
      if (durationMs !== undefined) {
        state.currentItem.durationMs = durationMs;
      }
    } else if (entry.localName === 'subtitle') {
      if (state.currentItem) {
        if (!state.currentItem.description) {
          setDescriptionIfLonger(state.currentItem, trimmed);
        }
      } else if (!state.feed.description) {
        state.feed.description = stripHtmlCompact(trimmed);
      }
    } else if (entry.localName === 'summary') {
      if (state.currentItem) {
        setDescriptionIfLonger(state.currentItem, trimmed);
      } else if (parent?.localName === 'channel' || parent?.localName === 'feed') {
        const clean = stripHtmlCompact(trimmed);
        if (clean && (!state.feed.description || clean.length > state.feed.description.length)) {
          state.feed.description = clean;
        }
      }
    } else if (entry.localName === 'new-feed-url') {
      if (/^https?:\/\//i.test(trimmed)) {
        state.feed.redirectUrl = trimmed;
      }
    }
  },
};
