import type { Chapter, EpochMs, FeedType, MediaType } from '../../types';
import { resolveRelativeUrl } from '../../util/url';
import type { XmlAttribute } from '../xml/tokenizer';

export interface StackEntry {
  readonly localName: string;
  readonly uri: string;
  readonly prefix: string;
  readonly attributes: readonly XmlAttribute[];
  textBuffer: string;
}

export interface MutableEpisode {
  guid?: string;
  title?: string;
  description?: string;
  link?: string;
  socialInteractUrl?: string;
  imageUrl?: string;
  itunesImageSet?: boolean;
  pubDate?: EpochMs;
  pubDateExplicit?: boolean;
  durationMs?: number;
  enclosureUrl?: string;
  enclosureMime?: string;
  enclosureSize?: number;
  mediaType?: MediaType;
  chaptersUrl?: string;
  chaptersType?: string;
  transcriptUrl?: string;
  transcriptType?: string;
  chapters?: Chapter[];
}

export interface MutableFeed {
  type: FeedType;
  title?: string;
  author?: string;
  description?: string;
  link?: string;
  imageUrl?: string;
  itunesImageSet?: boolean;
  language?: string;
  fundingUrl?: string;
  redirectUrl?: string;
  nextPageUrl?: string;
  alternateFeedUrls: Record<string, string>;
  episodes: MutableEpisode[];
}

export interface FeedParseState {
  readonly baseUrl?: string | undefined;
  readonly feed: MutableFeed;
  readonly stack: StackEntry[];
  currentItem: MutableEpisode | null;
}

export interface NamespaceHandler {
  readonly uris: readonly string[];
  readonly prefixes?: readonly string[];
  onStartElement?(entry: StackEntry, state: FeedParseState): void;
  onEndElement?(entry: StackEntry, state: FeedParseState): void;
}

export function setDescriptionIfLonger(target: { description?: string }, candidate: string | undefined): void {
  if (!candidate) return;
  const trimmed = candidate.trim();
  if (!trimmed) return;
  if (!target.description || trimmed.length > target.description.length) {
    target.description = trimmed;
  }
}

export function resolveFeedUrlMaybe(href: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  if (!baseUrl) return trimmed;
  try {
    return resolveRelativeUrl(trimmed, baseUrl);
  } catch {
    return trimmed;
  }
}

export function parentTag(state: FeedParseState): StackEntry | undefined {
  return state.stack.length >= 2 ? state.stack[state.stack.length - 2] : undefined;
}

export function grandparentTag(state: FeedParseState): StackEntry | undefined {
  return state.stack.length >= 3 ? state.stack[state.stack.length - 3] : undefined;
}
