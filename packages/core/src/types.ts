/**
 * @minipod/core — shared types and the cross-package contracts.
 *
 * THIS FILE IS THE LAW. Everything that crosses a package boundary
 * (`core` ⇄ `ui` ⇄ `host-node` ⇄ `host-android`) is typed here and only here.
 * Owned by the designer; coders may propose additive optional fields on the board.
 *
 * Rules: no `node:*`, no DOM-only types beyond the standard library (`Uint8Array`,
 * `AbortSignal`, `URL`), no Capacitor. Everything I/O-ish is injected.
 *
 * See ARCHITECTURE.md §3 (PlatformHost), §4 (core modules), §5 (PlayerEngine),
 * §7 (sync document), §8 (CloudFileProvider), §9 (SyncScheduler).
 */

// ---------------------------------------------------------------------------
// §A. Primitive aliases & identities (ARCHITECTURE.md §4.1.3, §7.2)
// ---------------------------------------------------------------------------

/** `"f_" + sha1Hex(schemeLessCanonical(url))` for RSS/Atom feeds, `"l_" + sha1Hex(folderRef)` for local folders. */
export type FeedKey = string;
/** `"e_" + sha1Hex(feedKey + "\n" + identity)`. */
export type EpisodeKey = string;
/** `"d_" + 16 random bytes hex`, generated once per install. */
export type DeviceId = string;
/** Hybrid-logical-clock milliseconds (ARCHITECTURE.md §7.3). Never a plain wall clock. */
export type HlcMs = number;
/** Unix epoch milliseconds (wall clock, informational only). */
export type EpochMs = number;
/** ISO-3166 alpha-2 country code, upper case; `'99'` = unset (upstream `COUNTRY_CODE_UNSET`). */
export type CountryCode = string;

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// §B. Errors (ARCHITECTURE.md §0)
// ---------------------------------------------------------------------------

export type MiniPodErrorCode =
  | 'invalid-url'
  | 'unsupported-feed'
  | 'feed-not-found'
  | 'auth-required'
  | 'network'
  | 'not-found'
  | 'invalid-argument'
  | 'sync-conflict'
  | 'sync-auth'
  | 'sync-schema'
  | 'unsupported'
  | 'cancelled'
  | 'internal';

export interface MiniPodErrorShape {
  readonly code: MiniPodErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// §C. HTTP (ARCHITECTURE.md §4.0, §4.3) — injected into core by each host
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'PROPFIND';

export interface HttpBasicCredentials {
  readonly username: string;
  readonly password: string;
}

export interface HttpRequest {
  readonly url: string;
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  /** UTF-8 text or raw bytes. */
  readonly body?: string | Uint8Array;
  /** Byte range `[start, end]` inclusive; `end` omitted = to EOF. Sent as `Range: bytes=start-end`. */
  readonly range?: { readonly start: number; readonly end?: number };
  /**
   * Basic-Auth credentials to try on 401 (after URL userInfo), ISO-8859-1 first then UTF-8
   * (upstream `BasicAuthorizationInterceptor` order). Re-attached after cross-host redirects.
   */
  readonly auth?: HttpBasicCredentials;
  /** Default 10. `0` = do not follow; the first response is returned as-is. */
  readonly maxRedirects?: number;
  /** Cap on the decoded body size; larger bodies reject with `invalid-argument`. */
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RedirectHop {
  readonly status: number;
  /** URL that *issued* the redirect. */
  readonly url: string;
  /** `Location` it pointed to (absolute). */
  readonly location: string;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** URL after all redirects. */
  readonly finalUrl: string;
  /** Every redirect hop in order (empty when none). Used by `RedirectRecorder`. */
  readonly chain: readonly RedirectHop[];
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

/** The one network primitive core ever uses. Desktop: Node `fetch` with a manual redirect loop; Android: `MiniPodPlugin.http`. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Result of analysing a redirect chain (port of upstream `RedirectChecker`). */
export interface PermanentRedirect {
  readonly from: string;
  readonly to: string;
  readonly reason: '301' | '308' | 'http-to-https';
}

// ---------------------------------------------------------------------------
// §D. Discovery (ARCHITECTURE.md §4.1)
// ---------------------------------------------------------------------------

export type SourceId = 'apple' | 'podcastindex' | 'fyyd' | 'gpodder' | 'combined';

export interface SearchResult {
  readonly title: string;
  readonly author?: string;
  readonly imageUrl?: string;
  /** May be an `https://itunes.apple.com/lookup?id=…` URL until resolved via `lookupUrl`. */
  readonly feedUrl: string;
  readonly source: SourceId;
}

export interface PodcastSearcher {
  readonly id: SourceId;
  readonly displayName: string;
  /** Weight in `CombinedSearcher`; `0` = excluded from federated search but still selectable alone. */
  readonly combinedWeight: number;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  /** True when `url` must be translated before fetching (Apple: `itunes.apple.com` or `podcasts.apple.com/…/idNNN`). */
  urlNeedsLookup?(url: string): boolean;
  lookupUrl?(url: string, signal?: AbortSignal): Promise<string>;
}

export interface PodcastSearcherRegistry {
  /** Ordered: combined, apple, podcastindex, fyyd, gpodder. */
  readonly all: readonly PodcastSearcher[];
  byId(id: SourceId): PodcastSearcher;
  urlNeedsLookup(url: string): boolean;
  lookupUrl(url: string, signal?: AbortSignal): Promise<string>;
}

export interface TopListLoader {
  topPodcasts(country: CountryCode, limit?: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface PodcastIndexKeys {
  readonly key: string;
  readonly secret: string;
}

/** A feed found on a website via `<link rel="alternate">`. */
export interface DiscoveredFeedLink {
  readonly url: string;
  readonly title?: string;
  readonly type: 'application/rss+xml' | 'application/atom+xml';
}

/** Outcome of `FeedUrlResolver.resolve(input)` / `host.search.resolveUrl(input)`. */
export type ResolveResult =
  | { readonly kind: 'feed'; readonly preview: FeedPreview }
  | { readonly kind: 'choices'; readonly pageUrl: string; readonly choices: readonly DiscoveredFeedLink[] }
  | { readonly kind: 'auth-required'; readonly url: string; readonly realm?: string };

// ---------------------------------------------------------------------------
// §E. Feed & episode model (ARCHITECTURE.md §4.2, §6)
// ---------------------------------------------------------------------------

export type FeedKind = 'RSS' | 'LOCAL';
export type MediaType = 'AUDIO' | 'VIDEO' | 'UNKNOWN';
export type DownloadState = 'NONE' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
export type FeedType = 'rss20' | 'rss091' | 'atom' | 'rdf';

export interface Feed {
  readonly feedKey: FeedKey;
  readonly kind: FeedKind;
  /** `true` = shown in Subscriptions; `false` = stub (preview / queued-only / synced placeholder). */
  readonly subscribed: boolean;
  /** Current scheme-bearing fetch URL, or `"local-folder:" + ref` for local folders. */
  readonly url: string;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly fundingUrl?: string;
  readonly hasCredentials: boolean;
  readonly nextPageUrl?: string;
  readonly lastRefreshedAt?: EpochMs;
  readonly lastEpisodeAt?: EpochMs;
  readonly addedAt: HlcMs;
  readonly updatedAt: HlcMs;
  readonly deletedAt?: HlcMs;
}

export interface Episode {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  /** `guid` | enclosure URL | `title + "|" + pubDateEpochMs` (ARCHITECTURE.md §7.2). */
  readonly identity: string;
  /** Materialised from a sync queue stub; replaced on the next feed parse. */
  readonly isStub: boolean;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly pubDate?: EpochMs;
  readonly durationMs?: number;
  readonly enclosureUrl?: string;
  readonly enclosureMime?: string;
  readonly enclosureSize?: number;
  readonly mediaType: MediaType;
  readonly chaptersUrl?: string;
  readonly chaptersType?: string;
  readonly transcriptUrl?: string;
  readonly transcriptType?: string;
  readonly downloadState: DownloadState;
  /** Host-specific path/URI of the downloaded file (never shown to the UI directly). */
  readonly downloadPath?: string;
}

/** Row shape the UI lists: episode ⨝ progress ⨝ queue membership. */
export interface EpisodeRow {
  readonly episode: Episode;
  readonly progress?: ProgressRecord;
  readonly inQueue: boolean;
}

export interface ParsedEpisode {
  readonly identity: string;
  readonly guid?: string;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly pubDate?: EpochMs;
  readonly durationMs?: number;
  readonly enclosureUrl?: string;
  readonly enclosureMime?: string;
  readonly enclosureSize?: number;
  readonly mediaType: MediaType;
  readonly chaptersUrl?: string;
  readonly chaptersType?: string;
  readonly transcriptUrl?: string;
  readonly transcriptType?: string;
  /** `psc:chapters` declared inline in the feed. */
  readonly chapters?: readonly Chapter[];
}

export interface ParsedFeed {
  readonly type: FeedType;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly fundingUrl?: string;
  /** `<itunes:new-feed-url>` → treated like a permanent redirect. */
  readonly redirectUrl?: string;
  /** Atom `<link rel="next">` (RFC 5005). */
  readonly nextPageUrl?: string;
  /** Alternate feed URLs advertised inside the feed (Atom `rel=alternate` with feed MIME). */
  readonly alternateFeedUrls?: Readonly<Record<string, string>>;
  readonly episodes: readonly ParsedEpisode[];
}

/** What the Add screen shows before the user subscribes (ARCHITECTURE.md §4.1.2). */
export interface FeedPreview {
  /** Opaque host token; `feeds.subscribe(previewId)` avoids a second fetch. */
  readonly previewId: string;
  readonly feedKey: FeedKey;
  readonly url: string;
  readonly parsed: ParsedFeed;
  readonly episodeCount: number;
  readonly alreadySubscribed: boolean;
  readonly permanentRedirect?: PermanentRedirect;
}

export type ChapterSource = 'PI_JSON' | 'PSC' | 'ID3' | 'VORBIS' | 'MP4';

export interface Chapter {
  readonly startMs: number;
  readonly title?: string;
  readonly link?: string;
  /** Remote image URL, or an opaque host image reference (see `EpisodesApi.chapterImage`). */
  readonly imageUrl?: string;
  /** For ID3 `APIC` sub-frames: byte slice inside the media file. */
  readonly embeddedImage?: { readonly offset: number; readonly length: number; readonly mime: string };
  readonly source: ChapterSource;
}

export interface OpmlCandidate {
  readonly title: string;
  readonly xmlUrl: string;
  readonly htmlUrl?: string;
  readonly type?: string;
}

/** Host-neutral reference to a local folder (desktop: absolute path; Android: SAF tree URI). */
export interface LocalFolderRef {
  readonly ref: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// §F. Progress, queue, playback state (ARCHITECTURE.md §4.5, §6, §7.4)
// ---------------------------------------------------------------------------

export type ProgressState = 'NEW' | 'IN_PROGRESS' | 'PLAYED';

export interface ProgressRecord {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly state: ProgressState;
  readonly playedAt?: HlcMs;
  readonly updatedAt: HlcMs;
  readonly deviceId: DeviceId;
}

/** Input to `host.progress.save` — the host stamps `updatedAt`/`deviceId`. */
export interface ProgressSave {
  readonly episodeKey: EpisodeKey;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly state: ProgressState;
  /** `true` on `pagehide`/pause-when-hidden: persist and push immediately. */
  readonly flush?: boolean;
}

/** Enough to render and stream a queued episode on a device that has not fetched the feed (ARCHITECTURE.md §7.1). */
export interface QueueStub {
  readonly identity: string;
  readonly title: string;
  readonly feedTitle?: string;
  readonly feedUrl: string;
  readonly enclosureUrl?: string;
  readonly enclosureMime?: string;
  readonly durationMs?: number;
  readonly imageUrl?: string;
  readonly pubDate?: EpochMs;
}

export interface QueueEntry {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  /** Fractional-index key (ARCHITECTURE.md §7.4); order = (pos, addedAt, episodeKey). */
  readonly pos: string;
  readonly addedAt: HlcMs;
  readonly updatedAt: HlcMs;
  readonly removed: boolean;
  readonly deviceId: DeviceId;
  readonly stub?: QueueStub;
}

/** Row shape the Queue screen lists (non-removed entries, ordered). */
export interface QueueRow {
  readonly entry: QueueEntry;
  readonly episode: Episode;
  readonly progress?: ProgressRecord;
}

export type SleepTimer =
  | { readonly mode: 'off' }
  | { readonly mode: 'minutes'; readonly minutes: number }
  | { readonly mode: 'endOfEpisode' }
  | { readonly mode: 'endOfChapter'; readonly chapterEndMs: number };

export interface SleepTimerState {
  readonly timer: SleepTimer;
  readonly remainingMs?: number;
}

// ---------------------------------------------------------------------------
// §G. Media sources & the PlayerEngine (ARCHITECTURE.md §3 rule 2, §5.1)
// ---------------------------------------------------------------------------

export type MediaSource =
  /** Desktop `/media/{episodeKey}` proxy, or Android direct enclosure URL (+ auth headers). */
  | { readonly kind: 'url'; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly mime?: string }
  /** Android downloaded file / local-folder `content://` document. */
  | { readonly kind: 'file'; readonly path: string; readonly mime?: string };

export interface MediaMetadataLite {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artworkUrl?: string;
  readonly durationMs?: number;
}

export interface PlayerLoadItem {
  readonly episodeKey: EpisodeKey;
  readonly source: MediaSource;
  readonly startMs: number;
  readonly speed: number;
  readonly metadata: MediaMetadataLite;
  readonly mediaType: MediaType;
}

/** Remaining queue handed to native engines so auto-advance never depends on JS (ARCHITECTURE.md §3.3). */
export interface QueueItemSource {
  readonly episodeKey: EpisodeKey;
  readonly source: MediaSource;
  readonly startMs: number;
  readonly metadata: MediaMetadataLite;
}

export interface PlayerSnapshot {
  readonly episodeKey?: EpisodeKey;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly speed: number;
}

export type PlayerEvent =
  | { readonly type: 'state'; readonly snapshot: PlayerSnapshot }
  /** ≈ every 1 s while playing. */
  | { readonly type: 'position'; readonly episodeKey: EpisodeKey; readonly positionMs: number; readonly durationMs?: number }
  | { readonly type: 'ended'; readonly episodeKey: EpisodeKey }
  | { readonly type: 'error'; readonly episodeKey?: EpisodeKey; readonly error: MiniPodErrorShape }
  | { readonly type: 'sleepTimer'; readonly state: SleepTimerState }
  /** Native engine advanced on its own (ARCHITECTURE.md §3.3); UI reconciles queue/progress. */
  | { readonly type: 'nativeAdvanced'; readonly from: EpisodeKey; readonly to: EpisodeKey };

export interface PlayerEngineCapabilities {
  /** Can render video enclosures inline (`attachVideoSurface`). Android v1: `false`. */
  readonly video: boolean;
  /** Keeps playing with the UI hidden / screen off. */
  readonly background: boolean;
  /** Accepts `setQueue` for autonomous auto-advance. */
  readonly nativeQueue: boolean;
}

/**
 * One interface, two implementations: `HtmlAudioEngine` (desktop, in @minipod/ui)
 * and `NativeAudioEngine` (Android, over MiniPodPlugin → Media3 PlaybackService).
 */
export interface PlayerEngine {
  readonly capabilities: PlayerEngineCapabilities;
  load(item: PlayerLoadItem): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seekTo(ms: number): void;
  /** UI passes `-10_000` / `+30_000`. */
  skip(deltaMs: number): void;
  /** Clamped to `0.5..3.0`. */
  setSpeed(speed: number): void;
  setSleepTimer(timer: SleepTimer): void;
  setQueue?(items: readonly QueueItemSource[]): void;
  attachVideoSurface?(element: HTMLElement): void;
  getSnapshot(): PlayerSnapshot;
  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// §H. Sync document `minipod-sync-v1.json` (ARCHITECTURE.md §7.1)
// ---------------------------------------------------------------------------

export const SYNC_SCHEMA_ID = 'minipod-sync';
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_FILE_NAME = 'minipod-sync-v1.json';

export interface SyncDevice {
  readonly name: string;
  readonly app: string;
  readonly lastSeenAt: EpochMs;
}

export interface SyncSubscription {
  readonly url: string;
  readonly movedTo?: string | null;
  readonly title?: string;
  readonly imageUrl?: string;
  readonly hasCredentials?: boolean;
  readonly updatedAt: HlcMs;
  readonly deleted: boolean;
  readonly deviceId: DeviceId;
}

export interface SyncQueueEntry {
  readonly feedKey: FeedKey;
  readonly pos: string;
  readonly addedAt: HlcMs;
  readonly updatedAt: HlcMs;
  readonly removed: boolean;
  readonly deviceId: DeviceId;
  /** Present iff `removed === false`. */
  readonly stub?: QueueStub;
}

export interface SyncProgress {
  readonly feedKey: FeedKey;
  readonly identity?: string;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly state: ProgressState;
  readonly playedAt?: HlcMs | null;
  readonly updatedAt: HlcMs;
  readonly deviceId: DeviceId;
}

/** A keyed map with its monotone tombstone/eviction floor (ARCHITECTURE.md §7.5, §7.7). */
export interface SyncMap<T> {
  readonly floor: HlcMs;
  readonly items: Readonly<Record<string, T>>;
}

export interface SyncDocument {
  readonly schema: typeof SYNC_SCHEMA_ID;
  readonly schemaVersion: number;
  /** Stamped by the writer at upload time; never touched by `merge`. */
  readonly rev: number;
  readonly writtenAt: EpochMs;
  readonly writtenBy: DeviceId;
  /** Largest HLC in the document (readers fast-forward their clock, capped). */
  readonly hlcMax: HlcMs;
  readonly devices: Readonly<Record<DeviceId, SyncDevice>>;
  readonly subscriptions: SyncMap<SyncSubscription>;
  readonly queue: SyncMap<SyncQueueEntry>;
  readonly progress: SyncMap<SyncProgress>;
}

/** Only the entity maps — what the upload decision compares (ARCHITECTURE.md §9.1). */
export type SyncEntityMaps = Pick<SyncDocument, 'subscriptions' | 'queue' | 'progress'>;

// ---------------------------------------------------------------------------
// §I. Sync providers, store, engine (ARCHITECTURE.md §7.6, §8, §9)
// ---------------------------------------------------------------------------

export type ProviderId = 'local-folder' | 'saf' | 'drive-appdata' | 'drive-file' | 'webdav' | 'gist';

export type ReadResult =
  | { readonly kind: 'not-modified' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array; readonly etag: string | null; readonly lastModified?: EpochMs };

export type WriteResult =
  | { readonly kind: 'ok'; readonly newEtag: string | null }
  /** Precondition failed; caller must re-read and re-merge. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failed'; readonly cause: unknown; readonly retryable: boolean };

export interface ProbeResult {
  readonly ok: boolean;
  readonly exists: boolean;
  readonly etag: string | null;
  readonly error?: MiniPodErrorShape;
}

export interface CloudFileProvider {
  readonly id: ProviderId;
  readonly supportsNativeConditionalWrite: boolean;
  /** Can detect "unchanged" without downloading the body. */
  readonly supportsCheapHead: boolean;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  head(signal?: AbortSignal): Promise<string | null>;
  read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult>;
  /**
   * `ifMatch === null` → create only if missing. Implementations without native preconditions
   * MUST call `head()` and return `{ kind: 'conflict' }` BEFORE transferring bytes when it differs.
   */
  write(bytes: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<WriteResult>;
  /** File-based providers: wake the scheduler when the file changes underneath us. */
  watch?(onChange: () => void): Unsubscribe;
}

/** Host primitive behind `HostFileProvider` (desktop `node:fs` path; Android SAF document URI via MiniPodPlugin.saf). */
export interface HostFileAccess {
  stat(): Promise<{ readonly size: number; readonly mtimeMs: EpochMs } | null>;
  read(): Promise<Uint8Array>;
  /** Atomic / truncating full-file replace. */
  write(bytes: Uint8Array): Promise<void>;
  watch?(onChange: () => void): Unsubscribe;
}

/** Hosts refresh silently before expiry; providers retry once with `forceRefresh` on 401. */
export type TokenProvider = (options?: { readonly forceRefresh?: boolean }) => Promise<string>;

export type SyncProviderConfig =
  | { readonly id: 'local-folder'; readonly folderPath: string }
  | { readonly id: 'saf'; readonly documentUri: string }
  | { readonly id: 'drive-appdata'; readonly accountHint?: string }
  | { readonly id: 'drive-file'; readonly accountHint?: string; readonly folderName?: string }
  | { readonly id: 'webdav'; readonly fileUrl: string; readonly username: string }
  | { readonly id: 'gist'; readonly gistId?: string };

/** Secrets travel separately from `SyncProviderConfig` and never enter Room/IndexedDB or the sync file. */
export type SyncProviderSecret =
  | { readonly id: 'webdav'; readonly password: string }
  | { readonly id: 'gist'; readonly token: string };

export interface SyncSettings {
  readonly provider: SyncProviderConfig | null;
  readonly wifiOnly: boolean;
  readonly deviceName: string;
}

export type SyncReason =
  | 'subscriptions-changed'
  | 'queue-changed'
  | 'progress-paused'
  | 'progress-completed'
  | 'progress-marked'
  | 'playing-checkpoint'
  | 'foreground'
  | 'hidden'
  | 'periodic'
  | 'remote-changed'
  | 'manual'
  | 'configured';

export interface SyncStatus {
  readonly enabled: boolean;
  readonly provider?: ProviderId;
  readonly phase: 'idle' | 'syncing' | 'backoff' | 'needs-attention' | 'off';
  readonly lastPullAt?: EpochMs;
  readonly lastPushAt?: EpochMs;
  readonly remoteRev?: number;
  readonly lastError?: MiniPodErrorShape;
  readonly backoffUntil?: EpochMs;
  readonly dirtyCount: number;
  /** `false` on Android: nothing syncs once the process is gone (ARCHITECTURE.md §3.3). */
  readonly backgroundSync: boolean;
}

export interface SyncState {
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly remoteEtag: string | null;
  readonly remoteFileId: string | null;
  readonly remoteRev: number;
  readonly floors: { readonly subscriptions: HlcMs; readonly queue: HlcMs; readonly progress: HlcMs };
  readonly hlcLast: HlcMs;
  readonly lastPullAt?: EpochMs;
  readonly lastPushAt?: EpochMs;
  readonly lastError?: MiniPodErrorShape;
  readonly backoffUntil?: EpochMs;
}

/** Local document plus dirtiness, as produced by `SyncStore.loadLocalDoc()` (ARCHITECTURE.md §7.6). */
export interface LocalSyncSnapshot {
  readonly maps: SyncEntityMaps;
  readonly device: SyncDevice;
  readonly dirty: { readonly subscriptions: ReadonlySet<FeedKey>; readonly queue: ReadonlySet<EpisodeKey>; readonly progress: ReadonlySet<EpisodeKey> };
}

/** Side effects the engine wants the host to perform after applying a merge (UI-visible). */
export interface ApplyDecisions {
  /** Progress of the currently loaded episode changed remotely → UI seeks and shows "Resumed from <device> — Undo". */
  readonly resumeHints: readonly { readonly episodeKey: EpisodeKey; readonly positionMs: number; readonly state: ProgressState; readonly deviceName: string }[];
  readonly feedsToRefresh: readonly FeedKey[];
}

/**
 * The only view of local storage the sync engine needs. Desktop: `SqliteSyncStore`; Android: `IdbSyncStore`.
 * `applyMerged` must be atomic (single SQLite / IndexedDB transaction) and must materialise stubs (ARCHITECTURE.md §7.6).
 */
export interface SyncStore {
  getSyncState(): Promise<SyncState>;
  setSyncState(patch: Partial<SyncState>): Promise<void>;
  loadLocalDoc(): Promise<LocalSyncSnapshot>;
  /** Re-stamp dirty rows at/below the remote floor (ARCHITECTURE.md §7.6 "before merge"). */
  restampDirtyBelowFloor(floors: SyncState['floors'], stamp: () => HlcMs): Promise<void>;
  applyMerged(merged: SyncDocument, currentEpisodeKey: EpisodeKey | undefined): Promise<ApplyDecisions>;
  /** Clear `sync_dirty` for rows whose value equals the pushed document. */
  markClean(pushed: SyncEntityMaps): Promise<void>;
  /** Purge local tombstones/evicted rows the writer GC'd. */
  purgeBelowFloors(floors: SyncState['floors']): Promise<void>;
}

/** Timers & network facts the scheduler needs; injected by hosts (ARCHITECTURE.md §9.2). */
export interface SyncSchedulerHost {
  now(): EpochMs;
  setTimeout(fn: () => void, ms: number): Unsubscribe;
  setInterval(fn: () => void, ms: number): Unsubscribe;
  /** `true` when the UI is visible (`document.visibilityState === 'visible'`); desktop server: always `true`. */
  isVisible(): boolean;
  /** `undefined` when unknown. */
  isMetered(): boolean | undefined;
  isOnline(): boolean;
}

// ---------------------------------------------------------------------------
// §J. Settings (ARCHITECTURE.md §6.1 `settings`, DESIGN.md §4.7)
// ---------------------------------------------------------------------------

export interface AppSettings {
  readonly schemaVersion: 1;
  readonly deleteDownloadWhenPlayed: boolean;
  readonly backgroundRefreshHours: 0 | 1 | 3 | 6 | 12 | 24;
  readonly sync: SyncSettings;
  /** Local only, never synced. */
  readonly playbackSpeed: number;
  readonly topChartsCountry: CountryCode;
  readonly subscriptionsLayout: 'grid' | 'list';
  readonly uiLanguage: 'system' | 'en' | 'zh-CN' | 'ja';
}

// ---------------------------------------------------------------------------
// §K. PlatformHost (ARCHITECTURE.md §3)
// ---------------------------------------------------------------------------

export type HostPlatform = 'desktop' | 'android';

export interface HostCapabilities {
  /** Android: `true` (Media3). Desktop: `false` (HtmlAudioEngine). */
  readonly nativeAudio: boolean;
  readonly downloads: boolean;
  readonly localFolderFeeds: boolean;
  /** Desktop: `['local-folder','drive-appdata','drive-file','webdav','gist']`; Android: `['saf', ('drive-appdata','drive-file')?, 'webdav','gist']`. */
  readonly syncProviders: readonly ProviderId[];
  /** Android SAF pickers / desktop server-side path browser. */
  readonly filePicker: boolean;
  readonly folderPicker: boolean;
  /** Desktop server: `true`; Android: `false`. */
  readonly backgroundSync: boolean;
  readonly openExternal: boolean;
}

export interface HostInfo {
  readonly platform: HostPlatform;
  readonly os: string;
  readonly appVersion: string;
  readonly capabilities: HostCapabilities;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  /** Desktop only: data directory shown in Settings › About. */
  readonly dataDir?: string;
}

export type EpisodeFilter = 'all' | 'unplayed' | 'downloaded';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface FeedsApi {
  list(): Promise<readonly Feed[]>;
  get(feedKey: FeedKey): Promise<Feed>;
  /** Runs the resolve pipeline (ARCHITECTURE.md §4.1.2) without subscribing. */
  preview(url: string, credentials?: HttpBasicCredentials): Promise<ResolveResult>;
  /** Accepts a `FeedPreview.previewId` or a URL. */
  subscribe(previewIdOrUrl: string): Promise<Feed>;
  unsubscribe(feedKey: FeedKey): Promise<void>;
  /** All subscribed feeds when `feedKey` is omitted. Resolves when finished; progress via `feed-refreshed` events. */
  refresh(feedKey?: FeedKey): Promise<void>;
  loadOlder(feedKey: FeedKey): Promise<number>;
  setCredentials(feedKey: FeedKey, credentials: HttpBasicCredentials | null): Promise<void>;
  addLocalFolder(folder: LocalFolderRef): Promise<Feed>;
  importOpml(xml: string): Promise<readonly OpmlCandidate[]>;
  subscribeMany(urls: readonly string[]): Promise<{ readonly added: number; readonly failed: readonly { url: string; error: MiniPodErrorShape }[] }>;
  exportOpml(): Promise<string>;
}

export interface SearchApi {
  sources(): Promise<readonly { readonly id: SourceId; readonly displayName: string; readonly inCombined: boolean }[]>;
  query(text: string, source?: SourceId, signal?: AbortSignal): Promise<readonly SearchResult[]>;
  topCharts(country: CountryCode, signal?: AbortSignal): Promise<readonly SearchResult[]>;
  /** URL, scheme URL, Apple page, website, share text → feed preview / choices / auth prompt. */
  resolveUrl(input: string, credentials?: HttpBasicCredentials): Promise<ResolveResult>;
  countries(): Promise<readonly { readonly code: CountryCode; readonly name: string }[]>;
}

export interface EpisodesApi {
  list(feedKey: FeedKey, filter: EpisodeFilter, cursor?: string): Promise<Page<EpisodeRow>>;
  get(episodeKey: EpisodeKey): Promise<EpisodeRow>;
  download(episodeKey: EpisodeKey): Promise<void>;
  deleteDownload(episodeKey: EpisodeKey): Promise<void>;
  chapters(episodeKey: EpisodeKey, forceRefresh?: boolean): Promise<readonly Chapter[]>;
  /** Resolves `Chapter.embeddedImage` / `imageUrl` to something an `<img>` can load (desktop route URL, Android `data:` URL). */
  chapterImage(episodeKey: EpisodeKey, chapterIndex: number): Promise<string | undefined>;
  share(episodeKey: EpisodeKey): Promise<{ readonly url: string; readonly title: string }>;
}

export interface QueueApi {
  list(): Promise<readonly QueueRow[]>;
  add(episodeKey: EpisodeKey): Promise<void>;
  playNext(episodeKey: EpisodeKey): Promise<void>;
  /** `beforeKey === null` → move to the end. */
  move(episodeKey: EpisodeKey, beforeKey: EpisodeKey | null): Promise<void>;
  remove(episodeKey: EpisodeKey): Promise<void>;
  clear(): Promise<void>;
}

export interface ProgressApi {
  get(episodeKey: EpisodeKey): Promise<ProgressRecord | undefined>;
  /** Fire-and-forget for the UI; the host persists immediately and stamps HLC/deviceId. */
  save(save: ProgressSave): Promise<void>;
  markPlayed(episodeKey: EpisodeKey, played: boolean): Promise<void>;
}

export interface PlaybackApi {
  /** Host-resolved source for the engine (ARCHITECTURE.md §3 rule 2). */
  sourceFor(episodeKey: EpisodeKey): Promise<MediaSource>;
  /** Android: remaining queue as native-playable sources; desktop may return `[]`. */
  queueSources(): Promise<readonly QueueItemSource[]>;
}

export interface SyncApi {
  status(): Promise<SyncStatus>;
  configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus>;
  /** Hosts that need interactive sign-in (Drive) start it here; resolves when a token is available. */
  authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void>;
  syncNow(): Promise<SyncStatus>;
  disconnect(): Promise<void>;
  /** Deletes the remote file (Drive AppData "Delete cloud data"). */
  resetRemote(): Promise<void>;
  /** "Resumed from <device> — Undo": re-stamps the local position so it wins. */
  undoResume(episodeKey: EpisodeKey, positionMs: number): Promise<void>;
}

export interface FilesApi {
  /** Android SAF document picker for the sync file (`capabilities.filePicker`). */
  pickSyncFile?(mode: 'open' | 'create'): Promise<{ readonly documentUri: string; readonly displayName: string } | undefined>;
  /** Android SAF tree picker / desktop folder browser (`capabilities.folderPicker`). */
  pickFolder?(): Promise<LocalFolderRef | undefined>;
  /** Desktop server-side path browser. */
  listDirectory?(path?: string): Promise<{ readonly path: string; readonly parent?: string; readonly dirs: readonly string[] }>;
  /** OPML export: Android `ACTION_CREATE_DOCUMENT`; desktop triggers a download. */
  saveTextFile(name: string, text: string, mime: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

// ---------------------------------------------------------------------------
// §K.1 In-App Auto-Updater (`codescv/minipod` GitHub Releases)
// ---------------------------------------------------------------------------

export interface ReleaseInfo {
  readonly tagName: string;
  readonly version: string;
  readonly title: string;
  readonly notes: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
  readonly apkUrl?: string;
  readonly apkName?: string;
  readonly apkSizeBytes?: number;
  readonly tarballUrl?: string;
  readonly tarballName?: string;
  readonly tarballSizeBytes?: number;
}

export interface HostUpdateCheckResult {
  readonly currentVersion: string;
  readonly updateAvailable: boolean;
  readonly release?: ReleaseInfo;
  readonly checkedAt: EpochMs;
}

export interface HostUpdateApplyResult {
  readonly ok: boolean;
  readonly method: 'git-pull' | 'release-bundle' | 'android-apk' | 'up-to-date' | 'external';
  readonly previousVersion: string;
  readonly targetVersion: string;
  readonly restartRequired?: boolean;
  readonly bundlePath?: string;
  readonly needsPermission?: boolean;
  readonly message: string;
}

export interface UpdaterApi {
  check(options?: { readonly currentVersion?: string }): Promise<HostUpdateCheckResult>;
  apply(options?: { readonly force?: boolean }): Promise<HostUpdateApplyResult>;
}

export type HostEvent =
  | { readonly type: 'feeds-changed' }
  | { readonly type: 'feed-refreshed'; readonly feedKey: FeedKey; readonly error?: MiniPodErrorShape }
  | { readonly type: 'episodes-changed'; readonly feedKey: FeedKey }
  | { readonly type: 'queue-changed' }
  | { readonly type: 'progress-changed'; readonly episodeKey: EpisodeKey; readonly fromSync?: { readonly deviceName: string; readonly positionMs: number; readonly state: ProgressState } }
  | { readonly type: 'download-updated'; readonly episodeKey: EpisodeKey; readonly state: DownloadState; readonly progress?: number; readonly error?: MiniPodErrorShape }
  | { readonly type: 'sync-status'; readonly status: SyncStatus }
  | { readonly type: 'settings-changed'; readonly settings: AppSettings }
  /** Deep link / share intent / CLI arg routed to the Add screen. */
  | { readonly type: 'open-add'; readonly input: string }
  | { readonly type: 'host-notice'; readonly level: 'info' | 'warning'; readonly message: string };

export interface PlatformHost {
  readonly info: HostInfo;
  readonly feeds: FeedsApi;
  readonly search: SearchApi;
  readonly episodes: EpisodesApi;
  readonly queue: QueueApi;
  readonly progress: ProgressApi;
  readonly playback: PlaybackApi;
  readonly sync: SyncApi;
  readonly files: FilesApi;
  readonly settings: SettingsApi;
  readonly updater?: UpdaterApi;
  subscribe(listener: (event: HostEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// §L. Constants shared by UI and hosts
// ---------------------------------------------------------------------------

export const SKIP_BACK_MS = 10_000;
export const SKIP_FORWARD_MS = 30_000;
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3.0;
export const SPEED_PRESETS: readonly number[] = [1.0, 1.25, 1.5, 1.75, 2.0];
export const RESUME_REWIND_MS = 3_000;
export const COMPLETION_TAIL_MS = 1_000;
export const LOCAL_PROGRESS_INTERVAL_MS = 5_000;
export const SYNC_PLAYING_CHECKPOINT_MS = 180_000;
export const SYNC_DEBOUNCE_SHORT_MS = 2_000;
export const SYNC_DEBOUNCE_QUEUE_MS = 5_000;
export const SYNC_PERIODIC_MS = 15 * 60_000;
export const SYNC_PULL_THROTTLE_MS = 20_000;
export const HLC_MAX_FORWARD_SKEW_MS = 5 * 60_000;
export const TOMBSTONE_TTL_SUBSCRIPTIONS_MS = 180 * 24 * 60 * 60_000;
export const TOMBSTONE_TTL_QUEUE_MS = 30 * 24 * 60 * 60_000;
export const PROGRESS_MAX_ENTRIES = 50_000;
export const QUEUE_MAX_ENTRIES = 1_000;
export const SUBSCRIPTIONS_MAX_ENTRIES = 5_000;
export const GIST_GZIP_THRESHOLD_BYTES = 800 * 1024;
export const COMBINED_SEARCH_TIMEOUT_MS = 10_000;
export const TOP_CHARTS_LIMIT = 25;
export const COUNTRY_CODE_UNSET: CountryCode = '99';
export const LAYOUT_EXPANDED_MIN_WIDTH_PX = 840;
export const USER_AGENT_PREFIX = 'MiniPod';
export const LOCAL_FOLDER_URL_PREFIX = 'local-folder:';

/** Public default PodcastIndex key pair shipped by AntennaPod (`net/discovery/build.gradle`); forks should register their own. */
export const DEFAULT_PODCASTINDEX_KEYS: PodcastIndexKeys = {
  key: 'XTMMQGA2YZ4WJUBYY4HK',
  secret: 'XAaAhk4^2YBsTE33vdbwbZNj82ZRLABDDqFdKe7x',
};
