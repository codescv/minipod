/**
 * Browser `PlatformHost` client speaking REST + SSE (`/api/*`, `/media/*`, `/api/events`)
 * to the `@minipod/host-node` loopback server (`ARCHITECTURE.md §3.2`).
 */
import type {
  AppSettings,
  Chapter,
  CountryCode,
  EpisodeFilter,
  EpisodeKey,
  EpisodeRow,
  Feed,
  FeedKey,
  HostCapabilities,
  HostEvent,
  HostInfo,
  HttpBasicCredentials,
  LocalFolderRef,
  MediaSource,
  MiniPodErrorShape,
  OpmlCandidate,
  Page,
  PlatformHost,
  ProgressRecord,
  ProgressSave,
  QueueItemSource,
  QueueRow,
  ResolveResult,
  SearchResult,
  SourceId,
  SyncProviderSecret,
  SyncSettings,
  SyncStatus,
  Unsubscribe,
} from '@minipod/core';
import { ROUTES } from '../shared/routes';
import { HostEventStream } from './events';
import { RestJsonClient, type RestClientConfig } from './http';

const FALLBACK_CAPABILITIES: HostCapabilities = {
  nativeAudio: false,
  downloads: true,
  localFolderFeeds: true,
  syncProviders: ['local-folder', 'drive-appdata', 'drive-file', 'webdav', 'gist'],
  filePicker: false,
  folderPicker: false,
  backgroundSync: true,
  openExternal: true,
};

export interface CreateRestPlatformHostOptions extends RestClientConfig {
  readonly initialInfo?: HostInfo;
  readonly enableSse?: boolean;
}

function prefixMediaUrl(baseUrl: string, maybeRelativeUrl: string): string {
  if (!baseUrl || !maybeRelativeUrl.startsWith('/')) {
    return maybeRelativeUrl;
  }
  return `${baseUrl}${maybeRelativeUrl}`;
}

export function createRestPlatformHost(options?: CreateRestPlatformHostOptions): PlatformHost {
  const client = new RestJsonClient(options);
  const events = new HostEventStream({
    url: client.resolveUrl('/api/events'),
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  let currentInfo: HostInfo = options?.initialInfo ?? {
    platform: 'desktop',
    os: 'desktop',
    appVersion: '0.1.0',
    capabilities: FALLBACK_CAPABILITIES,
    deviceId: 'd_00000000000000000000000000000000',
    deviceName: 'MiniPod Desktop',
  };

  if (!options?.initialInfo) {
    void client
      .request<HostInfo>(ROUTES.info.method, ROUTES.info.path)
      .then((fetched) => {
        currentInfo = fetched;
      })
      .catch(() => undefined);
  }

  const host: PlatformHost = {
    get info(): HostInfo {
      return currentInfo;
    },

    feeds: {
      list(): Promise<readonly Feed[]> {
        return client.request(ROUTES.feedsList.method, ROUTES.feedsList.path);
      },

      get(feedKey: FeedKey): Promise<Feed> {
        return client.request(
          ROUTES.feedsGet.method,
          `/api/feeds/${encodeURIComponent(feedKey)}`,
        );
      },

      preview(url: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        return client.request(ROUTES.feedsPreview.method, ROUTES.feedsPreview.path, {
          body: {
            url,
            ...(credentials ? { credentials } : {}),
          },
        });
      },

      subscribe(previewIdOrUrl: string): Promise<Feed> {
        return client.request(ROUTES.feedsSubscribe.method, ROUTES.feedsSubscribe.path, {
          body: { previewIdOrUrl },
        });
      },

      async unsubscribe(feedKey: FeedKey): Promise<void> {
        await client.request(
          ROUTES.feedsUnsubscribe.method,
          `/api/feeds/${encodeURIComponent(feedKey)}`,
        );
      },

      async refresh(feedKey?: FeedKey): Promise<void> {
        await client.request(ROUTES.feedsRefresh.method, ROUTES.feedsRefresh.path, {
          body: feedKey !== undefined ? { feedKey } : {},
        });
      },

      async loadOlder(feedKey: FeedKey): Promise<number> {
        const res = await client.request<{ readonly added: number }>(
          ROUTES.feedsLoadOlder.method,
          `/api/feeds/${encodeURIComponent(feedKey)}/load-older`,
          { body: {} },
        );
        return res.added;
      },

      async setCredentials(
        feedKey: FeedKey,
        credentials: HttpBasicCredentials | null,
      ): Promise<void> {
        await client.request(
          ROUTES.feedsSetCredentials.method,
          `/api/feeds/${encodeURIComponent(feedKey)}/credentials`,
          { body: { credentials } },
        );
      },

      addLocalFolder(folder: LocalFolderRef): Promise<Feed> {
        return client.request(ROUTES.feedsLocalFolder.method, ROUTES.feedsLocalFolder.path, {
          body: { folder },
        });
      },

      importOpml(xml: string): Promise<readonly OpmlCandidate[]> {
        return client.request(ROUTES.feedsOpmlImport.method, ROUTES.feedsOpmlImport.path, {
          rawXmlBody: xml,
        });
      },

      subscribeMany(urls: readonly string[]): Promise<{
        readonly added: number;
        readonly failed: readonly { url: string; error: MiniPodErrorShape }[];
      }> {
        return client.request(ROUTES.feedsSubscribeMany.method, ROUTES.feedsSubscribeMany.path, {
          body: { urls },
        });
      },

      async exportOpml(): Promise<string> {
        const res = await client.request<{ readonly xml: string }>(
          ROUTES.feedsOpmlExport.method,
          ROUTES.feedsOpmlExport.path,
        );
        return res.xml;
      },
    },

    search: {
      sources() {
        return client.request(ROUTES.searchSources.method, ROUTES.searchSources.path);
      },

      query(text: string, source?: SourceId, signal?: AbortSignal): Promise<readonly SearchResult[]> {
        return client.request(ROUTES.searchQuery.method, ROUTES.searchQuery.path, {
          query: {
            text,
            ...(source ? { source } : {}),
          },
          ...(signal ? { signal } : {}),
        });
      },

      topCharts(country: CountryCode, signal?: AbortSignal): Promise<readonly SearchResult[]> {
        return client.request(ROUTES.searchTopCharts.method, ROUTES.searchTopCharts.path, {
          query: { country },
          ...(signal ? { signal } : {}),
        });
      },

      resolveUrl(input: string, credentials?: HttpBasicCredentials): Promise<ResolveResult> {
        return client.request(ROUTES.searchResolveUrl.method, ROUTES.searchResolveUrl.path, {
          body: {
            input,
            ...(credentials ? { credentials } : {}),
          },
        });
      },

      countries() {
        return client.request(ROUTES.searchCountries.method, ROUTES.searchCountries.path);
      },
    },

    episodes: {
      list(feedKey: FeedKey, filter: EpisodeFilter, cursor?: string): Promise<Page<EpisodeRow>> {
        return client.request(ROUTES.episodesList.method, ROUTES.episodesList.path, {
          query: {
            feedKey,
            filter,
            ...(cursor ? { cursor } : {}),
          },
        });
      },

      get(episodeKey: EpisodeKey): Promise<EpisodeRow> {
        return client.request(
          ROUTES.episodesGet.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}`,
        );
      },

      async download(episodeKey: EpisodeKey): Promise<void> {
        await client.request(
          ROUTES.episodesDownload.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}/download`,
          { body: {} },
        );
      },

      async deleteDownload(episodeKey: EpisodeKey): Promise<void> {
        await client.request(
          ROUTES.episodesDeleteDownload.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}/download`,
        );
      },

      chapters(episodeKey: EpisodeKey, forceRefresh?: boolean): Promise<readonly Chapter[]> {
        return client.request(
          ROUTES.episodesChapters.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}/chapters`,
          forceRefresh ? { query: { forceRefresh: 1 } } : undefined,
        );
      },

      async chapterImage(
        episodeKey: EpisodeKey,
        chapterIndex: number,
      ): Promise<string | undefined> {
        const res = await client.request<{ readonly url: string | null }>(
          ROUTES.episodesChapterImageMeta.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}/chapters/${chapterIndex}/image-url`,
        );
        return res.url ? prefixMediaUrl(client.baseUrl, res.url) : undefined;
      },

      share(episodeKey: EpisodeKey): Promise<{ readonly url: string; readonly title: string }> {
        return client.request(
          ROUTES.episodesShare.method,
          `/api/episodes/${encodeURIComponent(episodeKey)}/share`,
        );
      },
    },

    queue: {
      list(): Promise<readonly QueueRow[]> {
        return client.request(ROUTES.queueList.method, ROUTES.queueList.path);
      },

      async add(episodeKey: EpisodeKey): Promise<void> {
        await client.request(ROUTES.queueAdd.method, ROUTES.queueAdd.path, {
          body: { episodeKey },
        });
      },

      async playNext(episodeKey: EpisodeKey): Promise<void> {
        await client.request(ROUTES.queuePlayNext.method, ROUTES.queuePlayNext.path, {
          body: { episodeKey },
        });
      },

      async move(episodeKey: EpisodeKey, beforeKey: EpisodeKey | null): Promise<void> {
        await client.request(ROUTES.queueMove.method, ROUTES.queueMove.path, {
          body: { episodeKey, beforeKey },
        });
      },

      async remove(episodeKey: EpisodeKey): Promise<void> {
        await client.request(
          ROUTES.queueRemove.method,
          `/api/queue/${encodeURIComponent(episodeKey)}`,
        );
      },

      async clear(): Promise<void> {
        await client.request(ROUTES.queueClear.method, ROUTES.queueClear.path, { body: {} });
      },
    },

    progress: {
      async get(episodeKey: EpisodeKey): Promise<ProgressRecord | undefined> {
        const res = await client.request<{ readonly record: ProgressRecord | null }>(
          ROUTES.progressGet.method,
          `/api/progress/${encodeURIComponent(episodeKey)}`,
        );
        return res.record ?? undefined;
      },

      async save(save: ProgressSave): Promise<void> {
        await client.request(ROUTES.progressSave.method, ROUTES.progressSave.path, {
          body: save,
          ...(save.flush ? { keepalive: true } : {}),
        });
      },

      async markPlayed(episodeKey: EpisodeKey, played: boolean): Promise<void> {
        await client.request(ROUTES.progressMarkPlayed.method, ROUTES.progressMarkPlayed.path, {
          body: { episodeKey, played },
        });
      },
    },

    playback: {
      async sourceFor(episodeKey: EpisodeKey): Promise<MediaSource> {
        const src = await client.request<MediaSource>(
          ROUTES.playbackSource.method,
          `/api/playback/source/${encodeURIComponent(episodeKey)}`,
        );
        if (src.kind === 'url') {
          return {
            ...src,
            url: prefixMediaUrl(client.baseUrl, src.url),
          };
        }
        return src;
      },

      async queueSources(): Promise<readonly QueueItemSource[]> {
        const list = await client.request<readonly QueueItemSource[]>(
          ROUTES.playbackQueueSources.method,
          ROUTES.playbackQueueSources.path,
        );
        return list.map((item) => ({
          ...item,
          source:
            item.source.kind === 'url'
              ? { ...item.source, url: prefixMediaUrl(client.baseUrl, item.source.url) }
              : item.source,
        }));
      },
    },

    sync: {
      status(): Promise<SyncStatus> {
        return client.request(ROUTES.syncStatus.method, ROUTES.syncStatus.path);
      },

      configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus> {
        return client.request(ROUTES.syncConfigure.method, ROUTES.syncConfigure.path, {
          body: {
            settings,
            ...(secret ? { secret } : {}),
          },
        });
      },

      async authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void> {
        await client.request(ROUTES.syncAuthorize.method, ROUTES.syncAuthorize.path, {
          body: { provider },
        });
      },

      syncNow(): Promise<SyncStatus> {
        return client.request(ROUTES.syncNow.method, ROUTES.syncNow.path, { body: {} });
      },

      async disconnect(): Promise<void> {
        await client.request(ROUTES.syncDisconnect.method, ROUTES.syncDisconnect.path, {
          body: {},
        });
      },

      async resetRemote(): Promise<void> {
        await client.request(ROUTES.syncResetRemote.method, ROUTES.syncResetRemote.path, {
          body: {},
        });
      },

      async undoResume(episodeKey: EpisodeKey, positionMs: number): Promise<void> {
        await client.request(ROUTES.syncUndoResume.method, ROUTES.syncUndoResume.path, {
          body: { episodeKey, positionMs },
        });
      },
    },

    files: {
      listDirectory(path?: string) {
        return client.request(
          ROUTES.filesListDirectory.method,
          ROUTES.filesListDirectory.path,
          path !== undefined ? { query: { path } } : undefined,
        );
      },

      async saveTextFile(name: string, text: string, mime: string): Promise<void> {
        if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const blob = new Blob([text], { type: mime });
          const blobUrl = URL.createObjectURL(blob);
          try {
            const anchor = document.createElement('a');
            anchor.href = blobUrl;
            anchor.download = name;
            anchor.style.display = 'none';
            document.body?.appendChild(anchor);
            anchor.click();
            anchor.remove();
          } finally {
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
          }
        }
      },

      async openExternal(url: string): Promise<void> {
        await client.request(ROUTES.filesOpenExternal.method, ROUTES.filesOpenExternal.path, {
          body: { url },
        });
      },
    },

    settings: {
      get(): Promise<AppSettings> {
        return client.request(ROUTES.settingsGet.method, ROUTES.settingsGet.path);
      },

      update(patch: Partial<AppSettings>): Promise<AppSettings> {
        const p = client.request<AppSettings>(ROUTES.settingsUpdate.method, ROUTES.settingsUpdate.path, {
          body: patch,
        });
        void p.then((updated) => {
          if (updated.sync.deviceName !== currentInfo.deviceName) {
            currentInfo = { ...currentInfo, deviceName: updated.sync.deviceName };
          }
        }).catch(() => undefined);
        return p;
      },
    },

    updater: {
      check(opts) {
        return client.request(ROUTES.updateCheck.method, ROUTES.updateCheck.path, {
          body: opts?.currentVersion ? { currentVersion: opts.currentVersion } : {},
        });
      },

      apply(opts) {
        return client.request(ROUTES.updateApply.method, ROUTES.updateApply.path, {
          body: opts?.force !== undefined ? { force: opts.force } : {},
        });
      },
    },

    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      if (options?.enableSse === false) {
        return () => undefined;
      }
      return events.subscribe(listener);
    },

    async dispose(): Promise<void> {
      events.dispose();
    },
  };

  return host;
}

/**
 * Connects to the MiniPod loopback server, fetches `GET /api/info` upfront so `host.info`
 * has the exact server `deviceId` / `dataDir` before mounting React, and returns `PlatformHost`.
 */
export async function connectRestPlatformHost(
  options?: CreateRestPlatformHostOptions,
): Promise<PlatformHost> {
  const client = new RestJsonClient(options);
  const info = await client.request<HostInfo>(ROUTES.info.method, ROUTES.info.path);
  return createRestPlatformHost({
    ...options,
    initialInfo: info,
  });
}
