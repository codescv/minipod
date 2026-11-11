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
  /**
   * Last known download ratio (`0..1`) per episode, so remounting a screen (`Queue` ↔
   * `Subscriptions` ↔ `Settings`) mid-download never flashes the percentage back to `0%`.
   * Kept on `FAILED` (partial `.part` resumes from there), cleared on `DONE` / `NONE`.
   */
  readonly downloadProgressByKey: Map<EpisodeKey, number>;
  /**
   * User-requested download stops (`停止下载` / `停止全部`) that must not be reverted by a stale
   * `download-updated(QUEUED|RUNNING|...)` event emitted before the host processed the stop, or
   * by a list snapshot fetched while `deleteDownload` was still in flight. See
   * {@link beginDownloadStop}.
   */
  readonly downloadStopGuards: Map<EpisodeKey, DownloadStopGuard>;
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
    downloadProgressByKey: new Map(),
    downloadStopGuards: new Map(),
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

/** Clamps a download ratio to `0..1` and converts it to an integer percentage (`0..100`). */
export function downloadRatioToPercent(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return 0;
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/**
 * Records a `download-updated` progress sample in `downloadProgressByKey` (idempotent):
 * - `QUEUED` (waiting for one of the host's 3 concurrent download slots): keeps the last known
 *   ratio (a resumed `.part`), seeding `0` for a brand-new download. A `QUEUED` sample's
 *   `progress: 0` carries no information (nothing transferred in this attempt yet), so it never
 *   wipes a prior ratio; a positive `progress` is recorded.
 * - `RUNNING`: stores `progress` when given; progress-less samples (e.g. a host auto-retry that
 *   stays `RUNNING`) keep the last known ratio
 * - `FAILED`: keeps the last known ratio (the resumed download continues from there)
 * - `DONE` / `NONE`: clears it
 */
export function applyDownloadProgressToViewCache(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  state: DownloadState,
  progress?: number,
): void {
  const map = getHostViewCache(host).downloadProgressByKey;
  if (state === 'RUNNING' || state === 'QUEUED') {
    const hasProgress =
      progress !== undefined &&
      Number.isFinite(progress) &&
      (state === 'RUNNING' || progress > 0 || !map.has(episodeKey));
    if (hasProgress) {
      map.set(episodeKey, Math.max(0, Math.min(1, progress)));
    } else if (!map.has(episodeKey)) {
      map.set(episodeKey, 0);
    }
    return;
  }
  if (state === 'DONE' || state === 'NONE') {
    map.delete(episodeKey);
  }
}

/**
 * Without a host `download-updated(NONE)` confirmation, how long after `deleteDownload` settled
 * late `RUNNING` / `FAILED` / `DONE` events for a stopped episode are still treated as stale
 * (emitted by the transfer / auto-retry loop before the host processed the cancellation).
 */
export const DOWNLOAD_STOP_GRACE_MS = 2000;

export interface DownloadStopGuard {
  /** In-flight `deleteDownload` calls for this episode. */
  pending: number;
  /** `Date.now()` when the last in-flight `deleteDownload` settled. */
  settledAt: number | null;
  /** The host confirmed the stop with `download-updated(NONE)`. */
  confirmed: boolean;
}

/**
 * Starts a user-requested stop (`停止下载` / `停止全部`) of a `QUEUED` / `RUNNING` download:
 * optimistically flips every SWR slice to `NONE` and guards the episode so that stale non-`NONE`
 * events / list snapshots cannot revert it while `deleteDownload` is in flight. The guard lifts
 * once `deleteDownload` settled ({@link endDownloadStop}) and the host confirmed with
 * `download-updated(NONE)` (or {@link DOWNLOAD_STOP_GRACE_MS} later without a confirmation).
 */
export function beginDownloadStop(host: PlatformHost, episodeKey: EpisodeKey): void {
  const guards = getHostViewCache(host).downloadStopGuards;
  const prev = guards.get(episodeKey);
  guards.set(episodeKey, { pending: (prev?.pending ?? 0) + 1, settledAt: null, confirmed: false });
  applyDownloadStateToViewCache(host, episodeKey, 'NONE');
}

/** Marks one in-flight `deleteDownload` (see {@link beginDownloadStop}) as settled. */
export function endDownloadStop(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  now: number = Date.now(),
): void {
  const guards = getHostViewCache(host).downloadStopGuards;
  const guard = guards.get(episodeKey);
  if (!guard) return;
  guard.pending = Math.max(0, guard.pending - 1);
  if (guard.pending > 0) return;
  guard.settledAt = now;
  if (guard.confirmed) guards.delete(episodeKey);
}

/** Drops the stop guard, e.g. when the user explicitly (re)starts the download. */
export function clearDownloadStop(host: PlatformHost, episodeKey: EpisodeKey): void {
  getHostViewCache(host).downloadStopGuards.delete(episodeKey);
}

/** Whether a user-requested stop of this episode's download is still guarded (see above). */
export function isDownloadStopGuarded(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  now: number = Date.now(),
): boolean {
  const guards = getHostViewCache(host).downloadStopGuards;
  const guard = guards.get(episodeKey);
  if (!guard) return false;
  if (guard.pending > 0) return true;
  if (
    !guard.confirmed &&
    guard.settledAt !== null &&
    now - guard.settledAt < DOWNLOAD_STOP_GRACE_MS
  ) {
    return true;
  }
  guards.delete(episodeKey);
  return false;
}

/**
 * Whether a `download-updated` event is stale because the user stopped this download:
 * - `NONE` is never stale: it confirms the stop (lifting the guard once `deleteDownload` settled)
 * - while `deleteDownload` is in flight, every other state is stale (progress ticks, auto-retry
 *   `RUNNING`, `QUEUED` -> `RUNNING` promotion, a cancellation surfaced as `FAILED`, ...)
 * - after it settled without a host confirmation (grace window): `RUNNING` / `FAILED` / `DONE`
 *   are stale, while `QUEUED` can only come from a fresh `download()` and lifts the guard
 */
export function isStaleDownloadEvent(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  state: DownloadState,
  now: number = Date.now(),
): boolean {
  if (!isDownloadStopGuarded(host, episodeKey, now)) return false;
  const guards = getHostViewCache(host).downloadStopGuards;
  const guard = guards.get(episodeKey);
  if (!guard) return false;
  if (state === 'NONE') {
    guard.confirmed = true;
    if (guard.pending === 0) guards.delete(episodeKey);
    return false;
  }
  if (guard.pending > 0) return true;
  if (state === 'QUEUED') {
    guards.delete(episodeKey);
    return false;
  }
  return true;
}

/**
 * Overrides a list snapshot's `downloadState` with `NONE` for guarded stops, so a snapshot fetched
 * while `deleteDownload` was still in flight never resurrects a stopped `QUEUED` / `RUNNING` row.
 */
export function guardStoppedDownloadState(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  state: DownloadState,
  now: number = Date.now(),
): DownloadState {
  return state !== 'NONE' && isDownloadStopGuarded(host, episodeKey, now) ? 'NONE' : state;
}

/**
 * Applies a `download-updated` transition to every SWR cache slice that embeds the episode
 * (`episodesByFeed` across all cached feeds, `queueRows`, `timelineItems`, `downloadedItems`,
 * `downloadedCount`, `downloadProgressByKey`).
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
  progress?: number,
): void {
  const viewCache = getHostViewCache(host);
  applyDownloadProgressToViewCache(host, episodeKey, state, progress);

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
    let next: T[] | null = null;
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      const patched = patch(item);
      if (patched !== item) {
        if (next === null) next = list.slice(0, i);
        next.push(patched);
      } else if (next !== null) {
        next.push(item);
      }
    }
    return next ?? list;
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
    if (before.some((item) => item.row.episode.episodeKey === episodeKey)) {
      const after = before.filter((item) => item.row.episode.episodeKey !== episodeKey);
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
