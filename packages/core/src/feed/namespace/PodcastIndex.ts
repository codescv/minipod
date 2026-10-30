import { getAttr } from '../xml/tokenizer';
import {
  resolveFeedUrlMaybe,
  type FeedParseState,
  type NamespaceHandler,
  type StackEntry,
} from './types';

export const PODCASTINDEX_URI = 'https://podcastindex.org/namespace/1.0';
export const PODCASTINDEX_URI_LEGACY =
  'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md';

export const PodcastIndexNamespace: NamespaceHandler = {
  uris: [PODCASTINDEX_URI, PODCASTINDEX_URI_LEGACY],
  prefixes: ['podcast'],
  onStartElement(entry: StackEntry, state: FeedParseState): void {
    if (entry.localName === 'funding') {
      const url = resolveFeedUrlMaybe(getAttr(entry.attributes, 'url'), state.baseUrl);
      if (url && !state.feed.fundingUrl && !state.currentItem) {
        state.feed.fundingUrl = url;
      } else if (url && !state.feed.fundingUrl) {
        state.feed.fundingUrl = url;
      }
    } else if (entry.localName === 'chapters' && state.currentItem) {
      const url = resolveFeedUrlMaybe(getAttr(entry.attributes, 'url'), state.baseUrl);
      const type = getAttr(entry.attributes, 'type')?.trim();
      if (url) {
        state.currentItem.chaptersUrl = url;
        if (type) state.currentItem.chaptersType = type;
      }
    } else if (entry.localName === 'transcript' && state.currentItem) {
      const url = resolveFeedUrlMaybe(getAttr(entry.attributes, 'url'), state.baseUrl);
      const type = getAttr(entry.attributes, 'type')?.trim();
      if (url && type) {
        // Keep the first transcript unless upgrading from HTML to VTT/SRT/JSON
        if (!state.currentItem.transcriptUrl || state.currentItem.transcriptType === 'text/html') {
          state.currentItem.transcriptUrl = url;
          state.currentItem.transcriptType = type;
        }
      }
    } else if (entry.localName === 'socialInteract' && state.currentItem) {
      const uri = resolveFeedUrlMaybe(getAttr(entry.attributes, 'uri'), state.baseUrl);
      if (uri) {
        state.currentItem.socialInteractUrl = uri;
      }
    }
  },
};
