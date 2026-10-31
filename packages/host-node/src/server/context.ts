/**
 * `NodePlatformHost`: server-side `PlatformHost` implementation backed by `node:sqlite`,
 * `NodeHttpClient`, `MediaProxy`, `EpisodeDownloader`, `FeedRefresher`, and `NodeSyncService`
 * (`ARCHITECTURE.md §3.1`, `§3.2`).
 */
import {
  buildQueueStub,
   buildUserAgent,
  ChapterLoader,
  computeResumePositionMs,
  createFeedUrlResolver,
  createItunesTopListLoader,
  createSearcherRegistry,
  extractUrlCredentials,
  filterOutSubscribed,
  HybridLogicalClock,
  LOCAL_FOLDER_URL_PREFIX,
  MiniPodError,
  Opml,
  type PodcastIndexKeys,
  prepareUrl,
  queueAdd,
  queueAutoRemoveOnFinish,
  queueClear,
  queueMove,
  queuePlayNext,
  queueRemove,
  rebalanceQueueIfNeeded,
  stampMarkPlayed,
  stampProgressSave,
  stampUndoResume,
  TOP_CHART_COUNTRIES,
  type AppSettings,
  type Chapter,
  type CountryCode,
  type EpisodeFilter,
  type EpisodeKey,
  type EpisodeRow,
  type Feed,
  type FeedKey,
  type FeedPreview,
  type HostCapabilities,
  type HostEvent,
  type HostInfo,
  type HttpBasicCredentials,
  type HttpClient,
  type LocalFolderRef,
  type MediaSource,
  type MiniPodErrorShape,
  type OpmlCandidate,
  type Page,
  type PlatformHost,
  type ProgressRecord,
  type ProgressSave,
  type QueueItemSource,
  type QueueRow,
  type ResolveResult,
  type SearchResult,
  type SourceId,
  type SyncProviderSecret,
  type SyncSchedulerHost,
  type SyncSettings,
  type SyncStatus,
  type Unsubscribe,
} from '@minipod/core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform, release as osRelease } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openDatabase, type Database } from '../db/sqlite';
import { ChaptersRepository } from '../db/repositories/chapters';
import { EpisodesRepository } from '../db/repositories/episodes';
import { FeedsRepository } from '../db/repositories/feeds';
import { ProgressRepository } from '../db/repositories/progress';
import { QueueRepository } from '../db/repositories/queue';
import { SqliteSyncStore } from '../db/SqliteSyncStore';
import { EpisodeDownloader } from '../downloads/downloader';
import { scanLocalFolder } from '../feeds/local-folder';
import { FeedRefresher } from '../feeds/refresher';
import { createNodeHttpClient } from '../net/fetcher';
import { MediaProxy, readLocalFileSliceSync } from '../net/range-proxy';
import { SettingsStore } from '../settings/store';
import { NodeSyncService } from '../sync/scheduler-host';
import { applyNodeUpdate, checkNodeUpdate } from '../updater/self-updater';

export const MINIPOD_VERSION = '0.1.9';

const DESKTOP_CAPABILITIES: HostCapabilities = {
  nativeAudio: false,
  downloads: true,
  localFolderFeeds: true,
  syncProviders: ['local-folder', 'drive-appdata', 'drive-file', 'webdav', 'gist'],
  filePicker: false,
  folderPicker: false,
  backgroundSync: true,
  openExternal: true,
};

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_CACHED_PREVIEWS = 64;
const PLAYING_SILENCE_MS = 6_500;

interface CachedPreviewEntry {
  readonly preview: FeedPreview;
  readonly credentials?: HttpBasicCredentials;
  readonly expiresAt: number;
}

export interface NodeHostOptions {
  /** Directory storing `minipod.sqlite`, `secrets.json`, and `downloads/`. Use `':memory:'` for unit tests. */
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly appVersion?: string;
  readonly repoDir?: string;
  readonly http?: HttpClient;
  readonly fetchImpl?: typeof fetch;
  readonly podcastIndexKeys?: PodcastIndexKeys;
  readonly defaultCountry?: CountryCode;
  readonly deviceName?: string;
  readonly openExternalImpl?: (url: string) => Promise<void>;
  readonly schedulerHost?: SyncSchedulerHost;
}

export interface NodeHostBundle {
  readonly host: PlatformHost;
  readonly db: Database;
  readonly syncStore: SqliteSyncStore;
  readonly syncService: NodeSyncService;
  readonly mediaProxy: MediaProxy;
  readonly emit: (event: HostEvent) => void;
}

export function defaultDataDir(): string {
  const override = process.env['MINIPOD_DATA_DIR']?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.minipod');
}

export async function defaultOpenExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MiniPodError('invalid-url', `Invalid external URL: ${url}`);
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'mailto:'
  ) {
    throw new MiniPodError('invalid-url', `Disallowed external URL scheme: ${parsed.protocol}`);
  }

  const plat = osPlatform();
  const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'cmd' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', parsed.toString()] : [parsed.toString()];

  await new Promise<void>((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', rej);
    child.once('spawn', () => {
      child.unref();
      res();
    });
  });
}

function detectDesktopDeviceName(): string {
  try {
    const h = hostname().trim();
    return h || 'MiniPod Desktop';
  } catch {
    return 'MiniPod Desktop';
  }
}

export function createNodePlatformHost(options?: NodeHostOptions): NodeHostBundle {
  const dataDir = options?.dataDir ?? defaultDataDir();
  const isMemory = dataDir === ':memory:' || options?.dbPath === ':memory:';
  const dbPath = isMemory ? ':memory:' : (options?.dbPath ?? join(dataDir, 'minipod.sqlite'));
  const downloadsDir = isMemory
    ? join(homedir(), '.minipod-test-downloads-unused')
    : join(dataDir, 'downloads');

  if (!isMemory) {
    mkdirSync(dataDir, { recursive: true });
  }

  const db = openDatabase(dbPath);
  const hlc = new HybridLogicalClock();
  const osLabel = `${osPlatform()} ${osRelease()}`;
  const effectiveVersion =
    options?.appVersion ?? (process.env['MINIPOD_APP_VERSION']?.trim() || MINIPOD_VERSION);
  const userAgent = buildUserAgent(effectiveVersion, osPlatform());

  const http =
    options?.http ??
    createNodeHttpClient({
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      userAgent,
    });

  const listeners = new Set<(event: HostEvent) => void>();
  const emit = (event: HostEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  };

  let downloaderRef: EpisodeDownloader | null = null;

  const syncStore = new SqliteSyncStore({
    db,
    hlc,
    appVersion: effectiveVersion,
    ...(options?.deviceName ? { defaultDeviceName: options.deviceName } : {}),
    onDeleteDownloads: (paths) => {
      downloaderRef?.deleteFilesByPaths(paths);
    },
  });

  const initialSyncState = syncStore.getSyncStateSync();
  const settingsStore = new SettingsStore(
    db,
    isMemory ? ':memory:' : dataDir,
    options?.deviceName ?? initialSyncState.deviceName ?? detectDesktopDeviceName(),
  );

  // Ensure initial settings row uses syncState.deviceName if not yet saved
  const bootSettings = settingsStore.get();
  if (bootSettings.sync.deviceName !== initialSyncState.deviceName) {
    void syncStore.setSyncState({ deviceName: bootSettings.sync.deviceName });
  }

  const feedsRepo = new FeedsRepository(db);
  const episodesRepo = new EpisodesRepository(db);
  const progressRepo = new ProgressRepository(db);
  const queueRepo = new QueueRepository(db);
  const chaptersRepo = new ChaptersRepository(db);

  const openExternal = options?.openExternalImpl ?? defaultOpenExternal;

  let currentPlayingEpisodeKey: EpisodeKey | undefined;
  let lastProgressTickAt = 0;
  let lastProgressTickPosMs = 0;
  let lastProgressTickKey: EpisodeKey | undefined;
  let playingSilenceTimer: ReturnType<typeof setTimeout> | null = null;

  const previewCache = new Map<string, CachedPreviewEntry>();

  const prunePreviewCache = (): void => {
    const now = Date.now();
    for (const [id, entry] of previewCache) {
      if (entry.expiresAt <= now) {
        previewCache.delete(id);
      }
    }
    while (previewCache.size > MAX_CACHED_PREVIEWS) {
      const oldestKey = previewCache.keys().next().value;
      if (oldestKey === undefined) break;
      previewCache.delete(oldestKey);
    }
  };

  const cachePreviewResult = (
    res: ResolveResult,
    credentials?: HttpBasicCredentials,
  ): ResolveResult => {
    if (res.kind === 'feed') {
      prunePreviewCache();
      const inlineCreds = extractUrlCredentials(res.preview.url).credentials;
      const effectiveCreds = credentials ?? inlineCreds;
      if (effectiveCreds) {
        settingsStore.setFeedCredentials(res.preview.feedKey, effectiveCreds);
      }
      // Materialise a hidden feed stub (`subscribed = 0`, `sync_dirty = 0`) so preview
      // streaming (`▶` without subscribing) proxies `/media/:episodeKey`, queues at head,
      // and tracks millisecond progress seamlessly (`DESIGN.md §4.3`, `ARCHITECTURE.md §6.3`).
      feedsRepo.upsertParsedFeed({
        feedKey: res.preview.feedKey,
        kind: 'RSS',
        url: res.preview.url,
        subscribed: false,
        parsed: res.preview.parsed,
        hlc,
        nowWallMs: Date.now(),
        hasCredentials:
          Boolean(effectiveCreds) || Boolean(settingsStore.getFeedCredentials(res.preview.feedKey)),
        markSyncDirty: false,
      });
      previewCache.set(res.preview.previewId, {
        preview: res.preview,
        ...(effectiveCreds ? { credentials: effectiveCreds } : {}),
        expiresAt: Date.now() + PREVIEW_TTL_MS,
      });
    }
    return res;
  };

  const downloader = new EpisodeDownloader({
    db,
    downloadsDir,
    userAgent,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    getCredentials: (fk) => settingsStore.getFeedCredentials(fk),
    emit,
  });
  downloaderRef = downloader;

  let refresherRef: FeedRefresher | null = null;

  const syncService = new NodeSyncService({
    store: syncStore,
    settingsStore,
    http,
    hlc,
    userAgent,
    openExternal,
    getCurrentEpisodeKey: () => currentPlayingEpisodeKey,
    emit,
    onRefreshFeeds: (feedKeys) => {
      for (const fk of feedKeys) {
        void refresherRef?.refresh(fk).catch(() => undefined);
      }
    },
    ...(options?.schedulerHost ? { schedulerHost: options.schedulerHost } : {}),
  });

  const refresher = new FeedRefresher({
    db,
    http,
    hlc,
    userAgent,
    getDeviceId: () => syncStore.getSyncStateSync().deviceId,
    getCredentials: (fk) => settingsStore.getFeedCredentials(fk),
    getCurrentPlayingEpisodeKey: () => currentPlayingEpisodeKey,
    emit,
    onFeedMoved: () => {
      syncService.request('subscriptions-changed');
    },
  });
  refresherRef = refresher;
  refresher.configureBackgroundRefresh(bootSettings.backgroundRefreshHours);

  const searcherRegistry = createSearcherRegistry({
    http,
    userAgent,
    ...(options?.podcastIndexKeys ? { podcastIndexKeys: options.podcastIndexKeys } : {}),
  });

  const topListLoader = createItunesTopListLoader({
    http,
    userAgent,
    ...(options?.defaultCountry ? { defaultCountry: options.defaultCountry } : {}),
  });

  const urlResolver = createFeedUrlResolver({
    http,
    registry: searcherRegistry,
    userAgent,
    isSubscribed: (fk) => feedsRepo.isSubscribed(fk),
  });

  const loadChaptersInternal = async (
    episodeKey: EpisodeKey,
    forceRefresh = false,
  ): Promise<readonly Chapter[]> => {
    const epRow = episodesRepo.getRawByKey(episodeKey);
    if (!epRow) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    if (!forceRefresh && epRow.chapters_merged === 1) {
      return chaptersRepo.getMergedChapters(epRow.id);
    }

    const feedChapters = chaptersRepo.getFeedChapters(epRow.id);
    const feedRow = feedsRepo.getRaw(epRow.feed_key);
    const isLocal = feedRow?.kind === 'LOCAL' || epRow.feed_key.startsWith('l_');
    const localFile =
      epRow.download_state === 'DONE' && epRow.download_path
        ? epRow.download_path
        : isLocal && epRow.enclosure_url
          ? epRow.enclosure_url
          : undefined;

    if (isLocal && !epRow.chapters_url && feedChapters.length > 0 && !forceRefresh) {
      chaptersRepo.saveMergedChapters(epRow.id, feedChapters);
      return feedChapters;
    }

    const episodeForLoader = {
      downloadState: localFile ? ('DONE' as const) : epRow.download_state,
      ...(epRow.enclosure_url !== null ? { enclosureUrl: epRow.enclosure_url } : {}),
      ...(epRow.chapters_url !== null ? { chaptersUrl: epRow.chapters_url } : {}),
      ...(localFile ? { downloadPath: localFile } : {}),
    };

    const creds = settingsStore.getFeedCredentials(epRow.feed_key);
    const merged = await ChapterLoader.load(episodeForLoader, {
      http,
      userAgent,
      ...(creds ? { credentials: creds } : {}),
      feedChapters,
      readLocalRange: async (path, start, endInclusive) =>
        readLocalFileSliceSync(path, start, endInclusive),
    });

    chaptersRepo.saveMergedChapters(epRow.id, merged);
    return merged;
  };

  const mediaProxy = new MediaProxy({
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    http,
    userAgent,
    artworkCacheDir: isMemory ? undefined : join(dataDir, 'artwork-cache'),
    resolveEpisode: (episodeKey) => {
      const raw = episodesRepo.getRawByKey(episodeKey);
      if (!raw) return undefined;
      const creds = settingsStore.getFeedCredentials(raw.feed_key);
      return {
        episodeKey: raw.episode_key,
        feedKey: raw.feed_key,
        isLocalFeed: raw.feed_key.startsWith('l_'),
        downloadState: raw.download_state,
        ...(raw.enclosure_url !== null ? { enclosureUrl: raw.enclosure_url } : {}),
        ...(raw.enclosure_mime !== null ? { enclosureMime: raw.enclosure_mime } : {}),
        ...(raw.download_path !== null ? { downloadPath: raw.download_path } : {}),
        ...(creds ? { credentials: creds } : {}),
      };
    },
    loadChaptersForEpisode: (episodeKey) => loadChaptersInternal(episodeKey, false),
    resolveLocalFeedCover: (fk) => {
      const feedRow = feedsRepo.getRaw(fk);
      if (!feedRow || !feedRow.local_cover_path) return undefined;
      if (feedRow.local_cover_path.startsWith('audio:')) {
        return {
          coverPath: feedRow.local_cover_path.slice('audio:'.length),
          isAudioFile: true,
        };
      }
      return { coverPath: feedRow.local_cover_path, isAudioFile: false };
    },
  });

  const subscribeFromPreview = (
    preview: FeedPreview,
    credentials?: HttpBasicCredentials,
  ): Feed => {
    const inlineCreds = extractUrlCredentials(preview.url).credentials;
    const effectiveCreds = credentials ?? inlineCreds;
    if (effectiveCreds) {
      settingsStore.setFeedCredentials(preview.feedKey, effectiveCreds);
    }

    const { feed } = feedsRepo.upsertParsedFeed({
      feedKey: preview.feedKey,
      kind: 'RSS',
      url: preview.url,
      subscribed: true,
      parsed: preview.parsed,
      hlc,
      nowWallMs: Date.now(),
      hasCredentials:
        Boolean(effectiveCreds) || Boolean(settingsStore.getFeedCredentials(preview.feedKey)),
      ...(preview.permanentRedirect ? { movedTo: preview.permanentRedirect.to } : {}),
      markSyncDirty: true,
    });

    emit({ type: 'feeds-changed' });
    emit({ type: 'episodes-changed', feedKey: feed.feedKey });
    syncService.request('subscriptions-changed');
    return feed;
  };

  const handleEpisodeCompletedSideEffects = async (
    episodeKey: EpisodeKey,
    feedKey: FeedKey,
  ): Promise<void> => {
    const syncState = syncStore.getSyncStateSync();
    const removedEntry = queueAutoRemoveOnFinish(queueRepo.listAllEntries(), episodeKey, {
      hlc,
      deviceId: syncState.deviceId,
    });
    if (removedEntry) {
      const isLocal = feedKey.startsWith('l_');
      queueRepo.upsertEntries([removedEntry], !isLocal);
      emit({ type: 'queue-changed' });
      if (!isLocal) {
        syncService.request('queue-changed');
      }
    }

    if (settingsStore.get().deleteDownloadWhenPlayed && !feedKey.startsWith('l_')) {
      const epRaw = episodesRepo.getRawByKey(episodeKey);
      if (epRaw && epRaw.download_state === 'DONE') {
        await downloader.deleteDownload(episodeKey);
      }
    }
  };

  const getCurrentHostInfo = (): HostInfo => {
    const st = syncStore.getSyncStateSync();
    return {
      platform: 'desktop',
      os: osLabel,
      appVersion: effectiveVersion,
      capabilities: DESKTOP_CAPABILITIES,
      deviceId: st.deviceId,
      deviceName: st.deviceName,
      ...(isMemory ? {} : { dataDir }),
    };
  };

  let disposed = false;

  const host: PlatformHost = {
    get info(): HostInfo {
      return getCurrentHostInfo();
    },

    feeds: {
      async list(): Promise<readonly Feed[]> {
        return feedsRepo.listSubscribed();
      },

      async get(feedKey: FeedKey): Promise<Feed> {
        return feedsRepo.get(feedKey);
      },

      async preview(url: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        const inline = extractUrlCredentials(url).credentials;
        const res = await urlResolver.resolve(url, {
          ...(credentials ? { credentials } : {}),
        });
        return cachePreviewResult(res, credentials ?? inline);
      },

      async subscribe(previewIdOrUrl: string): Promise<Feed> {
        prunePreviewCache();
        const cached = previewCache.get(previewIdOrUrl);
        if (cached) {
          previewCache.delete(previewIdOrUrl);
          return subscribeFromPreview(cached.preview, cached.credentials);
        }

        const inline = extractUrlCredentials(previewIdOrUrl).credentials;
        const resolved = await urlResolver.resolve(previewIdOrUrl);
        if (resolved.kind === 'auth-required') {
          throw new MiniPodError('auth-required', `Authentication required for ${resolved.url}`, {
            details: {
              url: resolved.url,
              ...(resolved.realm ? { realm: resolved.realm } : {}),
            },
          });
        }
        if (resolved.kind === 'choices') {
          if (resolved.choices.length > 0) {
            const firstChoice = await urlResolver.resolve(resolved.choices[0]!.url);
            if (firstChoice.kind === 'feed') {
              return subscribeFromPreview(firstChoice.preview, inline);
            }
          }
          throw new MiniPodError(
            'unsupported-feed',
            `Page ${resolved.pageUrl} advertises multiple feeds; preview and choose one first`,
          );
        }
        return subscribeFromPreview(resolved.preview, inline);
      },

      async unsubscribe(feedKey: FeedKey): Promise<void> {
        const st = syncStore.getSyncStateSync();
        const isLocal = feedKey.startsWith('l_');
        const dlPaths = feedsRepo.softDeleteUnsubscribe(feedKey, hlc, st.deviceId, {
          currentPlayingKey: currentPlayingEpisodeKey,
        });
        downloader.deleteFilesByPaths(dlPaths);
        settingsStore.setFeedCredentials(feedKey, null);

        emit({ type: 'feeds-changed' });
        emit({ type: 'queue-changed' });
        if (!isLocal) {
          syncService.request('subscriptions-changed');
        }
      },

      async refresh(feedKey?: FeedKey): Promise<void> {
        await refresher.refresh(feedKey);
      },

      async loadOlder(feedKey: FeedKey): Promise<number> {
        return refresher.loadOlder(feedKey);
      },

      async setCredentials(
        feedKey: FeedKey,
        credentials: HttpBasicCredentials | null,
      ): Promise<void> {
        feedsRepo.get(feedKey); // assert exists
        settingsStore.setFeedCredentials(feedKey, credentials);
        feedsRepo.setHasCredentials(feedKey, credentials !== null, hlc);
        emit({ type: 'feeds-changed' });
        if (!feedKey.startsWith('l_')) {
          syncService.request('subscriptions-changed');
        }
      },

      async addLocalFolder(folder: LocalFolderRef): Promise<Feed> {
        const scanned = scanLocalFolder(folder.ref, { displayName: folder.displayName });
        const { feed } = feedsRepo.upsertParsedFeed({
          feedKey: scanned.feedKey,
          kind: 'LOCAL',
          url: scanned.feedUrl,
          subscribed: true,
          parsed: scanned.parsed,
          hlc,
          nowWallMs: Date.now(),
          localCoverPath: scanned.localCoverSpec,
          overrideImageUrl: scanned.localCoverSpec
            ? `/api/feeds/${encodeURIComponent(scanned.feedKey)}/cover`
            : undefined,
          localMtimeByIdentity: scanned.mtimeByIdentity,
          markSyncDirty: false,
        });
        emit({ type: 'feeds-changed' });
        emit({ type: 'episodes-changed', feedKey: feed.feedKey });
        return feed;
      },

      async importOpml(xml: string): Promise<readonly OpmlCandidate[]> {
        return Opml.parse(xml);
      },

      async subscribeMany(urls: readonly string[]): Promise<{
        readonly added: number;
        readonly failed: readonly { url: string; error: MiniPodErrorShape }[];
      }> {
        let added = 0;
        const failed: Array<{ url: string; error: MiniPodErrorShape }> = [];
        const queue = [...urls];
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length > 0) {
            const rawUrl = queue.shift();
            if (!rawUrl) break;
            try {
              const normalized = prepareUrl(rawUrl);
              await host.feeds.subscribe(normalized);
              added += 1;
            } catch (err) {
              failed.push({
                url: rawUrl,
                error: MiniPodError.wrap(err, 'network').toShape(),
              });
            }
          }
        });
        await Promise.all(workers);
        return { added, failed };
      },

      async exportOpml(): Promise<string> {
        return Opml.write(feedsRepo.listSubscribed());
      },
    },

    search: {
      async sources() {
        return searcherRegistry.all.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          inCombined: s.id !== 'combined' && s.combinedWeight > 0,
        }));
      },

      async query(
        text: string,
        source: SourceId = 'combined',
        signal?: AbortSignal,
      ): Promise<readonly SearchResult[]> {
        return searcherRegistry.byId(source).search(text, signal);
      },

      async topCharts(country: CountryCode, signal?: AbortSignal): Promise<readonly SearchResult[]> {
        const raw = await topListLoader.topPodcasts(country, 60, signal);
        const subscribedTitles = feedsRepo.listSubscribed().map((f) => f.title);
        return filterOutSubscribed(raw, subscribedTitles);
      },

      async resolveUrl(input: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        const inline = extractUrlCredentials(input.trim()).credentials;
        const res = await urlResolver.resolve(input, {
          ...(credentials ? { credentials } : {}),
        });
        return cachePreviewResult(res, credentials ?? inline);
      },

      async countries() {
        return TOP_CHART_COUNTRIES;
      },
    },

    episodes: {
      async list(
        feedKey: FeedKey,
        filter: EpisodeFilter,
        cursor?: string,
      ): Promise<Page<EpisodeRow>> {
        return episodesRepo.list(feedKey, filter, cursor);
      },

      async get(episodeKey: EpisodeKey): Promise<EpisodeRow> {
        return episodesRepo.getRow(episodeKey);
      },

      async download(episodeKey: EpisodeKey): Promise<void> {
        await downloader.download(episodeKey);
      },

      async deleteDownload(episodeKey: EpisodeKey): Promise<void> {
        await downloader.deleteDownload(episodeKey);
      },

      async chapters(episodeKey: EpisodeKey, forceRefresh?: boolean): Promise<readonly Chapter[]> {
        return loadChaptersInternal(episodeKey, forceRefresh);
      },

      async chapterImage(
        episodeKey: EpisodeKey,
        chapterIndex: number,
      ): Promise<string | undefined> {
        const chapters = await loadChaptersInternal(episodeKey, false);
        const ch = chapters[chapterIndex];
        if (!ch) return undefined;
        if (ch.embeddedImage) {
          return `/api/episodes/${encodeURIComponent(episodeKey)}/chapters/${chapterIndex}/image`;
        }
        return ch.imageUrl;
      },

      async share(episodeKey: EpisodeKey): Promise<{ readonly url: string; readonly title: string }> {
        const epRow = episodesRepo.getRawByKey(episodeKey);
        if (!epRow) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        const feed = feedsRepo.getRaw(epRow.feed_key);
        const shareUrl =
          epRow.link ||
          (epRow.enclosure_url && /^https?:\/\//i.test(epRow.enclosure_url)
            ? epRow.enclosure_url
            : undefined) ||
          feed?.link ||
          (feed?.url && !feed.url.startsWith(LOCAL_FOLDER_URL_PREFIX) ? feed.url : '');
        return { url: shareUrl, title: epRow.title };
      },
    },

    queue: {
      async list(): Promise<readonly QueueRow[]> {
        const all = queueRepo.listAllEntries();
        const st = syncStore.getSyncStateSync();
        const rebalanced = rebalanceQueueIfNeeded(all, { hlc, deviceId: st.deviceId });
        if (rebalanced.length > 0) {
          queueRepo.upsertEntries(rebalanced, true);
          syncService.request('queue-changed');
        }
        return queueRepo.listActiveRows();
      },

      async add(episodeKey: EpisodeKey): Promise<void> {
        const epRow = episodesRepo.getRow(episodeKey);
        const feed = feedsRepo.get(epRow.episode.feedKey);
        const st = syncStore.getSyncStateSync();
        const isLocal = feed.kind === 'LOCAL';
        const stub = isLocal ? undefined : buildQueueStub(epRow.episode, feed);
        const mutated = queueAdd(
          queueRepo.listAllEntries(),
          {
            episodeKey,
            feedKey: feed.feedKey,
            ...(stub ? { stub } : {}),
          },
          { hlc, deviceId: st.deviceId },
        );
        if (mutated.length > 0) {
          queueRepo.upsertEntries(mutated, !isLocal);
          emit({ type: 'queue-changed' });
          if (!isLocal) syncService.request('queue-changed');
        }
      },

      async playNext(episodeKey: EpisodeKey): Promise<void> {
        const epRow = episodesRepo.getRow(episodeKey);
        const feed = feedsRepo.get(epRow.episode.feedKey);
        const st = syncStore.getSyncStateSync();
        const isLocal = feed.kind === 'LOCAL';
        const stub = isLocal ? undefined : buildQueueStub(epRow.episode, feed);
        const mutated = queuePlayNext(
          queueRepo.listAllEntries(),
          {
            episodeKey,
            feedKey: feed.feedKey,
            ...(stub ? { stub } : {}),
          },
          { hlc, deviceId: st.deviceId },
          currentPlayingEpisodeKey,
        );
        if (mutated.length > 0) {
          queueRepo.upsertEntries(mutated, !isLocal);
          emit({ type: 'queue-changed' });
          if (!isLocal) syncService.request('queue-changed');
        }
      },

      async move(episodeKey: EpisodeKey, beforeKey: EpisodeKey | null): Promise<void> {
        const st = syncStore.getSyncStateSync();
        const mutated = queueMove(queueRepo.listAllEntries(), episodeKey, beforeKey, {
          hlc,
          deviceId: st.deviceId,
        });
        if (mutated.length > 0) {
          const nonLocal = mutated.filter((m) => !m.feedKey.startsWith('l_'));
          const localOnly = mutated.filter((m) => m.feedKey.startsWith('l_'));
          if (nonLocal.length > 0) queueRepo.upsertEntries(nonLocal, true);
          if (localOnly.length > 0) queueRepo.upsertEntries(localOnly, false);
          emit({ type: 'queue-changed' });
          if (nonLocal.length > 0) syncService.request('queue-changed');
        }
      },

      async remove(episodeKey: EpisodeKey): Promise<void> {
        const st = syncStore.getSyncStateSync();
        const removed = queueRemove(queueRepo.listAllEntries(), episodeKey, {
          hlc,
          deviceId: st.deviceId,
        });
        if (removed) {
          const isLocal = removed.feedKey.startsWith('l_');
          queueRepo.upsertEntries([removed], !isLocal);
          emit({ type: 'queue-changed' });
          if (!isLocal) syncService.request('queue-changed');
        }
      },

      async clear(): Promise<void> {
        const st = syncStore.getSyncStateSync();
        const tombstones = queueClear(queueRepo.listAllEntries(), {
          hlc,
          deviceId: st.deviceId,
        });
        if (tombstones.length > 0) {
          const nonLocal = tombstones.filter((t) => !t.feedKey.startsWith('l_'));
          const localOnly = tombstones.filter((t) => t.feedKey.startsWith('l_'));
          if (nonLocal.length > 0) queueRepo.upsertEntries(nonLocal, true);
          if (localOnly.length > 0) queueRepo.upsertEntries(localOnly, false);
          emit({ type: 'queue-changed' });
          if (nonLocal.length > 0) syncService.request('queue-changed');
        }
      },
    },

    progress: {
      async get(episodeKey: EpisodeKey): Promise<ProgressRecord | undefined> {
        return progressRepo.get(episodeKey);
      },

      async save(save: ProgressSave): Promise<void> {
        const epRaw = episodesRepo.getRawByKey(save.episodeKey);
        const existingProg = progressRepo.get(save.episodeKey);
        const feedKey = epRaw?.feed_key ?? existingProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError('not-found', `Episode not found: ${save.episodeKey}`);
        }

        const st = syncStore.getSyncStateSync();
        const effectivePrevious: ProgressRecord | undefined =
          existingProg &&
          existingProg.durationMs === undefined &&
          epRaw?.duration_ms !== null &&
          epRaw?.duration_ms !== undefined
            ? { ...existingProg, durationMs: epRaw.duration_ms }
            : existingProg;

        const effectiveSave: ProgressSave =
          save.durationMs === undefined &&
          epRaw?.duration_ms !== null &&
          epRaw?.duration_ms !== undefined
            ? { ...save, durationMs: epRaw.duration_ms }
            : save;

        const stamped = stampProgressSave(effectiveSave, {
          feedKey,
          hlc,
          deviceId: st.deviceId,
          previous: effectivePrevious,
        });

        const isLocal = feedKey.startsWith('l_');
        progressRepo.upsert(stamped, {
          syncDirty: !isLocal,
          identity: epRaw?.identity,
        });

        currentPlayingEpisodeKey = save.episodeKey;
        emit({ type: 'progress-changed', episodeKey: save.episodeKey });

        if (playingSilenceTimer !== null) {
          clearTimeout(playingSilenceTimer);
          playingSilenceTimer = null;
        }

        const nowMs = Date.now();
        const elapsedSinceLast = nowMs - lastProgressTickAt;
        const posDelta = Math.abs(stamped.positionMs - lastProgressTickPosMs);
        const isSameEp = lastProgressTickKey === save.episodeKey;

        lastProgressTickAt = nowMs;
        lastProgressTickPosMs = stamped.positionMs;
        lastProgressTickKey = save.episodeKey;

        if (stamped.state === 'PLAYED') {
          syncService.scheduler.updatePlayback({
            playing: false,
            episodeKey: save.episodeKey,
            positionMs: 0,
          });
          await handleEpisodeCompletedSideEffects(save.episodeKey, feedKey);
          if (!isLocal) {
            if (save.flush) {
              await syncService.requestImmediatePush();
            } else {
              syncService.request('progress-completed');
            }
          }
          return;
        }

        if (save.flush) {
          syncService.scheduler.updatePlayback({
            playing: false,
            episodeKey: save.episodeKey,
            positionMs: stamped.positionMs,
          });
          if (!isLocal) {
            await syncService.requestImmediatePush();
          }
          return;
        }

        // Distinguish steady 5s periodic playback ticks from user pause/seek saves (§9.2)
        const looksLikePeriodicPlayingTick =
          isSameEp &&
          elapsedSinceLast >= 4_200 &&
          elapsedSinceLast <= 12_000 &&
          posDelta <= 18_000;

        syncService.scheduler.updatePlayback({
          playing: true,
          episodeKey: save.episodeKey,
          positionMs: stamped.positionMs,
        });

        if (!isLocal && isSameEp && !looksLikePeriodicPlayingTick) {
          // Immediate seek or explicit pause < 4.2s after previous tick
          syncService.request('progress-paused');
        }

        // Silence timer: if no further 5s tick arrives within 6.5s, playback paused -> debounced sync
        playingSilenceTimer = setTimeout(() => {
          playingSilenceTimer = null;
          syncService.scheduler.updatePlayback({
            playing: false,
            episodeKey: save.episodeKey,
            positionMs: stamped.positionMs,
          });
          if (!isLocal) {
            syncService.request('progress-paused');
          }
        }, PLAYING_SILENCE_MS);
        playingSilenceTimer.unref?.();
      },

      async markPlayed(episodeKey: EpisodeKey, played: boolean): Promise<void> {
        const epRaw = episodesRepo.getRawByKey(episodeKey);
        const existingProg = progressRepo.get(episodeKey);
        const feedKey = epRaw?.feed_key ?? existingProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }

        const st = syncStore.getSyncStateSync();
        const stamped = stampMarkPlayed({
          episodeKey,
          feedKey,
          played,
          hlc,
          deviceId: st.deviceId,
          previous: existingProg,
          durationMs: epRaw?.duration_ms ?? undefined,
        });

        const isLocal = feedKey.startsWith('l_');
        progressRepo.upsert(stamped, {
          syncDirty: !isLocal,
          identity: epRaw?.identity,
        });
        emit({ type: 'progress-changed', episodeKey });

        if (played) {
          await handleEpisodeCompletedSideEffects(episodeKey, feedKey);
        }

        if (!isLocal) {
          syncService.request('progress-marked');
        }
      },
    },

    playback: {
      async sourceFor(episodeKey: EpisodeKey): Promise<MediaSource> {
        const raw = episodesRepo.getRawByKey(episodeKey);
        if (!raw) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        currentPlayingEpisodeKey = episodeKey;
        return {
          kind: 'url',
          url: `/media/${encodeURIComponent(episodeKey)}`,
          ...(raw.enclosure_mime !== null ? { mime: raw.enclosure_mime } : {}),
        };
      },

      async queueSources(): Promise<readonly QueueItemSource[]> {
        const rows = queueRepo.listActiveRows();
        const feedByKey = new Map(feedsRepo.listAllRaw().map((f) => [f.feed_key, f]));
        return rows.map((r) => {
          const feed = feedByKey.get(r.episode.feedKey);
          const artworkUrl = r.episode.imageUrl?.trim() || feed?.image_url?.trim() || undefined;
          return {
            episodeKey: r.episode.episodeKey,
            source: {
              kind: 'url' as const,
              url: `/media/${encodeURIComponent(r.episode.episodeKey)}`,
              ...(r.episode.enclosureMime ? { mime: r.episode.enclosureMime } : {}),
            },
            startMs: computeResumePositionMs(r.progress),
            metadata: {
              title: r.episode.title,
              ...(feed?.title ? { artist: feed.title, album: feed.title } : {}),
              ...(artworkUrl !== undefined ? { artworkUrl } : {}),
              ...(r.episode.durationMs !== undefined ? { durationMs: r.episode.durationMs } : {}),
            },
          };
        });
      },
    },

    sync: {
      async status(): Promise<SyncStatus> {
        return syncService.engine.getStatus();
      },

      async configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus> {
        return syncService.configure(settings, secret);
      },

      async authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void> {
        await syncService.authorize(provider);
      },

      async syncNow(): Promise<SyncStatus> {
        return syncService.syncNow();
      },

      async disconnect(): Promise<void> {
        await syncService.disconnect();
      },

      async resetRemote(): Promise<void> {
        await syncService.resetRemote();
      },

      async undoResume(episodeKey: EpisodeKey, positionMs: number): Promise<void> {
        const epRaw = episodesRepo.getRawByKey(episodeKey);
        const existingProg = progressRepo.get(episodeKey);
        const feedKey = epRaw?.feed_key ?? existingProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        const st = syncStore.getSyncStateSync();
        const stamped = stampUndoResume({
          episodeKey,
          feedKey,
          positionMs,
          hlc,
          deviceId: st.deviceId,
          previous: existingProg,
          durationMs: epRaw?.duration_ms ?? undefined,
        });
        const isLocal = feedKey.startsWith('l_');
        progressRepo.upsert(stamped, {
          syncDirty: !isLocal,
          identity: epRaw?.identity,
        });
        emit({ type: 'progress-changed', episodeKey });
        if (!isLocal) {
          syncService.request('progress-paused');
        }
      },
    },

    files: {
      async listDirectory(rawPath?: string) {
        const target = resolve(rawPath && rawPath.trim() ? rawPath.trim() : homedir());
        if (!existsSync(target)) {
          throw new MiniPodError('not-found', `Directory does not exist: ${target}`);
        }
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(target);
        } catch (err) {
          throw new MiniPodError('sync-auth', `Cannot access directory: ${target}`, { cause: err });
        }
        if (!st.isDirectory()) {
          throw new MiniPodError('invalid-argument', `Not a directory: ${target}`);
        }

        let entries: string[];
        try {
          entries = readdirSync(target);
        } catch (err) {
          throw new MiniPodError('sync-auth', `Permission denied listing: ${target}`, {
            cause: err,
          });
        }

        const dirs: string[] = [];
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          const child = join(target, name);
          try {
            if (statSync(child).isDirectory()) {
              dirs.push(name);
            }
          } catch {
            // ignore inaccessible entry
          }
        }
        dirs.sort((a, b) => a.localeCompare(b));

        const parentDir = dirname(target);
        return {
          path: target,
          dirs,
          ...(parentDir !== target ? { parent: parentDir } : {}),
        };
      },

      async saveTextFile(name: string, text: string, _mime: string): Promise<void> {
        if (isMemory) return;
        const safeName = name.replace(/[\\/]/g, '_') || 'minipod.opml';
        const outPath = join(dataDir, safeName);
        writeFileSync(outPath, text, 'utf8');
      },

      async openExternal(url: string): Promise<void> {
        await openExternal(url);
      },
    },

    settings: {
      async get(): Promise<AppSettings> {
        return settingsStore.get();
      },

      async update(patch: Partial<AppSettings>): Promise<AppSettings> {
        const next = settingsStore.update(patch);
        if (patch.backgroundRefreshHours !== undefined) {
          refresher.configureBackgroundRefresh(next.backgroundRefreshHours);
        }
        if (patch.sync !== undefined) {
          syncService.scheduler.setWifiOnly(next.sync.wifiOnly);
          await syncStore.setSyncState({ deviceName: next.sync.deviceName });
        }
        emit({ type: 'settings-changed', settings: next });
        return next;
      },
    },

    updater: {
      async check(checkOpts) {
        return checkNodeUpdate({
          currentVersion: effectiveVersion,
          overrideCurrentVersion: checkOpts?.currentVersion,
          dataDir,
          repoDir: options?.repoDir,
          fetchImpl: options?.fetchImpl,
          userAgent,
        });
      },

      async apply(applyOpts) {
        return applyNodeUpdate({
          currentVersion: effectiveVersion,
          dataDir,
          repoDir: options?.repoDir,
          fetchImpl: options?.fetchImpl,
          userAgent,
          force: applyOpts?.force,
        });
      },
    },

    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (playingSilenceTimer !== null) {
        clearTimeout(playingSilenceTimer);
        playingSilenceTimer = null;
      }
      refresher.dispose();
      downloader.dispose();
      syncService.dispose();
      mediaProxy.clearCache();
      listeners.clear();
      try {
        db.close();
      } catch {
        // ignore double close
      }
    },
  };

  return {
    host,
    db,
    syncStore,
    syncService,
    mediaProxy,
    emit,
  };
}
