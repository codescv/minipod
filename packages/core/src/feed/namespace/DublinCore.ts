import { parsePubDateMs } from '../../util/time';
import { stripHtmlCompact } from '../xml/tokenizer';
import type { FeedParseState, NamespaceHandler, StackEntry } from './types';

export const DUBLIN_CORE_URI = 'http://purl.org/dc/elements/1.1/';
export const DUBLIN_CORE_URI_NO_SLASH = 'http://purl.org/dc/elements/1.1';

export const DublinCoreNamespace: NamespaceHandler = {
  uris: [DUBLIN_CORE_URI, DUBLIN_CORE_URI_NO_SLASH],
  prefixes: ['dc'],
  onEndElement(entry: StackEntry, state: FeedParseState): void {
    const trimmed = entry.textBuffer.trim();
    if (!trimmed) return;

    if (entry.localName === 'date' && state.currentItem) {
      if (!state.currentItem.pubDateExplicit) {
        const ms = parsePubDateMs(trimmed);
        if (ms !== undefined) state.currentItem.pubDate = ms;
      }
    } else if (entry.localName === 'creator' && !state.currentItem && !state.feed.author) {
      const clean = stripHtmlCompact(trimmed);
      if (clean) state.feed.author = clean;
    }
  },
};
