/**
 * `CapacitorPlatformHost`: Android `PlatformHost` implementation running in the
 * Capacitor WebView over IndexedDB (`IdbSyncStore`), `@capacitor/preferences`
 * (`AndroidSecretsStore`), and `MiniPodPlugin.java` (`ARCHITECTURE.md §3.2`, `§3.3`, `§6.2`, `§10`).
 */
import type { PluginListenerHandle } from '@capacitor/core';
import {
  BasicAuth,
  buildQueueStub,
  buildUserAgent,
  ChapterLoader,
  compareSemver,
  computeResumePositionMs,
  createFeedUrlResolver,
  createItunesTopListLoader,
  createSearcherRegistry,
  decodeBase64,
  decodeFeedBytes,
  detectFeedType,
  encodeBase64,
  extractUrlCredentials,
  fetchLatestRelease,
  fetchWithBasicAuth,
  filterOutSubscribed,
  GitHubGistProvider,
  GoogleDriveProvider,
  HybridLogicalClock,
  LOCAL_FOLDER_URL_PREFIX,
  MiniPodError,
  Opml,
  parseFeed,
  prepareUrl,
  queueAdd,
  queueAutoRemoveOnFinish,
  queueClear,
  queueMove,
  queuePlayNext,
  queueRemove,
  rebalanceQueueIfNeeded,
  RedirectRecorder,
  stampMarkPlayed,
  stampProgressSave,
  stampUndoResume,
  SyncEngine,
  SyncScheduler,
  TOP_CHART_COUNTRIES,
  WebDavProvider,
  type ApplyDecisions,
  type AppSettings,
  type Chapter,
  type CloudFileProvider,
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
  type ProviderId,
  type QueueItemSource,
  type QueueRow,
  type ResolveResult,
  type SearchResult,
  type SourceId,
  type SyncProviderConfig,
  type SyncProviderSecret,
  type SyncSettings,
  type SyncStatus,
  type Unsubscribe,
} from '@minipod/core';
import { resolveCapacitorHostDeps, type CapacitorHostDeps } from './default-deps';
import { scanSafLocalFolder, type ExistingSafEpisodeHint } from './feeds/local-folder';
import { createPluginHttpClient } from './net/plugin-http';
import { NativeAudioEngine } from './player/NativeAudioEngine';
import type { DeepLinkPayload } from './plugin-types';
import {
  AndroidSecretsStore,
  createDefaultAndroidAppSettings,
  openMiniPodDb,
  type MiniPodDb,
} from './storage/idb';
import { IdbSyncStore } from './storage/IdbSyncStore';
import { AndroidDriveAuthManager } from './sync/drive-auth';
import { createSafFileProvider } from './sync/SafFileProvider';

export const CAPACITOR_HOST_VERSION = '0.1.22';

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_CACHED_PREVIEWS = 64;
const DOWNLOAD_EVENT_MIN_INTERVAL_MS = 500; // <= 2/s per ARCHITECTURE.md §3 rule 4
const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();

interface CachedPreviewEntry {
  readonly preview: FeedPreview;
  readonly credentials?: HttpBasicCredentials;
  readonly expiresAt: number;
}

export interface CreateCapacitorHostOptions extends Partial<CapacitorHostDeps> {
  readonly http?: HttpClient;
  readonly defaultCountry?: CountryCode;
}

export interface CapacitorHostBundle {
  readonly host: PlatformHost;
  readonly engine: NativeAudioEngine;
  readonly db: MiniPodDb;
  readonly syncStore: IdbSyncStore;
  readonly syncEngine: SyncEngine;
  readonly syncScheduler: SyncScheduler;
  readonly reconcileJournal: () => Promise<void>;
  readonly emit: (event: HostEvent) => void;
}

function guessDownloadExtension(url: string, mime?: string): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('aac')) return 'aac';
  if (m.includes('wav')) return 'wav';
  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // ignore URL parse error
  }
  return 'audio';
}

export function extractActionSendInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const urlMatch =
    /(?:https?:\/\/|feed:\/\/|itpc:\/\/|pcast:\/\/|pcast:|antennapod-subscribe:\/\/)\S+/i.exec(
      trimmed,
    );
  if (urlMatch?.[0]) {
    return urlMatch[0].replace(/[),.!?'"\]>]+$/, '');
  }
  return trimmed;
}

export async function createCapacitorPlatformHost(
  options?: CreateCapacitorHostOptions,
): Promise<CapacitorHostBundle> {
  const deps = await resolveCapacitorHostDeps(options);
  const { plugin } = deps;
  const db = await openMiniPodDb(deps.idbFactory, deps.dbName);
  const hlc = new HybridLogicalClock();
  const userAgent = buildUserAgent(deps.appVersion, 'android');

  const http = options?.http ?? createPluginHttpClient(plugin, { userAgent });
  const secretsStore = new AndroidSecretsStore(deps.preferences);
  const driveAuth = new AndroidDriveAuthManager(plugin);
  const driveSupported = await driveAuth.isAvailable();

  const syncProviders: readonly ProviderId[] = driveSupported
    ? ['saf', 'drive-appdata', 'drive-file', 'webdav', 'gist']
    : ['saf', 'webdav', 'gist'];

  const capabilities: HostCapabilities = {
    nativeAudio: true,
    downloads: true,
    localFolderFeeds: true,
    syncProviders,
    filePicker: true,
    folderPicker: true,
    backgroundSync: false,
    openExternal: true,
  };

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

  const syncStore = new IdbSyncStore({
    db,
    hlc,
    appVersion: deps.appVersion,
    defaultDeviceName: deps.defaultDeviceName,
    onDeleteDownloads: async (paths) => {
      for (const path of paths) {
        await plugin.deleteLocalFile({ path }).catch(() => undefined);
      }
    },
  });

  const bootSyncState = await syncStore.init();

  const readSettings = async (): Promise<AppSettings> => {
    const rec = await db.get('settings', 'app');
    if (!rec?.value) {
      return createDefaultAndroidAppSettings(bootSyncState.deviceName);
    }
    return {
      ...rec.value,
      deleteDownloadWhenPlayed:
        rec.value.deleteDownloadWhenPlayed === undefined
          ? true
          : Boolean(rec.value.deleteDownloadWhenPlayed),
    };
  };

  const writeSettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const cur = await readSettings();
    const merged: AppSettings = {
      ...cur,
      ...patch,
      sync: patch.sync ? { ...cur.sync, ...patch.sync } : cur.sync,
    };
    await db.put('settings', { key: 'app', value: merged });
    return merged;
  };

  let currentPlayingEpisodeKey: EpisodeKey | undefined;
  let disposed = false;

  // Serialized journal reconciliation mutex (`ARCHITECTURE.md §3.3`)
  let journalChain: Promise<void> = Promise.resolve();

  const handleEpisodeCompletedSideEffects = async (
    episodeKey: EpisodeKey,
    feedKey: FeedKey,
    notifySync: boolean,
  ): Promise<void> => {
    const st = await syncStore.getSyncState();
    const allQ = await syncStore.listAllQueueEntries();
    const removedEntry = queueAutoRemoveOnFinish(allQ, episodeKey, {
      hlc,
      deviceId: st.deviceId,
    });
    if (removedEntry) {
      await syncStore.upsertQueueEntries([removedEntry], true);
      emit({ type: 'queue-changed' });
      if (notifySync && !feedKey.startsWith('l_')) {
        syncScheduler.request('queue-changed');
      }
    }

    const curSettings = await readSettings();
    if (curSettings.deleteDownloadWhenPlayed && !feedKey.startsWith('l_')) {
      const epRec = await syncStore.getEpisodeRecord(episodeKey);
      if (epRec && epRec.downloadState === 'DONE') {
        if (epRec.downloadPath) {
          await plugin.deleteLocalFile({ path: epRec.downloadPath }).catch(() => undefined);
        }
        await syncStore.setEpisodeDownloadState(episodeKey, 'NONE');
        emit({ type: 'download-updated', episodeKey, state: 'NONE' });
      }
    }
  };

  const runReconcileJournalOnce = async (): Promise<void> => {
    let journal;
    try {
      journal = await plugin.media.readJournal();
    } catch {
      return;
    }
    const completed = journal.completed ?? [];
    const current = journal.current ?? null;
    if (completed.length === 0 && !current) {
      return;
    }

    const st = await syncStore.getSyncState();
    const allQ = await syncStore.listAllQueueEntries();
    const qByEp = new Map(allQ.map((q) => [q.episodeKey, q]));
    const completedKeys = new Set<EpisodeKey>();
    const changedEpisodes = new Set<EpisodeKey>();
    let maxWallMs = 0;

    // 1. Replay append-only native completions (`completed[]`)
    for (const c of completed) {
      completedKeys.add(c.episodeKey);
      if (c.endedWallMs > maxWallMs) {
        maxWallMs = c.endedWallMs;
      }

      const [epRec, prevProg] = await Promise.all([
        syncStore.getEpisodeRecord(c.episodeKey),
        syncStore.getProgress(c.episodeKey),
      ]);
      const feedKey = epRec?.feedKey ?? prevProg?.feedKey ?? qByEp.get(c.episodeKey)?.feedKey;
      if (!feedKey) continue;

      if (prevProg?.state !== 'PLAYED' || c.endedWallMs > prevProg.updatedAt) {
        const playedRec = stampMarkPlayed({
          episodeKey: c.episodeKey,
          feedKey,
          played: true,
          hlc,
          deviceId: st.deviceId,
          previous: prevProg,
          durationMs: c.durationMs ?? epRec?.durationMs ?? prevProg?.durationMs,
        });
        await syncStore.upsertProgress(playedRec, {
          syncDirty: true,
          identity: epRec?.identity,
        });
        changedEpisodes.add(c.episodeKey);
      }

      await handleEpisodeCompletedSideEffects(c.episodeKey, feedKey, false);
    }

    // 2. Replay active 5s native checkpoint (`current`)
    if (current && !completedKeys.has(current.episodeKey)) {
      if (current.wallMs > maxWallMs) {
        maxWallMs = current.wallMs;
      }

      const [epRec, prevProg] = await Promise.all([
        syncStore.getEpisodeRecord(current.episodeKey),
        syncStore.getProgress(current.episodeKey),
      ]);
      const feedKey = epRec?.feedKey ?? prevProg?.feedKey ?? qByEp.get(current.episodeKey)?.feedKey;
      if (feedKey) {
        const isNewerThanStored =
          !prevProg ||
          current.wallMs > prevProg.updatedAt ||
          (prevProg.state !== 'PLAYED' && current.positionMs !== prevProg.positionMs);

        if (isNewerThanStored && current.positionMs > 0) {
          const stamped = stampProgressSave(
            {
              episodeKey: current.episodeKey,
              positionMs: current.positionMs,
              state: 'IN_PROGRESS',
              ...(current.durationMs !== undefined
                ? { durationMs: current.durationMs }
                : epRec?.durationMs !== undefined
                  ? { durationMs: epRec.durationMs }
                  : {}),
            },
            {
              feedKey,
              hlc,
              deviceId: st.deviceId,
              previous: prevProg,
            },
          );
          await syncStore.upsertProgress(stamped, {
            syncDirty: true,
            identity: epRec?.identity,
          });
          changedEpisodes.add(current.episodeKey);

          if (stamped.state === 'PLAYED') {
            await handleEpisodeCompletedSideEffects(current.episodeKey, feedKey, false);
          }
        }
      }
    }

    // 3. Clear native journal ONLY AFTER IDB writes have committed (`ARCHITECTURE.md §3.3`)
    await plugin.media.clearJournal({ upToWallMs: maxWallMs > 0 ? maxWallMs : Date.now() });

    for (const epKey of changedEpisodes) {
      emit({ type: 'progress-changed', episodeKey: epKey });
    }

    if (changedEpisodes.size > 0 && deps.schedulerHost.isVisible()) {
      syncScheduler.request('progress-paused');
    }
  };

  const reconcileJournal = (): Promise<void> => {
    journalChain = journalChain.then(runReconcileJournalOnce, runReconcileJournalOnce);
    return journalChain;
  };

  // Instantiate SyncEngine + SyncScheduler (`ARCHITECTURE.md §8`, `§9`)
  const instantiateSyncProvider = async (
    config: SyncProviderConfig,
  ): Promise<CloudFileProvider> => {
    switch (config.id) {
      case 'saf':
        return createSafFileProvider({
          documentUri: config.documentUri,
          plugin,
          isVisible: () => deps.schedulerHost.isVisible(),
          setIntervalFn: (fn, ms) => deps.schedulerHost.setInterval(fn, ms),
        });

      case 'drive-appdata':
      case 'drive-file': {
        if (!driveSupported) {
          throw new MiniPodError(
            'unsupported',
            'Google Drive sync is unavailable because Google Play Services is absent',
          );
        }
        const st = await syncStore.getSyncState();
        const effectiveHint = config.accountHint ?? driveAuth.getLastAuthorizedEmail();
        return new GoogleDriveProvider({
          mode: config.id === 'drive-appdata' ? 'appdata' : 'file',
          http,
          getToken: driveAuth.createTokenProvider(config.id, effectiveHint),
          initialFileId: st.remoteFileId,
          userAgent,
          ...(config.id === 'drive-file' && config.folderName
            ? { folderName: config.folderName }
            : {}),
        });
      }

      case 'webdav': {
        const password = (await secretsStore.getWebDavPassword()) ?? '';
        return new WebDavProvider({
          fileUrl: config.fileUrl,
          username: config.username,
          password,
          http,
          userAgent,
        });
      }

      case 'gist': {
        const token = (await secretsStore.getGistToken()) ?? '';
        const st = await syncStore.getSyncState();
        const initialGistId = config.gistId ?? st.remoteFileId ?? undefined;
        return new GitHubGistProvider({
          token,
          http,
          userAgent,
          ...(initialGistId ? { gistId: initialGistId } : {}),
          onGistCreated: (newGistId) => {
            void (async () => {
              const cur = await readSettings();
              if (cur.sync.provider?.id === 'gist') {
                const updated = await writeSettings({
                  sync: {
                    ...cur.sync,
                    provider: { id: 'gist', gistId: newGistId },
                  },
                });
                emit({ type: 'settings-changed', settings: updated });
              }
            })();
          },
        });
      }

      case 'local-folder':
        throw new MiniPodError(
          'unsupported',
          'Desktop local-folder sync provider is not supported on Android; use SAF instead',
        );
    }
  };

  let refreshFeedsFn: ((feedKeys: readonly FeedKey[]) => void) | null = null;
  let pushNativeQueueFn: (() => Promise<void>) | null = null;

  const syncEngine = new SyncEngine({
    store: syncStore,
    provider: null,
    hlc,
    backgroundSync: false,
    getCurrentEpisodeKey: () => currentPlayingEpisodeKey,
    onStatusChanged: (status) => {
      emit({ type: 'sync-status', status });
    },
    onDecisions: (decisions: ApplyDecisions) => {
      emit({ type: 'feeds-changed' });
      emit({ type: 'queue-changed' });
      void pushNativeQueueFn?.();
      for (const hint of decisions.resumeHints) {
        emit({
          type: 'progress-changed',
          episodeKey: hint.episodeKey,
          fromSync: {
            deviceName: hint.deviceName,
            positionMs: hint.positionMs,
            state: hint.state,
          },
        });
      }
      if (decisions.feedsToRefresh.length > 0) {
        refreshFeedsFn?.(decisions.feedsToRefresh);
      }
    },
  });

  const initialSettings = await readSettings();
  const syncScheduler = new SyncScheduler({
    engine: syncEngine,
    host: deps.schedulerHost,
    wifiOnly: initialSettings.sync.wifiOnly,
  });

  if (initialSettings.sync.provider) {
    try {
      const provider = await instantiateSyncProvider(initialSettings.sync.provider);
      syncEngine.setProvider(provider);
    } catch {
      // Provider unsupported or invalid config; leave disconnected until user reconfigures
    }
  }

  // Instantiate `NativeAudioEngine` (`ARCHITECTURE.md §3.3`)
  const engine = new NativeAudioEngine({
    plugin,
    isVisible: () => deps.schedulerHost.isVisible(),
    onNativeActivity: () => {
      if (deps.schedulerHost.isVisible()) {
        void reconcileJournal();
      }
    },
    onHiddenFlushNeeded: () => {
      void (async () => {
        try {
          await reconcileJournal();
          if (syncEngine.getProvider()) {
            await syncScheduler.requestAsync('hidden');
          }
        } finally {
          await plugin.media.ackFlush().catch(() => undefined);
        }
      })();
    },
  });

  engine.subscribe((ev) => {
    if (ev.type === 'state') {
      currentPlayingEpisodeKey = ev.snapshot.episodeKey;
      syncScheduler.updatePlayback({
        playing: ev.snapshot.playing,
        positionMs: ev.snapshot.positionMs,
        ...(ev.snapshot.episodeKey !== undefined ? { episodeKey: ev.snapshot.episodeKey } : {}),
      });
    } else if (ev.type === 'position') {
      currentPlayingEpisodeKey = ev.episodeKey;
      syncScheduler.updatePlayback({
        playing: engine.getSnapshot().playing,
        positionMs: ev.positionMs,
        episodeKey: ev.episodeKey,
      });
    } else if (ev.type === 'nativeAdvanced') {
      currentPlayingEpisodeKey = ev.to;
      void reconcileJournal().then(() => pushNativeQueueFn?.());
    } else if (ev.type === 'ended') {
      syncScheduler.updatePlayback({
        playing: false,
        positionMs: 0,
        episodeKey: ev.episodeKey,
      });
    }
  });

  // Reconcile any native journal recorded while WebView was asleep/killed BEFORE starting sync!
  await reconcileJournal();
  syncScheduler.start();
  if (syncEngine.getProvider()) {
    syncScheduler.request('foreground');
  }

  // Resolve `MediaSource` for an episode (`ARCHITECTURE.md §3` rule 2)
  const resolveMediaSourceForEpisode = async (episodeKey: EpisodeKey): Promise<MediaSource> => {
    const ep = await syncStore.getEpisodeRecord(episodeKey);
    if (!ep) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    if (ep.downloadState === 'DONE' && ep.downloadPath) {
      return {
        kind: 'file',
        path: ep.downloadPath,
        ...(ep.enclosureMime !== undefined ? { mime: ep.enclosureMime } : {}),
      };
    }
    if ((ep.feedKey.startsWith('l_') || ep.enclosureUrl?.startsWith('content://')) && ep.enclosureUrl) {
      return {
        kind: 'file',
        path: ep.enclosureUrl,
        ...(ep.enclosureMime !== undefined ? { mime: ep.enclosureMime } : {}),
      };
    }
    if (!ep.enclosureUrl) {
      throw new MiniPodError('not-found', `Episode ${episodeKey} has no playable enclosure URL`);
    }

    const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(ep.enclosureUrl);
    const storedCreds = await secretsStore.getFeedCredentials(ep.feedKey);
    const creds = inlineCreds ?? storedCreds;
    const headers: Record<string, string> = { 'User-Agent': userAgent };
    if (creds) {
      headers['Authorization'] = BasicAuth.encode(creds.username, creds.password, 'ISO-8859-1');
    }

    return {
      kind: 'url',
      url: cleanUrl,
      headers,
      ...(ep.enclosureMime !== undefined ? { mime: ep.enclosureMime } : {}),
    };
  };

  const buildRemainingQueueSources = async (): Promise<readonly QueueItemSource[]> => {
    const rows = await syncStore.listActiveQueueRows();
    if (rows.length === 0) return [];

    let startIndex = 0;
    if (currentPlayingEpisodeKey) {
      const idx = rows.findIndex((r) => r.entry.episodeKey === currentPlayingEpisodeKey);
      if (idx >= 0) {
        startIndex = idx + 1;
      }
    }

    const slice = rows.slice(startIndex);
    // Offline (Airplane Mode): only hand downloaded/local files to the native playlist. A remote
    // URL would be pre-buffered by ExoPlayer right after a local file, fail, and drop the whole
    // player (including the playing local episode) to IDLE.
    const online = deps.schedulerHost.isOnline();
    const items: QueueItemSource[] = [];
    for (const row of slice) {
      try {
        const source = await resolveMediaSourceForEpisode(row.episode.episodeKey);
        if (!online && source.kind !== 'file') continue;
        const feedRec = await syncStore.getFeedRecord(row.episode.feedKey);
        const startMs = computeResumePositionMs(row.progress);
        const artworkUrl = row.episode.imageUrl?.trim() || feedRec?.imageUrl?.trim() || undefined;
        items.push({
          episodeKey: row.episode.episodeKey,
          source,
          startMs,
          metadata: {
            title: row.episode.title,
            ...(feedRec?.author !== undefined ? { artist: feedRec.author } : {}),
            ...(feedRec?.title !== undefined ? { album: feedRec.title } : {}),
            ...(artworkUrl !== undefined ? { artworkUrl } : {}),
            ...(row.episode.durationMs !== undefined ? { durationMs: row.episode.durationMs } : {}),
          },
        });
      } catch {
        // Skip unresolvable stub without enclosure
      }
    }
    return items;
  };

  const syncNativeQueue = async (): Promise<void> => {
    if (!currentPlayingEpisodeKey && !engine.getSnapshot().episodeKey) return;
    const items = await buildRemainingQueueSources();
    engine.setQueue(items);
  };
  pushNativeQueueFn = syncNativeQueue;

  // Refresh the native playlist when connectivity changes (re-add remote items once back online).
  let removeConnectivityListeners: (() => void) | null = null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onConnectivityChanged = (): void => {
      void syncNativeQueue().catch(() => undefined);
    };
    window.addEventListener('online', onConnectivityChanged);
    window.addEventListener('offline', onConnectivityChanged);
    removeConnectivityListeners = () => {
      window.removeEventListener('online', onConnectivityChanged);
      window.removeEventListener('offline', onConnectivityChanged);
    };
  }

  // Discovery & URL Resolver (`@minipod/core`)
  const searcherRegistry = createSearcherRegistry({
    http,
    userAgent,
    ...(deps.podcastIndexKeys !== undefined ? { podcastIndexKeys: deps.podcastIndexKeys } : {}),
  });

  const topListLoader = createItunesTopListLoader({
    http,
    userAgent,
    ...(options?.defaultCountry !== undefined ? { defaultCountry: options.defaultCountry } : {}),
  });

  const urlResolver = createFeedUrlResolver({
    http,
    registry: searcherRegistry,
    userAgent,
    isSubscribed: (fk) => syncStore.isSubscribed(fk),
  });

  const previewCache = new Map<string, CachedPreviewEntry>();
  const prunePreviewCache = (): void => {
    const now = Date.now();
    for (const [id, entry] of previewCache) {
      if (entry.expiresAt <= now) previewCache.delete(id);
    }
    while (previewCache.size > MAX_CACHED_PREVIEWS) {
      const first = previewCache.keys().next().value;
      if (first === undefined) break;
      previewCache.delete(first);
    }
  };

  const cachePreviewResult = async (
    res: ResolveResult,
    credentials?: HttpBasicCredentials,
  ): Promise<ResolveResult> => {
    if (res.kind === 'feed') {
      prunePreviewCache();
      const inlineCreds = extractUrlCredentials(res.preview.url).credentials;
      const effectiveCreds = credentials ?? inlineCreds;
      if (effectiveCreds) {
        await secretsStore.setFeedCredentials(res.preview.feedKey, effectiveCreds);
      }
      const storedCreds = await secretsStore.getFeedCredentials(res.preview.feedKey);
      await syncStore.upsertParsedFeed({
        feedKey: res.preview.feedKey,
        kind: 'RSS',
        url: res.preview.url,
        subscribed: false,
        parsed: res.preview.parsed,
        nowWallMs: Date.now(),
        hasCredentials: Boolean(effectiveCreds || storedCreds),
        markSyncDirty: false,
      });
      previewCache.set(res.preview.previewId, {
        preview: res.preview,
        expiresAt: Date.now() + PREVIEW_TTL_MS,
        ...(effectiveCreds !== undefined ? { credentials: effectiveCreds } : {}),
      });
    }
    return res;
  };

  const subscribeFromPreview = async (
    preview: FeedPreview,
    credentials?: HttpBasicCredentials,
  ): Promise<Feed> => {
    const inlineCreds = extractUrlCredentials(preview.url).credentials;
    const effectiveCreds = credentials ?? inlineCreds;
    if (effectiveCreds) {
      await secretsStore.setFeedCredentials(preview.feedKey, effectiveCreds);
    }
    const storedCreds = await secretsStore.getFeedCredentials(preview.feedKey);

    const feed = await syncStore.upsertParsedFeed({
      feedKey: preview.feedKey,
      kind: 'RSS',
      url: preview.url,
      subscribed: true,
      parsed: preview.parsed,
      nowWallMs: Date.now(),
      hasCredentials: Boolean(effectiveCreds || storedCreds),
      ...(preview.permanentRedirect ? { movedTo: preview.permanentRedirect.to } : {}),
      markSyncDirty: true,
    });

    emit({ type: 'feeds-changed' });
    emit({ type: 'episodes-changed', feedKey: feed.feedKey });
    syncScheduler.request('subscriptions-changed');
    return feed;
  };

  // Feed Refresh (`RSS` + `LOCAL` SAF folder)
  const inflightRefresh = new Map<FeedKey, Promise<void>>();
  const refreshSingleFeed = async (feedKey: FeedKey, rethrow: boolean): Promise<void> => {
    const existingTask = inflightRefresh.get(feedKey);
    if (existingTask) return existingTask;

    const task = (async () => {
      const feedRec = await syncStore.getFeedRecord(feedKey);
      if (!feedRec) {
        throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
      }

      try {
        if (feedRec.kind === 'LOCAL' || feedRec.url.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
          const treeUri = feedRec.url.startsWith(LOCAL_FOLDER_URL_PREFIX)
            ? feedRec.url.slice(LOCAL_FOLDER_URL_PREFIX.length)
            : feedRec.url;
          const existingEps = await db.getAllFromIndex('episodes', 'byFeed', feedKey);
          const hints = new Map<string, ExistingSafEpisodeHint>();
          for (const ep of existingEps) {
            hints.set(ep.identity, {
              identity: ep.identity,
              episode: {
                identity: ep.identity,
                guid: ep.guid ?? ep.identity,
                title: ep.title,
                mediaType: ep.mediaType,
                ...(ep.description !== undefined ? { description: ep.description } : {}),
                ...(ep.enclosureUrl !== undefined ? { enclosureUrl: ep.enclosureUrl } : {}),
                ...(ep.enclosureMime !== undefined ? { enclosureMime: ep.enclosureMime } : {}),
                ...(ep.enclosureSize !== undefined ? { enclosureSize: ep.enclosureSize } : {}),
                ...(ep.pubDate !== undefined ? { pubDate: ep.pubDate } : {}),
                ...(ep.durationMs !== undefined ? { durationMs: ep.durationMs } : {}),
              },
              ...(ep.localMtimeMs !== undefined ? { mtimeMs: ep.localMtimeMs } : {}),
              ...(ep.enclosureSize !== undefined ? { size: ep.enclosureSize } : {}),
            });
          }

          const scanned = await scanSafLocalFolder(treeUri, plugin, {
            ...(feedRec.title !== undefined ? { displayName: feedRec.title } : {}),
            existingByIdentity: hints,
          });

          await syncStore.upsertParsedFeed({
            feedKey,
            kind: 'LOCAL',
            url: scanned.feedUrl,
            subscribed: feedRec.subscribedNum === 1,
            parsed: scanned.parsed,
            nowWallMs: Date.now(),
            localMtimeByIdentity: scanned.mtimeByIdentity,
            presentIdentities: scanned.presentIdentities,
            ...(currentPlayingEpisodeKey !== undefined
              ? { currentPlayingKey: currentPlayingEpisodeKey }
              : {}),
            ...(scanned.coverDataUrl !== undefined ? { overrideImageUrl: scanned.coverDataUrl } : {}),
            markSyncDirty: false,
          });

          emit({ type: 'episodes-changed', feedKey });
          emit({ type: 'feeds-changed' });
          emit({ type: 'feed-refreshed', feedKey });
          return;
        }

        const fetchUrl = feedRec.movedTo || feedRec.url;
        const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(fetchUrl);
        const storedCreds = await secretsStore.getFeedCredentials(feedKey);
        const creds = inlineCreds ?? storedCreds;

        const headers: Record<string, string> = {
          Accept:
            'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
          'User-Agent': userAgent,
        };
        if (feedRec.etag) headers['If-None-Match'] = feedRec.etag;
        if (feedRec.lastModified) headers['If-Modified-Since'] = feedRec.lastModified;

        const resp = await fetchWithBasicAuth(
          http,
          { url: cleanUrl, method: 'GET', headers },
          creds,
        );
        const nowMs = Date.now();

        if (resp.status === 304) {
          await syncStore.updateConditionalHeaders(feedKey, {
            etag: resp.headers['etag'],
            lastModified: resp.headers['last-modified'],
            refreshedAt: nowMs,
          });
          emit({ type: 'feed-refreshed', feedKey });
          return;
        }
        if (resp.status === 401) {
          throw new MiniPodError('auth-required', `Authentication required for ${cleanUrl}`, {
            details: { url: resp.finalUrl || cleanUrl },
          });
        }
        if (resp.status === 404 || resp.status === 410) {
          throw new MiniPodError(
            'feed-not-found',
            `Feed returned HTTP ${resp.status} at ${resp.finalUrl || cleanUrl}`,
          );
        }
        if (resp.status < 200 || resp.status >= 300) {
          throw new MiniPodError('network', `Feed refresh failed with HTTP ${resp.status}`);
        }

        const finalUrl = resp.finalUrl || cleanUrl;
        const xmlText = decodeFeedBytes(await resp.bytes(), resp.headers['content-type']);
        detectFeedType(xmlText);
        const parsed = parseFeed(xmlText, { baseUrl: finalUrl });

        let newPermUrl: string | undefined = RedirectRecorder.analyse(resp.chain)?.to;
        if (parsed.redirectUrl) {
          const candidate = prepareUrl(parsed.redirectUrl, finalUrl);
          if (candidate !== cleanUrl) newPermUrl = candidate;
        }

        let targetKey = feedKey;
        let moved = false;
        if (newPermUrl && newPermUrl !== fetchUrl) {
          const st = await syncStore.getSyncState();
          targetKey = await syncStore.recordPermanentMove(feedKey, newPermUrl, st.deviceId);
          moved = true;
        }

        await syncStore.upsertParsedFeed({
          feedKey: targetKey,
          kind: 'RSS',
          url: newPermUrl ?? fetchUrl,
          subscribed: feedRec.subscribedNum === 1,
          parsed,
          nowWallMs: nowMs,
          ...(resp.headers['etag'] !== undefined ? { etag: resp.headers['etag'] } : {}),
          ...(resp.headers['last-modified'] !== undefined
            ? { lastModified: resp.headers['last-modified'] }
            : {}),
          ...(newPermUrl !== undefined ? { movedTo: newPermUrl } : {}),
          ...(moved ? { markSyncDirty: true } : {}),
        });

        if (moved) {
          syncScheduler.request('subscriptions-changed');
        }

        emit({ type: 'episodes-changed', feedKey: targetKey });
        emit({ type: 'feeds-changed' });
        emit({ type: 'feed-refreshed', feedKey: targetKey });
      } catch (err) {
        const wrapped = MiniPodError.wrap(err, 'network');
        emit({ type: 'feed-refreshed', feedKey, error: wrapped.toShape() });
        if (rethrow) throw wrapped;
      }
    })().finally(() => {
      inflightRefresh.delete(feedKey);
    });

    inflightRefresh.set(feedKey, task);
    return task;
  };

  refreshFeedsFn = (feedKeys) => {
    for (const fk of feedKeys) {
      void refreshSingleFeed(fk, false).catch(() => undefined);
    }
  };

  // Optional background refresh timer while process is alive
  let bgRefreshUnsub: Unsubscribe | null = null;
  const configureBgRefresh = (hours: AppSettings['backgroundRefreshHours']): void => {
    if (bgRefreshUnsub) {
      bgRefreshUnsub();
      bgRefreshUnsub = null;
    }
    if (hours <= 0) return;
    bgRefreshUnsub = deps.schedulerHost.setInterval(() => {
      void host.feeds.refresh().catch(() => undefined);
    }, hours * 60 * 60_000);
  };
  configureBgRefresh(initialSettings.backgroundRefreshHours);

  // Download progress listener (coalesced <= 2/s per episode)
  const lastDownloadEmitAt = new Map<EpisodeKey, number>();
  // Episodes whose in-flight download was stopped by the user (`deleteDownload` while RUNNING/QUEUED)
  const cancelledDownloads = new Set<EpisodeKey>();
  const dlListenerHandle: PluginListenerHandle = await plugin.addListener(
    'download-progress',
    (ev) => {
      if (cancelledDownloads.has(ev.episodeKey)) return;
      const now = Date.now();
      const prev = lastDownloadEmitAt.get(ev.episodeKey) ?? 0;
      if (now - prev < DOWNLOAD_EVENT_MIN_INTERVAL_MS) return;
      lastDownloadEmitAt.set(ev.episodeKey, now);
      const progress =
        ev.totalBytes && ev.totalBytes > 0
          ? Math.min(1, Math.max(0, ev.bytesDownloaded / ev.totalBytes))
          : undefined;
      emit({
        type: 'download-updated',
        episodeKey: ev.episodeKey,
        state: 'RUNNING',
        ...(progress !== undefined ? { progress } : {}),
      });
    },
  );

  // Chapters & embedded chapter images (`data:` URLs on Android per `types.ts` line 791)
  const readLocalByteSlice = async (
    pathOrUri: string,
    start: number,
    endInclusive?: number,
  ): Promise<Uint8Array> => {
    const length =
      endInclusive !== undefined ? Math.max(0, endInclusive - start + 1) : 256 * 1024;
    if (length === 0) return new Uint8Array(0);
    if (pathOrUri.startsWith('content://')) {
      const res = await plugin.saf.readRange({ uri: pathOrUri, start, length });
      return decodeBase64(res.base64);
    }
    const res = await plugin.readLocalFileRange({ path: pathOrUri, start, length });
    return decodeBase64(res.base64);
  };

  const loadChaptersInternal = async (
    episodeKey: EpisodeKey,
    forceRefresh = false,
  ): Promise<readonly Chapter[]> => {
    const ep = await syncStore.getEpisodeRecord(episodeKey);
    if (!ep) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    const chRec = await syncStore.getChaptersRecord(episodeKey);
    if (!forceRefresh && chRec.merged) {
      return chRec.mergedChapters;
    }

    const isLocal = ep.feedKey.startsWith('l_') || Boolean(ep.enclosureUrl?.startsWith('content://'));
    const localPath =
      ep.downloadState === 'DONE' && ep.downloadPath
        ? ep.downloadPath
        : isLocal && ep.enclosureUrl
          ? ep.enclosureUrl
          : undefined;

    if (isLocal && !ep.chaptersUrl && chRec.feedChapters.length > 0 && !forceRefresh) {
      await syncStore.saveMergedChapters(episodeKey, chRec.feedChapters);
      return chRec.feedChapters;
    }

    const creds = await secretsStore.getFeedCredentials(ep.feedKey);
    const merged = await ChapterLoader.load(
      {
        downloadState: localPath ? 'DONE' : ep.downloadState,
        ...(ep.enclosureUrl !== undefined ? { enclosureUrl: ep.enclosureUrl } : {}),
        ...(ep.chaptersUrl !== undefined ? { chaptersUrl: ep.chaptersUrl } : {}),
        ...(localPath !== undefined ? { downloadPath: localPath } : {}),
      },
      {
        http,
        userAgent,
        feedChapters: chRec.feedChapters,
        readLocalRange: readLocalByteSlice,
        ...(creds !== undefined ? { credentials: creds } : {}),
      },
    );

    await syncStore.saveMergedChapters(episodeKey, merged);
    return merged;
  };

  // Deep-link & `ACTION_SEND` routing (`ARCHITECTURE.md §10`)
  const pendingOpenAddInputs: string[] = [];
  const dispatchOpenAdd = (input: string): void => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (listeners.size === 0) {
      pendingOpenAddInputs.push(trimmed);
    } else {
      emit({ type: 'open-add', input: trimmed });
    }
  };

  const handleDeepLinkPayload = async (payload: DeepLinkPayload): Promise<void> => {
    if (payload.action === 'send' && payload.text) {
      const extracted = extractActionSendInput(payload.text);
      if (extracted) dispatchOpenAdd(extracted);
      return;
    }

    if (payload.uri) {
      const uri = payload.uri.trim();
      const mime = (payload.mimeType ?? '').toLowerCase();
      const looksLikeOpml =
        uri.startsWith('content://') ||
        mime.includes('opml') ||
        /\.opml(?:\?|$)/i.test(uri);

      if (uri.startsWith('content://') && looksLikeOpml) {
        try {
          const raw = await plugin.saf.read({ uri });
          const xml = UTF8_DECODER.decode(decodeBase64(raw.base64));
          if (xml.trim()) {
            dispatchOpenAdd(xml);
            return;
          }
        } catch {
          // Fall back to passing URI directly
        }
      }
      dispatchOpenAdd(uri);
    }
  };

  const deepLinkPluginHandle = await plugin.addListener('deep-link', (payload) => {
    void handleDeepLinkPayload(payload);
  });

  const lifecycleUnsub = deps.onAppLifecycle?.({
    onForeground: () => {
      // Re-read native playback state (never clobbers a paused position with 0 when the service
      // was stopped in the background) and refresh the native queue for current connectivity.
      void engine.syncStateFromNative().catch(() => undefined);
      void reconcileJournal().then(() => {
        void syncNativeQueue().catch(() => undefined);
        if (syncEngine.getProvider()) {
          syncScheduler.request('foreground');
        }
      });
    },
    onBackground: () => {
      if (syncEngine.getProvider()) {
        syncScheduler.request('hidden');
      }
    },
    onDeepLink: (payload) => {
      void handleDeepLinkPayload(payload);
    },
  });

  // Check initial launch intent (`MainActivity` cold start from deep link / share sheet)
  try {
    const launchIntent = await plugin.getLaunchIntent();
    if (launchIntent) {
      await handleDeepLinkPayload(launchIntent);
    }
  } catch {
    // Ignore if absent
  }

  const host: PlatformHost = {
    get info(): HostInfo {
      const st = syncStore.getCachedSyncState();
      return {
        platform: 'android',
        os: deps.osLabel,
        appVersion: deps.appVersion,
        capabilities,
        deviceId: st.deviceId,
        deviceName: st.deviceName,
      };
    },

    feeds: {
      async list(): Promise<readonly Feed[]> {
        return syncStore.listSubscribedFeeds();
      },

      async get(feedKey: FeedKey): Promise<Feed> {
        return syncStore.getFeed(feedKey);
      },

      async preview(url: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        const inline = extractUrlCredentials(url).credentials;
        const res = await urlResolver.resolve(url, {
          ...(credentials !== undefined ? { credentials } : {}),
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
              ...(resolved.realm !== undefined ? { realm: resolved.realm } : {}),
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
        const st = await syncStore.getSyncState();
        const isLocal = feedKey.startsWith('l_');
        const dlPaths = await syncStore.softDeleteUnsubscribe(
          feedKey,
          st.deviceId,
          currentPlayingEpisodeKey,
        );
        for (const path of dlPaths) {
          await plugin.deleteLocalFile({ path }).catch(() => undefined);
        }
        await secretsStore.setFeedCredentials(feedKey, null);

        emit({ type: 'feeds-changed' });
        emit({ type: 'queue-changed' });
        await syncNativeQueue();
        if (!isLocal) {
          syncScheduler.request('subscriptions-changed');
        }
      },

      async refresh(feedKey?: FeedKey): Promise<void> {
        if (feedKey !== undefined) {
          await refreshSingleFeed(feedKey, true);
          return;
        }
        const subscribed = await syncStore.listSubscribedFeeds();
        const queue = [...subscribed];
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            await refreshSingleFeed(next.feedKey, false);
          }
        });
        await Promise.all(workers);
      },

      async loadOlder(feedKey: FeedKey): Promise<number> {
        const feedRec = await syncStore.getFeedRecord(feedKey);
        if (!feedRec) {
          throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
        }
        if (!feedRec.nextPageUrl) return 0;

        const storedCreds = await secretsStore.getFeedCredentials(feedKey);
        const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(feedRec.nextPageUrl);
        const resp = await fetchWithBasicAuth(
          http,
          {
            url: cleanUrl,
            method: 'GET',
            headers: {
              Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9',
              'User-Agent': userAgent,
            },
          },
          inlineCreds ?? storedCreds,
        );
        if (resp.status < 200 || resp.status >= 300) {
          throw new MiniPodError('network', `Failed to load older episodes (HTTP ${resp.status})`);
        }
        const finalUrl = resp.finalUrl || cleanUrl;
        const xmlText = decodeFeedBytes(await resp.bytes(), resp.headers['content-type']);
        detectFeedType(xmlText);
        const parsed = parseFeed(xmlText, { baseUrl: finalUrl });
        const nextUrl =
          parsed.nextPageUrl && parsed.nextPageUrl !== feedRec.nextPageUrl
            ? parsed.nextPageUrl
            : undefined;
        const added = await syncStore.appendOlderEpisodes(feedKey, parsed.episodes, nextUrl);
        if (added > 0) {
          emit({ type: 'episodes-changed', feedKey });
        }
        emit({ type: 'feeds-changed' });
        return added;
      },

      async setCredentials(
        feedKey: FeedKey,
        credentials: HttpBasicCredentials | null,
      ): Promise<void> {
        await secretsStore.setFeedCredentials(feedKey, credentials);
        await syncStore.setFeedHasCredentials(feedKey, credentials !== null);
        emit({ type: 'feeds-changed' });
        if (!feedKey.startsWith('l_')) {
          syncScheduler.request('subscriptions-changed');
        }
      },

      async addLocalFolder(folder: LocalFolderRef): Promise<Feed> {
        const scanned = await scanSafLocalFolder(folder.ref, plugin, {
          displayName: folder.displayName,
        });
        const feed = await syncStore.upsertParsedFeed({
          feedKey: scanned.feedKey,
          kind: 'LOCAL',
          url: scanned.feedUrl,
          subscribed: true,
          parsed: scanned.parsed,
          nowWallMs: Date.now(),
          localMtimeByIdentity: scanned.mtimeByIdentity,
          presentIdentities: scanned.presentIdentities,
          ...(scanned.coverDataUrl !== undefined ? { overrideImageUrl: scanned.coverDataUrl } : {}),
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
        const subscribed = await syncStore.listSubscribedFeeds();
        return Opml.write(subscribed);
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
        const subscribed = await syncStore.listSubscribedFeeds();
        return filterOutSubscribed(
          raw,
          subscribed.map((f) => f.title),
        );
      },

      async resolveUrl(input: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        const inline = extractUrlCredentials(input.trim()).credentials;
        const res = await urlResolver.resolve(input, {
          ...(credentials !== undefined ? { credentials } : {}),
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
        return syncStore.listEpisodes(feedKey, filter, cursor);
      },

      async get(episodeKey: EpisodeKey): Promise<EpisodeRow> {
        return syncStore.getEpisodeRow(episodeKey);
      },

      async download(episodeKey: EpisodeKey): Promise<void> {
        const ep = await syncStore.getEpisodeRecord(episodeKey);
        if (!ep) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        if (ep.feedKey.startsWith('l_') || ep.enclosureUrl?.startsWith('content://')) {
          return;
        }
        if (!ep.enclosureUrl) {
          throw new MiniPodError('invalid-argument', `Episode ${episodeKey} has no enclosure URL`);
        }
        if (ep.downloadState === 'DONE' && ep.downloadPath) {
          return;
        }

        const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(ep.enclosureUrl);
        const storedCreds = await secretsStore.getFeedCredentials(ep.feedKey);
        const creds = inlineCreds ?? storedCreds;
        const ext = guessDownloadExtension(cleanUrl, ep.enclosureMime);
        const destPath = `downloads/${episodeKey}.${ext}`;

        cancelledDownloads.delete(episodeKey);
        await syncStore.setEpisodeDownloadState(episodeKey, 'QUEUED');
        emit({ type: 'download-updated', episodeKey, state: 'QUEUED' });

        const settleCancelled = async (): Promise<void> => {
          await syncStore.setEpisodeDownloadState(episodeKey, 'NONE');
          emit({ type: 'download-updated', episodeKey, state: 'NONE' });
        };

        try {
          const res = await plugin.httpToFile({
            episodeKey,
            url: cleanUrl,
            destPath,
            headers: { 'User-Agent': userAgent },
            ...(creds !== undefined ? { auth: creds } : {}),
          });
          if (cancelledDownloads.has(episodeKey)) {
            // User stopped the download right as it finished: discard the file and stay `NONE`.
            await plugin.deleteLocalFile({ path: res.path }).catch(() => undefined);
            await settleCancelled();
            return;
          }
          await syncStore.setEpisodeDownloadState(episodeKey, 'DONE', res.path);
          emit({ type: 'download-updated', episodeKey, state: 'DONE', progress: 1 });
          emit({ type: 'episodes-changed', feedKey: ep.feedKey });
          await syncNativeQueue();
        } catch (err) {
          const wrapped = MiniPodError.wrap(err, 'network');
          if (cancelledDownloads.has(episodeKey) || wrapped.code === 'cancelled') {
            await settleCancelled();
            return;
          }
          await syncStore.setEpisodeDownloadState(episodeKey, 'FAILED');
          emit({
            type: 'download-updated',
            episodeKey,
            state: 'FAILED',
            error: wrapped.toShape(),
          });
          throw wrapped;
        } finally {
          lastDownloadEmitAt.delete(episodeKey);
        }
      },

      async deleteDownload(episodeKey: EpisodeKey): Promise<void> {
        const ep = await syncStore.getEpisodeRecord(episodeKey);
        if (!ep) return;
        // Mark first so a racing `httpToFile` resolution/rejection settles to `NONE` (never `FAILED`).
        cancelledDownloads.add(episodeKey);
        await plugin.cancelDownload({ episodeKey }).catch(() => undefined);
        if (ep.downloadPath) {
          await plugin.deleteLocalFile({ path: ep.downloadPath }).catch(() => undefined);
        }
        if (
          ep.enclosureUrl &&
          !ep.feedKey.startsWith('l_') &&
          !ep.enclosureUrl.startsWith('content://')
        ) {
          // In-flight downloads have no `downloadPath` yet: remove the deterministic target + `.part`.
          const { cleanUrl } = extractUrlCredentials(ep.enclosureUrl);
          const ext = guessDownloadExtension(cleanUrl, ep.enclosureMime);
          const deterministic = `downloads/${episodeKey}.${ext}`;
          await plugin.deleteLocalFile({ path: deterministic }).catch(() => undefined);
          await plugin.deleteLocalFile({ path: `${deterministic}.part` }).catch(() => undefined);
        }
        await syncStore.setEpisodeDownloadState(episodeKey, 'NONE');
        emit({ type: 'download-updated', episodeKey, state: 'NONE' });
        emit({ type: 'episodes-changed', feedKey: ep.feedKey });
        await syncNativeQueue();
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
          const ep = await syncStore.getEpisodeRecord(episodeKey);
          if (!ep) return ch.imageUrl;
          const { offset, length, mime } = ch.embeddedImage;
          if (length <= 0) return ch.imageUrl;

          const isLocal =
            ep.feedKey.startsWith('l_') || Boolean(ep.enclosureUrl?.startsWith('content://'));
          const localPath =
            ep.downloadState === 'DONE' && ep.downloadPath
              ? ep.downloadPath
              : isLocal && ep.enclosureUrl
                ? ep.enclosureUrl
                : undefined;

          try {
            if (localPath) {
              const slice = await readLocalByteSlice(localPath, offset, offset + length - 1);
              return `data:${mime || 'image/jpeg'};base64,${encodeBase64(slice)}`;
            }
            if (ep.enclosureUrl) {
              const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(ep.enclosureUrl);
              const creds = inlineCreds ?? (await secretsStore.getFeedCredentials(ep.feedKey));
              const resp = await fetchWithBasicAuth(
                http,
                {
                  url: cleanUrl,
                  method: 'GET',
                  range: { start: offset, end: offset + length - 1 },
                  headers: { 'User-Agent': userAgent },
                },
                creds,
              );
              if (resp.status === 206 || resp.status === 200) {
                const body = await resp.bytes();
                const slice =
                  resp.status === 200 ? body.subarray(offset, offset + length) : body;
                return `data:${mime || 'image/jpeg'};base64,${encodeBase64(slice)}`;
              }
            }
          } catch {
            return ch.imageUrl;
          }
        }
        return ch.imageUrl;
      },

      async share(episodeKey: EpisodeKey): Promise<{ readonly url: string; readonly title: string }> {
        const ep = await syncStore.getEpisodeRecord(episodeKey);
        if (!ep) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        const feed = await syncStore.getFeedRecord(ep.feedKey);
        const shareUrl =
          ep.link ||
          (ep.enclosureUrl && /^https?:\/\//i.test(ep.enclosureUrl)
            ? ep.enclosureUrl
            : undefined) ||
          feed?.link ||
          (feed?.url && !feed.url.startsWith(LOCAL_FOLDER_URL_PREFIX) ? feed.url : '');
        return { url: shareUrl, title: ep.title };
      },
    },

    queue: {
      async list(): Promise<readonly QueueRow[]> {
        const [all, st] = await Promise.all([
          syncStore.listAllQueueEntries(),
          syncStore.getSyncState(),
        ]);
        const rebalanced = rebalanceQueueIfNeeded(all, { hlc, deviceId: st.deviceId });
        if (rebalanced.length > 0) {
          await syncStore.upsertQueueEntries(rebalanced, true);
          syncScheduler.request('queue-changed');
        }
        return syncStore.listActiveQueueRows();
      },

      async add(episodeKey: EpisodeKey): Promise<void> {
        const epRow = await syncStore.getEpisodeRow(episodeKey);
        const feed = await syncStore.getFeed(epRow.episode.feedKey);
        const st = await syncStore.getSyncState();
        const isLocal = feed.kind === 'LOCAL';
        const stub = isLocal ? undefined : buildQueueStub(epRow.episode, feed);
        const mutated = queueAdd(
          await syncStore.listAllQueueEntries(),
          {
            episodeKey,
            feedKey: feed.feedKey,
            ...(stub !== undefined ? { stub } : {}),
          },
          { hlc, deviceId: st.deviceId },
        );
        if (mutated.length > 0) {
          await syncStore.upsertQueueEntries(mutated, !isLocal);
          emit({ type: 'queue-changed' });
          await syncNativeQueue();
          if (!isLocal) syncScheduler.request('queue-changed');
        }
      },

      async playNext(episodeKey: EpisodeKey): Promise<void> {
        const epRow = await syncStore.getEpisodeRow(episodeKey);
        const feed = await syncStore.getFeed(epRow.episode.feedKey);
        const st = await syncStore.getSyncState();
        const isLocal = feed.kind === 'LOCAL';
        const stub = isLocal ? undefined : buildQueueStub(epRow.episode, feed);
        const mutated = queuePlayNext(
          await syncStore.listAllQueueEntries(),
          {
            episodeKey,
            feedKey: feed.feedKey,
            ...(stub !== undefined ? { stub } : {}),
          },
          { hlc, deviceId: st.deviceId },
          currentPlayingEpisodeKey,
        );
        if (mutated.length > 0) {
          await syncStore.upsertQueueEntries(mutated, !isLocal);
          emit({ type: 'queue-changed' });
          await syncNativeQueue();
          if (!isLocal) syncScheduler.request('queue-changed');
        }
      },

      async move(episodeKey: EpisodeKey, beforeKey: EpisodeKey | null): Promise<void> {
        const st = await syncStore.getSyncState();
        const mutated = queueMove(
          await syncStore.listAllQueueEntries(),
          episodeKey,
          beforeKey,
          { hlc, deviceId: st.deviceId },
        );
        if (mutated.length > 0) {
          await syncStore.upsertQueueEntries(mutated, true);
          emit({ type: 'queue-changed' });
          await syncNativeQueue();
          if (mutated.some((m) => !m.feedKey.startsWith('l_'))) {
            syncScheduler.request('queue-changed');
          }
        }
      },

      async remove(episodeKey: EpisodeKey): Promise<void> {
        const st = await syncStore.getSyncState();
        const removed = queueRemove(await syncStore.listAllQueueEntries(), episodeKey, {
          hlc,
          deviceId: st.deviceId,
        });
        if (removed) {
          const isLocal = removed.feedKey.startsWith('l_');
          await syncStore.upsertQueueEntries([removed], !isLocal);
          emit({ type: 'queue-changed' });
          await syncNativeQueue();
          if (!isLocal) {
            syncScheduler.request('queue-changed');
          }
        }
      },

      async clear(): Promise<void> {
        const st = await syncStore.getSyncState();
        const mutated = queueClear(await syncStore.listAllQueueEntries(), {
          hlc,
          deviceId: st.deviceId,
        });
        if (mutated.length > 0) {
          await syncStore.upsertQueueEntries(mutated, true);
          emit({ type: 'queue-changed' });
          await syncNativeQueue();
          if (mutated.some((m) => !m.feedKey.startsWith('l_'))) {
            syncScheduler.request('queue-changed');
          }
        }
      },
    },

    progress: {
      async get(episodeKey: EpisodeKey): Promise<ProgressRecord | undefined> {
        return syncStore.getProgress(episodeKey);
      },

      async save(save: ProgressSave): Promise<void> {
        const [epRec, prevProg, st] = await Promise.all([
          syncStore.getEpisodeRecord(save.episodeKey),
          syncStore.getProgress(save.episodeKey),
          syncStore.getSyncState(),
        ]);
        const feedKey = epRec?.feedKey ?? prevProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError(
            'not-found',
            `Cannot save progress for unknown episode: ${save.episodeKey}`,
          );
        }

        const stamped = stampProgressSave(save, {
          feedKey,
          hlc,
          deviceId: st.deviceId,
          previous: prevProg,
          ended: save.state === 'PLAYED',
        });

        await syncStore.upsertProgress(stamped, {
          syncDirty: true,
          identity: epRec?.identity,
        });

        if (stamped.state === 'PLAYED' && prevProg?.state !== 'PLAYED') {
          await handleEpisodeCompletedSideEffects(save.episodeKey, feedKey, true);
          await syncNativeQueue();
        }

        if (!feedKey.startsWith('l_')) {
          if (save.flush) {
            if (syncEngine.getProvider()) {
              await syncScheduler.requestAsync('hidden');
            }
          } else if (stamped.state === 'PLAYED') {
            syncScheduler.request('progress-completed');
          } else if (!engine.getSnapshot().playing) {
            syncScheduler.request('progress-paused');
          }
        }
      },

      async markPlayed(episodeKey: EpisodeKey, played: boolean): Promise<void> {
        const [epRec, prevProg, st] = await Promise.all([
          syncStore.getEpisodeRecord(episodeKey),
          syncStore.getProgress(episodeKey),
          syncStore.getSyncState(),
        ]);
        const feedKey = epRec?.feedKey ?? prevProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }

        const stamped = stampMarkPlayed({
          episodeKey,
          feedKey,
          played,
          hlc,
          deviceId: st.deviceId,
          previous: prevProg,
          durationMs: epRec?.durationMs ?? prevProg?.durationMs,
        });

        await syncStore.upsertProgress(stamped, {
          syncDirty: true,
          identity: epRec?.identity,
        });

        if (played) {
          await handleEpisodeCompletedSideEffects(episodeKey, feedKey, false);
          await syncNativeQueue();
        }

        emit({ type: 'progress-changed', episodeKey });
        if (!feedKey.startsWith('l_')) {
          syncScheduler.request('progress-marked');
        }
      },
    },

    playback: {
      async sourceFor(episodeKey: EpisodeKey): Promise<MediaSource> {
        currentPlayingEpisodeKey = episodeKey;
        const source = await resolveMediaSourceForEpisode(episodeKey);
        void syncNativeQueue();
        return source;
      },

      async queueSources(): Promise<readonly QueueItemSource[]> {
        return buildRemainingQueueSources();
      },
    },

    sync: {
      async status(): Promise<SyncStatus> {
        return syncEngine.getStatus();
      },

      async configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus> {
        if (secret) {
          await secretsStore.saveSyncSecret(secret);
        }

        const effectiveSettings: SyncSettings =
          (settings.provider?.id === 'drive-appdata' || settings.provider?.id === 'drive-file') &&
          driveAuth.getSafFallbackUri()
            ? {
                ...settings,
                provider: { id: 'saf', documentUri: driveAuth.consumeSafFallbackUri()! },
              }
            : (settings.provider?.id === 'drive-appdata' ||
                  settings.provider?.id === 'drive-file') &&
                !settings.provider.accountHint &&
                driveAuth.getLastAuthorizedEmail()
              ? {
                  ...settings,
                  provider: {
                    ...settings.provider,
                    accountHint: driveAuth.getLastAuthorizedEmail()!,
                  },
                }
              : settings;

        const prevSettings = await readSettings();
        const providerChanged =
          JSON.stringify(prevSettings.sync.provider) !== JSON.stringify(effectiveSettings.provider);

        if (providerChanged && effectiveSettings.provider !== null) {
          await syncStore.markAllDirty();
        }

        await syncStore.setSyncState({
          deviceName: effectiveSettings.deviceName,
          ...(providerChanged
            ? {
                remoteEtag: null,
                remoteFileId: null,
                remoteRev: 0,
                floors: { subscriptions: 0, queue: 0, progress: 0 },
              }
            : {}),
        });

        if (!effectiveSettings.provider) {
          syncEngine.setProvider(null);
          const updated = await writeSettings({ sync: effectiveSettings });
          syncScheduler.setWifiOnly(updated.sync.wifiOnly);
          syncScheduler.rebindProviderWatcher();
          emit({ type: 'settings-changed', settings: updated });
          const status = await syncEngine.getStatus();
          emit({ type: 'sync-status', status });
          return status;
        }

        const candidate = await instantiateSyncProvider(effectiveSettings.provider);
        const probe = await candidate.probe();
        if (!probe.ok) {
          throw probe.error
            ? MiniPodError.fromShape(probe.error)
            : new MiniPodError('sync-auth', 'Sync provider probe failed');
        }

        const updated = await writeSettings({ sync: effectiveSettings });
        syncScheduler.setWifiOnly(updated.sync.wifiOnly);
        syncEngine.setProvider(candidate);
        syncScheduler.rebindProviderWatcher();
        emit({ type: 'settings-changed', settings: updated });

        const res = await syncScheduler.requestAsync('configured');
        return res ? res.status : syncEngine.getStatus();
      },

      async authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void> {
        const cur = await readSettings();
        const hint =
          cur.sync.provider?.id === provider ? cur.sync.provider.accountHint : undefined;
        await driveAuth.authorizeInteractive(provider, hint);
      },

      async syncNow(): Promise<SyncStatus> {
        if (!syncEngine.getProvider()) {
          return syncEngine.getStatus();
        }
        const res = await syncScheduler.requestAsync('manual');
        return res ? res.status : syncEngine.getStatus();
      },

      async disconnect(): Promise<void> {
        const cur = await readSettings();
        syncEngine.setProvider(null);
        syncScheduler.rebindProviderWatcher();
        await secretsStore.clearSyncSecrets();
        driveAuth.clearCache();

        await syncStore.setSyncState({
          remoteEtag: null,
          remoteFileId: null,
          remoteRev: 0,
          lastError: undefined,
          backoffUntil: 0,
        } as unknown as Partial<import('@minipod/core').SyncState>);

        const updated = await writeSettings({
          sync: {
            ...cur.sync,
            provider: null,
          },
        });
        emit({ type: 'settings-changed', settings: updated });
        const status = await syncEngine.getStatus();
        emit({ type: 'sync-status', status });
      },

      async resetRemote(): Promise<void> {
        await syncEngine.resetRemote();
      },

      async undoResume(episodeKey: EpisodeKey, positionMs: number): Promise<void> {
        const [epRec, prevProg, st] = await Promise.all([
          syncStore.getEpisodeRecord(episodeKey),
          syncStore.getProgress(episodeKey),
          syncStore.getSyncState(),
        ]);
        const feedKey = epRec?.feedKey ?? prevProg?.feedKey;
        if (!feedKey) {
          throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
        }
        const stamped = stampUndoResume({
          episodeKey,
          feedKey,
          positionMs,
          hlc,
          deviceId: st.deviceId,
          previous: prevProg,
          durationMs: epRec?.durationMs ?? prevProg?.durationMs,
        });
        await syncStore.upsertProgress(stamped, {
          syncDirty: true,
          identity: epRec?.identity,
        });
        emit({ type: 'progress-changed', episodeKey });
        if (!feedKey.startsWith('l_')) {
          syncScheduler.request('progress-marked');
        }
      },
    },

    files: {
      async pickSyncFile(
        mode: 'open' | 'create',
      ): Promise<{ readonly documentUri: string; readonly displayName: string } | undefined> {
        const picked = await plugin.saf.pick({
          mode,
          mime: 'application/json',
          suggestedName: 'minipod-sync-v1.json',
        });
        if (!picked) return undefined;
        return {
          documentUri: picked.uri,
          displayName: picked.displayName,
        };
      },

      async pickFolder(): Promise<LocalFolderRef | undefined> {
        const picked = await plugin.saf.pick({ mode: 'tree' });
        if (!picked) return undefined;
        return {
          ref: picked.uri,
          displayName: picked.displayName,
        };
      },

      async saveTextFile(name: string, text: string, mime: string): Promise<void> {
        const picked = await plugin.saf.pick({
          mode: 'create',
          mime,
          suggestedName: name,
        });
        if (!picked) return;
        await plugin.saf.write({
          uri: picked.uri,
          base64: encodeBase64(UTF8_ENCODER.encode(text)),
        });
      },

      async openExternal(url: string): Promise<void> {
        await plugin.openExternal({ url });
      },
    },

    settings: {
      async get(): Promise<AppSettings> {
        return readSettings();
      },

      async update(patch: Partial<AppSettings>): Promise<AppSettings> {
        const updated = await writeSettings(patch);
        if (patch.sync?.deviceName !== undefined) {
          await syncStore.setSyncState({ deviceName: updated.sync.deviceName });
        }
        if (patch.sync?.wifiOnly !== undefined) {
          syncScheduler.setWifiOnly(updated.sync.wifiOnly);
        }
        if (patch.backgroundRefreshHours !== undefined) {
          configureBgRefresh(updated.backgroundRefreshHours);
        }
        emit({ type: 'settings-changed', settings: updated });
        return updated;
      },
    },

    updater: {
      async check(opts) {
        const currentVersion = opts?.currentVersion ?? deps.appVersion;
        const release = await fetchLatestRelease(async (url, init) => {
          const res = await http({
            url,
            method: 'GET',
            ...(init?.headers ? { headers: init.headers } : {}),
            ...(init?.signal ? { signal: init.signal } : {}),
          });
          const text = await res.text();
          return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            json: async () => JSON.parse(text) as unknown,
            text: async () => text,
          };
        });
        return {
          currentVersion,
          updateAvailable: compareSemver(release.version, currentVersion) > 0,
          release,
          checkedAt: Date.now(),
        };
      },

      async apply(opts) {
        const checkRes = await this.check();
        const release = checkRes.release;
        if (!release || (!checkRes.updateAvailable && !opts?.force)) {
          return {
            ok: true,
            method: 'up-to-date',
            previousVersion: deps.appVersion,
            targetVersion: deps.appVersion,
            message: `MiniPod v${deps.appVersion} is already up to date.`,
          };
        }
        if (deps.plugin.downloadAndInstallApk && release.apkUrl) {
          const res = await deps.plugin.downloadAndInstallApk({
            url: release.apkUrl,
            version: release.version,
          });
          return {
            ok: true,
            method: 'android-apk',
            previousVersion: deps.appVersion,
            targetVersion: release.version,
            bundlePath: res.filePath,
            ...(res.needsPermission !== undefined ? { needsPermission: res.needsPermission } : {}),
            message: res.needsPermission
              ? 'Allow installing unknown apps in Android Settings to finish updating.'
              : `Launching Android package installer for v${release.version}.`,
          };
        }
        await deps.plugin.openExternal({ url: release.apkUrl ?? release.htmlUrl });
        return {
          ok: true,
          method: 'external',
          previousVersion: deps.appVersion,
          targetVersion: release.version,
          message: `Opened v${release.version} release page.`,
        };
      },
    },

    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      listeners.add(listener);
      if (pendingOpenAddInputs.length > 0) {
        const queued = pendingOpenAddInputs.splice(0, pendingOpenAddInputs.length);
        queueMicrotask(() => {
          for (const input of queued) {
            try {
              listener({ type: 'open-add', input });
            } catch {
              // ignore
            }
          }
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      bgRefreshUnsub?.();
      lifecycleUnsub?.();
      removeConnectivityListeners?.();
      syncScheduler.dispose();
      engine.dispose();
      await Promise.all([
        dlListenerHandle.remove().catch(() => undefined),
        deepLinkPluginHandle.remove().catch(() => undefined),
      ]);
      db.close();
      listeners.clear();
    },
  };

  return {
    host,
    engine,
    db,
    syncStore,
    syncEngine,
    syncScheduler,
    reconcileJournal,
    emit,
  };
}
