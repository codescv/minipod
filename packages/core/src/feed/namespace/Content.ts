import { setDescriptionIfLonger, type FeedParseState, type NamespaceHandler, type StackEntry } from './types';

export const CONTENT_URI = 'http://purl.org/rss/1.0/modules/content/';

export const ContentNamespace: NamespaceHandler = {
  uris: [CONTENT_URI],
  prefixes: ['content'],
  onEndElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'encoded' && state.currentItem) {
      setDescriptionIfLonger(state.currentItem, entry.textBuffer);
    }
  },
};
