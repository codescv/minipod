/**
 * `IdbSyncStore`: IndexedDB implementation of `@minipod/core`'s `SyncStore`
 * plus domain repository operations for `CapacitorPlatformHost`
 * (`ARCHITECTURE.md §6.2`, `§6.3`, `§7.6`, `§7.7`).
 *
 * Every multi-store mutation (`applyMerged`, `upsertParsedFeed`, `softDeleteUnsubscribe`,
 * `recordPermanentMove`) executes inside a single `readwrite` IndexedDB transaction
 * with zero non-IDB awaits while the transaction is open.
 */
import {
  APP_SETTINGS_SCHEMA_VERSION,
  compareQueueOrder,
  episodeKey as deriveEpisodeKey,
  feedKey as deriveFeedKey,
  fromSyncQueueEntry,
  generateDeviceId,
  HybridLogicalClock,
  MiniPodError,
  pickProgress,
  toSyncQueueEntry,
  type ApplyDecisions,
  type Chapter,
  type DeviceId,
  type DownloadState,
  type Episode,
  type EpisodeFilter,
  type EpisodeKey,
  type EpisodeRow,
  type EpochMs,
  type Feed,
  type FeedKey,
  type FeedKind,
  type HlcMs,
  type LocalSyncSnapshot,
  type Page,
  type ParsedEpisode,
  type ParsedFeed,
  type ProgressRecord,
  type QueueEntry,
  type QueueRow,
  type QueueStub,
  type RestampBelowFloorOptions,
  type SyncDocument,
  type SyncEntityMaps,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncState,
  type SyncStore,
  type SyncSubscription,
} from '@minipod/core';
import {
  createDefaultAndroidAppSettings,
  type IdbEpisodeRecord,
  type IdbFeedRecord,
  type IdbProgressRecord,
  type IdbQueueRecord,
  type IdbSyncStateRecord,
  type MiniPodDb,
} from './idb';

const EPISODE_PAGE_SIZE = 50;

export interface IdbSyncStoreDeps {
  readonly db: MiniPodDb;
  readonly hlc: HybridLogicalClock;
  readonly appVersion: string;
  readonly defaultDeviceName?: string;
  readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
  readonly onDeleteDownloads?: (paths: readonly string[]) => void | Promise<void>;
}

export function idbRecordToFeed(r: IdbFeedRecord): Feed {
  const imageUrl = r.imageUrl?.trim() || undefined;
  return {
    feedKey: r.feedKey,
    kind: r.kind,
    subscribed: r.subscribedNum === 1,
    url: r.movedTo || r.url,
    hasCredentials: r.hasCredentials,
    addedAt: r.addedAt,
    updatedAt: r.updatedAt,
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.author !== undefined ? { author: r.author } : {}),
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.link !== undefined ? { link: r.link } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(r.language !== undefined ? { language: r.language } : {}),
    ...(r.fundingUrl !== undefined ? { fundingUrl: r.fundingUrl } : {}),
    ...(r.nextPageUrl !== undefined ? { nextPageUrl: r.nextPageUrl } : {}),
    ...(r.lastRefreshedAt !== undefined ? { lastRefreshedAt: r.lastRefreshedAt } : {}),
    ...(r.lastEpisodeAt > 0 ? { lastEpisodeAt: r.lastEpisodeAt } : {}),
    ...(typeof r.deletedAt === 'number' ? { deletedAt: r.deletedAt } : {}),
  };
}

export function idbRecordToEpisode(r: IdbEpisodeRecord): Episode {
  const imageUrl = r.imageUrl?.trim() || undefined;
  return {
    episodeKey: r.episodeKey,
    feedKey: r.feedKey,
    identity: r.identity,
    isStub: r.isStub,
    title: r.title,
    mediaType: r.mediaType,
    downloadState: r.downloadState,
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.link !== undefined ? { link: r.link } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(r.pubDate !== undefined ? { pubDate: r.pubDate } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.enclosureUrl !== undefined ? { enclosureUrl: r.enclosureUrl } : {}),
    ...(r.enclosureMime !== undefined ? { enclosureMime: r.enclosureMime } : {}),
    ...(r.enclosureSize !== undefined ? { enclosureSize: r.enclosureSize } : {}),
    ...(r.chaptersUrl !== undefined ? { chaptersUrl: r.chaptersUrl } : {}),
    ...(r.chaptersType !== undefined ? { chaptersType: r.chaptersType } : {}),
    ...(r.transcriptUrl !== undefined ? { transcriptUrl: r.transcriptUrl } : {}),
    ...(r.transcriptType !== undefined ? { transcriptType: r.transcriptType } : {}),
    ...(r.downloadPath !== undefined ? { downloadPath: r.downloadPath } : {}),
  };
}

export function idbRecordToProgress(r: IdbProgressRecord): ProgressRecord {
  return {
    episodeKey: r.episodeKey,
    feedKey: r.feedKey,
    positionMs: r.positionMs,
    state: r.state,
    updatedAt: r.updatedAt,
    deviceId: r.deviceId,
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(typeof r.playedAt === 'number' ? { playedAt: r.playedAt } : {}),
  };
}

export function idbRecordToQueueEntry(r: IdbQueueRecord): QueueEntry {
  return {
    episodeKey: r.episodeKey,
    feedKey: r.feedKey,
    pos: r.pos,
    addedAt: r.addedAt,
    updatedAt: r.updatedAt,
    removed: r.removedNum === 1,
    deviceId: r.deviceId,
    ...(r.stub !== undefined ? { stub: r.stub } : {}),
  };
}

function subscriptionCoreMatches(local: IdbFeedRecord, remote: SyncSubscription): boolean {
  const localDeleted = local.deletedAt != null || local.subscribedNum === 0;
  if (localDeleted !== remote.deleted) return false;
  const effectiveUrl = remote.movedTo || remote.url;
  if (!localDeleted && (local.movedTo || local.url) !== effectiveUrl) return false;
  return true;
}

function subscriptionFullyMatches(
  local: IdbFeedRecord,
  remote: SyncSubscription,
  fallbackDeviceId: DeviceId,
): boolean {
  if (!subscriptionCoreMatches(local, remote)) return false;
  if (local.updatedAt !== remote.updatedAt) return false;
  if ((local.deviceId ?? fallbackDeviceId) !== remote.deviceId) return false;
  if ((local.movedTo ?? null) !== (remote.movedTo ?? null)) return false;
  if (Boolean(local.hasCredentials) !== Boolean(remote.hasCredentials)) return false;
  if (remote.title !== undefined && local.title === undefined) return false;
  if (remote.imageUrl !== undefined && local.imageUrl === undefined) return false;
  return true;
}

function idbProgressToSyncProgress(p: IdbProgressRecord): SyncProgress {
  return {
    feedKey: p.feedKey,
    positionMs: p.positionMs,
    state: p.state,
    playedAt: p.playedAt ?? null,
    updatedAt: p.updatedAt,
    deviceId: p.deviceId,
    ...(p.identity !== undefined ? { identity: p.identity } : {}),
    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
  };
}

function toSyncStateModel(row: IdbSyncStateRecord): SyncState {
  return {
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    remoteEtag: row.remoteEtag,
    remoteFileId: row.remoteFileId,
    remoteRev: row.remoteRev,
    floors: {
      subscriptions: row.floorSubscriptions,
      queue: row.floorQueue,
      progress: row.floorProgress,
    },
    hlcLast: row.hlcLast,
    ...(row.lastPullAt !== undefined ? { lastPullAt: row.lastPullAt } : {}),
    ...(row.lastPushAt !== undefined ? { lastPushAt: row.lastPushAt } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.backoffUntil !== undefined && row.backoffUntil > 0 ? { backoffUntil: row.backoffUntil } : {}),
    ...(row.remoteDevices !== undefined ? { remoteDevices: row.remoteDevices } : {}),
    ...(row.lastRemoteFingerprint !== undefined ? { lastRemoteFingerprint: row.lastRemoteFingerprint } : {}),
    ...(row.pendingLineageReset ? { pendingLineageReset: true } : {}),
  };
}

export class IdbSyncStore implements SyncStore {
  readonly db: MiniPodDb;
  private readonly hlc: HybridLogicalClock;
  private readonly appVersion: string;
  private readonly defaultDeviceName: string;
  private readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
  private readonly onDeleteDownloads?: (paths: readonly string[]) => void | Promise<void>;
  private cachedSyncState: IdbSyncStateRecord | null = null;

  constructor(deps: IdbSyncStoreDeps) {
    this.db = deps.db;
    this.hlc = deps.hlc;
    this.appVersion = deps.appVersion;
    this.defaultDeviceName = deps.defaultDeviceName ?? 'Android';
    if (deps.getCurrentEpisodeKey !== undefined) {
      this.getCurrentEpisodeKey = deps.getCurrentEpisodeKey;
    }
    if (deps.onDeleteDownloads !== undefined) {
      this.onDeleteDownloads = deps.onDeleteDownloads;
    }
  }

  /**
   * Ensures singleton rows in `syncState` (`id = 1`) and `settings` (`key = 'app'`) exist,
   * and restores the local HLC without +5m drift clamping from `MAX(hlcLast, ownEntityHlc)` (SYNC-P2-01).
   */
  async init(): Promise<SyncState> {
    const tx = this.db.transaction(['syncState', 'settings', 'feeds', 'queue', 'progress'], 'readwrite');
    const syncStore = tx.objectStore('syncState');
    const settingsStore = tx.objectStore('settings');

    let stateRow = await syncStore.get(1);
    if (!stateRow) {
      stateRow = {
        id: 1,
        deviceId: generateDeviceId(),
        deviceName: this.defaultDeviceName,
        remoteEtag: null,
        remoteFileId: null,
        remoteRev: 0,
        floorSubscriptions: 0,
        floorQueue: 0,
        floorProgress: 0,
        hlcLast: this.hlc.current(),
      };
      await syncStore.put(stateRow);
    } else {
      const [allFeeds, allQueue, allProg] = await Promise.all([
        tx.objectStore('feeds').getAll(),
        tx.objectStore('queue').getAll(),
        tx.objectStore('progress').getAll(),
      ]);
      let maxLocalHlc = stateRow.hlcLast;
      for (const f of allFeeds) {
        if (f.kind === 'RSS' && (!f.deviceId || f.deviceId === stateRow.deviceId)) {
          if (f.updatedAt > maxLocalHlc) maxLocalHlc = f.updatedAt;
        }
      }
      for (const q of allQueue) {
        if (q.deviceId === stateRow.deviceId && q.updatedAt > maxLocalHlc) {
          maxLocalHlc = q.updatedAt;
        }
      }
      for (const p of allProg) {
        if (p.deviceId === stateRow.deviceId && p.updatedAt > maxLocalHlc) {
          maxLocalHlc = p.updatedAt;
        }
      }
      if (maxLocalHlc > this.hlc.current()) {
        this.hlc.restore(maxLocalHlc);
      }
    }

    const existingSettings = await settingsStore.get('app');
    if (!existingSettings) {
      await settingsStore.put({
        key: 'app',
        value: createDefaultAndroidAppSettings(stateRow.deviceName),
      });
    } else if (
      (Number(existingSettings.value?.schemaVersion) || 1) < APP_SETTINGS_SCHEMA_VERSION
    ) {
      // Pre-v0.1.14 installs persisted `deleteDownloadWhenPlayed: false` and the toggle was removed
      // in v0.1.14, leaving users stuck with downloads never being auto-deleted once played.
      // Auto-deleting played downloads is an always-on product behavior: force-migrate to `true`.
      await settingsStore.put({
        ...existingSettings,
        value: {
          ...createDefaultAndroidAppSettings(stateRow.deviceName),
          ...existingSettings.value,
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          deleteDownloadWhenPlayed: true,
        },
      });
    }

    await tx.done;
    this.cachedSyncState = stateRow;
    return toSyncStateModel(stateRow);
  }

  getCachedSyncState(): SyncState {
    if (!this.cachedSyncState) {
      throw new MiniPodError('internal', 'IdbSyncStore.init() has not been awaited yet');
    }
    return toSyncStateModel(this.cachedSyncState);
  }

  private async ensureStateInStore(store: {
    get(key: 1): Promise<IdbSyncStateRecord | undefined>;
    put(value: IdbSyncStateRecord): Promise<unknown>;
  }): Promise<IdbSyncStateRecord> {
    const existing = await store.get(1);
    if (existing) {
      if (existing.hlcLast > this.hlc.current()) {
        this.hlc.restore(existing.hlcLast);
      }
      this.cachedSyncState = existing;
      return existing;
    }
    const created: IdbSyncStateRecord = {
      id: 1,
      deviceId: generateDeviceId(),
      deviceName: this.defaultDeviceName,
      remoteEtag: null,
      remoteFileId: null,
      remoteRev: 0,
      floorSubscriptions: 0,
      floorQueue: 0,
      floorProgress: 0,
      hlcLast: this.hlc.current(),
    };
    await store.put(created);
    this.cachedSyncState = created;
    return created;
  }

  async getSyncState(): Promise<SyncState> {
    const tx = this.db.transaction(['syncState'], 'readwrite');
    const row = await this.ensureStateInStore(tx.objectStore('syncState'));
    await tx.done;
    return toSyncStateModel(row);
  }

  async setSyncState(patch: Partial<SyncState>): Promise<void> {
    const tx = this.db.transaction(['syncState'], 'readwrite');
    const store = tx.objectStore('syncState');
    const current = await this.ensureStateInStore(store);

    const lastPullAt = 'lastPullAt' in patch ? patch.lastPullAt : current.lastPullAt;
    const lastPushAt = 'lastPushAt' in patch ? patch.lastPushAt : current.lastPushAt;
    const lastError = 'lastError' in patch ? patch.lastError : current.lastError;
    const backoffUntil =
      'backoffUntil' in patch
        ? patch.backoffUntil && patch.backoffUntil > 0
          ? patch.backoffUntil
          : undefined
        : current.backoffUntil;
    const remoteDevices =
      'remoteDevices' in patch ? patch.remoteDevices : current.remoteDevices;
    const lastRemoteFingerprint =
      'lastRemoteFingerprint' in patch
        ? patch.lastRemoteFingerprint
        : current.lastRemoteFingerprint;
    const pendingLineageReset =
      'pendingLineageReset' in patch
        ? Boolean(patch.pendingLineageReset)
        : Boolean(current.pendingLineageReset);

    const updated: IdbSyncStateRecord = {
      id: 1,
      deviceId: patch.deviceId ?? current.deviceId,
      deviceName: patch.deviceName ?? current.deviceName,
      remoteEtag: 'remoteEtag' in patch ? (patch.remoteEtag ?? null) : current.remoteEtag,
      remoteFileId: 'remoteFileId' in patch ? (patch.remoteFileId ?? null) : current.remoteFileId,
      remoteRev: patch.remoteRev ?? current.remoteRev,
      floorSubscriptions: patch.floors?.subscriptions ?? current.floorSubscriptions,
      floorQueue: patch.floors?.queue ?? current.floorQueue,
      floorProgress: patch.floors?.progress ?? current.floorProgress,
      hlcLast: Math.max(current.hlcLast, patch.hlcLast ?? 0, this.hlc.current()),
      ...(lastPullAt !== undefined ? { lastPullAt } : {}),
      ...(lastPushAt !== undefined ? { lastPushAt } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(backoffUntil !== undefined ? { backoffUntil } : {}),
      ...(remoteDevices !== undefined ? { remoteDevices } : {}),
      ...(lastRemoteFingerprint !== undefined ? { lastRemoteFingerprint } : {}),
      ...(pendingLineageReset ? { pendingLineageReset: true } : {}),
    };

    await store.put(updated);
    await tx.done;
    this.cachedSyncState = updated;
  }

  async getDirtyCount(): Promise<number> {
    const tx = this.db.transaction(['feeds', 'queue', 'progress'], 'readonly');
    const [allFeeds, dirtyQueueCount, dirtyProgCount] = await Promise.all([
      tx.objectStore('feeds').getAll(),
      tx.objectStore('queue').index('bySyncDirty').count(1),
      tx.objectStore('progress').index('bySyncDirty').count(1),
    ]);
    await tx.done;
    let dirtySubsCount = 0;
    for (const f of allFeeds) {
      if (
        f.kind === 'RSS' &&
        !f.feedKey.startsWith('l_') &&
        (f.subscribedNum === 1 || f.deletedAt != null) &&
        f.syncDirty === 1
      ) {
        dirtySubsCount += 1;
      }
    }
    return dirtySubsCount + dirtyQueueCount + dirtyProgCount;
  }

  async loadLocalDoc(): Promise<LocalSyncSnapshot> {
    let stateRow: IdbSyncStateRecord | undefined;
    let allFeeds: IdbFeedRecord[];
    let allQueue: IdbQueueRecord[];
    let allProgress: IdbProgressRecord[];

    // Use a non-blocking `'readonly'` transaction whenever `syncState` is already initialized (SYNC-P2-09).
    if (this.cachedSyncState) {
      const tx = this.db.transaction(['syncState', 'feeds', 'queue', 'progress'], 'readonly');
      [stateRow, allFeeds, allQueue, allProgress] = await Promise.all([
        tx.objectStore('syncState').get(1),
        tx.objectStore('feeds').getAll(),
        tx.objectStore('queue').getAll(),
        tx.objectStore('progress').getAll(),
      ]);
      await tx.done;
    } else {
      const tx = this.db.transaction(['syncState', 'feeds', 'queue', 'progress'], 'readwrite');
      stateRow = await this.ensureStateInStore(tx.objectStore('syncState'));
      [allFeeds, allQueue, allProgress] = await Promise.all([
        tx.objectStore('feeds').getAll(),
        tx.objectStore('queue').getAll(),
        tx.objectStore('progress').getAll(),
      ]);
      await tx.done;
    }

    if (!stateRow) {
      const rwTx = this.db.transaction(['syncState'], 'readwrite');
      stateRow = await this.ensureStateInStore(rwTx.objectStore('syncState'));
      await rwTx.done;
    } else {
      this.cachedSyncState = stateRow;
    }

    const localFeedKeys = new Set<FeedKey>();
    const subItems: Record<FeedKey, SyncSubscription> = {};
    const dirtySubs = new Set<FeedKey>();

    for (const f of allFeeds) {
      if (f.kind === 'LOCAL' || f.feedKey.startsWith('l_')) {
        localFeedKeys.add(f.feedKey);
        continue;
      }
      // Stubs (`subscribedNum === 0 && deletedAt == null`) are NOT subscriptions!
      if (f.subscribedNum === 0 && f.deletedAt == null) {
        continue;
      }
      const deleted = f.deletedAt != null;
      subItems[f.feedKey] = {
        url: f.url,
        movedTo: f.movedTo ?? null,
        updatedAt: f.updatedAt,
        deleted,
        deviceId: f.deviceId ?? stateRow.deviceId,
        ...(f.title !== undefined ? { title: f.title } : {}),
        ...(f.imageUrl !== undefined ? { imageUrl: f.imageUrl } : {}),
        ...(f.hasCredentials ? { hasCredentials: true } : {}),
      };
      if (f.syncDirty === 1) {
        dirtySubs.add(f.feedKey);
      }
    }

    const queueItems: Record<EpisodeKey, SyncQueueEntry> = {};
    const dirtyQueue = new Set<EpisodeKey>();
    for (const q of allQueue) {
      if (localFeedKeys.has(q.feedKey) || q.feedKey.startsWith('l_')) continue;
      queueItems[q.episodeKey] = toSyncQueueEntry(idbRecordToQueueEntry(q));
      if (q.syncDirty === 1) {
        dirtyQueue.add(q.episodeKey);
      }
    }

    const progItems: Record<EpisodeKey, SyncProgress> = {};
    const dirtyProg = new Set<EpisodeKey>();
    for (const p of allProgress) {
      if (localFeedKeys.has(p.feedKey) || p.feedKey.startsWith('l_')) continue;
      progItems[p.episodeKey] = idbProgressToSyncProgress(p);
      if (p.syncDirty === 1) {
        dirtyProg.add(p.episodeKey);
      }
    }

    return {
      maps: {
        subscriptions: { floor: stateRow.floorSubscriptions, items: subItems },
        queue: { floor: stateRow.floorQueue, items: queueItems },
        progress: { floor: stateRow.floorProgress, items: progItems },
      },
      device: {
        name: stateRow.deviceName,
        app: `minipod/${this.appVersion}`,
        lastSeenAt: Date.now(),
      },
      dirty: {
        subscriptions: dirtySubs,
        queue: dirtyQueue,
        progress: dirtyProg,
      },
    };
  }

  async restampDirtyBelowFloor(
    floors: SyncState['floors'],
    stamp: () => HlcMs,
    options?: RestampBelowFloorOptions,
  ): Promise<void> {
    const excludeSubs = options?.excludeKeys?.subscriptions;
    const excludeQueue = options?.excludeKeys?.queue;
    const excludeProg = options?.excludeKeys?.progress;
    const includeCleanLive = options?.includeCleanLive === true;

    const tx = this.db.transaction(['syncState', 'feeds', 'queue', 'progress'], 'readwrite');
    const stateRow = await this.ensureStateInStore(tx.objectStore('syncState'));
    const feedsStore = tx.objectStore('feeds');
    const queueStore = tx.objectStore('queue');
    const progStore = tx.objectStore('progress');

    if (floors.subscriptions > 0) {
      const feeds = await feedsStore.getAll();
      for (const f of feeds) {
        if (f.kind !== 'RSS' || f.feedKey.startsWith('l_')) continue;
        if (f.subscribedNum === 0 && f.deletedAt == null) continue; // stub
        if (f.updatedAt > floors.subscriptions) continue;
        if (excludeSubs?.has(f.feedKey)) continue;
        const eligible =
          f.syncDirty === 1 || (includeCleanLive && f.subscribedNum === 1 && f.deletedAt == null);
        if (!eligible) continue;
        const next = Math.max(stamp(), floors.subscriptions + 1, f.updatedAt + 1);
        await feedsStore.put({
          ...f,
          updatedAt: next,
          deviceId: stateRow.deviceId,
          syncDirty: 1,
          ...(f.deletedAt != null ? { deletedAt: next } : {}),
        });
      }
    }

    if (floors.queue > 0) {
      const queue = await queueStore.getAll();
      for (const q of queue) {
        if (q.feedKey.startsWith('l_')) continue;
        if (q.updatedAt > floors.queue) continue;
        if (excludeQueue?.has(q.episodeKey)) continue;
        const eligible = q.syncDirty === 1 || (includeCleanLive && q.removedNum === 0);
        if (!eligible) continue;
        const next = Math.max(stamp(), floors.queue + 1, q.updatedAt + 1);
        await queueStore.put({ ...q, updatedAt: next, deviceId: stateRow.deviceId, syncDirty: 1 });
      }
    }

    if (floors.progress > 0) {
      const prog = await progStore.getAll();
      for (const p of prog) {
        if (p.feedKey.startsWith('l_')) continue;
        if (p.updatedAt > floors.progress) continue;
        if (excludeProg?.has(p.episodeKey)) continue;
        const eligible = p.syncDirty === 1 || includeCleanLive;
        if (!eligible) continue;
        const next = Math.max(stamp(), floors.progress + 1, p.updatedAt + 1);
        await progStore.put({ ...p, updatedAt: next, deviceId: stateRow.deviceId, syncDirty: 1 });
      }
    }

    await tx.done;
  }

  /**
   * Atomically applies a merged `SyncDocument` in a single multi-store `readwrite` transaction
   * (`ARCHITECTURE.md §6.2`, `§7.6`).
   */
  async applyMerged(
    merged: SyncDocument,
    currentEpisodeKey: EpisodeKey | undefined,
  ): Promise<ApplyDecisions> {
    const downloadsToDelete: string[] = [];
    const resumeHints: Array<{
      readonly episodeKey: EpisodeKey;
      readonly positionMs: number;
      readonly state: SyncProgress['state'];
      readonly deviceName: string;
    }> = [];
    const feedsToRefresh: FeedKey[] = [];
    let subsChanged = false;
    let queueChanged = false;
    let progressChanged = false;
    const changedProgressKeys = new Set<EpisodeKey>();
    let hasConcurrentLocalEdits = false;
    const writeWallMs = Date.now();

    const tx = this.db.transaction(
      ['feeds', 'episodes', 'chapters', 'progress', 'queue', 'syncState'],
      'readwrite',
    );
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const chaptersStore = tx.objectStore('chapters');
    const progressStore = tx.objectStore('progress');
    const queueStore = tx.objectStore('queue');
    const syncStateStore = tx.objectStore('syncState');

    const [stateRow, allFeeds, allEpisodes, allQueue, allProgress] = await Promise.all([
      this.ensureStateInStore(syncStateStore),
      feedsStore.getAll(),
      episodesStore.getAll(),
      queueStore.getAll(),
      progressStore.getAll(),
    ]);

    const localFeedKeys = new Set<FeedKey>();
    const preFeedMap = new Map<FeedKey, IdbFeedRecord>();
    const feedMap = new Map<FeedKey, IdbFeedRecord>();
    for (const f of allFeeds) {
      if (f.kind === 'LOCAL' || f.feedKey.startsWith('l_')) {
        localFeedKeys.add(f.feedKey);
      } else {
        preFeedMap.set(f.feedKey, f);
        feedMap.set(f.feedKey, f);
      }
    }

    const episodeMap = new Map<EpisodeKey, IdbEpisodeRecord>(
      allEpisodes.map((e) => [e.episodeKey, e]),
    );
    // Transaction-start pre-cascade snapshots for concurrent-edit detection (SYNC-P0-01)
    const preQueueMap = new Map<EpisodeKey, IdbQueueRecord>(
      allQueue.map((q) => [q.episodeKey, q]),
    );
    const queueMap = new Map<EpisodeKey, IdbQueueRecord>(
      allQueue.map((q) => [q.episodeKey, q]),
    );
    const preProgressMap = new Map<EpisodeKey, IdbProgressRecord>(
      allProgress.map((p) => [p.episodeKey, p]),
    );
    const progressMap = new Map<EpisodeKey, IdbProgressRecord>(
      allProgress.map((p) => [p.episodeKey, p]),
    );

    const collectMergedPreserveQueueKeys = (
      fk: FeedKey,
      cutoff: HlcMs,
    ): ReadonlySet<EpisodeKey> => {
      const preserved = new Set<EpisodeKey>();
      for (const [epKey, q] of Object.entries(merged.queue.items)) {
        if (q.feedKey === fk && !q.removed && q.updatedAt > cutoff) {
          preserved.add(epKey);
        }
      }
      return preserved;
    };

    const softDeleteFeedInTx = async (
      fk: FeedKey,
      stampHlc: HlcMs,
      deviceId: DeviceId,
      markDirty: 0 | 1,
      preserveQueueKeys: ReadonlySet<EpisodeKey>,
    ): Promise<void> => {
      const f = feedMap.get(fk);
      if (!f) return;

      const protectedEpisodeKeys = new Set<EpisodeKey>();
      if (currentEpisodeKey) protectedEpisodeKeys.add(currentEpisodeKey);
      for (const k of preserveQueueKeys) protectedEpisodeKeys.add(k);

      for (const q of [...queueMap.values()]) {
        if (q.feedKey !== fk || q.removedNum !== 0) continue;
        if (preserveQueueKeys.has(q.episodeKey)) {
          protectedEpisodeKeys.add(q.episodeKey);
          continue;
        }
        // Concurrent local re-queue/edit strictly newer than remote unsubscribe -> protect! (SYNC-P0-01)
        const preQ = preQueueMap.get(q.episodeKey);
        if (markDirty === 0 && preQ && preQ.syncDirty === 1 && preQ.updatedAt > stampHlc) {
          protectedEpisodeKeys.add(q.episodeKey);
          continue;
        }
        const nextQ: IdbQueueRecord = {
          episodeKey: q.episodeKey,
          feedKey: q.feedKey,
          pos: q.pos,
          addedAt: q.addedAt,
          updatedAt: stampHlc,
          removedNum: 1,
          deviceId,
          syncDirty: markDirty,
        };
        queueMap.set(q.episodeKey, nextQ);
        await queueStore.put(nextQ);
        queueChanged = true;
      }

      for (const ep of [...episodeMap.values()]) {
        if (ep.feedKey !== fk) continue;
        if (protectedEpisodeKeys.has(ep.episodeKey)) {
          continue;
        }
        if (ep.downloadPath) {
          downloadsToDelete.push(ep.downloadPath);
        }
        episodeMap.delete(ep.episodeKey);
        await episodesStore.delete(ep.episodeKey);
        await chaptersStore.delete(ep.episodeKey);
      }

      const nextFeed: IdbFeedRecord = {
        ...f,
        subscribedNum: 0,
        updatedAt: stampHlc,
        deletedAt: stampHlc,
        deviceId,
        syncDirty: markDirty,
      };
      feedMap.set(fk, nextFeed);
      await feedsStore.put(nextFeed);
    };

    const canHardDeleteFeedInTx = (fk: FeedKey): boolean => {
      for (const q of queueMap.values()) {
        if (q.feedKey === fk && q.removedNum === 0) return false;
      }
      if (currentEpisodeKey) {
        const playingEp = episodeMap.get(currentEpisodeKey);
        if (playingEp && playingEp.feedKey === fk) return false;
      }
      return true;
    };

    // 1. Subscriptions (4-state updatedAt-first guard, SYNC-P0-01)
    for (const [fk, winSub] of Object.entries(merged.subscriptions.items)) {
      if (localFeedKeys.has(fk) || fk.startsWith('l_')) continue;
      const localRow = preFeedMap.get(fk);
      const effectiveUrl = winSub.movedTo || winSub.url;

      if (!localRow) {
        if (!winSub.deleted) {
          const created: IdbFeedRecord = {
            feedKey: fk,
            kind: 'RSS',
            subscribedNum: 1,
            url: effectiveUrl,
            movedTo: winSub.movedTo ?? null,
            hasCredentials: Boolean(winSub.hasCredentials),
            lastEpisodeAt: 0,
            addedAt: winSub.updatedAt,
            updatedAt: winSub.updatedAt,
            deletedAt: null,
            deviceId: winSub.deviceId,
            syncDirty: 0,
            ...(winSub.title !== undefined ? { title: winSub.title } : {}),
            ...(winSub.imageUrl !== undefined ? { imageUrl: winSub.imageUrl } : {}),
          };
          feedMap.set(fk, created);
          await feedsStore.put(created);
          feedsToRefresh.push(fk);
        } else {
          const tomb: IdbFeedRecord = {
            feedKey: fk,
            kind: 'RSS',
            subscribedNum: 0,
            url: effectiveUrl,
            movedTo: winSub.movedTo ?? null,
            hasCredentials: false,
            lastEpisodeAt: 0,
            addedAt: winSub.updatedAt,
            updatedAt: winSub.updatedAt,
            deletedAt: winSub.updatedAt,
            deviceId: winSub.deviceId,
            syncDirty: 0,
            ...(winSub.title !== undefined ? { title: winSub.title } : {}),
            ...(winSub.imageUrl !== undefined ? { imageUrl: winSub.imageUrl } : {}),
          };
          feedMap.set(fk, tomb);
          await feedsStore.put(tomb);
        }
        subsChanged = true;
        continue;
      }

      if (localRow.syncDirty === 1 && localRow.updatedAt > winSub.updatedAt) {
        hasConcurrentLocalEdits = true;
        continue;
      }

      if (localRow.updatedAt === winSub.updatedAt) {
        if (localRow.syncDirty === 1 && subscriptionCoreMatches(localRow, winSub)) {
          continue;
        }
        if (localRow.syncDirty === 0 && subscriptionFullyMatches(localRow, winSub, stateRow.deviceId)) {
          continue;
        }
      }

      if (!winSub.deleted) {
        const wasUnsubscribed = localRow.subscribedNum === 0 || localRow.deletedAt != null;
        const updated: IdbFeedRecord = {
          ...localRow,
          subscribedNum: 1,
          url: effectiveUrl,
          movedTo: winSub.movedTo ?? localRow.movedTo ?? null,
          hasCredentials: localRow.hasCredentials || Boolean(winSub.hasCredentials),
          updatedAt: winSub.updatedAt,
          deletedAt: null,
          deviceId: winSub.deviceId,
          syncDirty: 0,
          ...(localRow.title === undefined && winSub.title !== undefined
            ? { title: winSub.title }
            : {}),
          ...(localRow.imageUrl === undefined && winSub.imageUrl !== undefined
            ? { imageUrl: winSub.imageUrl }
            : {}),
        };
        feedMap.set(fk, updated);
        await feedsStore.put(updated);
        subsChanged = true;
        if (wasUnsubscribed) {
          feedsToRefresh.push(fk);
        }
      } else {
        if (localRow.subscribedNum === 1 || localRow.deletedAt == null) {
          const preserveQueueKeys = collectMergedPreserveQueueKeys(fk, winSub.updatedAt);
          await softDeleteFeedInTx(fk, winSub.updatedAt, winSub.deviceId, 0, preserveQueueKeys);
          subsChanged = true;
        } else {
          const updatedTomb: IdbFeedRecord = {
            ...localRow,
            updatedAt: winSub.updatedAt,
            deletedAt: winSub.updatedAt,
            deviceId: winSub.deviceId,
            syncDirty: 0,
          };
          feedMap.set(fk, updatedTomb);
          await feedsStore.put(updatedTomb);
          subsChanged = true;
        }
      }
    }

    // Clean (`syncDirty === 0`) RSS subscriptions absent from merged fell under remote floor
    for (const localRow of [...preFeedMap.values()]) {
      if (localRow.syncDirty !== 0) continue;
      if (localRow.subscribedNum === 0 && localRow.deletedAt == null) continue; // stub
      if (!(localRow.feedKey in merged.subscriptions.items)) {
        const floorStamp = Math.max(merged.subscriptions.floor, localRow.updatedAt);
        const preserveQueueKeys = collectMergedPreserveQueueKeys(localRow.feedKey, floorStamp);
        if (localRow.subscribedNum === 1) {
          await softDeleteFeedInTx(
            localRow.feedKey,
            floorStamp,
            stateRow.deviceId,
            0,
            preserveQueueKeys,
          );
          subsChanged = true;
        }
        // Clean orphan episodes/chapters & downloads before deleting feed (SYNC-P2-05)
        if (preserveQueueKeys.size === 0 && canHardDeleteFeedInTx(localRow.feedKey)) {
          for (const ep of [...episodeMap.values()]) {
            if (ep.feedKey !== localRow.feedKey) continue;
            if (ep.downloadPath) {
              downloadsToDelete.push(ep.downloadPath);
            }
            episodeMap.delete(ep.episodeKey);
            await episodesStore.delete(ep.episodeKey);
            await chaptersStore.delete(ep.episodeKey);
          }
          feedMap.delete(localRow.feedKey);
          await feedsStore.delete(localRow.feedKey);
          subsChanged = true;
        }
      }
    }

    // 2. Queue (using pre-cascade `preQueueMap` snapshot, SYNC-P0-01)
    for (const [epKey, winQ] of Object.entries(merged.queue.items)) {
      if (localFeedKeys.has(winQ.feedKey) || winQ.feedKey.startsWith('l_')) continue;
      const preQ = preQueueMap.get(epKey);

      if (preQ) {
        if (preQ.syncDirty === 1 && preQ.updatedAt > winQ.updatedAt) {
          hasConcurrentLocalEdits = true;
          continue;
        }
        if (preQ.updatedAt === winQ.updatedAt) {
          const coreMatch = (preQ.removedNum === 1) === winQ.removed && preQ.pos === winQ.pos;
          if (preQ.syncDirty === 1 && coreMatch) {
            continue;
          }
          if (preQ.syncDirty === 0) {
            const curQ = queueMap.get(epKey);
            if (
              curQ &&
              curQ.updatedAt === winQ.updatedAt &&
              (curQ.removedNum === 1) === winQ.removed &&
              curQ.pos === winQ.pos &&
              curQ.deviceId === winQ.deviceId &&
              curQ.addedAt === winQ.addedAt &&
              curQ.feedKey === winQ.feedKey &&
              curQ.syncDirty === 0
            ) {
              continue;
            }
          }
        }
      }

      if (!winQ.removed) {
        if (!feedMap.has(winQ.feedKey)) {
          const stubFeed: IdbFeedRecord = {
            feedKey: winQ.feedKey,
            kind: 'RSS',
            subscribedNum: 0,
            url: winQ.stub?.feedUrl ?? `https://invalid.local/${winQ.feedKey}`,
            hasCredentials: false,
            lastEpisodeAt: 0,
            addedAt: winQ.updatedAt,
            updatedAt: winQ.updatedAt,
            deletedAt: null,
            syncDirty: 0,
            ...(winQ.stub?.feedTitle !== undefined ? { title: winQ.stub.feedTitle } : {}),
            ...(winQ.stub?.imageUrl !== undefined ? { imageUrl: winQ.stub.imageUrl } : {}),
          };
          feedMap.set(winQ.feedKey, stubFeed);
          await feedsStore.put(stubFeed);
        }

        if (!episodeMap.has(epKey)) {
          const mime = winQ.stub?.enclosureMime ?? '';
          const mediaType = mime.toLowerCase().startsWith('video/')
            ? 'VIDEO'
            : mime.toLowerCase().startsWith('audio/') || Boolean(winQ.stub?.enclosureUrl)
              ? 'AUDIO'
              : 'UNKNOWN';
          const stubEp: IdbEpisodeRecord = {
            episodeKey: epKey,
            feedKey: winQ.feedKey,
            identity: winQ.stub?.identity ?? epKey,
            isStub: true,
            title: winQ.stub?.title ?? 'Queued Episode',
            pubDateSort: winQ.stub?.pubDate ?? 0,
            mediaType,
            downloadState: 'NONE',
            ...(winQ.stub?.pubDate !== undefined ? { pubDate: winQ.stub.pubDate } : {}),
            ...(winQ.stub?.durationMs !== undefined ? { durationMs: winQ.stub.durationMs } : {}),
            ...(winQ.stub?.enclosureUrl !== undefined ? { enclosureUrl: winQ.stub.enclosureUrl } : {}),
            ...(winQ.stub?.enclosureMime !== undefined ? { enclosureMime: winQ.stub.enclosureMime } : {}),
            ...(winQ.stub?.imageUrl !== undefined ? { imageUrl: winQ.stub.imageUrl } : {}),
          };
          episodeMap.set(epKey, stubEp);
          await episodesStore.put(stubEp);
        }
      }

      const entry = fromSyncQueueEntry(epKey, winQ);
      const nextQ: IdbQueueRecord = {
        episodeKey: entry.episodeKey,
        feedKey: entry.feedKey,
        pos: entry.pos,
        addedAt: entry.addedAt,
        updatedAt: entry.updatedAt,
        removedNum: entry.removed ? 1 : 0,
        deviceId: entry.deviceId,
        syncDirty: 0,
        ...(entry.stub !== undefined ? { stub: entry.stub } : {}),
      };
      queueMap.set(epKey, nextQ);
      await queueStore.put(nextQ);
      queueChanged = true;
    }

    for (const localQ of [...preQueueMap.values()]) {
      if (localFeedKeys.has(localQ.feedKey) || localQ.feedKey.startsWith('l_')) continue;
      if (localQ.syncDirty === 0 && !(localQ.episodeKey in merged.queue.items)) {
        queueMap.delete(localQ.episodeKey);
        await queueStore.delete(localQ.episodeKey);
        queueChanged = true;
      }
    }

    // 3. Progress (using pre-cascade `preProgressMap`, setting `localWrittenAt`, SYNC-P0-01, SYNC-P0-03)
    for (const [epKey, winP] of Object.entries(merged.progress.items)) {
      if (localFeedKeys.has(winP.feedKey) || winP.feedKey.startsWith('l_')) continue;
      const preP = preProgressMap.get(epKey);

      if (preP) {
        if (preP.syncDirty === 1 && preP.updatedAt > winP.updatedAt) {
          hasConcurrentLocalEdits = true;
          continue;
        }
        if (preP.updatedAt === winP.updatedAt) {
          const coreMatch = preP.state === winP.state && preP.positionMs === winP.positionMs;
          if (preP.syncDirty === 1 && coreMatch) {
            continue;
          }
          if (
            preP.syncDirty === 0 &&
            coreMatch &&
            preP.deviceId === winP.deviceId &&
            preP.feedKey === winP.feedKey &&
            preP.durationMs === winP.durationMs &&
            (preP.playedAt ?? null) === (winP.playedAt ?? null) &&
            preP.identity === winP.identity
          ) {
            continue;
          }
        }
      }

      const changedRemotely =
        winP.deviceId !== stateRow.deviceId &&
        (!preP ||
          winP.updatedAt > preP.updatedAt ||
          (winP.updatedAt === preP.updatedAt &&
            (winP.positionMs !== preP.positionMs || winP.state !== preP.state)));

      const nextP: IdbProgressRecord = {
        episodeKey: epKey,
        feedKey: winP.feedKey,
        positionMs: winP.positionMs,
        state: winP.state,
        playedAt: winP.playedAt ?? null,
        updatedAt: winP.updatedAt,
        deviceId: winP.deviceId,
        localWrittenAt: writeWallMs,
        syncDirty: 0,
        ...(winP.identity !== undefined ? { identity: winP.identity } : {}),
        ...(winP.durationMs !== undefined ? { durationMs: winP.durationMs } : {}),
      };
      progressMap.set(epKey, nextP);
      await progressStore.put(nextP);
      progressChanged = true;
      changedProgressKeys.add(epKey);

      if (changedRemotely && currentEpisodeKey !== undefined && epKey === currentEpisodeKey) {
        const remoteDevName = merged.devices[winP.deviceId]?.name ?? 'another device';
        resumeHints.push({
          episodeKey: epKey,
          positionMs: winP.positionMs,
          state: winP.state,
          deviceName: remoteDevName,
        });
      }
    }

    for (const localP of [...preProgressMap.values()]) {
      if (localFeedKeys.has(localP.feedKey) || localP.feedKey.startsWith('l_')) continue;
      if (localP.syncDirty === 0 && !(localP.episodeKey in merged.progress.items)) {
        progressMap.delete(localP.episodeKey);
        await progressStore.delete(localP.episodeKey);
        progressChanged = true;
        changedProgressKeys.add(localP.episodeKey);
      }
    }

    // Raise floors monotonically inside the same transaction
    const nextState: IdbSyncStateRecord = {
      ...stateRow,
      floorSubscriptions: Math.max(stateRow.floorSubscriptions, merged.subscriptions.floor),
      floorQueue: Math.max(stateRow.floorQueue, merged.queue.floor),
      floorProgress: Math.max(stateRow.floorProgress, merged.progress.floor),
      hlcLast: Math.max(stateRow.hlcLast, this.hlc.current()),
    };
    await syncStateStore.put(nextState);
    await tx.done;

    this.cachedSyncState = nextState;

    if (downloadsToDelete.length > 0 && this.onDeleteDownloads) {
      await this.onDeleteDownloads(downloadsToDelete);
    }

    return {
      resumeHints,
      feedsToRefresh,
      changed: {
        subscriptions: subsChanged,
        queue: queueChanged,
        progress: progressChanged,
        progressEpisodeKeys: [...changedProgressKeys],
      },
      hasConcurrentLocalEdits,
    };
  }

  async markClean(pushed: SyncEntityMaps): Promise<void> {
    const tx = this.db.transaction(['feeds', 'queue', 'progress'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const queueStore = tx.objectStore('queue');
    const progStore = tx.objectStore('progress');

    for (const [fk, sub] of Object.entries(pushed.subscriptions.items)) {
      const f = await feedsStore.get(fk);
      if (f && f.kind === 'RSS' && f.updatedAt === sub.updatedAt && f.syncDirty === 1) {
        await feedsStore.put({ ...f, syncDirty: 0 });
      }
    }

    for (const [epKey, q] of Object.entries(pushed.queue.items)) {
      const localQ = await queueStore.get(epKey);
      if (localQ && localQ.updatedAt === q.updatedAt && localQ.syncDirty === 1) {
        await queueStore.put({ ...localQ, syncDirty: 0 });
      }
    }

    for (const [epKey, p] of Object.entries(pushed.progress.items)) {
      const localP = await progStore.get(epKey);
      if (localP && localP.updatedAt === p.updatedAt && localP.syncDirty === 1) {
        await progStore.put({ ...localP, syncDirty: 0 });
      }
    }

    await tx.done;
  }

  async purgeBelowFloors(floors: SyncState['floors']): Promise<void> {
    const downloadsToDelete: string[] = [];
    const currentEpKey = this.getCurrentEpisodeKey?.();

    const tx = this.db.transaction(['feeds', 'episodes', 'chapters', 'queue', 'progress'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const chaptersStore = tx.objectStore('chapters');
    const queueStore = tx.objectStore('queue');
    const progStore = tx.objectStore('progress');

    if (floors.subscriptions > 0) {
      const [feeds, allQueue] = await Promise.all([feedsStore.getAll(), queueStore.getAll()]);
      const activeQueueFeedKeys = new Set(
        allQueue.filter((q) => q.removedNum === 0).map((q) => q.feedKey),
      );

      for (const f of feeds) {
        if (
          f.kind === 'RSS' &&
          f.subscribedNum === 0 &&
          f.deletedAt != null &&
          f.syncDirty === 0 &&
          f.updatedAt <= floors.subscriptions
        ) {
          if (activeQueueFeedKeys.has(f.feedKey)) continue;
          const feedEps = await episodesStore.index('byFeed').getAll(f.feedKey);
          if (currentEpKey && feedEps.some((e) => e.episodeKey === currentEpKey)) {
            continue;
          }
          // Clean orphan episodes, chapters, and downloads when purging feed (SYNC-P2-05)
          for (const ep of feedEps) {
            if (ep.downloadPath) {
              downloadsToDelete.push(ep.downloadPath);
            }
            await episodesStore.delete(ep.episodeKey);
            await chaptersStore.delete(ep.episodeKey);
          }
          await feedsStore.delete(f.feedKey);
        }
      }
    }

    if (floors.queue > 0) {
      const queue = await queueStore.getAll();
      for (const q of queue) {
        if (q.removedNum === 1 && q.syncDirty === 0 && q.updatedAt <= floors.queue) {
          await queueStore.delete(q.episodeKey);
        }
      }
    }

    if (floors.progress > 0) {
      const prog = await progStore.getAll();
      for (const p of prog) {
        if (p.state === 'PLAYED' && p.syncDirty === 0 && p.updatedAt <= floors.progress) {
          await progStore.delete(p.episodeKey);
        }
      }
    }

    await tx.done;

    if (downloadsToDelete.length > 0 && this.onDeleteDownloads) {
      await this.onDeleteDownloads(downloadsToDelete);
    }
  }

  /**
   * Marks all non-local RSS subscriptions (`subscribedNum === 1 || deletedAt != null`),
   * queue entries, and progress records as dirty (`syncDirty = 1`) in a single `readwrite`
   * transaction so switching/configuring a new sync provider pushes all local state.
   */
  async markAllDirty(): Promise<void> {
    const tx = this.db.transaction(['feeds', 'queue', 'progress'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const queueStore = tx.objectStore('queue');
    const progStore = tx.objectStore('progress');

    const [allFeeds, allQueue, allProgress] = await Promise.all([
      feedsStore.getAll(),
      queueStore.getAll(),
      progStore.getAll(),
    ]);

    for (const f of allFeeds) {
      if (f.kind === 'LOCAL' || f.feedKey.startsWith('l_')) continue;
      if (f.subscribedNum === 0 && f.deletedAt == null) continue;
      if (f.syncDirty !== 1) {
        await feedsStore.put({ ...f, syncDirty: 1 });
      }
    }

    for (const q of allQueue) {
      if (q.feedKey.startsWith('l_')) continue;
      if (q.syncDirty !== 1) {
        await queueStore.put({ ...q, syncDirty: 1 });
      }
    }

    for (const p of allProgress) {
      if (p.feedKey.startsWith('l_')) continue;
      if (p.syncDirty !== 1) {
        await progStore.put({ ...p, syncDirty: 1 });
      }
    }

    await tx.done;
  }

  // -------------------------------------------------------------------------
  // Domain CRUD helpers for `CapacitorPlatformHost`
  // -------------------------------------------------------------------------

  async listSubscribedFeeds(): Promise<Feed[]> {
    const rows = await this.db.getAllFromIndex('feeds', 'subscribed', 1);
    rows.sort((a, b) => {
      if (b.lastEpisodeAt !== a.lastEpisodeAt) return b.lastEpisodeAt - a.lastEpisodeAt;
      return (a.title ?? a.url).localeCompare(b.title ?? b.url);
    });
    return rows.map(idbRecordToFeed);
  }

  async getFeedRecord(feedKey: FeedKey): Promise<IdbFeedRecord | undefined> {
    return this.db.get('feeds', feedKey);
  }

  async getFeed(feedKey: FeedKey): Promise<Feed> {
    const row = await this.db.get('feeds', feedKey);
    if (!row) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }
    return idbRecordToFeed(row);
  }

  async isSubscribed(feedKey: FeedKey): Promise<boolean> {
    const row = await this.db.get('feeds', feedKey);
    return row?.subscribedNum === 1;
  }

  async upsertParsedFeed(params: {
    readonly feedKey: FeedKey;
    readonly kind: FeedKind;
    readonly url: string;
    readonly subscribed: boolean;
    readonly parsed: ParsedFeed;
    readonly nowWallMs: EpochMs;
    readonly deviceId?: DeviceId;
    readonly preserveSubscriptionState?: boolean;
    readonly hasCredentials?: boolean;
    readonly movedTo?: string;
    readonly etag?: string;
    readonly lastModified?: string;
    readonly overrideImageUrl?: string;
    readonly localMtimeByIdentity?: ReadonlyMap<string, EpochMs>;
    readonly presentIdentities?: ReadonlySet<string>;
    readonly currentPlayingKey?: EpisodeKey;
    readonly markSyncDirty?: boolean;
  }): Promise<Feed> {
    const tx = this.db.transaction(['feeds', 'episodes', 'chapters', 'queue'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const chaptersStore = tx.objectStore('chapters');
    const queueStore = tx.objectStore('queue');

    const existingFeed = await feedsStore.get(params.feedKey);

    // Refresh guard (SYNC-P0-02): re-check live subscription status inside the write tx;
    // abort write-back if unsubscribed/deleted/purged during the HTTP fetch.
    if (params.preserveSubscriptionState) {
      if (!existingFeed || existingFeed.subscribedNum === 0 || existingFeed.deletedAt != null) {
        await tx.done;
        if (existingFeed) {
          return idbRecordToFeed(existingFeed);
        }
        return {
          feedKey: params.feedKey,
          kind: params.kind,
          subscribed: false,
          url: params.url,
          hasCredentials: false,
          addedAt: params.nowWallMs,
          updatedAt: params.nowWallMs,
        };
      }
    }

    const existingEps = await episodesStore.index('byFeed').getAll(params.feedKey);
    const existingEpByKey = new Map<EpisodeKey, IdbEpisodeRecord>(
      existingEps.map((e) => [e.episodeKey, e]),
    );

    const effectiveSubscribed = params.preserveSubscriptionState
      ? existingFeed!.subscribedNum === 1
      : params.subscribed;
    const subscribingNow =
      !params.preserveSubscriptionState &&
      effectiveSubscribed &&
      (!existingFeed || existingFeed.subscribedNum === 0 || existingFeed.deletedAt != null);
    const urlMoved = params.movedTo !== undefined && params.movedTo !== existingFeed?.movedTo;
    const stamp =
      !existingFeed || subscribingNow || urlMoved || params.markSyncDirty
        ? this.hlc.stamp(existingFeed?.updatedAt)
        : existingFeed.updatedAt;
    const effectiveImage =
      params.overrideImageUrl?.trim() ||
      params.parsed.imageUrl?.trim() ||
      existingFeed?.imageUrl?.trim() ||
      undefined;

    let maxPubDate = existingFeed?.lastEpisodeAt ?? 0;
    for (const item of params.parsed.episodes) {
      if (item.pubDate !== undefined && item.pubDate > maxPubDate) {
        maxPubDate = item.pubDate;
      }
      const epKey = deriveEpisodeKey(params.feedKey, item.identity);
      const prevEp = existingEpByKey.get(epKey);
      const pubDate = item.pubDate ?? prevEp?.pubDate;
      const epImage =
        item.imageUrl?.trim() || effectiveImage || prevEp?.imageUrl?.trim() || undefined;
      const localMtime = params.localMtimeByIdentity?.get(item.identity) ?? prevEp?.localMtimeMs;

      const epRec: IdbEpisodeRecord = {
        episodeKey: epKey,
        feedKey: params.feedKey,
        identity: item.identity,
        isStub: false,
        title: item.title,
        pubDateSort: pubDate ?? 0,
        mediaType: item.mediaType,
        downloadState: prevEp?.downloadState ?? 'NONE',
        ...(item.guid !== undefined ? { guid: item.guid } : prevEp?.guid !== undefined ? { guid: prevEp.guid } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.link !== undefined ? { link: item.link } : {}),
        ...(epImage !== undefined ? { imageUrl: epImage } : {}),
        ...(pubDate !== undefined ? { pubDate } : {}),
        ...(item.durationMs !== undefined
          ? { durationMs: item.durationMs }
          : prevEp?.durationMs !== undefined
            ? { durationMs: prevEp.durationMs }
            : {}),
        ...(item.enclosureUrl !== undefined ? { enclosureUrl: item.enclosureUrl } : {}),
        ...(item.enclosureMime !== undefined ? { enclosureMime: item.enclosureMime } : {}),
        ...(item.enclosureSize !== undefined ? { enclosureSize: item.enclosureSize } : {}),
        ...(item.chaptersUrl !== undefined ? { chaptersUrl: item.chaptersUrl } : {}),
        ...(item.chaptersType !== undefined ? { chaptersType: item.chaptersType } : {}),
        ...(item.transcriptUrl !== undefined ? { transcriptUrl: item.transcriptUrl } : {}),
        ...(item.transcriptType !== undefined ? { transcriptType: item.transcriptType } : {}),
        ...(localMtime !== undefined ? { localMtimeMs: localMtime } : {}),
        ...(prevEp?.downloadPath !== undefined ? { downloadPath: prevEp.downloadPath } : {}),
      };
      await episodesStore.put(epRec);

      if (item.chapters && item.chapters.length > 0) {
        const existingCh = await chaptersStore.get(epKey);
        const isLocal = params.kind === 'LOCAL';
        await chaptersStore.put({
          episodeKey: epKey,
          feedChapters: item.chapters,
          mergedChapters: isLocal ? item.chapters : (existingCh?.mergedChapters ?? []),
          merged: isLocal ? true : Boolean(existingCh?.merged),
        });
      }
    }

    // For LOCAL folders, remove deleted files from episodes/queue while preserving progress
    if (params.kind === 'LOCAL' && params.presentIdentities) {
      for (const prevEp of existingEps) {
        if (
          !params.presentIdentities.has(prevEp.identity) &&
          prevEp.episodeKey !== params.currentPlayingKey
        ) {
          await queueStore.delete(prevEp.episodeKey);
          await episodesStore.delete(prevEp.episodeKey);
          await chaptersStore.delete(prevEp.episodeKey);
        }
      }
    }

    const markDirty: 0 | 1 =
      params.kind === 'LOCAL'
        ? 0
        : params.markSyncDirty || subscribingNow || urlMoved
          ? 1
          : (existingFeed?.syncDirty ?? 0);

    const nextSubscribedNum: 0 | 1 = effectiveSubscribed
      ? 1
      : existingFeed?.deletedAt == null
        ? (existingFeed?.subscribedNum ?? 0)
        : 0;

    const effectiveDeviceId =
      (subscribingNow || urlMoved || !existingFeed) &&
      (params.deviceId ?? this.cachedSyncState?.deviceId) !== undefined
        ? (params.deviceId ?? this.cachedSyncState?.deviceId)
        : (existingFeed?.deviceId ?? params.deviceId ?? this.cachedSyncState?.deviceId);

    const feedRec: IdbFeedRecord = {
      feedKey: params.feedKey,
      kind: params.kind,
      subscribedNum: nextSubscribedNum,
      url: params.url,
      movedTo: params.movedTo ?? existingFeed?.movedTo ?? null,
      hasCredentials: params.hasCredentials ?? existingFeed?.hasCredentials ?? false,
      lastRefreshedAt: params.nowWallMs,
      lastEpisodeAt: maxPubDate,
      addedAt: subscribingNow ? stamp : (existingFeed?.addedAt ?? stamp),
      updatedAt: stamp,
      deletedAt: effectiveSubscribed ? null : (existingFeed?.deletedAt ?? null),
      syncDirty: markDirty,
      ...(effectiveDeviceId !== undefined ? { deviceId: effectiveDeviceId } : {}),
      ...(params.parsed.title !== undefined
        ? { title: params.parsed.title }
        : existingFeed?.title !== undefined
          ? { title: existingFeed.title }
          : {}),
      ...(params.parsed.author !== undefined
        ? { author: params.parsed.author }
        : existingFeed?.author !== undefined
          ? { author: existingFeed.author }
          : {}),
      ...(params.parsed.description !== undefined
        ? { description: params.parsed.description }
        : existingFeed?.description !== undefined
          ? { description: existingFeed.description }
          : {}),
      ...(params.parsed.link !== undefined
        ? { link: params.parsed.link }
        : existingFeed?.link !== undefined
          ? { link: existingFeed.link }
          : {}),
      ...(effectiveImage !== undefined ? { imageUrl: effectiveImage } : {}),
      ...(params.parsed.language !== undefined
        ? { language: params.parsed.language }
        : existingFeed?.language !== undefined
          ? { language: existingFeed.language }
          : {}),
      ...(params.parsed.fundingUrl !== undefined
        ? { fundingUrl: params.parsed.fundingUrl }
        : existingFeed?.fundingUrl !== undefined
          ? { fundingUrl: existingFeed.fundingUrl }
          : {}),
      ...(params.parsed.nextPageUrl !== undefined
        ? { nextPageUrl: params.parsed.nextPageUrl }
        : existingFeed?.nextPageUrl !== undefined
          ? { nextPageUrl: existingFeed.nextPageUrl }
          : {}),
      ...(params.etag !== undefined
        ? { etag: params.etag }
        : existingFeed?.etag !== undefined
          ? { etag: existingFeed.etag }
          : {}),
      ...(params.lastModified !== undefined
        ? { lastModified: params.lastModified }
        : existingFeed?.lastModified !== undefined
          ? { lastModified: existingFeed.lastModified }
          : {}),
    };

    await feedsStore.put(feedRec);
    await tx.done;

    return idbRecordToFeed(feedRec);
  }

  async appendOlderEpisodes(
    feedKey: FeedKey,
    episodes: readonly ParsedEpisode[],
    nextPageUrl: string | undefined,
  ): Promise<number> {
    const tx = this.db.transaction(['feeds', 'episodes', 'chapters'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const chaptersStore = tx.objectStore('chapters');

    const feed = await feedsStore.get(feedKey);
    if (!feed) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }

    let added = 0;
    for (const item of episodes) {
      const epKey = deriveEpisodeKey(feedKey, item.identity);
      const existing = await episodesStore.get(epKey);
      if (!existing || existing.isStub) {
        added += 1;
      }
      const pubDate = item.pubDate ?? existing?.pubDate;
      const epImage =
        item.imageUrl?.trim() ||
        feed.imageUrl?.trim() ||
        existing?.imageUrl?.trim() ||
        undefined;
      const rec: IdbEpisodeRecord = {
        episodeKey: epKey,
        feedKey,
        identity: item.identity,
        isStub: false,
        title: item.title,
        pubDateSort: pubDate ?? 0,
        mediaType: item.mediaType,
        downloadState: existing?.downloadState ?? 'NONE',
        ...(item.guid !== undefined ? { guid: item.guid } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.link !== undefined ? { link: item.link } : {}),
        ...(epImage !== undefined ? { imageUrl: epImage } : {}),
        ...(pubDate !== undefined ? { pubDate } : {}),
        ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        ...(item.enclosureUrl !== undefined ? { enclosureUrl: item.enclosureUrl } : {}),
        ...(item.enclosureMime !== undefined ? { enclosureMime: item.enclosureMime } : {}),
        ...(item.enclosureSize !== undefined ? { enclosureSize: item.enclosureSize } : {}),
        ...(item.chaptersUrl !== undefined ? { chaptersUrl: item.chaptersUrl } : {}),
        ...(item.chaptersType !== undefined ? { chaptersType: item.chaptersType } : {}),
        ...(item.transcriptUrl !== undefined ? { transcriptUrl: item.transcriptUrl } : {}),
        ...(item.transcriptType !== undefined ? { transcriptType: item.transcriptType } : {}),
        ...(existing?.downloadPath !== undefined ? { downloadPath: existing.downloadPath } : {}),
      };
      await episodesStore.put(rec);

      if (item.chapters && item.chapters.length > 0) {
        const prevCh = await chaptersStore.get(epKey);
        if (!prevCh) {
          await chaptersStore.put({
            episodeKey: epKey,
            feedChapters: item.chapters,
            mergedChapters: [],
            merged: false,
          });
        }
      }
    }

    const updatedFeed: IdbFeedRecord = { ...feed };
    if (nextPageUrl !== undefined) {
      (updatedFeed as { nextPageUrl?: string }).nextPageUrl = nextPageUrl;
    } else {
      delete (updatedFeed as { nextPageUrl?: string }).nextPageUrl;
    }
    await feedsStore.put(updatedFeed);
    await tx.done;
    return added;
  }

  async updateConditionalHeaders(
    feedKey: FeedKey,
    headers: { etag?: string | undefined; lastModified?: string | undefined; refreshedAt: EpochMs },
  ): Promise<void> {
    const tx = this.db.transaction(['feeds'], 'readwrite');
    const store = tx.objectStore('feeds');
    const feed = await store.get(feedKey);
    if (feed) {
      await store.put({
        ...feed,
        lastRefreshedAt: headers.refreshedAt,
        ...(headers.etag !== undefined ? { etag: headers.etag } : {}),
        ...(headers.lastModified !== undefined ? { lastModified: headers.lastModified } : {}),
      });
    }
    await tx.done;
  }

  /**
   * Records a permanent URL move (`301`/`308`, `http->https`, `<itunes:new-feed-url>`),
   * aliasing and re-keying episodes/queue/progress when `feedKey(newUrl)` differs (`§4.1.3`).
   */
  async recordPermanentMove(
    oldFeedKey: FeedKey,
    newUrl: string,
    deviceId: DeviceId,
  ): Promise<FeedKey> {
    const newFeedKey = deriveFeedKey(newUrl);
    const tx = this.db.transaction(['feeds', 'episodes', 'chapters', 'queue', 'progress'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const chaptersStore = tx.objectStore('chapters');
    const queueStore = tx.objectStore('queue');
    const progStore = tx.objectStore('progress');

    const oldFeed = await feedsStore.get(oldFeedKey);
    if (!oldFeed || oldFeed.kind !== 'RSS') {
      await tx.done;
      return oldFeedKey;
    }

    const stamp = this.hlc.stamp(oldFeed.updatedAt);

    if (newFeedKey === oldFeedKey) {
      if (oldFeed.url !== newUrl || oldFeed.movedTo !== newUrl) {
        await feedsStore.put({
          ...oldFeed,
          url: newUrl,
          movedTo: newUrl,
          updatedAt: stamp,
          deviceId,
          syncDirty: 1,
        });
      }
      await tx.done;
      return oldFeedKey;
    }

    const existingTarget = await feedsStore.get(newFeedKey);
    if (!existingTarget) {
      // Align with Node & §4.1.3: when target key does not exist locally, keep `oldFeedKey`
      // and record `movedTo` + updated fetch `url` on the original key (SYNC-P1-03).
      await feedsStore.put({
        ...oldFeed,
        url: newUrl,
        movedTo: newUrl,
        updatedAt: stamp,
        deviceId,
        syncDirty: 1,
      });
      await tx.done;
      return oldFeedKey;
    }

    // Alias collision merge: tombstone `oldFeedKey` with `movedTo` and merge into `existingTarget` (§4.1.3)
    const survivorStamp = this.hlc.stamp(existingTarget.updatedAt);
    await feedsStore.put({
      ...existingTarget,
      url: newUrl,
      subscribedNum: oldFeed.subscribedNum === 1 ? 1 : existingTarget.subscribedNum,
      deletedAt: oldFeed.subscribedNum === 1 ? null : (existingTarget.deletedAt ?? null),
      updatedAt: survivorStamp,
      deviceId,
      syncDirty: 1,
    });

    await feedsStore.put({
      ...oldFeed,
      subscribedNum: 0,
      movedTo: newUrl,
      updatedAt: stamp,
      deletedAt: stamp,
      deviceId,
      syncDirty: 1,
    });

    const oldEps = await episodesStore.index('byFeed').getAll(oldFeedKey);
    const identityByOldEpKey = new Map<EpisodeKey, string>();
    for (const ep of oldEps) {
      identityByOldEpKey.set(ep.episodeKey, ep.identity);
      const nextEpKey = deriveEpisodeKey(newFeedKey, ep.identity);
      const existingTargetEp = await episodesStore.get(nextEpKey);
      await episodesStore.delete(ep.episodeKey);
      if (!existingTargetEp) {
        await episodesStore.put({
          ...ep,
          episodeKey: nextEpKey,
          feedKey: newFeedKey,
        });
      }
      const ch = await chaptersStore.get(ep.episodeKey);
      if (ch) {
        await chaptersStore.delete(ep.episodeKey);
        if (!(await chaptersStore.get(nextEpKey))) {
          await chaptersStore.put({ ...ch, episodeKey: nextEpKey });
        }
      }
    }

    // Re-key active queue rows: write a Tombstone on `oldEpKey` (NEVER hard delete!)
    // so old keys never boomerang back as stubs after sync (SYNC-P1-03).
    const oldQueue = await queueStore.index('byFeed').getAll(oldFeedKey);
    for (const q of oldQueue) {
      if (q.removedNum !== 0) continue;
      const identity = q.stub?.identity ?? identityByOldEpKey.get(q.episodeKey);
      if (!identity) continue;
      const nextEpKey = deriveEpisodeKey(newFeedKey, identity);
      const tombStamp = this.hlc.stamp(q.updatedAt);
      const nextStamp = this.hlc.stamp(q.updatedAt);
      const tombRec: IdbQueueRecord = {
        episodeKey: q.episodeKey,
        feedKey: q.feedKey,
        pos: q.pos,
        addedAt: q.addedAt,
        updatedAt: tombStamp,
        removedNum: 1,
        deviceId,
        syncDirty: 1,
      };
      await queueStore.put(tombRec);
      await queueStore.put({
        ...q,
        episodeKey: nextEpKey,
        feedKey: newFeedKey,
        updatedAt: nextStamp,
        removedNum: 0,
        deviceId,
        syncDirty: 1,
      });
    }

    // Re-key progress rows: compare against existing target progress via `pickProgress`
    // so newer progress on the target key is never overwritten (SYNC-P1-03).
    const writeWallMs = Date.now();
    const oldProgs = await progStore.index('byFeed').getAll(oldFeedKey);
    for (const p of oldProgs) {
      const identity = p.identity ?? identityByOldEpKey.get(p.episodeKey);
      if (!identity) continue;
      const nextEpKey = deriveEpisodeKey(newFeedKey, identity);
      const targetP = await progStore.get(nextEpKey);
      await progStore.delete(p.episodeKey);
      const candidateSync = idbProgressToSyncProgress({ ...p, episodeKey: nextEpKey, feedKey: newFeedKey, identity });
      const keepOld =
        !targetP ||
        pickProgress(candidateSync, idbProgressToSyncProgress(targetP)) === candidateSync;
      if (keepOld) {
        await progStore.put({
          ...p,
          episodeKey: nextEpKey,
          feedKey: newFeedKey,
          identity,
          localWrittenAt: writeWallMs,
          syncDirty: 1,
        });
      }
    }

    await tx.done;
    return newFeedKey;
  }

  /**
   * Soft-deletes a feed on unsubscribe (`ARCHITECTURE.md §6.3`), returning any
   * downloaded file paths to remove on disk.
   */
  async softDeleteUnsubscribe(
    feedKey: FeedKey,
    deviceId: DeviceId,
    currentPlayingKey?: EpisodeKey,
  ): Promise<string[]> {
    const downloadsToDelete: string[] = [];
    const tx = this.db.transaction(['feeds', 'episodes', 'queue', 'chapters'], 'readwrite');
    const feedsStore = tx.objectStore('feeds');
    const episodesStore = tx.objectStore('episodes');
    const queueStore = tx.objectStore('queue');
    const chaptersStore = tx.objectStore('chapters');

    const feed = await feedsStore.get(feedKey);
    if (!feed) {
      await tx.done;
      return [];
    }

    const isLocal = feed.kind === 'LOCAL' || feedKey.startsWith('l_');
    const stamp = this.hlc.stamp(feed.updatedAt);

    const queueItems = await queueStore.index('byFeed').getAll(feedKey);
    for (const q of queueItems) {
      if (isLocal) {
        await queueStore.delete(q.episodeKey);
      } else if (q.removedNum === 0) {
        await queueStore.put({
          episodeKey: q.episodeKey,
          feedKey: q.feedKey,
          pos: q.pos,
          addedAt: q.addedAt,
          // Advance per-entry HLC causally beyond `q.updatedAt` instead of reusing feed `stamp` (SYNC-P2-05)
          updatedAt: this.hlc.stamp(q.updatedAt),
          removedNum: 1,
          deviceId,
          syncDirty: 1,
        });
      }
    }

    const eps = await episodesStore.index('byFeed').getAll(feedKey);
    for (const ep of eps) {
      if (ep.downloadPath) {
        downloadsToDelete.push(ep.downloadPath);
      }
      if (ep.episodeKey !== currentPlayingKey) {
        await episodesStore.delete(ep.episodeKey);
        await chaptersStore.delete(ep.episodeKey);
      } else if (ep.downloadState !== 'NONE') {
        const cleared: IdbEpisodeRecord = { ...ep, downloadState: 'NONE' };
        delete (cleared as { downloadPath?: string }).downloadPath;
        await episodesStore.put(cleared);
      }
    }

    if (isLocal) {
      await feedsStore.delete(feedKey);
    } else {
      await feedsStore.put({
        ...feed,
        subscribedNum: 0,
        hasCredentials: false,
        updatedAt: stamp,
        deletedAt: stamp,
        deviceId,
        syncDirty: 1,
      });
    }

    await tx.done;
    return downloadsToDelete;
  }

  async setFeedHasCredentials(
    feedKey: FeedKey,
    hasCredentials: boolean,
    deviceId?: DeviceId,
  ): Promise<void> {
    const tx = this.db.transaction(['feeds'], 'readwrite');
    const store = tx.objectStore('feeds');
    const feed = await store.get(feedKey);
    if (!feed) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }
    const isLocal = feed.kind === 'LOCAL' || feedKey.startsWith('l_');
    const stamp = this.hlc.stamp(feed.updatedAt);
    const effectiveDeviceId = deviceId ?? this.cachedSyncState?.deviceId ?? feed.deviceId;
    await store.put({
      ...feed,
      hasCredentials,
      updatedAt: stamp,
      syncDirty: isLocal ? 0 : 1,
      ...(effectiveDeviceId !== undefined ? { deviceId: effectiveDeviceId } : {}),
    });
    await tx.done;
  }

  async listEpisodes(
    feedKey: FeedKey,
    filter: EpisodeFilter,
    cursor?: string,
  ): Promise<Page<EpisodeRow>> {
    const tx = this.db.transaction(['episodes', 'progress', 'queue'], 'readonly');
    const [eps, progs, queues] = await Promise.all([
      tx.objectStore('episodes').index('byFeed').getAll(feedKey),
      tx.objectStore('progress').index('byFeed').getAll(feedKey),
      tx.objectStore('queue').index('byFeed').getAll(feedKey),
    ]);
    await tx.done;

    const progByKey = new Map<EpisodeKey, ProgressRecord>(
      progs.map((p) => [p.episodeKey, idbRecordToProgress(p)]),
    );
    const activeQueueKeys = new Set<EpisodeKey>(
      queues.filter((q) => q.removedNum === 0).map((q) => q.episodeKey),
    );

    const sorted = eps
      .filter((e) => !e.isStub)
      .sort((a, b) => {
        if (b.pubDateSort !== a.pubDateSort) return b.pubDateSort - a.pubDateSort;
        return a.episodeKey.localeCompare(b.episodeKey);
      });

    const filtered: EpisodeRow[] = [];
    for (const ep of sorted) {
      const prog = progByKey.get(ep.episodeKey);
      if (filter === 'unplayed' && prog?.state === 'PLAYED') continue;
      if (filter === 'downloaded' && ep.downloadState !== 'DONE') continue;
      filtered.push({
        episode: idbRecordToEpisode(ep),
        inQueue: activeQueueKeys.has(ep.episodeKey),
        ...(prog ? { progress: prog } : {}),
      });
    }

    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const items = filtered.slice(offset, offset + EPISODE_PAGE_SIZE);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async getEpisodeRecord(episodeKey: EpisodeKey): Promise<IdbEpisodeRecord | undefined> {
    return this.db.get('episodes', episodeKey);
  }

  async getEpisodeRow(episodeKey: EpisodeKey): Promise<EpisodeRow> {
    const tx = this.db.transaction(['episodes', 'progress', 'queue'], 'readonly');
    const [ep, prog, q] = await Promise.all([
      tx.objectStore('episodes').get(episodeKey),
      tx.objectStore('progress').get(episodeKey),
      tx.objectStore('queue').get(episodeKey),
    ]);
    await tx.done;

    if (!ep) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    return {
      episode: idbRecordToEpisode(ep),
      inQueue: q?.removedNum === 0,
      ...(prog ? { progress: idbRecordToProgress(prog) } : {}),
    };
  }

  async setEpisodeDownloadState(
    episodeKey: EpisodeKey,
    downloadState: DownloadState,
    downloadPath?: string,
  ): Promise<void> {
    const tx = this.db.transaction(['episodes'], 'readwrite');
    const store = tx.objectStore('episodes');
    const ep = await store.get(episodeKey);
    if (ep) {
      const next: IdbEpisodeRecord = {
        ...ep,
        downloadState,
      };
      if (downloadPath !== undefined) {
        (next as { downloadPath?: string }).downloadPath = downloadPath;
      } else {
        delete (next as { downloadPath?: string }).downloadPath;
      }
      await store.put(next);
    }
    await tx.done;
  }

  /**
   * Atomic compare-and-set of an episode's download state: writes `downloadState` (+ `downloadPath`,
   * cleared when omitted) only when the current state is one of `from`. Lets late native download
   * events / snapshot reconciliation never resurrect a state the user already moved past (e.g. a
   * cancelled `NONE`). Returns the previous state when applied, otherwise `undefined`.
   */
  async updateEpisodeDownloadStateIf(
    episodeKey: EpisodeKey,
    from: readonly DownloadState[],
    downloadState: DownloadState,
    downloadPath?: string,
  ): Promise<DownloadState | undefined> {
    const tx = this.db.transaction(['episodes'], 'readwrite');
    const store = tx.objectStore('episodes');
    const ep = await store.get(episodeKey);
    let previous: DownloadState | undefined;
    if (ep && from.includes(ep.downloadState)) {
      previous = ep.downloadState;
      const next: IdbEpisodeRecord = { ...ep, downloadState };
      if (downloadPath !== undefined) {
        (next as { downloadPath?: string }).downloadPath = downloadPath;
      } else {
        delete (next as { downloadPath?: string }).downloadPath;
      }
      await store.put(next);
    }
    await tx.done;
    return previous;
  }

  /**
   * Boot reconciliation: `QUEUED` / `RUNNING` records can only be stale at startup (the WebView /
   * process died mid-download, leaving the `.part` behind). Flip them to `FAILED` so the UI shows
   * `继续下载` (resumable via HTTP `Range`) instead of a stuck progress ring. Feed refreshes and
   * sync merges preserve `FAILED` as-is. Returns the affected episode keys.
   *
   * `keep`: episodes the native download queue still reports as QUEUED/RUNNING (the native task
   * survived the WebView restart and will be re-attached) are left untouched.
   */
  async failStaleInFlightDownloads(keep?: ReadonlySet<EpisodeKey>): Promise<EpisodeKey[]> {
    const tx = this.db.transaction(['episodes'], 'readwrite');
    const store = tx.objectStore('episodes');
    const affected: EpisodeKey[] = [];
    let cursor = await store.openCursor();
    while (cursor) {
      const ep = cursor.value;
      if (
        (ep.downloadState === 'QUEUED' || ep.downloadState === 'RUNNING') &&
        !keep?.has(ep.episodeKey)
      ) {
        const next: IdbEpisodeRecord = { ...ep, downloadState: 'FAILED' };
        delete (next as { downloadPath?: string }).downloadPath;
        await cursor.update(next);
        affected.push(ep.episodeKey);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return affected;
  }

  /** Every episode record whose download is `QUEUED` or `RUNNING` (queue `停止全部`). */
  async listInFlightDownloadRecords(): Promise<IdbEpisodeRecord[]> {
    const out: IdbEpisodeRecord[] = [];
    let cursor = await this.db.transaction(['episodes'], 'readonly').objectStore('episodes').openCursor();
    while (cursor) {
      const ep = cursor.value;
      if (ep.downloadState === 'QUEUED' || ep.downloadState === 'RUNNING') out.push(ep);
      cursor = await cursor.continue();
    }
    return out;
  }

  async listAllQueueEntries(): Promise<QueueEntry[]> {
    const rows = await this.db.getAll('queue');
    return rows.map(idbRecordToQueueEntry);
  }

  /**
   * Atomically reads all queue entries, runs a pure queue mutation, and writes back
   * only the mutated rows inside a single IDB `readwrite` transaction (preventing
   * two-transaction races with `applyMerged`, SYNC-P1-11).
   */
  async mutateQueueAtomic(
    mutator: (entries: readonly QueueEntry[]) => readonly QueueEntry[],
  ): Promise<readonly QueueEntry[]> {
    const tx = this.db.transaction(['queue'], 'readwrite');
    const store = tx.objectStore('queue');
    const allRows = await store.getAll();
    const mutated = mutator(allRows.map(idbRecordToQueueEntry));
    for (const entry of mutated) {
      const isLocal = entry.feedKey.startsWith('l_');
      const rec: IdbQueueRecord = {
        episodeKey: entry.episodeKey,
        feedKey: entry.feedKey,
        pos: entry.pos,
        addedAt: entry.addedAt,
        updatedAt: entry.updatedAt,
        removedNum: entry.removed ? 1 : 0,
        deviceId: entry.deviceId,
        syncDirty: isLocal ? 0 : 1,
        ...(entry.stub !== undefined ? { stub: entry.stub } : {}),
      };
      await store.put(rec);
    }
    await tx.done;
    return mutated;
  }

  async upsertQueueEntries(entries: readonly QueueEntry[], syncDirty: boolean): Promise<void> {
    if (entries.length === 0) return;
    const tx = this.db.transaction(['queue'], 'readwrite');
    const store = tx.objectStore('queue');
    for (const entry of entries) {
      const isLocal = entry.feedKey.startsWith('l_');
      const rec: IdbQueueRecord = {
        episodeKey: entry.episodeKey,
        feedKey: entry.feedKey,
        pos: entry.pos,
        addedAt: entry.addedAt,
        updatedAt: entry.updatedAt,
        removedNum: entry.removed ? 1 : 0,
        deviceId: entry.deviceId,
        syncDirty: syncDirty && !isLocal ? 1 : 0,
        ...(entry.stub !== undefined ? { stub: entry.stub } : {}),
      };
      await store.put(rec);
    }
    await tx.done;
  }

  async listActiveQueueRows(): Promise<QueueRow[]> {
    const tx = this.db.transaction(['queue', 'episodes', 'progress'], 'readonly');
    const [allQueue, allEps, allProgs] = await Promise.all([
      tx.objectStore('queue').getAll(),
      tx.objectStore('episodes').getAll(),
      tx.objectStore('progress').getAll(),
    ]);
    await tx.done;

    const epMap = new Map<EpisodeKey, Episode>(allEps.map((e) => [e.episodeKey, idbRecordToEpisode(e)]));
    const progMap = new Map<EpisodeKey, ProgressRecord>(
      allProgs.map((p) => [p.episodeKey, idbRecordToProgress(p)]),
    );

    const active = allQueue
      .filter((q) => q.removedNum === 0)
      .map(idbRecordToQueueEntry)
      .sort(compareQueueOrder);

    const rows: QueueRow[] = [];
    for (const entry of active) {
      const ep = epMap.get(entry.episodeKey) ?? stubToFallbackEpisode(entry);
      const prog = progMap.get(entry.episodeKey);
      rows.push({
        entry,
        episode: ep,
        ...(prog ? { progress: prog } : {}),
      });
    }
    return rows;
  }

  async getProgress(episodeKey: EpisodeKey): Promise<ProgressRecord | undefined> {
    const row = await this.db.get('progress', episodeKey);
    return row ? idbRecordToProgress(row) : undefined;
  }

  async getProgressRecord(episodeKey: EpisodeKey): Promise<IdbProgressRecord | undefined> {
    return this.db.get('progress', episodeKey);
  }

  async upsertProgress(
    record: ProgressRecord,
    opts?: { syncDirty?: boolean; identity?: string | undefined; localWrittenAt?: EpochMs },
  ): Promise<void> {
    const tx = this.db.transaction(['progress', 'episodes'], 'readwrite');
    const progStore = tx.objectStore('progress');
    const existing = await progStore.get(record.episodeKey);
    const ep = await tx.objectStore('episodes').get(record.episodeKey);
    const isLocal = record.feedKey.startsWith('l_');
    const identity = opts?.identity ?? existing?.identity ?? ep?.identity;

    const rec: IdbProgressRecord = {
      episodeKey: record.episodeKey,
      feedKey: record.feedKey,
      positionMs: record.positionMs,
      state: record.state,
      playedAt: record.playedAt ?? null,
      updatedAt: record.updatedAt,
      deviceId: record.deviceId,
      localWrittenAt: opts?.localWrittenAt ?? Date.now(),
      syncDirty: (opts?.syncDirty ?? true) && !isLocal ? 1 : 0,
      ...(identity !== undefined ? { identity } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    await progStore.put(rec);
    await tx.done;
  }

  async getChaptersRecord(episodeKey: EpisodeKey): Promise<{
    feedChapters: readonly Chapter[];
    mergedChapters: readonly Chapter[];
    merged: boolean;
  }> {
    const rec = await this.db.get('chapters', episodeKey);
    if (!rec) {
      return { feedChapters: [], mergedChapters: [], merged: false };
    }
    return {
      feedChapters: rec.feedChapters,
      mergedChapters: rec.mergedChapters,
      merged: rec.merged,
    };
  }

  async saveMergedChapters(episodeKey: EpisodeKey, mergedChapters: readonly Chapter[]): Promise<void> {
    const tx = this.db.transaction(['chapters'], 'readwrite');
    const store = tx.objectStore('chapters');
    const existing = await store.get(episodeKey);
    await store.put({
      episodeKey,
      feedChapters: existing?.feedChapters ?? [],
      mergedChapters,
      merged: true,
    });
    await tx.done;
  }
}

function stubToFallbackEpisode(entry: QueueEntry): Episode {
  const stub: QueueStub | undefined = entry.stub;
  const imageUrl = stub?.imageUrl?.trim() || undefined;
  const mime = stub?.enclosureMime ?? '';
  const mediaType = mime.toLowerCase().startsWith('video/')
    ? 'VIDEO'
    : mime.toLowerCase().startsWith('audio/') || Boolean(stub?.enclosureUrl)
      ? 'AUDIO'
      : 'UNKNOWN';
  return {
    episodeKey: entry.episodeKey,
    feedKey: entry.feedKey,
    identity: stub?.identity ?? entry.episodeKey,
    isStub: true,
    title: stub?.title ?? 'Queued Episode',
    mediaType,
    downloadState: 'NONE',
    ...(stub?.pubDate !== undefined ? { pubDate: stub.pubDate } : {}),
    ...(stub?.durationMs !== undefined ? { durationMs: stub.durationMs } : {}),
    ...(stub?.enclosureUrl !== undefined ? { enclosureUrl: stub.enclosureUrl } : {}),
    ...(stub?.enclosureMime !== undefined ? { enclosureMime: stub.enclosureMime } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
}
