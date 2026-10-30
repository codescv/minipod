import type { EpisodeKey, EpochMs, FeedKey } from '../types';
import { sha1Hex, sha1HexSync } from '../util/sha1';

export interface EpisodeIdentityInput {
  readonly guid?: string | undefined;
  readonly enclosureUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly pubDate?: EpochMs | undefined;
}

/**
 * Computes the deterministic episode identity string (ARCHITECTURE.md §7.2):
 * `guid -> enclosureUrl -> title + "|" + pubDateEpochMs`
 */
export function episodeIdentity(item: EpisodeIdentityInput): string {
  const guid = item.guid?.trim();
  if (guid) return guid;
  const enclosure = item.enclosureUrl?.trim();
  if (enclosure) return enclosure;
  return `${(item.title ?? '').trim()}|${item.pubDate ?? 0}`;
}

/**
 * Computes the deterministic `EpisodeKey`:
 * `"e_" + sha1Hex(feedKey + "\n" + identity)`
 */
export function episodeKey(feedKey: FeedKey, identity: string): EpisodeKey {
  return `e_${sha1HexSync(`${feedKey}\n${identity}`)}`;
}

/**
 * Async WebCrypto (`crypto.subtle.digest('SHA-1')`) variant of `episodeKey`.
 */
export async function episodeKeyAsync(feedKey: FeedKey, identity: string): Promise<EpisodeKey> {
  return `e_${await sha1Hex(`${feedKey}\n${identity}`)}`;
}
