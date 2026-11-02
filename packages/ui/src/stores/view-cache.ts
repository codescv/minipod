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
  DownloadState,
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

export type EpisodeSortOrder = 'desc' | 'asc';

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
  readonly feedSortOrder: Map<FeedKey, EpisodeSortOrder>;
  timelineItems: readonly TimelineEpisodeItem[];
  timelineLoaded: boolean;
  timelineClearedCutoffMs: number;
  lastAutoRefreshAt: number;
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
    feedSortOrder: new Map(),
    timelineItems: [],
    timelineLoaded: false,
    timelineClearedCutoffMs: 0,
    lastAutoRefreshAt: 0,
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
      if (
        viewCache.timelineClearedCutoffMs > 0 &&
        (item.row.episode.pubDate ?? 0) <= viewCache.timelineClearedCutoffMs
      ) {
        return false;
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

/**
 * Applies a `download-updated` transition to every SWR cache slice that embeds the episode
 * (`episodesByFeed` across all cached feeds, `queueRows`, `timelineItems`, `downloadedItems`,
 * `downloadedCount`).
 *
 * Needed because only the mounted screen revalidates: e.g. when an episode finishes (and its
 * download is auto-deleted) while the user is on the Queue screen, `DownloadsPage` /
 * `SubscriptionsGrid` are unmounted, and a stale `episodesByFeed` (`DONE`) would otherwise
 * re-pollute `downloadedItems` (Manage Downloads) on the next `recomputeHostTimelineAndDownloads`.
 *
 * Idempotent (safe to call from several listeners for the same event) and keeps array identity
 * when nothing changed.
 */
export function applyDownloadStateToViewCache(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  state: DownloadState,
  downloadPath?: string,
): void {
  const viewCache = getHostViewCache(host);

  const patchEpisode = <E extends EpisodeRowModel['episode']>(ep: E): E => {
    const nextPath = state === 'DONE' ? (downloadPath ?? ep.downloadPath) : undefined;
    if (ep.downloadState === state && ep.downloadPath === nextPath) return ep;
    const { downloadPath: _omit, ...rest } = ep;
    void _omit;
    return {
      ...rest,
      downloadState: state,
      ...(nextPath !== undefined ? { downloadPath: nextPath } : {}),
    } as E;
  };

  const patchRow = <R extends { readonly episode: EpisodeRowModel['episode'] }>(row: R): R => {
    if (row.episode.episodeKey !== episodeKey) return row;
    const episode = patchEpisode(row.episode);
    return episode === row.episode ? row : { ...row, episode };
  };

  const patchList = <T>(list: readonly T[], patch: (item: T) => T): readonly T[] => {
    let changed = false;
    const next = list.map((item) => {
      const patched = patch(item);
      if (patched !== item) changed = true;
      return patched;
    });
    return changed ? next : list;
  };

  for (const [feedKey, rows] of viewCache.episodesByFeed) {
    const next = patchList(rows, patchRow);
    if (next !== rows) viewCache.episodesByFeed.set(feedKey, next);
  }

  viewCache.queueRows = patchList(viewCache.queueRows, patchRow);

  viewCache.timelineItems = patchList(viewCache.timelineItems, (item) => {
    const row = patchRow(item.row);
    return row === item.row ? item : { ...item, row };
  });

  if (state !== 'DONE') {
    const before = viewCache.downloadedItems;
    const after = before.filter((item) => item.row.episode.episodeKey !== episodeKey);
    if (after.length !== before.length) {
      viewCache.downloadedItems = after;
      viewCache.downloadedCount = after.length;
    }
  } else {
    viewCache.downloadedItems = patchList(viewCache.downloadedItems, (item) => {
      const row = patchRow(item.row);
      return row === item.row ? item : { ...item, row };
    });
  }
}
