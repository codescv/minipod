/**
 * Android IndexedDB schema (`idb`, database `minipod`, version 1) and
 * `@capacitor/preferences`-backed secret store (`ARCHITECTURE.md §6.2`).
 *
 * Uses `factory.open(name, version)` + `wrap(request)` so each unit test can
 * pass its own isolated `new IDBFactory()` from `fake-indexeddb`.
 */
import { Preferences } from '@capacitor/preferences';
import { wrap, type DBSchema, type IDBPDatabase } from 'idb';
import {
  COUNTRY_CODE_UNSET,
  type AppSettings,
  type Chapter,
  type DeviceId,
  type DownloadState,
  type EpisodeKey,
  type EpochMs,
  type FeedKey,
  type FeedKind,
  type HlcMs,
  type HttpBasicCredentials,
  type MediaType,
  type MiniPodErrorShape,
  type ProgressState,
  type QueueStub,
  type SyncProviderSecret,
} from '@minipod/core';

export const MINIPOD_IDB_NAME = 'minipod';
export const MINIPOD_IDB_VERSION = 1;

export interface IdbFeedRecord {
  readonly feedKey: FeedKey;
  readonly kind: FeedKind;
  /** `1` = subscribed, `0` = stub or soft-deleted tombstone. */
  readonly subscribedNum: 0 | 1;
  readonly url: string;
  readonly movedTo?: string | null;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly fundingUrl?: string;
  readonly hasCredentials: boolean;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly nextPageUrl?: string;
  readonly lastRefreshedAt?: EpochMs;
  readonly lastEpisodeAt: number; // 0 when absent so IDB index is always sortable
  readonly addedAt: HlcMs;
  readonly updatedAt: HlcMs;
  readonly deletedAt?: HlcMs | null;
  /** `1` = dirty, `0` = clean. */
  readonly syncDirty: 0 | 1;
}

export interface IdbEpisodeRecord {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly identity: string;
  readonly guid?: string;
  readonly isStub: boolean;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly imageUrl?: string;
  readonly pubDate?: EpochMs;
  /** Mirrors `pubDate ?? 0` so the compound index `['feedKey', 'pubDateSort']` sorts cleanly. */
  readonly pubDateSort: number;
  readonly durationMs?: number;
  readonly enclosureUrl?: string;
  readonly enclosureMime?: string;
  readonly enclosureSize?: number;
  readonly mediaType: MediaType;
  readonly chaptersUrl?: string;
  readonly chaptersType?: string;
  readonly transcriptUrl?: string;
  readonly transcriptType?: string;
  readonly localMtimeMs?: EpochMs;
  readonly downloadState: DownloadState;
  readonly downloadPath?: string;
}

export interface IdbProgressRecord {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly identity?: string;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly state: ProgressState;
  readonly playedAt?: HlcMs | null;
  readonly updatedAt: HlcMs;
  readonly deviceId: DeviceId;
  readonly syncDirty: 0 | 1;
}

export interface IdbQueueRecord {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly pos: string;
  readonly addedAt: HlcMs;
  readonly updatedAt: HlcMs;
  readonly removedNum: 0 | 1;
  readonly deviceId: DeviceId;
  readonly stub?: QueueStub;
  readonly syncDirty: 0 | 1;
}

export interface IdbChaptersRecord {
  readonly episodeKey: EpisodeKey;
  readonly feedChapters: readonly Chapter[];
  readonly mergedChapters: readonly Chapter[];
  readonly merged: boolean;
}

export interface IdbSyncStateRecord {
  readonly id: 1;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly remoteEtag: string | null;
  readonly remoteFileId: string | null;
  readonly remoteRev: number;
  readonly floorSubscriptions: HlcMs;
  readonly floorQueue: HlcMs;
  readonly floorProgress: HlcMs;
  readonly hlcLast: HlcMs;
  readonly lastPullAt?: EpochMs;
  readonly lastPushAt?: EpochMs;
  readonly lastError?: MiniPodErrorShape;
  readonly backoffUntil?: EpochMs;
}

export interface IdbSettingsRecord {
  readonly key: 'app';
  readonly value: AppSettings;
}

export interface MiniPodDbSchema extends DBSchema {
  feeds: {
    key: FeedKey;
    value: IdbFeedRecord;
    indexes: {
      subscribed: number;
      lastEpisodeAt: number;
    };
  };
  episodes: {
    key: EpisodeKey;
    value: IdbEpisodeRecord;
    indexes: {
      byFeed: FeedKey;
      byFeedPub: [FeedKey, number];
    };
  };
  progress: {
    key: EpisodeKey;
    value: IdbProgressRecord;
    indexes: {
      byFeed: FeedKey;
      bySyncDirty: number;
    };
  };
  queue: {
    key: EpisodeKey;
    value: IdbQueueRecord;
    indexes: {
      byFeed: FeedKey;
      byRemovedPos: [number, string];
      bySyncDirty: number;
    };
  };
  chapters: {
    key: EpisodeKey;
    value: IdbChaptersRecord;
  };
  syncState: {
    key: 1;
    value: IdbSyncStateRecord;
  };
  settings: {
    key: 'app';
    value: IdbSettingsRecord;
  };
}

export type MiniPodDb = IDBPDatabase<MiniPodDbSchema>;

export async function openMiniPodDb(
  factory: IDBFactory = globalThis.indexedDB,
  name: string = MINIPOD_IDB_NAME,
): Promise<MiniPodDb> {
  const request = factory.open(name, MINIPOD_IDB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (event.oldVersion < 1) {
      const feeds = db.createObjectStore('feeds', { keyPath: 'feedKey' });
      feeds.createIndex('subscribed', 'subscribedNum');
      feeds.createIndex('lastEpisodeAt', 'lastEpisodeAt');

      const episodes = db.createObjectStore('episodes', { keyPath: 'episodeKey' });
      episodes.createIndex('byFeed', 'feedKey');
      episodes.createIndex('byFeedPub', ['feedKey', 'pubDateSort']);

      const progress = db.createObjectStore('progress', { keyPath: 'episodeKey' });
      progress.createIndex('byFeed', 'feedKey');
      progress.createIndex('bySyncDirty', 'syncDirty');

      const queue = db.createObjectStore('queue', { keyPath: 'episodeKey' });
      queue.createIndex('byFeed', 'feedKey');
      queue.createIndex('byRemovedPos', ['removedNum', 'pos']);
      queue.createIndex('bySyncDirty', 'syncDirty');

      db.createObjectStore('chapters', { keyPath: 'episodeKey' });
      db.createObjectStore('syncState', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'key' });
    }
  };
  return (await wrap(request)) as unknown as MiniPodDb;
}

export function createDefaultAndroidAppSettings(deviceName: string): AppSettings {
  return {
    schemaVersion: 1,
    deleteDownloadWhenPlayed: false,
    backgroundRefreshHours: 0,
    sync: {
      provider: null,
      wifiOnly: false,
      deviceName,
    },
    playbackSpeed: 1.0,
    topChartsCountry: COUNTRY_CODE_UNSET,
    subscriptionsLayout: 'grid',
    uiLanguage: 'system',
  };
}

/**
 * Minimal key-value adapter over `@capacitor/preferences` so unit tests can inject
 * an in-memory map without calling Capacitor's native Preferences bridge.
 */
export interface PreferencesLike {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

export function createMemoryPreferences(): PreferencesLike {
  const map = new Map<string, string>();
  return {
    async get({ key }) {
      return { value: map.get(key) ?? null };
    },
    async set({ key, value }) {
      map.set(key, value);
    },
    async remove({ key }) {
      map.delete(key);
    },
  };
}

export function createCapacitorPreferences(): PreferencesLike {
  return {
    get: (opts) => Preferences.get(opts),
    set: (opts) => Preferences.set(opts),
    remove: (opts) => Preferences.remove(opts),
  };
}

const FEED_CREDS_PREFIX = 'minipod.secret.feed.';
const WEBDAV_PASSWORD_KEY = 'minipod.secret.webdav';
const GIST_TOKEN_KEY = 'minipod.secret.gist';

/**
 * App-private secret store backed by `@capacitor/preferences` (`SharedPreferences`),
 * never IndexedDB or the cloud sync document (`ARCHITECTURE.md §6.2`, `§8.2`).
 */
export class AndroidSecretsStore {
  private readonly prefs: PreferencesLike;

  constructor(prefs: PreferencesLike = createCapacitorPreferences()) {
    this.prefs = prefs;
  }

  async getFeedCredentials(feedKey: FeedKey): Promise<HttpBasicCredentials | undefined> {
    const { value } = await this.prefs.get({ key: `${FEED_CREDS_PREFIX}${feedKey}` });
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as { username?: unknown; password?: unknown };
      if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
        return { username: parsed.username, password: parsed.password };
      }
    } catch {
      // ignore malformed entry
    }
    return undefined;
  }

  async setFeedCredentials(
    feedKey: FeedKey,
    credentials: HttpBasicCredentials | null,
  ): Promise<void> {
    const key = `${FEED_CREDS_PREFIX}${feedKey}`;
    if (!credentials) {
      await this.prefs.remove({ key });
      return;
    }
    await this.prefs.set({
      key,
      value: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
      }),
    });
  }

  async saveSyncSecret(secret: SyncProviderSecret): Promise<void> {
    if (secret.id === 'webdav') {
      await this.prefs.set({ key: WEBDAV_PASSWORD_KEY, value: secret.password });
    } else if (secret.id === 'gist') {
      await this.prefs.set({ key: GIST_TOKEN_KEY, value: secret.token });
    }
  }

  async getWebDavPassword(): Promise<string | undefined> {
    const { value } = await this.prefs.get({ key: WEBDAV_PASSWORD_KEY });
    return value ?? undefined;
  }

  async getGistToken(): Promise<string | undefined> {
    const { value } = await this.prefs.get({ key: GIST_TOKEN_KEY });
    return value ?? undefined;
  }

  async clearSyncSecrets(): Promise<void> {
    await Promise.all([
      this.prefs.remove({ key: WEBDAV_PASSWORD_KEY }),
      this.prefs.remove({ key: GIST_TOKEN_KEY }),
    ]);
  }
}
