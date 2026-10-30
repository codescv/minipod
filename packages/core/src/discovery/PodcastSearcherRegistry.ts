import { MiniPodError } from '../errors';
import type {
  EpochMs,
  HttpClient,
  PodcastIndexKeys,
  PodcastSearcher,
  PodcastSearcherRegistry,
  SourceId,
} from '../types';
import { CombinedSearcher } from './CombinedSearcher';
import { FyydSearcher } from './FyydSearcher';
import { GpodderSearcher } from './GpodderSearcher';
import { ItunesSearcher } from './ItunesSearcher';
import { PodcastIndexSearcher } from './PodcastIndexSearcher';

export interface SearcherRegistryDeps {
  readonly http: HttpClient;
  readonly podcastIndexKeys?: PodcastIndexKeys;
  readonly now?: () => EpochMs;
  readonly userAgent?: string;
  readonly combinedTimeoutMs?: number;
}

export function createSearcherRegistry(deps: SearcherRegistryDeps): PodcastSearcherRegistry {
  const apple = new ItunesSearcher({
    http: deps.http,
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });
  const podcastindex = new PodcastIndexSearcher({
    http: deps.http,
    ...(deps.podcastIndexKeys ? { keys: deps.podcastIndexKeys } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });
  const fyyd = new FyydSearcher({
    http: deps.http,
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });
  const gpodder = new GpodderSearcher({
    http: deps.http,
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });

  const peers: readonly PodcastSearcher[] = [apple, podcastindex, fyyd, gpodder];
  const combined = new CombinedSearcher({
    searchers: peers,
    ...(deps.combinedTimeoutMs !== undefined ? { timeoutMs: deps.combinedTimeoutMs } : {}),
  });

  const all: readonly PodcastSearcher[] = [combined, apple, podcastindex, fyyd, gpodder];
  const byIdMap = new Map<SourceId, PodcastSearcher>(all.map((s) => [s.id, s]));

  return {
    all,
    byId(id: SourceId): PodcastSearcher {
      const found = byIdMap.get(id);
      if (!found) {
        throw new MiniPodError('invalid-argument', `Unknown podcast search source: ${id}`);
      }
      return found;
    },
    urlNeedsLookup(url: string): boolean {
      return peers.some((p) => p.urlNeedsLookup?.(url) === true);
    },
    async lookupUrl(url: string, signal?: AbortSignal): Promise<string> {
      for (const p of peers) {
        if (p.urlNeedsLookup?.(url) && p.lookupUrl) {
          return p.lookupUrl(url, signal);
        }
      }
      return url;
    },
  };
}
