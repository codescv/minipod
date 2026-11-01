/**
 * Stateful in-memory `MockPlatformHost` and `MockPlayerEngine` (`@minipod/ui/dev`).
 *
 * Powers `pnpm dev:ui` and Vitest + Testing Library suites without a backend or native shell,
 * exercising subscriptions, federated search, Top Charts, URL/scheme normalization,
 * HTTP 401 Basic Auth retry, multi-feed HTML `<link rel="alternate">` selection,
 * unsubscribed preview streaming, RFC 5005 pagination, OPML import/export, local folders,
 * unified queue fractional reordering, chapters, sleep timer, and zero-cost cloud sync.
 */
import {
  COUNTRY_CODE_UNSET,
  LOCAL_FOLDER_URL_PREFIX,
  MiniPodError,
  type AppSettings,
  type Chapter,
  type CountryCode,
  type DownloadState,
  type Episode,
  type EpisodeFilter,
  type EpisodeKey,
  type EpisodeRow,
  type Feed,
  type FeedKey,
  type FeedPreview,
  type HostCapabilities,
  type HostEvent,
  type HostInfo,
  type HostPlatform,
  type HttpBasicCredentials,
  type LocalFolderRef,
  type MediaSource,
  type OpmlCandidate,
  type Page,
  type ParsedEpisode,
  type ParsedFeed,
  type PlatformHost,
  type PlayerEngine,
  type PlayerEngineCapabilities,
  type PlayerEvent,
  type PlayerLoadItem,
  type PlayerSnapshot,
  type ProgressRecord,
  type ProgressSave,
  type ProgressState,
  type QueueEntry,
  type QueueItemSource,
  type QueueRow,
  type ResolveResult,
  type SearchResult,
  type SleepTimer,
  type SourceId,
  type SyncProviderSecret,
  type SyncSettings,
  type SyncStatus,
  type Unsubscribe,
  type UpdaterApi,
} from '@minipod/core';
import { deriveEpisodeKey, deriveFeedKey, prepareFeedUrl } from '../lib/identity';
import { clampSpeed } from '../player/PlayerEngine';
import { SleepTimerController } from '../player/SleepTimer';
import { DEFAULT_APP_SETTINGS } from '../stores/settings';

function svgCover(bg1: string, bg2: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg2}"/></linearGradient></defs><rect width="240" height="240" rx="28" fill="url(#g)"/><text x="120" y="136" font-family="system-ui,sans-serif" font-size="56" font-weight="700" fill="#ffffff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface MockHostOptions {
  readonly platform?: HostPlatform | undefined;
  readonly appVersion?: string | undefined;
  readonly capabilities?: Partial<HostCapabilities> | undefined;
  readonly initialSettings?: Partial<AppSettings> | undefined;
  readonly updater?: UpdaterApi | undefined;
  readonly empty?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_DESKTOP_CAPABILITIES: HostCapabilities = {
  nativeAudio: false,
  downloads: true,
  localFolderFeeds: true,
  syncProviders: ['local-folder', 'drive-appdata', 'drive-file', 'webdav', 'gist'],
  filePicker: false,
  folderPicker: false,
  backgroundSync: true,
  openExternal: true,
};

const DEFAULT_ANDROID_CAPABILITIES: HostCapabilities = {
  nativeAudio: true,
  downloads: true,
  localFolderFeeds: true,
  syncProviders: ['saf', 'drive-appdata', 'drive-file', 'webdav', 'gist'],
  filePicker: true,
  folderPicker: true,
  backgroundSync: false,
  openExternal: true,
};

const COUNTRIES: readonly { readonly code: CountryCode; readonly name: string }[] = [
  { code: COUNTRY_CODE_UNSET, name: 'Global (Default)' },
  { code: 'US', name: 'United States' },
  { code: 'CN', name: 'China' },
  { code: 'JP', name: 'Japan' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
];

const CATALOG_SEARCH_RESULTS: readonly SearchResult[] = [
  {
    title: 'Accidental Tech Podcast',
    author: 'Marco Arment, Casey Liss, John Siracusa',
    imageUrl: svgCover('#1d4ed8', '#0ea5e9', 'ATP'),
    feedUrl: 'https://feeds.example.org/atp.xml',
    source: 'apple',
  },
  {
    title: 'Linux Unplugged',
    author: 'Jupiter Broadcasting',
    imageUrl: svgCover('#0f766e', '#14b8a6', 'LUP'),
    feedUrl: 'https://feeds.example.org/linux-unplugged.xml',
    source: 'podcastindex',
  },
  {
    title: 'Open Web Craft',
    author: 'Indie Audio Collective',
    imageUrl: svgCover('#6d28d9', '#a855f7', 'OWC'),
    feedUrl: 'https://feeds.example.org/open-web-craft.xml',
    source: 'fyyd',
  },
  {
    title: 'Free Software Weekly',
    author: 'gpodder Community',
    imageUrl: svgCover('#b45309', '#f59e0b', 'FSW'),
    feedUrl: 'https://feeds.example.org/free-software-weekly.xml',
    source: 'gpodder',
  },
  {
    title: '科技早知道 · Tech Early Know',
    author: '声动活泼',
    imageUrl: svgCover('#be123c', '#fb7185', '早'),
    feedUrl: 'https://feeds.example.org/tech-early.xml',
    source: 'apple',
  },
];

export class MockPlatformHost implements PlatformHost {
  readonly info: HostInfo;
  readonly updater?: UpdaterApi;

  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly feedsMap = new Map<FeedKey, Feed>();
  private readonly episodesMap = new Map<EpisodeKey, Episode>();
  private readonly feedEpisodeOrder = new Map<FeedKey, EpisodeKey[]>();
  private readonly chaptersMap = new Map<EpisodeKey, readonly Chapter[]>();
  private readonly progressMap = new Map<EpisodeKey, ProgressRecord>();
  private readonly credentialsMap = new Map<FeedKey, HttpBasicCredentials>();
  private readonly previewsMap = new Map<string, FeedPreview>();
  private readonly olderPagesMap = new Map<string, readonly ParsedEpisode[]>();
  private queueOrder: QueueEntry[] = [];
  private settingsState: AppSettings;
  private syncStatusState: SyncStatus;
  private lastSecret: SyncProviderSecret | undefined;
  private hlcCounter = 1_760_000_000_000;
  private readonly nowFn: () => number;

  /** Recorded external URLs & saved files for assertions in UI tests. */
  readonly openedExternalUrls: string[] = [];
  readonly savedFiles: { readonly name: string; readonly text: string; readonly mime: string }[] = [];
  readonly progressSaves: ProgressSave[] = [];

  constructor(options?: MockHostOptions) {
    this.nowFn = options?.now ?? (() => Date.now());
    const platform = options?.platform ?? 'desktop';
    const baseCaps =
      platform === 'android' ? DEFAULT_ANDROID_CAPABILITIES : DEFAULT_DESKTOP_CAPABILITIES;
    const capabilities: HostCapabilities = {
      ...baseCaps,
      ...options?.capabilities,
    };

    const deviceName =
      options?.initialSettings?.sync?.deviceName ??
      (platform === 'android' ? 'Pixel 9' : 'ThinkPad Linux');

    this.info = {
      platform,
      os: platform === 'android' ? 'Android 15' : 'Linux x86_64',
      appVersion: options?.appVersion ?? '0.1.22',
      capabilities,
      deviceId: 'd_0123456789abcdef0123456789abcdef',
      deviceName,
      ...(platform === 'desktop' ? { dataDir: '~/.local/share/minipod' } : {}),
    };
    if (options?.updater) {
      this.updater = options.updater;
    }

    this.settingsState = {
      ...DEFAULT_APP_SETTINGS,
      ...options?.initialSettings,
      sync: {
        ...DEFAULT_APP_SETTINGS.sync,
        deviceName,
        ...options?.initialSettings?.sync,
      },
    };

    this.syncStatusState = {
      enabled: Boolean(this.settingsState.sync.provider),
      ...(this.settingsState.sync.provider ? { provider: this.settingsState.sync.provider.id } : {}),
      phase: this.settingsState.sync.provider ? 'idle' : 'off',
      dirtyCount: 0,
      backgroundSync: capabilities.backgroundSync,
    };

    if (!options?.empty) {
      this.seedSampleData();
    }
  }

  private nextHlc(): number {
    this.hlcCounter = Math.max(this.hlcCounter + 1, this.nowFn());
    return this.hlcCounter;
  }

  emit(event: HostEvent): void {
    for (const fn of this.listeners) {
      fn(event);
    }
  }

  /** Test & dev helper: simulate an incoming cross-device sync progress update. */
  simulateRemoteProgress(
    episodeKey: EpisodeKey,
    positionMs: number,
    deviceName: string,
    state: ProgressState = 'IN_PROGRESS',
  ): void {
    const ep = this.episodesMap.get(episodeKey);
    const feedKey = ep?.feedKey ?? ('f_remote' as FeedKey);
    const ts = this.nextHlc();
    this.progressMap.set(episodeKey, {
      episodeKey,
      feedKey,
      positionMs,
      ...(ep?.durationMs !== undefined ? { durationMs: ep.durationMs } : {}),
      state,
      ...(state === 'PLAYED' ? { playedAt: ts } : {}),
      updatedAt: ts,
      deviceId: 'd_remote99999999999999999999999999',
    });
    this.emit({
      type: 'progress-changed',
      episodeKey,
      fromSync: { deviceName, positionMs, state },
    });
  }

  getStoredSecret(): SyncProviderSecret | undefined {
    return this.lastSecret;
  }

  private seedSampleData(): void {
    const baseTime = 1_760_000_000_000;

    // 1. Syntax & Signal (with RFC 5005 nextPageUrl, chapters, video episode, progress, download)
    const url1 = 'https://feeds.example.org/syntax-signal.xml';
    const fk1 = deriveFeedKey(url1);
    const nextUrl1 = 'https://feeds.example.org/syntax-signal.xml?page=2';
    this.feedsMap.set(fk1, {
      feedKey: fk1,
      kind: 'RSS',
      subscribed: true,
      url: url1,
      title: 'Syntax & Signal',
      author: 'Clara Vance & Leo Park',
      description:
        'Deep dives into systems architecture, audio codecs, CRDT cloud sync, and minimalist software craft.',
      link: 'https://syntax-signal.example.org',
      imageUrl: svgCover('#1e3a8a', '#0284c7', 'S&S'),
      language: 'en',
      hasCredentials: false,
      nextPageUrl: nextUrl1,
      lastRefreshedAt: baseTime,
      lastEpisodeAt: baseTime - 3_600_000,
      addedAt: baseTime - 86_400_000 * 10,
      updatedAt: baseTime,
    });

    const f1Episodes: ParsedEpisode[] = [
      {
        identity: 'ss-ep-42',
        title: '42: Zero-Backend Sync with Hybrid Logical Clocks',
        description:
          '<p>How two podcast players converge over a single JSON file on Google Drive, WebDAV, or Syncthing.</p><ul><li>Monotone tombstones</li><li>Fractional indexing</li><li><a href="https://antennapod.org">AntennaPod upstream</a></li></ul>',
        link: 'https://syntax-signal.example.org/42',
        pubDate: baseTime - 3_600_000 * 6,
        durationMs: 2_400_000,
        enclosureUrl: 'https://cdn.example.org/ss/42.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
        chapters: [
          { startMs: 0, title: 'Cold Open & Problem Statement', source: 'PSC' },
          {
            startMs: 360_000,
            title: 'Hybrid Logical Clocks Explained',
            imageUrl: svgCover('#0f766e', '#2dd4bf', 'HLC'),
            source: 'PI_JSON',
          },
          { startMs: 1_080_000, title: 'Fractional Queue Ordering', source: 'PI_JSON' },
          { startMs: 1_860_000, title: 'Conditional Writes & Wrap-Up', source: 'PSC' },
        ],
      },
      {
        identity: 'ss-ep-41',
        title: '41: Parsing 15 Years of Wild RSS & Atom Feeds',
        description: '<p>Handling RDF, Atom RFC 5005 paged archives, and permanent 301 redirects.</p>',
        pubDate: baseTime - 86_400_000 * 7,
        durationMs: 1_980_000,
        enclosureUrl: 'https://cdn.example.org/ss/41.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
      {
        identity: 'ss-ep-40-video',
        title: '40: Live Studio Walkthrough (Video Special)',
        description: '<p>Video tour of our hardware audio chain and live chapter tagging setup.</p>',
        pubDate: baseTime - 86_400_000 * 14,
        durationMs: 1_500_000,
        enclosureUrl: 'https://cdn.example.org/ss/40.mp4',
        enclosureMime: 'video/mp4',
        mediaType: 'VIDEO',
      },
      {
        identity: 'ss-ep-39',
        title: '39: SQLite WAL Mode on Desktop',
        description: '<p>Why node:sqlite needs zero native C++ addons in Node 22.</p>',
        pubDate: baseTime - 86_400_000 * 21,
        durationMs: 2_100_000,
        enclosureUrl: 'https://cdn.example.org/ss/39.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
    ];
    const f1Keys = this.insertParsedEpisodes(fk1, f1Episodes, {
      downloadedIndices: new Set([0]),
    });

    // Older archive page for RFC 5005 `loadOlder`
    this.olderPagesMap.set(nextUrl1, [
      {
        identity: 'ss-ep-38-archive',
        title: '38: Archive — Designing Calm Interfaces',
        description: '<p>Why removing unread badges lowers listener anxiety.</p>',
        pubDate: baseTime - 86_400_000 * 28,
        durationMs: 1_740_000,
        enclosureUrl: 'https://cdn.example.org/ss/38.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
      {
        identity: 'ss-ep-37-archive',
        title: '37: Archive — Media3 & Foreground Services',
        description: '<p>Keeping audio rock-solid when the Android WebView is backgrounded.</p>',
        pubDate: baseTime - 86_400_000 * 35,
        durationMs: 1_920_000,
        enclosureUrl: 'https://cdn.example.org/ss/37.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
    ]);

    // Progress on ep 42 (IN_PROGRESS 8m / 40m) and ep 41 (PLAYED)
    const ep42Key = f1Keys[0]!;
    const ep41Key = f1Keys[1]!;
    this.progressMap.set(ep42Key, {
      episodeKey: ep42Key,
      feedKey: fk1,
      positionMs: 480_000,
      durationMs: 2_400_000,
      state: 'IN_PROGRESS',
      updatedAt: baseTime - 1_800_000,
      deviceId: this.info.deviceId,
    });
    this.progressMap.set(ep41Key, {
      episodeKey: ep41Key,
      feedKey: fk1,
      positionMs: 0,
      durationMs: 1_980_000,
      state: 'PLAYED',
      playedAt: baseTime - 86_400_000 * 2,
      updatedAt: baseTime - 86_400_000 * 2,
      deviceId: this.info.deviceId,
    });

    // 2. 内核茶话会 (Kernel Tea)
    const url2 = 'https://feeds.example.org/kernel-tea.xml';
    const fk2 = deriveFeedKey(url2);
    this.feedsMap.set(fk2, {
      feedKey: fk2,
      kind: 'RSS',
      subscribed: true,
      url: url2,
      title: '内核茶话会',
      author: '林舟 & 苏澄',
      description: '每周畅聊操作系统、编译器、开源社区与极简数字生活。',
      link: 'https://kernel-tea.example.org',
      imageUrl: svgCover('#065f46', '#10b981', '茶'),
      language: 'zh-CN',
      hasCredentials: false,
      lastRefreshedAt: baseTime,
      lastEpisodeAt: baseTime - 7_200_000,
      addedAt: baseTime - 86_400_000 * 8,
      updatedAt: baseTime,
    });
    const f2Keys = this.insertParsedEpisodes(
      fk2,
      [
        {
          identity: 'kt-18',
          title: 'Vol.18 为什么我们只需要一个播放队列？',
          description: '<p>从纸质待办清单聊到极简播客客户端的信息架构减法。</p>',
          pubDate: baseTime - 7_200_000,
          durationMs: 2_760_000,
          enclosureUrl: 'https://cdn.example.org/kt/18.mp3',
          enclosureMime: 'audio/mpeg',
          mediaType: 'AUDIO',
          chapters: [
            { startMs: 0, title: '开场：收件箱焦虑从何而来', source: 'PSC' },
            { startMs: 900_000, title: '单一队列的流畅体验', source: 'PSC' },
          ],
        },
        {
          identity: 'kt-17',
          title: 'Vol.17 WebAssembly 与跨平台音频工具链',
          description: '<p>深入剖析现代浏览器与原生宿主之间的边界设计。</p>',
          pubDate: baseTime - 86_400_000 * 6,
          durationMs: 3_120_000,
          enclosureUrl: 'https://cdn.example.org/kt/17.mp3',
          enclosureMime: 'audio/mpeg',
          mediaType: 'AUDIO',
        },
      ],
      { downloadedIndices: new Set([1]) },
    );

    // 3. Minimalist Design Radio
    const url3 = 'https://feeds.example.org/minimalist-radio.xml';
    const fk3 = deriveFeedKey(url3);
    this.feedsMap.set(fk3, {
      feedKey: fk3,
      kind: 'RSS',
      subscribed: true,
      url: url3,
      title: 'Minimalist Design Radio',
      author: 'Studio Kanso',
      description: 'Quiet conversations on typography, Material You color harmony, and calm technology.',
      link: 'https://kanso.example.org',
      imageUrl: svgCover('#4c1d95', '#8b5cf6', 'MDR'),
      language: 'en',
      hasCredentials: false,
      lastRefreshedAt: baseTime,
      lastEpisodeAt: baseTime - 86_400_000,
      addedAt: baseTime - 86_400_000 * 5,
      updatedAt: baseTime,
    });
    const f3Keys = this.insertParsedEpisodes(fk3, [
      {
        identity: 'mdr-09',
        title: '09: Dynamic Color Without Visual Noise',
        description: '<p>Using Material 3 tonal surfaces instead of heavy borders and badges.</p>',
        pubDate: baseTime - 86_400_000,
        durationMs: 1_680_000,
        enclosureUrl: 'https://cdn.example.org/mdr/09.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
      {
        identity: 'mdr-08',
        title: '08: Designing Keyboard-First Media Controls',
        description: '<p>J/L skipping, bracket speed controls, and predictable focus rings.</p>',
        pubDate: baseTime - 86_400_000 * 9,
        durationMs: 1_440_000,
        enclosureUrl: 'https://cdn.example.org/mdr/08.mp3',
        enclosureMime: 'audio/mpeg',
        mediaType: 'AUDIO',
      },
    ]);

    // Seed unified queue with 3 episodes
    this.enqueueInternal(ep42Key);
    this.enqueueInternal(f2Keys[0]!);
    this.enqueueInternal(f3Keys[0]!);
  }

  private insertParsedEpisodes(
    feedKey: FeedKey,
    parsedList: readonly ParsedEpisode[],
    opts?: { readonly downloadedIndices?: ReadonlySet<number>; readonly isStub?: boolean },
  ): EpisodeKey[] {
    const existingOrder = this.feedEpisodeOrder.get(feedKey) ?? [];
    const keys: EpisodeKey[] = [];
    parsedList.forEach((p, idx) => {
      const epKey = deriveEpisodeKey(feedKey, p.identity);
      keys.push(epKey);
      const prev = this.episodesMap.get(epKey);
      const dlState: DownloadState =
        prev?.downloadState ?? (opts?.downloadedIndices?.has(idx) ? 'DONE' : 'NONE');
      const ep: Episode = {
        episodeKey: epKey,
        feedKey,
        identity: p.identity,
        isStub: opts?.isStub ?? false,
        title: p.title,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.link !== undefined ? { link: p.link } : {}),
        ...(p.imageUrl !== undefined ? { imageUrl: p.imageUrl } : {}),
        ...(p.pubDate !== undefined ? { pubDate: p.pubDate } : {}),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
        ...(p.enclosureUrl !== undefined ? { enclosureUrl: p.enclosureUrl } : {}),
        ...(p.enclosureMime !== undefined ? { enclosureMime: p.enclosureMime } : {}),
        ...(p.enclosureSize !== undefined ? { enclosureSize: p.enclosureSize } : {}),
        mediaType: p.mediaType,
        ...(p.chaptersUrl !== undefined ? { chaptersUrl: p.chaptersUrl } : {}),
        ...(p.chaptersType !== undefined ? { chaptersType: p.chaptersType } : {}),
        ...(p.transcriptUrl !== undefined ? { transcriptUrl: p.transcriptUrl } : {}),
        ...(p.transcriptType !== undefined ? { transcriptType: p.transcriptType } : {}),
        downloadState: dlState,
        ...(dlState === 'DONE' ? { downloadPath: `/mock/downloads/${epKey}.mp3` } : {}),
      };
      this.episodesMap.set(epKey, ep);
      if (p.chapters && p.chapters.length > 0) {
        this.chaptersMap.set(epKey, p.chapters);
      }
      if (!existingOrder.includes(epKey)) {
        existingOrder.push(epKey);
      }
    });
    this.feedEpisodeOrder.set(feedKey, existingOrder);
    return keys;
  }

  private reindexQueuePositions(): void {
    this.queueOrder = this.queueOrder.map((entry, idx) => ({
      ...entry,
      pos: `a${idx.toString(36).padStart(3, '0')}`,
    }));
  }

  private buildQueueStub(ep: Episode): QueueEntry['stub'] {
    const feed = this.feedsMap.get(ep.feedKey);
    return {
      identity: ep.identity,
      title: ep.title,
      ...(feed?.title !== undefined ? { feedTitle: feed.title } : {}),
      feedUrl: feed?.url ?? 'https://feeds.example.org/unknown.xml',
      ...(ep.enclosureUrl !== undefined ? { enclosureUrl: ep.enclosureUrl } : {}),
      ...(ep.enclosureMime !== undefined ? { enclosureMime: ep.enclosureMime } : {}),
      ...(ep.durationMs !== undefined ? { durationMs: ep.durationMs } : {}),
      ...(ep.imageUrl !== undefined
        ? { imageUrl: ep.imageUrl }
        : feed?.imageUrl !== undefined
          ? { imageUrl: feed.imageUrl }
          : {}),
      ...(ep.pubDate !== undefined ? { pubDate: ep.pubDate } : {}),
    };
  }

  private enqueueInternal(episodeKey: EpisodeKey, atFront = false): void {
    const ep = this.episodesMap.get(episodeKey);
    if (!ep) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    const existingIdx = this.queueOrder.findIndex((q) => q.episodeKey === episodeKey);
    if (existingIdx >= 0) {
      if (atFront && existingIdx > 0) {
        const [item] = this.queueOrder.splice(existingIdx, 1);
        if (item) this.queueOrder.unshift({ ...item, updatedAt: this.nextHlc() });
        this.reindexQueuePositions();
      }
      return;
    }
    const ts = this.nextHlc();
    const stub = this.buildQueueStub(ep);
    const entry: QueueEntry = {
      episodeKey,
      feedKey: ep.feedKey,
      pos: 'a000',
      addedAt: ts,
      updatedAt: ts,
      removed: false,
      deviceId: this.info.deviceId,
      ...(stub ? { stub } : {}),
    };
    if (atFront) {
      this.queueOrder.unshift(entry);
    } else {
      this.queueOrder.push(entry);
    }
    this.reindexQueuePositions();
  }

  private resolveUrlInternal(rawInput: string, credentials?: HttpBasicCredentials): ResolveResult {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new MiniPodError('invalid-url', 'Feed URL is empty');
    }

    // Translate Apple Podcast page / lookup URLs into canonical feed URLs
    let normalized = prepareFeedUrl(trimmed);
    const appleIdMatch = /(?:podcasts|itunes)\.apple\.com\/.*?(?:id=|\/id)(\d+)/i.exec(normalized);
    if (appleIdMatch) {
      normalized = `https://feeds.example.org/apple-podcast-${appleIdMatch[1]}.xml`;
    }

    const lower = normalized.toLowerCase();

    // Multi-feed HTML `<link rel="alternate">` discovery simulation
    if (
      lower.includes('multi.example') ||
      lower.includes('multi-feed') ||
      lower.endsWith('blog.example.org') ||
      lower.endsWith('blog.example.org/')
    ) {
      return {
        kind: 'choices',
        pageUrl: normalized,
        choices: [
          {
            url: 'https://feeds.example.org/blog-audio.xml',
            title: 'Engineering Blog Podcast (MP3)',
            type: 'application/rss+xml',
          },
          {
            url: 'https://feeds.example.org/blog-atom.xml',
            title: 'Engineering Blog Video Cast (Atom)',
            type: 'application/atom+xml',
          },
        ],
      };
    }

    const feedKey = deriveFeedKey(normalized);
    const storedCreds = credentials ?? this.credentialsMap.get(feedKey);

    // HTTP 401 Basic Auth protected feed simulation
    if (lower.includes('private') || lower.includes('protected') || lower.includes('401')) {
      if (!storedCreds || !storedCreds.username.trim() || !storedCreds.password || storedCreds.password === 'wrong') {
        return {
          kind: 'auth-required',
          url: normalized,
          realm: 'Subscriber-Only Private Feed',
        };
      }
      this.credentialsMap.set(feedKey, storedCreds);
    }

    const existingFeed = this.feedsMap.get(feedKey);
    const catalogMatch = CATALOG_SEARCH_RESULTS.find((c) => c.feedUrl === normalized);
    const slug =
      new URL(normalized).pathname
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/\.(xml|rss|atom)$/i, '') ?? 'podcast';
    const prettySlug = slug
      .split(/[-_]+/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
      .join(' ');

    const title =
      existingFeed?.title ??
      catalogMatch?.title ??
      (lower.includes('private') ? 'Members Bonus Show (Private)' : prettySlug || 'Indie Feed');
    const author = existingFeed?.author ?? catalogMatch?.author ?? 'Independent Creator';
    const imageUrl =
      existingFeed?.imageUrl ?? catalogMatch?.imageUrl ?? svgCover('#334155', '#64748b', title.slice(0, 2).toUpperCase());
    const description =
      existingFeed?.description ??
      `Episodes from ${title} (${normalized}). Supports chapters, queue, and zero-cost sync.`;

    const existingEpKeys = this.feedEpisodeOrder.get(feedKey);
    const parsedEpisodes: ParsedEpisode[] =
      existingEpKeys && existingEpKeys.length > 0
        ? existingEpKeys.map((k) => {
            const e = this.episodesMap.get(k)!;
            const chs = this.chaptersMap.get(k);
            return {
              identity: e.identity,
              title: e.title,
              ...(e.description !== undefined ? { description: e.description } : {}),
              ...(e.pubDate !== undefined ? { pubDate: e.pubDate } : {}),
              ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
              ...(e.enclosureUrl !== undefined ? { enclosureUrl: e.enclosureUrl } : {}),
              ...(e.enclosureMime !== undefined ? { enclosureMime: e.enclosureMime } : {}),
              mediaType: e.mediaType,
              ...(chs ? { chapters: chs } : {}),
            };
          })
        : [
            {
              identity: `${slug}-ep-2`,
              title: `${title} — Episode 2: Deep Dive`,
              description: `<p>Latest episode of <strong>${title}</strong>.</p>`,
              pubDate: this.nowFn() - 86_400_000,
              durationMs: 1_800_000,
              enclosureUrl: `https://cdn.example.org/${slug}/ep2.mp3`,
              enclosureMime: 'audio/mpeg',
              mediaType: 'AUDIO',
              chapters: [
                { startMs: 0, title: 'Intro', source: 'PSC' },
                { startMs: 600_000, title: 'Main Topic', source: 'PSC' },
              ],
            },
            {
              identity: `${slug}-ep-1`,
              title: `${title} — Episode 1: Pilot`,
              description: `<p>First episode of ${title}.</p>`,
              pubDate: this.nowFn() - 86_400_000 * 8,
              durationMs: 1_500_000,
              enclosureUrl: `https://cdn.example.org/${slug}/ep1.mp3`,
              enclosureMime: 'audio/mpeg',
              mediaType: 'AUDIO',
            },
          ];

    const parsedFeed: ParsedFeed = {
      type: lower.includes('atom') ? 'atom' : 'rss20',
      title,
      author,
      description,
      link: `https://${new URL(normalized).hostname}`,
      imageUrl,
      language: 'en',
      ...(existingFeed?.nextPageUrl ? { nextPageUrl: existingFeed.nextPageUrl } : {}),
      episodes: parsedEpisodes,
    };

    // Materialize a hidden `subscribed: false` stub if not yet in `feedsMap` so direct `▶` preview
    // streaming, queue, and progress recording work without subscribing (DESIGN.md §4.2, ARCH §6.1).
    if (!existingFeed) {
      const ts = this.nextHlc();
      this.feedsMap.set(feedKey, {
        feedKey,
        kind: 'RSS',
        subscribed: false,
        url: normalized,
        title,
        author,
        description,
        imageUrl,
        hasCredentials: this.credentialsMap.has(feedKey),
        addedAt: ts,
        updatedAt: ts,
      });
      this.insertParsedEpisodes(feedKey, parsedEpisodes, { isStub: false });
    }

    const previewId = `prev_${feedKey}_${this.nextHlc()}`;
    const preview: FeedPreview = {
      previewId,
      feedKey,
      url: normalized,
      parsed: parsedFeed,
      episodeCount: parsedEpisodes.length,
      alreadySubscribed: Boolean(existingFeed?.subscribed && !existingFeed.deletedAt),
    };
    this.previewsMap.set(previewId, preview);

    return { kind: 'feed', preview };
  }

  readonly feeds: PlatformHost['feeds'] = {
    list: async () =>
      Array.from(this.feedsMap.values())
        .filter((f) => f.subscribed && !f.deletedAt)
        .sort((a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url)),

    get: async (feedKey) => {
      const feed = this.feedsMap.get(feedKey);
      if (!feed) throw new MiniPodError('feed-not-found', `Feed not found: ${feedKey}`);
      return feed;
    },

    preview: async (url, credentials) => this.resolveUrlInternal(url, credentials),

    subscribe: async (previewIdOrUrl) => {
      let preview = this.previewsMap.get(previewIdOrUrl);
      if (!preview) {
        const res = this.resolveUrlInternal(previewIdOrUrl);
        if (res.kind !== 'feed') {
          throw new MiniPodError('unsupported-feed', 'Input did not resolve directly to a single feed');
        }
        preview = res.preview;
      }
      const ts = this.nextHlc();
      const existing = this.feedsMap.get(preview.feedKey);
      const subscribedFeed: Feed = {
        feedKey: preview.feedKey,
        kind: 'RSS',
        subscribed: true,
        url: preview.url,
        ...(preview.parsed.title !== undefined ? { title: preview.parsed.title } : {}),
        ...(preview.parsed.author !== undefined ? { author: preview.parsed.author } : {}),
        ...(preview.parsed.description !== undefined ? { description: preview.parsed.description } : {}),
        ...(preview.parsed.link !== undefined ? { link: preview.parsed.link } : {}),
        ...(preview.parsed.imageUrl !== undefined ? { imageUrl: preview.parsed.imageUrl } : {}),
        ...(preview.parsed.language !== undefined ? { language: preview.parsed.language } : {}),
        hasCredentials: existing?.hasCredentials ?? this.credentialsMap.has(preview.feedKey),
        ...(preview.parsed.nextPageUrl !== undefined ? { nextPageUrl: preview.parsed.nextPageUrl } : {}),
        lastRefreshedAt: this.nowFn(),
        addedAt: existing?.addedAt ?? ts,
        updatedAt: ts,
      };
      this.feedsMap.set(preview.feedKey, subscribedFeed);
      this.insertParsedEpisodes(preview.feedKey, preview.parsed.episodes);
      this.bumpDirty();
      this.emit({ type: 'feeds-changed' });
      return subscribedFeed;
    },

    unsubscribe: async (feedKey) => {
      const existing = this.feedsMap.get(feedKey);
      if (!existing) return;
      const ts = this.nextHlc();
      this.feedsMap.set(feedKey, {
        ...existing,
        subscribed: false,
        updatedAt: ts,
        deletedAt: ts,
      });
      this.bumpDirty();
      this.emit({ type: 'feeds-changed' });
    },

    refresh: async (feedKey) => {
      const targets = feedKey
        ? [this.feedsMap.get(feedKey)].filter((f): f is Feed => Boolean(f))
        : Array.from(this.feedsMap.values()).filter((f) => f.subscribed && !f.deletedAt);
      const now = this.nowFn();
      for (const f of targets) {
        this.feedsMap.set(f.feedKey, { ...f, lastRefreshedAt: now });
        this.emit({ type: 'feed-refreshed', feedKey: f.feedKey });
      }
      this.emit({ type: 'feeds-changed' });
    },

    loadOlder: async (feedKey) => {
      const feed = this.feedsMap.get(feedKey);
      if (!feed || !feed.nextPageUrl) return 0;
      const older = this.olderPagesMap.get(feed.nextPageUrl) ?? [];
      this.olderPagesMap.delete(feed.nextPageUrl);
      this.insertParsedEpisodes(feedKey, older);
      const { nextPageUrl: _omit, ...rest } = feed;
      void _omit;
      this.feedsMap.set(feedKey, { ...rest, updatedAt: this.nextHlc() });
      this.emit({ type: 'episodes-changed', feedKey });
      this.emit({ type: 'feeds-changed' });
      return older.length;
    },

    setCredentials: async (feedKey, credentials) => {
      if (credentials) {
        this.credentialsMap.set(feedKey, credentials);
      } else {
        this.credentialsMap.delete(feedKey);
      }
      const existing = this.feedsMap.get(feedKey);
      if (existing) {
        this.feedsMap.set(feedKey, {
          ...existing,
          hasCredentials: Boolean(credentials),
          updatedAt: this.nextHlc(),
        });
        this.emit({ type: 'feeds-changed' });
      }
    },

    addLocalFolder: async (folder: LocalFolderRef) => {
      const url = `${LOCAL_FOLDER_URL_PREFIX}${folder.ref}`;
      const feedKey = deriveFeedKey(url);
      const ts = this.nextHlc();
      const feed: Feed = {
        feedKey,
        kind: 'LOCAL',
        subscribed: true,
        url,
        title: folder.displayName,
        author: 'Local folder',
        description: `Local media files from ${folder.ref}`,
        imageUrl: svgCover('#3f3f46', '#71717a', 'DIR'),
        hasCredentials: false,
        lastRefreshedAt: this.nowFn(),
        addedAt: ts,
        updatedAt: ts,
      };
      this.feedsMap.set(feedKey, feed);
      this.insertParsedEpisodes(
        feedKey,
        [
          {
            identity: `${folder.ref}/track-01.mp3`,
            title: '01 - Audiobook Chapter 1.mp3',
            pubDate: this.nowFn() - 3_600_000,
            durationMs: 1_320_000,
            enclosureUrl: `file://${folder.ref}/track-01.mp3`,
            enclosureMime: 'audio/mpeg',
            mediaType: 'AUDIO',
          },
          {
            identity: `${folder.ref}/track-02.mp3`,
            title: '02 - Audiobook Chapter 2.mp3',
            pubDate: this.nowFn() - 1_800_000,
            durationMs: 1_480_000,
            enclosureUrl: `file://${folder.ref}/track-02.mp3`,
            enclosureMime: 'audio/mpeg',
            mediaType: 'AUDIO',
          },
        ],
        { downloadedIndices: new Set([0, 1]) },
      );
      this.emit({ type: 'feeds-changed' });
      return feed;
    },

    importOpml: async (xml) => {
      const out: OpmlCandidate[] = [];
      const seen = new Set<string>();
      const outlineRegex = /<outline\b([^>]*)\/?>/gi;
      let match: RegExpExecArray | null;
      while ((match = outlineRegex.exec(xml)) !== null) {
        const attrs = match[1] ?? '';
        const xmlUrl = /\bxmlUrl\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
        if (!xmlUrl || seen.has(xmlUrl)) continue;
        seen.add(xmlUrl);
        const title =
          /\btitle\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() ??
          /\btext\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() ??
          xmlUrl;
        const htmlUrl = /\bhtmlUrl\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
        out.push({
          title,
          xmlUrl,
          ...(htmlUrl ? { htmlUrl } : {}),
          type: 'rss',
        });
      }
      return out;
    },

    subscribeMany: async (urls) => {
      let added = 0;
      const failed: { url: string; error: { code: 'invalid-url'; message: string } }[] = [];
      for (const u of urls) {
        try {
          await this.feeds.subscribe(u);
          added++;
        } catch (err) {
          failed.push({
            url: u,
            error: { code: 'invalid-url', message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      return { added, failed };
    },

    exportOpml: async () => {
      const subs = (await this.feeds.list()).filter((f) => f.kind === 'RSS');
      const lines = subs.map((f) => {
        const safeTitle = (f.title ?? f.url).replace(/"/g, '&quot;');
        const safeUrl = f.url.replace(/"/g, '&quot;');
        return `    <outline type="rss" text="${safeTitle}" title="${safeTitle}" xmlUrl="${safeUrl}" />`;
      });
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        '  <head><title>MiniPod Subscriptions</title></head>',
        '  <body>',
        ...lines,
        '  </body>',
        '</opml>',
      ].join('\n');
    },
  };

  readonly search: PlatformHost['search'] = {
    sources: async () => [
      { id: 'combined', displayName: 'All', inCombined: false },
      { id: 'apple', displayName: 'Apple', inCombined: true },
      { id: 'podcastindex', displayName: 'PodcastIndex', inCombined: true },
      { id: 'fyyd', displayName: 'fyyd', inCombined: true },
      { id: 'gpodder', displayName: 'gpodder', inCombined: false },
    ],

    query: async (text, source: SourceId = 'combined') => {
      const q = text.trim().toLowerCase();
      if (!q) return [];
      const pool = CATALOG_SEARCH_RESULTS.filter((item) => {
        const matchesSource = source === 'combined' ? item.source !== 'gpodder' : item.source === source;
        if (!matchesSource) return false;
        return (
          item.title.toLowerCase().includes(q) ||
          (item.author?.toLowerCase().includes(q) ?? false) ||
          item.feedUrl.toLowerCase().includes(q)
        );
      });
      if (pool.length > 0) return pool;
      // Synthesize a deterministic search hit for arbitrary queries in dev/tests
      const actualSource: SourceId = source === 'combined' ? 'podcastindex' : source;
      return [
        {
          title: `${text.trim()} Podcast`,
          author: `${actualSource} Studio`,
          imageUrl: svgCover('#1e40af', '#3b82f6', text.trim().slice(0, 2).toUpperCase()),
          feedUrl: `https://feeds.example.org/search-${encodeURIComponent(q.replace(/\s+/g, '-'))}.xml`,
          source: actualSource,
        },
      ];
    },

    topCharts: async (country) => {
      if (country === 'ZZ') return [];
      const tag = country === COUNTRY_CODE_UNSET ? 'Global' : country;
      return CATALOG_SEARCH_RESULTS.map((r, idx) => ({
        ...r,
        title: country === COUNTRY_CODE_UNSET ? r.title : `${r.title} (${tag} #${idx + 1})`,
      }));
    },

    resolveUrl: async (input, credentials) => this.resolveUrlInternal(input, credentials),

    countries: async () => COUNTRIES,
  };

  readonly episodes: PlatformHost['episodes'] = {
    list: async (feedKey, filter: EpisodeFilter): Promise<Page<EpisodeRow>> => {
      const keys = this.feedEpisodeOrder.get(feedKey) ?? [];
      const queuedSet = new Set(this.queueOrder.map((q) => q.episodeKey));
      const items: EpisodeRow[] = [];
      for (const k of keys) {
        const episode = this.episodesMap.get(k);
        if (!episode) continue;
        const progress = this.progressMap.get(k);
        if (filter === 'unplayed' && progress?.state === 'PLAYED') continue;
        if (filter === 'downloaded' && episode.downloadState !== 'DONE') continue;
        items.push({
          episode,
          ...(progress ? { progress } : {}),
          inQueue: queuedSet.has(k),
        });
      }
      return { items };
    },

    get: async (episodeKey) => {
      const episode = this.episodesMap.get(episodeKey);
      if (!episode) throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
      const progress = this.progressMap.get(episodeKey);
      const inQueue = this.queueOrder.some((q) => q.episodeKey === episodeKey);
      return {
        episode,
        ...(progress ? { progress } : {}),
        inQueue,
      };
    },

    download: async (episodeKey) => {
      const ep = this.episodesMap.get(episodeKey);
      if (!ep) throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
      const updated: Episode = {
        ...ep,
        downloadState: 'DONE',
        downloadPath: `/mock/downloads/${episodeKey}.mp3`,
      };
      this.episodesMap.set(episodeKey, updated);
      this.emit({ type: 'download-updated', episodeKey, state: 'DONE', progress: 1 });
      this.emit({ type: 'episodes-changed', feedKey: ep.feedKey });
    },

    deleteDownload: async (episodeKey) => {
      const ep = this.episodesMap.get(episodeKey);
      if (!ep) return;
      const { downloadPath: _omit, ...rest } = ep;
      void _omit;
      this.episodesMap.set(episodeKey, { ...rest, downloadState: 'NONE' });
      this.emit({ type: 'download-updated', episodeKey, state: 'NONE' });
      this.emit({ type: 'episodes-changed', feedKey: ep.feedKey });
    },

    chapters: async (episodeKey) => this.chaptersMap.get(episodeKey) ?? [],

    chapterImage: async (episodeKey, chapterIndex) => {
      const list = this.chaptersMap.get(episodeKey) ?? [];
      return list[chapterIndex]?.imageUrl;
    },

    share: async (episodeKey) => {
      const ep = this.episodesMap.get(episodeKey);
      if (!ep) throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
      return {
        url: ep.link ?? ep.enclosureUrl ?? `https://share.example.org/${episodeKey}`,
        title: ep.title,
      };
    },
  };

  readonly queue: PlatformHost['queue'] = {
    list: async (): Promise<readonly QueueRow[]> =>
      this.queueOrder
        .map((entry) => {
          const episode = this.episodesMap.get(entry.episodeKey);
          if (!episode) return null;
          const progress = this.progressMap.get(entry.episodeKey);
          return {
            entry,
            episode,
            ...(progress ? { progress } : {}),
          };
        })
        .filter((r): r is QueueRow => r !== null),

    add: async (episodeKey) => {
      this.enqueueInternal(episodeKey, false);
      this.bumpDirty();
      this.emit({ type: 'queue-changed' });
    },

    playNext: async (episodeKey) => {
      // Insert at index 1 if something is at index 0, otherwise index 0
      const ep = this.episodesMap.get(episodeKey);
      if (!ep) throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
      this.queueOrder = this.queueOrder.filter((q) => q.episodeKey !== episodeKey);
      const ts = this.nextHlc();
      const stub = this.buildQueueStub(ep);
      const entry: QueueEntry = {
        episodeKey,
        feedKey: ep.feedKey,
        pos: 'a000',
        addedAt: ts,
        updatedAt: ts,
        removed: false,
        deviceId: this.info.deviceId,
        ...(stub ? { stub } : {}),
      };
      const insertAt = this.queueOrder.length > 0 ? 1 : 0;
      this.queueOrder.splice(insertAt, 0, entry);
      this.reindexQueuePositions();
      this.bumpDirty();
      this.emit({ type: 'queue-changed' });
    },

    move: async (episodeKey, beforeKey) => {
      const idx = this.queueOrder.findIndex((q) => q.episodeKey === episodeKey);
      if (idx < 0) return;
      const [item] = this.queueOrder.splice(idx, 1);
      if (!item) return;
      const moved: QueueEntry = { ...item, updatedAt: this.nextHlc() };
      if (beforeKey === null) {
        this.queueOrder.push(moved);
      } else {
        const targetIdx = this.queueOrder.findIndex((q) => q.episodeKey === beforeKey);
        if (targetIdx < 0) {
          this.queueOrder.push(moved);
        } else {
          this.queueOrder.splice(targetIdx, 0, moved);
        }
      }
      this.reindexQueuePositions();
      this.bumpDirty();
      this.emit({ type: 'queue-changed' });
    },

    remove: async (episodeKey) => {
      this.queueOrder = this.queueOrder.filter((q) => q.episodeKey !== episodeKey);
      this.reindexQueuePositions();
      this.bumpDirty();
      this.emit({ type: 'queue-changed' });
    },

    clear: async () => {
      this.queueOrder = [];
      this.bumpDirty();
      this.emit({ type: 'queue-changed' });
    },
  };

  readonly progress: PlatformHost['progress'] = {
    get: async (episodeKey) => this.progressMap.get(episodeKey),

    save: async (save) => {
      this.progressSaves.push(save);
      const ep = this.episodesMap.get(save.episodeKey);
      const feedKey = ep?.feedKey ?? ('f_unknown' as FeedKey);
      const ts = this.nextHlc();
      const record: ProgressRecord = {
        episodeKey: save.episodeKey,
        feedKey,
        positionMs: save.state === 'PLAYED' ? 0 : save.positionMs,
        ...(save.durationMs !== undefined
          ? { durationMs: save.durationMs }
          : ep?.durationMs !== undefined
            ? { durationMs: ep.durationMs }
            : {}),
        state: save.state,
        ...(save.state === 'PLAYED' ? { playedAt: ts } : {}),
        updatedAt: ts,
        deviceId: this.info.deviceId,
      };
      this.progressMap.set(save.episodeKey, record);

      if (save.state === 'PLAYED') {
        const beforeLen = this.queueOrder.length;
        this.queueOrder = this.queueOrder.filter((q) => q.episodeKey !== save.episodeKey);
        if (this.queueOrder.length !== beforeLen) {
          this.reindexQueuePositions();
          this.emit({ type: 'queue-changed' });
        }
        if (this.settingsState.deleteDownloadWhenPlayed && ep?.downloadState === 'DONE') {
          await this.episodes.deleteDownload(save.episodeKey);
        }
      }

      this.bumpDirty();
      this.emit({ type: 'progress-changed', episodeKey: save.episodeKey });
      if (ep) {
        this.emit({ type: 'episodes-changed', feedKey: ep.feedKey });
      }
    },

    markPlayed: async (episodeKey, played) => {
      const ep = this.episodesMap.get(episodeKey);
      await this.progress.save({
        episodeKey,
        positionMs: 0,
        state: played ? 'PLAYED' : 'NEW',
        ...(ep?.durationMs !== undefined ? { durationMs: ep.durationMs } : {}),
      });
    },
  };

  readonly playback: PlatformHost['playback'] = {
    sourceFor: async (episodeKey): Promise<MediaSource> => {
      const ep = this.episodesMap.get(episodeKey);
      if (!ep) throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
      if (ep.downloadState === 'DONE' && ep.downloadPath && this.info.platform === 'android') {
        return {
          kind: 'file',
          path: ep.downloadPath,
          ...(ep.enclosureMime ? { mime: ep.enclosureMime } : {}),
        };
      }
      return {
        kind: 'url',
        url: ep.enclosureUrl ?? `https://cdn.example.org/media/${episodeKey}.mp3`,
        ...(ep.enclosureMime ? { mime: ep.enclosureMime } : {}),
      };
    },

    queueSources: async (): Promise<readonly QueueItemSource[]> => {
      const rows = await this.queue.list();
      const out: QueueItemSource[] = [];
      for (const r of rows) {
        const source = await this.playback.sourceFor(r.episode.episodeKey);
        const feed = this.feedsMap.get(r.episode.feedKey);
        out.push({
          episodeKey: r.episode.episodeKey,
          source,
          startMs: r.progress?.state === 'IN_PROGRESS' ? r.progress.positionMs : 0,
          metadata: {
            title: r.episode.title,
            ...(feed?.title ? { artist: feed.title, album: feed.title } : {}),
            ...(r.episode.imageUrl
              ? { artworkUrl: r.episode.imageUrl }
              : feed?.imageUrl
                ? { artworkUrl: feed.imageUrl }
                : {}),
            ...(r.episode.durationMs !== undefined ? { durationMs: r.episode.durationMs } : {}),
          },
        });
      }
      return out;
    },
  };

  readonly sync: PlatformHost['sync'] = {
    status: async () => this.syncStatusState,

    configure: async (syncSettings: SyncSettings, secret?: SyncProviderSecret) => {
      this.lastSecret = secret;
      this.settingsState = {
        ...this.settingsState,
        sync: syncSettings,
      };
      const now = this.nowFn();
      this.syncStatusState = syncSettings.provider
        ? {
            enabled: true,
            provider: syncSettings.provider.id,
            phase: 'idle',
            lastPullAt: now,
            lastPushAt: now,
            remoteRev: (this.syncStatusState.remoteRev ?? 0) + 1,
            dirtyCount: 0,
            backgroundSync: this.info.capabilities.backgroundSync,
          }
        : {
            enabled: false,
            phase: 'off',
            dirtyCount: 0,
            backgroundSync: this.info.capabilities.backgroundSync,
          };
      this.emit({ type: 'settings-changed', settings: this.settingsState });
      this.emit({ type: 'sync-status', status: this.syncStatusState });
      return this.syncStatusState;
    },

    authorize: async (_provider) => {
      // Simulated interactive Google Drive OAuth completion
    },

    syncNow: async () => {
      if (!this.settingsState.sync.provider) {
        return this.syncStatusState;
      }
      const now = this.nowFn();
      this.syncStatusState = {
        enabled: true,
        provider: this.settingsState.sync.provider.id,
        phase: 'idle',
        lastPullAt: now,
        lastPushAt: now,
        remoteRev: (this.syncStatusState.remoteRev ?? 0) + 1,
        dirtyCount: 0,
        backgroundSync: this.info.capabilities.backgroundSync,
      };
      this.emit({ type: 'sync-status', status: this.syncStatusState });
      return this.syncStatusState;
    },

    disconnect: async () => {
      this.lastSecret = undefined;
      this.settingsState = {
        ...this.settingsState,
        sync: { ...this.settingsState.sync, provider: null },
      };
      this.syncStatusState = {
        enabled: false,
        phase: 'off',
        dirtyCount: 0,
        backgroundSync: this.info.capabilities.backgroundSync,
      };
      this.emit({ type: 'settings-changed', settings: this.settingsState });
      this.emit({ type: 'sync-status', status: this.syncStatusState });
    },

    resetRemote: async () => {
      if (this.syncStatusState.enabled) {
        this.syncStatusState = {
          ...this.syncStatusState,
          remoteRev: 0,
        };
        this.emit({ type: 'sync-status', status: this.syncStatusState });
      }
    },

    undoResume: async (episodeKey, positionMs) => {
      await this.progress.save({
        episodeKey,
        positionMs,
        state: 'IN_PROGRESS',
        flush: true,
      });
    },
  };

  readonly files: PlatformHost['files'] = {
    pickSyncFile: async (mode) => ({
      documentUri: `content://com.android.externalstorage.documents/document/Sync%2Fminipod-sync-${mode}.json`,
      displayName: 'minipod-sync-v1.json',
    }),

    pickFolder: async () => ({
      ref: '/home/listener/Audiobooks',
      displayName: 'Audiobooks',
    }),

    listDirectory: async (dirPath) => {
      const current = dirPath && dirPath.trim() ? dirPath.trim() : '/home/listener';
      if (current === '/') {
        return { path: '/', dirs: ['/home', '/media'] };
      }
      if (current === '/home') {
        return { path: '/home', parent: '/', dirs: ['/home/listener'] };
      }
      return {
        path: current,
        parent: '/home',
        dirs: [`${current}/Google Drive`, `${current}/Syncthing`, `${current}/Audiobooks`],
      };
    },

    saveTextFile: async (name, text, mime) => {
      this.savedFiles.push({ name, text, mime });
    },

    openExternal: async (url) => {
      this.openedExternalUrls.push(url);
    },
  };

  readonly settings: PlatformHost['settings'] = {
    get: async () => this.settingsState,

    update: async (patch) => {
      this.settingsState = {
        ...this.settingsState,
        ...patch,
        sync: patch.sync ? { ...this.settingsState.sync, ...patch.sync } : this.settingsState.sync,
      };
      this.emit({ type: 'settings-changed', settings: this.settingsState });
      return this.settingsState;
    },
  };

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  private bumpDirty(): void {
    if (!this.syncStatusState.enabled) return;
    this.syncStatusState = {
      ...this.syncStatusState,
      dirtyCount: this.syncStatusState.dirtyCount + 1,
    };
  }
}

export function createMockPlatformHost(options?: MockHostOptions): MockPlatformHost {
  return new MockPlatformHost(options);
}

/**
 * Deterministic in-memory `PlayerEngine` for `pnpm dev:ui` and Vitest tests.
 */
export class MockPlayerEngine implements PlayerEngine {
  readonly capabilities: PlayerEngineCapabilities;

  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private snapshot: PlayerSnapshot = {
    playing: false,
    buffering: false,
    positionMs: 0,
    speed: 1.0,
  };
  private sleepController: SleepTimerController;
  private clockMs = 1_760_000_000_000;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  loadedItem: PlayerLoadItem | null = null;
  queuedItems: readonly QueueItemSource[] = [];
  volumeFactor = 1;
  attachedVideoElement: HTMLElement | null = null;

  constructor(options?: {
    readonly capabilities?: Partial<PlayerEngineCapabilities> | undefined;
    readonly autoTick?: boolean | undefined;
  }) {
    this.capabilities = {
      video: true,
      background: false,
      nativeQueue: false,
      ...options?.capabilities,
    };
    this.sleepController = new SleepTimerController(
      {
        onVolumeFactor: (f) => {
          this.volumeFactor = f;
        },
        onExpire: () => {
          this.pause();
        },
        onStateChange: (state) => {
          this.emit({ type: 'sleepTimer', state });
        },
      },
      { now: () => this.clockMs },
    );

    if (options?.autoTick) {
      this.tickInterval = setInterval(() => {
        if (this.snapshot.playing && this.snapshot.episodeKey) {
          const nextPos = this.snapshot.positionMs + Math.round(500 * this.snapshot.speed);
          if (this.snapshot.durationMs !== undefined && nextPos >= this.snapshot.durationMs) {
            this.emitEnded();
          } else {
            this.emitPosition(nextPos);
          }
        }
      }, 500);
    }
  }

  async load(item: PlayerLoadItem): Promise<void> {
    this.loadedItem = item;
    this.snapshot = {
      episodeKey: item.episodeKey,
      playing: false,
      buffering: false,
      positionMs: Math.max(0, item.startMs),
      ...(item.metadata.durationMs !== undefined ? { durationMs: item.metadata.durationMs } : {}),
      speed: clampSpeed(item.speed),
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  async play(): Promise<void> {
    if (!this.snapshot.episodeKey) return;
    this.snapshot = { ...this.snapshot, playing: true };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  pause(): void {
    if (!this.snapshot.playing) return;
    this.snapshot = { ...this.snapshot, playing: false };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  stop(): void {
    this.snapshot = {
      playing: false,
      buffering: false,
      positionMs: 0,
      speed: this.snapshot.speed,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  seekTo(ms: number): void {
    const upper = this.snapshot.durationMs ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.max(0, Math.min(upper, Math.floor(ms)));
    this.snapshot = { ...this.snapshot, positionMs: clamped };
    this.sleepController.onPosition(clamped);
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  skip(deltaMs: number): void {
    this.seekTo(this.snapshot.positionMs + deltaMs);
  }

  setSpeed(speed: number): void {
    this.snapshot = { ...this.snapshot, speed: clampSpeed(speed) };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  setSleepTimer(timer: SleepTimer): void {
    this.sleepController.set(timer, this.snapshot.positionMs);
  }

  setQueue(items: readonly QueueItemSource[]): void {
    this.queuedItems = items;
  }

  attachVideoSurface(element: HTMLElement): void {
    this.attachedVideoElement = element;
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.sleepController.dispose();
    this.listeners.clear();
  }

  /** Test helper: move playback position and trigger position/sleep listeners. */
  emitPosition(positionMs: number): void {
    const epKey = this.snapshot.episodeKey;
    if (!epKey) return;
    const durationMs = this.snapshot.durationMs;
    this.snapshot = { ...this.snapshot, positionMs };
    this.sleepController.onPosition(positionMs);
    this.emit({
      type: 'position',
      episodeKey: epKey,
      positionMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  /**
   * Test helper: replace the raw engine snapshot and emit a `state` event, e.g. to simulate a
   * native `PlaybackService` that was stopped/reset while paused in the background (idle, 0 ms).
   */
  emitRawState(snapshot: PlayerSnapshot): void {
    this.snapshot = snapshot;
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  /** Test helper: simulate natural track completion. */
  emitEnded(): void {
    const epKey = this.snapshot.episodeKey;
    if (!epKey) return;
    this.snapshot = { ...this.snapshot, playing: false };
    this.sleepController.onEpisodeEnded();
    this.emit({ type: 'state', snapshot: this.snapshot });
    this.emit({ type: 'ended', episodeKey: epKey });
  }

  /** Test helper: advance sleep timer clock deterministically. */
  advanceSleepClock(deltaMs: number): void {
    this.clockMs += deltaMs;
    this.sleepController.tickCountdown();
  }

  private emit(event: PlayerEvent): void {
    for (const fn of this.listeners) {
      fn(event);
    }
  }
}

export function createMockPlayerEngine(options?: {
  readonly capabilities?: Partial<PlayerEngineCapabilities> | undefined;
  readonly autoTick?: boolean | undefined;
}): MockPlayerEngine {
  return new MockPlayerEngine(options);
}
