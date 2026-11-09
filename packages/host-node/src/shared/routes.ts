/**
 * Exhaustive typed REST route descriptors shared between `@minipod/host-node` server and client.
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
  HostInfo,
  HostUpdateApplyResult,
  HostUpdateCheckResult,
  HttpBasicCredentials,
  LocalFolderRef,
  MediaSource,
  MiniPodErrorShape,
  OpmlCandidate,
  Page,
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
} from '@minipod/core';

export type RouteHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec<TReq = void, TRes = void> {
  readonly method: RouteHttpMethod;
  readonly path: string;
  readonly _req?: TReq;
  readonly _res?: TRes;
}

function route<TReq = void, TRes = void>(
  method: RouteHttpMethod,
  path: string,
): RouteSpec<TReq, TRes> {
  return { method, path };
}

export const ROUTES = {
  info: route<void, HostInfo>('GET', '/api/info'),

  feedsList: route<void, readonly Feed[]>('GET', '/api/feeds'),
  feedsPreview: route<
    { readonly url: string; readonly credentials?: HttpBasicCredentials },
    ResolveResult
  >('POST', '/api/feeds/preview'),
  feedsSubscribe: route<{ readonly previewIdOrUrl: string }, Feed>('POST', '/api/feeds/subscribe'),
  feedsRefresh: route<{ readonly feedKey?: FeedKey }, null>('POST', '/api/feeds/refresh'),
  feedsLocalFolder: route<{ readonly folder: LocalFolderRef }, Feed>(
    'POST',
    '/api/feeds/local-folder',
  ),
  feedsOpmlImport: route<{ readonly xml: string }, readonly OpmlCandidate[]>(
    'POST',
    '/api/feeds/opml',
  ),
  feedsOpmlExport: route<void, { readonly xml: string }>('GET', '/api/feeds/opml'),
  feedsSubscribeMany: route<
    { readonly urls: readonly string[] },
    { readonly added: number; readonly failed: readonly { url: string; error: MiniPodErrorShape }[] }
  >('POST', '/api/feeds/subscribe-many'),
  feedsGet: route<{ readonly feedKey: FeedKey }, Feed>('GET', '/api/feeds/:feedKey'),
  feedsUnsubscribe: route<{ readonly feedKey: FeedKey }, null>('DELETE', '/api/feeds/:feedKey'),
  feedsLoadOlder: route<{ readonly feedKey: FeedKey }, { readonly added: number }>(
    'POST',
    '/api/feeds/:feedKey/load-older',
  ),
  feedsSetCredentials: route<
    { readonly feedKey: FeedKey; readonly credentials: HttpBasicCredentials | null },
    null
  >('PUT', '/api/feeds/:feedKey/credentials'),

  searchSources: route<
    void,
    readonly { readonly id: SourceId; readonly displayName: string; readonly inCombined: boolean }[]
  >('GET', '/api/search/sources'),
  searchQuery: route<
    { readonly text: string; readonly source?: SourceId },
    readonly SearchResult[]
  >('GET', '/api/search/query'),
  searchTopCharts: route<{ readonly country: CountryCode }, readonly SearchResult[]>(
    'GET',
    '/api/search/top-charts',
  ),
  searchResolveUrl: route<
    { readonly input: string; readonly credentials?: HttpBasicCredentials },
    ResolveResult
  >('POST', '/api/search/resolve'),
  searchCountries: route<void, readonly { readonly code: CountryCode; readonly name: string }[]>(
    'GET',
    '/api/search/countries',
  ),

  episodesList: route<
    { readonly feedKey: FeedKey; readonly filter: EpisodeFilter; readonly cursor?: string },
    Page<EpisodeRow>
  >('GET', '/api/episodes'),
  episodesGet: route<{ readonly episodeKey: EpisodeKey }, EpisodeRow>(
    'GET',
    '/api/episodes/:episodeKey',
  ),
  episodesDownload: route<{ readonly episodeKey: EpisodeKey }, null>(
    'POST',
    '/api/episodes/:episodeKey/download',
  ),
  episodesDeleteDownload: route<{ readonly episodeKey: EpisodeKey }, null>(
    'DELETE',
    '/api/episodes/:episodeKey/download',
  ),
  episodesCancelAllDownloads: route<void, null>('POST', '/api/episodes/downloads/cancel-all'),
  episodesChapters: route<
    { readonly episodeKey: EpisodeKey; readonly forceRefresh?: boolean },
    readonly Chapter[]
  >('GET', '/api/episodes/:episodeKey/chapters'),
  episodesChapterImageMeta: route<
    { readonly episodeKey: EpisodeKey; readonly index: number },
    { readonly url: string | null }
  >('GET', '/api/episodes/:episodeKey/chapters/:index/image-url'),
  episodesShare: route<
    { readonly episodeKey: EpisodeKey },
    { readonly url: string; readonly title: string }
  >('GET', '/api/episodes/:episodeKey/share'),

  queueList: route<void, readonly QueueRow[]>('GET', '/api/queue'),
  queueAdd: route<{ readonly episodeKey: EpisodeKey }, null>('POST', '/api/queue/add'),
  queuePlayNext: route<{ readonly episodeKey: EpisodeKey }, null>('POST', '/api/queue/play-next'),
  queueMove: route<
    { readonly episodeKey: EpisodeKey; readonly beforeKey: EpisodeKey | null },
    null
  >('POST', '/api/queue/move'),
  queueRemove: route<{ readonly episodeKey: EpisodeKey }, null>('DELETE', '/api/queue/:episodeKey'),
  queueClear: route<void, null>('POST', '/api/queue/clear'),

  progressGet: route<
    { readonly episodeKey: EpisodeKey },
    { readonly record: ProgressRecord | null }
  >('GET', '/api/progress/:episodeKey'),
  progressSave: route<ProgressSave, null>('POST', '/api/progress/save'),
  progressMarkPlayed: route<
    { readonly episodeKey: EpisodeKey; readonly played: boolean },
    null
  >('POST', '/api/progress/mark-played'),

  playbackSource: route<{ readonly episodeKey: EpisodeKey }, MediaSource>(
    'GET',
    '/api/playback/source/:episodeKey',
  ),
  playbackQueueSources: route<void, readonly QueueItemSource[]>(
    'GET',
    '/api/playback/queue-sources',
  ),

  syncStatus: route<void, SyncStatus>('GET', '/api/sync/status'),
  syncConfigure: route<
    { readonly settings: SyncSettings; readonly secret?: SyncProviderSecret },
    SyncStatus
  >('POST', '/api/sync/configure'),
  syncAuthorize: route<{ readonly provider: 'drive-appdata' | 'drive-file' }, null>(
    'POST',
    '/api/sync/authorize',
  ),
  syncNow: route<void, SyncStatus>('POST', '/api/sync/now'),
  syncDisconnect: route<void, null>('POST', '/api/sync/disconnect'),
  syncResetRemote: route<void, null>('POST', '/api/sync/reset-remote'),
  syncUndoResume: route<{ readonly episodeKey: EpisodeKey; readonly positionMs: number }, null>(
    'POST',
    '/api/sync/undo-resume',
  ),

  filesListDirectory: route<
    { readonly path?: string },
    { readonly path: string; readonly parent?: string; readonly dirs: readonly string[] }
  >('GET', '/api/files/list-directory'),
  filesOpenExternal: route<{ readonly url: string }, null>('POST', '/api/files/open-external'),

  settingsGet: route<void, AppSettings>('GET', '/api/settings'),
  settingsUpdate: route<Partial<AppSettings>, AppSettings>('PATCH', '/api/settings'),

  updateCheck: route<{ readonly currentVersion?: string }, HostUpdateCheckResult>(
    'POST',
    '/api/update/check',
  ),
  updateApply: route<{ readonly force?: boolean }, HostUpdateApplyResult>(
    'POST',
    '/api/update/apply',
  ),
} as const;

export type RouteName = keyof typeof ROUTES;
