import type { Chapter } from '../../types';
import { parseChapterTimestampMs } from '../../util/time';
import { getAttr } from '../xml/tokenizer';
import {
  resolveFeedUrlMaybe,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const SIMPLE_CHAPTERS_URI = 'http://podlove.org/simple-chapters';
export const SIMPLE_CHAPTERS_URI_SLASH = 'http://podlove.org/simple-chapters/';

export const SimpleChaptersNamespace: NamespaceHandler = {
  uris: [SIMPLE_CHAPTERS_URI, SIMPLE_CHAPTERS_URI_SLASH],
  prefixes: ['psc', 'sc'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    if (!state.currentItem) return;

    if (entry.localName === 'chapters') {
      state.currentItem.chapters = [];
    } else if (entry.localName === 'chapter') {
      const startAttr = getAttr(entry.attributes, 'start');
      if (!startAttr) return;
      const startMs = parseChapterTimestampMs(startAttr);
      if (startMs === undefined || startMs < 0) return;

      const title = getAttr(entry.attributes, 'title')?.trim();
      const link = resolveFeedUrlMaybe(getAttr(entry.attributes, 'href'), state.baseUrl);
      const imageUrl = resolveFeedUrlMaybe(getAttr(entry.attributes, 'image'), state.baseUrl);

      const chapter: Chapter = {
        startMs,
        source: 'PSC',
        ...(title ? { title } : {}),
        ...(link ? { link } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      };
      if (!state.currentItem.chapters) {
        state.currentItem.chapters = [];
      }
      state.currentItem.chapters.push(chapter);
    }
  },
};
