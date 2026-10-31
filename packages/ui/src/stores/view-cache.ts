/**
 * Per-host in-memory Stale-While-Revalidate (SWR) view cache (`v0.1.9`).
 *
 * Keyed by `WeakMap<PlatformHost, HostViewCache>` so that:
 * - Production maintains a single persistent view cache across all tab and screen switches
 *   (`Subscriptions` ↔ `Queue` ↔ `Settings` ↔ `PodcastDetail` ↔ `DownloadsPage` ↔ `AddSearch`),
 *   rendering existing lists on frame 0 (`0ms`) without clearing to empty/loading states while
 *   revalidating seamlessly in the background.
 * - Every unit test (`MockHost`) remains 100% isolated with zero cross-test leakage.
 */
import type {
  CountryCode,
  EpisodeFilter,
  EpisodeKey,
  EpisodeRow as EpisodeRowModel,
  Feed,
  FeedKey,
  PlatformHost,
  QueueRow,
  SearchResult,
  SyncStatus,
} from '@minipod/core';

export const DEFAULT_TIMELINE_LIMIT = 30;

export interface TimelineEpisodeItem {
  readonly row: EpisodeRowModel;
  readonly feed: Feed;
  readonly allowDownloads: boolean;
}

export interface DownloadedEpisodeItem {
  readonly row: EpisodeRowModel;
  readonly feed: Feed;
}

export interface HostViewCache {
  feeds: readonly Feed[];
  feedsLoaded: boolean;
  feedsByKey: ReadonlyMap<FeedKey, Feed>;
  readonly episodesByFeed: Map<FeedKey, readonly EpisodeRowModel[]>;
  timelineItems: readonly TimelineEpisodeItem[];
  timelineLoaded: boolean;
  downloadedCount: number;
  downloadedItems: readonly DownloadedEpisodeItem[];
  downloadsLoaded: boolean;
  subsExpanded: boolean;
  timelineLimit: number;
  queueRows: readonly QueueRow[];
  queueLoaded: boolean;
  syncStatus: SyncStatus | null;
  topChartsCountries: readonly { readonly code: CountryCode; readonly name: string }[];
  readonly topChartsByCountry: Map<CountryCode, readonly SearchResult[]>;
  readonly searchResultsByKey: Map<string, readonly SearchResult[]>;
}

const hostViewCaches = new WeakMap<PlatformHost, HostViewCache>();

function createEmptyHostViewCache(): HostViewCache {
  return {
    feeds: [],
    feedsLoaded: false,
    feedsByKey: new Map(),
    episodesByFeed: new Map(),
    timelineItems: [],
    timelineLoaded: false,
    downloadedCount: 0,
    downloadedItems: [],
    downloadsLoaded: false,
    subsExpanded: false,
    timelineLimit: DEFAULT_TIMELINE_LIMIT,
    queueRows: [],
    queueLoaded: false,
    syncStatus: null,
    topChartsCountries: [],
    topChartsByCountry: new Map(),
    searchResultsByKey: new Map(),
  };
}

export function getHostViewCache(host: PlatformHost): HostViewCache {
  let cache = hostViewCaches.get(host);
  if (!cache) {
    cache = createEmptyHostViewCache();
    hostViewCaches.set(host, cache);
  }
  return cache;
}

export function filterCachedEpisodeRows(
  allRows: readonly EpisodeRowModel[],
  filter: EpisodeFilter,
  inlineUndoKeys?: ReadonlySet<EpisodeKey>,
): readonly EpisodeRowModel[] {
  if (filter === 'unplayed') {
    return allRows.filter(
      (r) =>
        r.progress?.state !== 'PLAYED' ||
        (inlineUndoKeys !== undefined && inlineUndoKeys.has(r.episode.episodeKey)),
    );
  }
  if (filter === 'downloaded') {
    return allRows.filter((r) => r.episode.downloadState === 'DONE');
  }
  return allRows;
}

export function recomputeHostTimelineAndDownloads(
  host: PlatformHost,
  feeds: readonly Feed[],
  episodesByFeed: ReadonlyMap<FeedKey, readonly EpisodeRowModel[]>,
  inlineUndoKeys?: ReadonlySet<EpisodeKey>,
  activeEpisodeKey?: EpisodeKey,
): {
  readonly timelineItems: readonly TimelineEpisodeItem[];
  readonly downloadedCount: number;
  readonly downloadedItems: readonly DownloadedEpisodeItem[];
} {
  const canDownload = Boolean(host.info.capabilities.downloads);
  const viewCache = getHostViewCache(host);
  const queuedEpisodeKeys = new Set<EpisodeKey>(
    viewCache.queueRows.map((q) => q.episode.episodeKey),
  );
  const allItems: TimelineEpisodeItem[] = [];

  for (const feed of feeds) {
    const rows = episodesByFeed.get(feed.feedKey);
    if (!rows || rows.length === 0) continue;
    const allowDownloads = canDownload && feed.kind !== 'LOCAL';
    for (const row of rows) {
      allItems.push({ row, feed, allowDownloads });
    }
  }

  const downloadedItems = allItems
    .filter((item) => item.allowDownloads && item.row.episode.downloadState === 'DONE')
    .map(({ row, feed }): DownloadedEpisodeItem => ({ row, feed }))
    .sort((a, b) => {
      const pubDiff = (b.row.episode.pubDate ?? 0) - (a.row.episode.pubDate ?? 0);
      if (pubDiff !== 0) return pubDiff;
      return a.row.episode.episodeKey.localeCompare(b.row.episode.episodeKey);
    });

  const timelineItems = allItems
    .filter((item) => {
      const epKey = item.row.episode.episodeKey;
      if (inlineUndoKeys !== undefined && inlineUndoKeys.has(epKey)) {
        return true;
      }
      if (item.row.progress?.state === 'PLAYED') return false;
      if (item.row.progress?.state === 'IN_PROGRESS') return false;
      if ((item.row.progress?.positionMs ?? 0) > 0) return false;
      if (item.row.inQueue || queuedEpisodeKeys.has(epKey)) return false;
      if (activeEpisodeKey !== undefined && epKey === activeEpisodeKey) return false;
      return true;
    })
    .sort((a, b) => {
      const pubDiff = (b.row.episode.pubDate ?? 0) - (a.row.episode.pubDate ?? 0);
      if (pubDiff !== 0) return pubDiff;
      return a.row.episode.episodeKey.localeCompare(b.row.episode.episodeKey);
    });

  return {
    timelineItems,
    downloadedCount: downloadedItems.length,
    downloadedItems,
  };
}
