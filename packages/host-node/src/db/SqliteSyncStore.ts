/**
 * `SqliteSyncStore`: SQLite implementation of `@minipod/core`'s `SyncStore`
 * (ARCHITECTURE.md §6.1, §7.6, §7.7).
 *
 * All multi-table merges in `applyMerged` run inside a single `SAVEPOINT` transaction.
 * Local folder feeds (`kind = 'LOCAL'`) never enter or leave the cloud sync document.
 */
import {
  fromSyncQueueEntry,
  generateDeviceId,
  HybridLogicalClock,
  toSyncQueueEntry,
  type ApplyDecisions,
  type DeviceId,
  type EpisodeKey,
  type FeedKey,
  type HlcMs,
  type LocalSyncSnapshot,
  type MiniPodErrorShape,
  type SyncDocument,
  type SyncEntityMaps,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncState,
  type SyncStore,
  type SyncSubscription,
} from '@minipod/core';
import { hostname } from 'node:os';
import type { Database } from './sqlite';
import { transaction } from './sqlite';
import { EpisodesRepository } from './repositories/episodes';
import { FeedsRepository, type FeedDbRow } from './repositories/feeds';
import { ProgressRepository, type ProgressDbRow } from './repositories/progress';
import { QueueRepository, rowToQueueEntry, type QueueDbRow } from './repositories/queue';

interface SyncStateRow {
  id: number;
  provider: string | null;
  provider_config: string | null;
  device_id: string;
  device_name: string;
  remote_etag: string | null;
  remote_file_id: string | null;
  remote_rev: number;
  floor_subscriptions: number;
  floor_queue: number;
  floor_progress: number;
  hlc_last: number;
  last_pull_at: number | null;
  last_push_at: number | null;
  last_error_json: string | null;
  backoff_until: number | null;
}

export interface SqliteSyncStoreDeps {
  readonly db: Database;
  readonly hlc: HybridLogicalClock;
  readonly appVersion: string;
  readonly defaultDeviceName?: string;
  readonly onDeleteDownloads?: (paths: readonly string[]) => void;
}

function defaultDesktopDeviceName(): string {
  try {
    const h = hostname().trim();
    return h || 'MiniPod Desktop';
  } catch {
    return 'MiniPod Desktop';
  }
}

function subscriptionEquals(row: FeedDbRow, remote: SyncSubscription): boolean {
  const localDeleted = row.deleted_at !== null || row.subscribed === 0;
  if (localDeleted !== remote.deleted) return false;
  if (row.updated_at !== remote.updatedAt) return false;
  const effectiveUrl = remote.movedTo || remote.url;
  if (!localDeleted && row.url !== effectiveUrl) return false;
  return true;
}

function feedRowToSyncSubscription(row: FeedDbRow, fallbackDeviceId: DeviceId): SyncSubscription {
  const deleted = row.deleted_at !== null;
  return {
    url: row.url,
    movedTo: row.moved_to ?? null,
    updatedAt: row.updated_at,
    deleted,
    deviceId: fallbackDeviceId,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.image_url !== null ? { imageUrl: row.image_url } : {}),
    ...(row.has_credentials !== 0 ? { hasCredentials: true } : {}),
  };
}

function progressRowToSyncProgress(row: ProgressDbRow): SyncProgress {
  return {
    feedKey: row.feed_key,
    positionMs: row.position_ms,
    state: row.state,
    playedAt: row.played_at,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    ...(row.identity !== null ? { identity: row.identity } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
  };
}

export class SqliteSyncStore implements SyncStore {
  private readonly db: Database;
  private readonly hlc: HybridLogicalClock;
  private readonly appVersion: string;
  private readonly feedsRepo: FeedsRepository;
  private readonly episodesRepo: EpisodesRepository;
  private readonly progressRepo: ProgressRepository;
  private readonly queueRepo: QueueRepository;
  private readonly onDeleteDownloads?: (paths: readonly string[]) => void;

  constructor(deps: SqliteSyncStoreDeps) {
    this.db = deps.db;
    this.hlc = deps.hlc;
    this.appVersion = deps.appVersion;
    this.feedsRepo = new FeedsRepository(deps.db);
    this.episodesRepo = new EpisodesRepository(deps.db);
    this.progressRepo = new ProgressRepository(deps.db);
    this.queueRepo = new QueueRepository(deps.db);
    if (deps.onDeleteDownloads !== undefined) {
      this.onDeleteDownloads = deps.onDeleteDownloads;
    }

    this.ensureSyncStateRow(deps.defaultDeviceName ?? defaultDesktopDeviceName());
  }

  private ensureSyncStateRow(defaultName: string): SyncStateRow {
    const existing = this.db
      .prepare('SELECT * FROM sync_state WHERE id = 1')
      .get() as SyncStateRow | undefined;
    if (existing) {
      if (existing.hlc_last > this.hlc.current()) {
        this.hlc.observe(existing.hlc_last);
      }
      return existing;
    }
    const deviceId = generateDeviceId();
    this.db
      .prepare(
        `INSERT INTO sync_state
         (id, device_id, device_name, remote_rev, floor_subscriptions, floor_queue, floor_progress, hlc_last)
         VALUES (1, ?, ?, 0, 0, 0, 0, ?)`,
      )
      .run(deviceId, defaultName, this.hlc.current());
    return this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as unknown as SyncStateRow;
  }

  getSyncStateSync(): SyncState {
    const row = this.ensureSyncStateRow('MiniPod Desktop');
    let lastError: MiniPodErrorShape | undefined;
    if (row.last_error_json) {
      try {
        lastError = JSON.parse(row.last_error_json) as MiniPodErrorShape;
      } catch {
        lastError = undefined;
      }
    }
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      remoteEtag: row.remote_etag,
      remoteFileId: row.remote_file_id,
      remoteRev: row.remote_rev,
      floors: {
        subscriptions: row.floor_subscriptions,
        queue: row.floor_queue,
        progress: row.floor_progress,
      },
      hlcLast: row.hlc_last,
      ...(row.last_pull_at !== null ? { lastPullAt: row.last_pull_at } : {}),
      ...(row.last_push_at !== null ? { lastPushAt: row.last_push_at } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(row.backoff_until !== null && row.backoff_until > 0 ? { backoffUntil: row.backoff_until } : {}),
    };
  }

  async getSyncState(): Promise<SyncState> {
    return this.getSyncStateSync();
  }

  async setSyncState(patch: Partial<SyncState>): Promise<void> {
    transaction(this.db, () => {
      const current = this.ensureSyncStateRow('MiniPod Desktop');

      const deviceId = patch.deviceId ?? current.device_id;
      const deviceName = patch.deviceName ?? current.device_name;
      const remoteEtag = 'remoteEtag' in patch ? (patch.remoteEtag ?? null) : current.remote_etag;
      const remoteFileId = 'remoteFileId' in patch ? (patch.remoteFileId ?? null) : current.remote_file_id;
      const remoteRev = patch.remoteRev ?? current.remote_rev;
      const floorSub = patch.floors?.subscriptions ?? current.floor_subscriptions;
      const floorQueue = patch.floors?.queue ?? current.floor_queue;
      const floorProg = patch.floors?.progress ?? current.floor_progress;
      const hlcLast = Math.max(current.hlc_last, patch.hlcLast ?? 0, this.hlc.current());
      const lastPullAt = 'lastPullAt' in patch ? (patch.lastPullAt ?? null) : current.last_pull_at;
      const lastPushAt = 'lastPushAt' in patch ? (patch.lastPushAt ?? null) : current.last_push_at;
      const lastErrorJson =
        'lastError' in patch
          ? patch.lastError
            ? JSON.stringify(patch.lastError)
            : null
          : current.last_error_json;
      const backoffUntil =
        'backoffUntil' in patch
          ? patch.backoffUntil && patch.backoffUntil > 0
            ? patch.backoffUntil
            : null
          : current.backoff_until;

      this.db
        .prepare(
          `UPDATE sync_state SET
             device_id = ?,
             device_name = ?,
             remote_etag = ?,
             remote_file_id = ?,
             remote_rev = ?,
             floor_subscriptions = ?,
             floor_queue = ?,
             floor_progress = ?,
             hlc_last = ?,
             last_pull_at = ?,
             last_push_at = ?,
             last_error_json = ?,
             backoff_until = ?
           WHERE id = 1`,
        )
        .run(
          deviceId,
          deviceName,
          remoteEtag,
          remoteFileId,
          remoteRev,
          floorSub,
          floorQueue,
          floorProg,
          hlcLast,
          lastPullAt,
          lastPushAt,
          lastErrorJson,
          backoffUntil,
        );
    });
  }

  private getLocalFeedKeySet(): Set<FeedKey> {
    const rows = this.db
      .prepare("SELECT feed_key FROM feeds WHERE kind = 'LOCAL'")
      .all() as Array<{ feed_key: string }>;
    return new Set(rows.map((r) => r.feed_key));
  }

  async loadLocalDoc(): Promise<LocalSyncSnapshot> {
    const state = this.getSyncStateSync();
    const localFeeds = this.getLocalFeedKeySet();

    // Subscriptions: all RSS feeds that are either subscribed=1 or tombstoned (deleted_at IS NOT NULL).
    // Feed stubs (`subscribed = 0 AND deleted_at IS NULL`) are NOT subscriptions!
    const feedRows = this.db
      .prepare(
        "SELECT * FROM feeds WHERE kind = 'RSS' AND (subscribed = 1 OR deleted_at IS NOT NULL)",
      )
      .all() as unknown as FeedDbRow[];

    const subItems: Record<FeedKey, SyncSubscription> = {};
    const dirtySubs = new Set<FeedKey>();
    for (const row of feedRows) {
      subItems[row.feed_key] = feedRowToSyncSubscription(row, state.deviceId);
      if (row.sync_dirty !== 0) {
        dirtySubs.add(row.feed_key);
      }
    }

    // Queue: exclude items belonging to LOCAL folder feeds
    const queueRows = this.queueRepo.listAllRaw();
    const queueItems: Record<EpisodeKey, SyncQueueEntry> = {};
    const dirtyQueue = new Set<EpisodeKey>();
    for (const qRow of queueRows) {
      if (localFeeds.has(qRow.feed_key) || qRow.feed_key.startsWith('l_')) continue;
      const entry = rowToQueueEntry(qRow);
      queueItems[qRow.episode_key] = toSyncQueueEntry(entry);
      if (qRow.sync_dirty !== 0) {
        dirtyQueue.add(qRow.episode_key);
      }
    }

    // Progress: exclude items belonging to LOCAL folder feeds
    const progRows = this.progressRepo.listAllRaw();
    const progItems: Record<EpisodeKey, SyncProgress> = {};
    const dirtyProg = new Set<EpisodeKey>();
    for (const pRow of progRows) {
      if (localFeeds.has(pRow.feed_key) || pRow.feed_key.startsWith('l_')) continue;
      progItems[pRow.episode_key] = progressRowToSyncProgress(pRow);
      if (pRow.sync_dirty !== 0) {
        dirtyProg.add(pRow.episode_key);
      }
    }

    return {
      maps: {
        subscriptions: { floor: state.floors.subscriptions, items: subItems },
        queue: { floor: state.floors.queue, items: queueItems },
        progress: { floor: state.floors.progress, items: progItems },
      },
      device: {
        name: state.deviceName,
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
  ): Promise<void> {
    transaction(this.db, () => {
      if (floors.subscriptions > 0) {
        const rows = this.db
          .prepare(
            "SELECT id, updated_at FROM feeds WHERE kind = 'RSS' AND sync_dirty = 1 AND updated_at <= ?",
          )
          .all(floors.subscriptions) as Array<{ id: number; updated_at: number }>;
        for (const row of rows) {
          const next = Math.max(stamp(), floors.subscriptions + 1, row.updated_at + 1);
          this.db
            .prepare(
              'UPDATE feeds SET updated_at = ?, deleted_at = CASE WHEN deleted_at IS NOT NULL THEN ? ELSE NULL END WHERE id = ?',
            )
            .run(next, next, row.id);
        }
      }

      if (floors.queue > 0) {
        const rows = this.db
          .prepare('SELECT episode_key, updated_at FROM queue WHERE sync_dirty = 1 AND updated_at <= ?')
          .all(floors.queue) as Array<{ episode_key: string; updated_at: number }>;
        for (const row of rows) {
          const next = Math.max(stamp(), floors.queue + 1, row.updated_at + 1);
          this.db
            .prepare('UPDATE queue SET updated_at = ? WHERE episode_key = ?')
            .run(next, row.episode_key);
        }
      }

      if (floors.progress > 0) {
        const rows = this.db
          .prepare('SELECT episode_key, updated_at FROM progress WHERE sync_dirty = 1 AND updated_at <= ?')
          .all(floors.progress) as Array<{ episode_key: string; updated_at: number }>;
        for (const row of rows) {
          const next = Math.max(stamp(), floors.progress + 1, row.updated_at + 1);
          this.db
            .prepare('UPDATE progress SET updated_at = ? WHERE episode_key = ?')
            .run(next, row.episode_key);
        }
      }
    });
  }

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

    transaction(this.db, () => {
      const state = this.getSyncStateSync();
      const localFeeds = this.getLocalFeedKeySet();

      // 1. Subscriptions
      const existingFeedRows = this.db
        .prepare("SELECT * FROM feeds WHERE kind = 'RSS'")
        .all() as unknown as FeedDbRow[];
      const localFeedByKey = new Map<FeedKey, FeedDbRow>(
        existingFeedRows.map((r) => [r.feed_key, r]),
      );

      for (const [feedKey, winSub] of Object.entries(merged.subscriptions.items)) {
        const localRow = localFeedByKey.get(feedKey);
        const effectiveUrl = winSub.movedTo || winSub.url;

        if (!winSub.deleted) {
          if (!localRow) {
            this.db
              .prepare(
                `INSERT INTO feeds
                 (feed_key, kind, subscribed, url, moved_to, title, image_url, has_credentials,
                  added_at, updated_at, deleted_at, sync_dirty)
                 VALUES (?, 'RSS', 1, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
              )
              .run(
                feedKey,
                effectiveUrl,
                winSub.movedTo ?? null,
                winSub.title ?? null,
                winSub.imageUrl ?? null,
                winSub.hasCredentials ? 1 : 0,
                winSub.updatedAt,
                winSub.updatedAt,
              );
            feedsToRefresh.push(feedKey);
          } else {
            const wasUnsubscribed = localRow.subscribed === 0 || localRow.deleted_at !== null;
            const localWon =
              localRow.sync_dirty !== 0 &&
              localRow.subscribed === 1 &&
              localRow.deleted_at === null &&
              localRow.updated_at >= winSub.updatedAt &&
              subscriptionEquals(localRow, winSub);

            this.db
              .prepare(
                `UPDATE feeds SET
                   subscribed = 1,
                   url = ?,
                   moved_to = COALESCE(?, moved_to),
                   title = COALESCE(title, ?),
                   image_url = COALESCE(image_url, ?),
                   has_credentials = CASE WHEN has_credentials = 1 OR ? = 1 THEN 1 ELSE 0 END,
                   updated_at = ?,
                   deleted_at = NULL,
                   sync_dirty = ?
                 WHERE id = ?`,
              )
              .run(
                effectiveUrl,
                winSub.movedTo ?? null,
                winSub.title ?? null,
                winSub.imageUrl ?? null,
                winSub.hasCredentials ? 1 : 0,
                winSub.updatedAt,
                localWon ? 1 : 0,
                localRow.id,
              );
            if (wasUnsubscribed) {
              feedsToRefresh.push(feedKey);
            }
          }
        } else {
          // Winner is deleted tombstone
          if (!localRow) {
            this.db
              .prepare(
                `INSERT INTO feeds
                 (feed_key, kind, subscribed, url, moved_to, title, image_url,
                  added_at, updated_at, deleted_at, sync_dirty)
                 VALUES (?, 'RSS', 0, ?, ?, ?, ?, ?, ?, ?, 0)`,
              )
              .run(
                feedKey,
                effectiveUrl,
                winSub.movedTo ?? null,
                winSub.title ?? null,
                winSub.imageUrl ?? null,
                winSub.updatedAt,
                winSub.updatedAt,
                winSub.updatedAt,
              );
          } else if (localRow.subscribed !== 0 || localRow.deleted_at === null) {
            const dlPaths = this.feedsRepo.softDeleteUnsubscribe(
              feedKey,
              this.hlc,
              state.deviceId,
              {
                currentPlayingKey: currentEpisodeKey,
                stampOverride: winSub.updatedAt,
                syncDirty: false,
              },
            );
            downloadsToDelete.push(...dlPaths);
          } else {
            const localWon = localRow.sync_dirty !== 0 && localRow.updated_at >= winSub.updatedAt;
            this.db
              .prepare(
                'UPDATE feeds SET updated_at = ?, deleted_at = ?, sync_dirty = ? WHERE id = ?',
              )
              .run(winSub.updatedAt, winSub.updatedAt, localWon ? 1 : 0, localRow.id);
          }
        }
      }

      // Clean (`sync_dirty = 0`) RSS subscriptions absent from merged fell under remote floor -> soft-delete/purge
      for (const localRow of existingFeedRows) {
        if (localRow.sync_dirty !== 0) continue;
        if (localRow.subscribed === 0 && localRow.deleted_at === null) continue; // stub
        if (!(localRow.feed_key in merged.subscriptions.items)) {
          if (localRow.subscribed !== 0) {
            const dlPaths = this.feedsRepo.softDeleteUnsubscribe(
              localRow.feed_key,
              this.hlc,
              state.deviceId,
              { currentPlayingKey: currentEpisodeKey, syncDirty: false },
            );
            downloadsToDelete.push(...dlPaths);
          }
          this.db
            .prepare('DELETE FROM feeds WHERE id = ? AND subscribed = 0')
            .run(localRow.id);
        }
      }

      // 2. Queue
      const existingQueue = this.queueRepo.listAllRaw();
      const localQueueByKey = new Map<EpisodeKey, QueueDbRow>(
        existingQueue.map((q) => [q.episode_key, q]),
      );

      for (const [epKey, winQ] of Object.entries(merged.queue.items)) {
        if (localFeeds.has(winQ.feedKey) || winQ.feedKey.startsWith('l_')) continue;
        const localQ = localQueueByKey.get(epKey);

        if (!winQ.removed) {
          const feedStubRow = this.feedsRepo.ensureFeedStub(winQ.feedKey, {
            kind: 'RSS',
            url: winQ.stub?.feedUrl ?? `https://invalid.local/${winQ.feedKey}`,
            title: winQ.stub?.feedTitle,
            imageUrl: winQ.stub?.imageUrl,
            nowHlc: winQ.updatedAt,
          });
          this.episodesRepo.ensureStubEpisode(feedStubRow.id, winQ.feedKey, epKey, winQ.stub);
        }

        const localWon =
          localQ !== undefined &&
          localQ.sync_dirty !== 0 &&
          localQ.updated_at >= winQ.updatedAt &&
          localQ.device_id === winQ.deviceId &&
          (localQ.removed !== 0) === winQ.removed &&
          localQ.pos === winQ.pos;

        const entry = fromSyncQueueEntry(epKey, winQ);
        this.queueRepo.upsertEntries([entry], localWon);
      }

      for (const localQ of existingQueue) {
        if (localFeeds.has(localQ.feed_key) || localQ.feed_key.startsWith('l_')) continue;
        if (localQ.sync_dirty === 0 && !(localQ.episode_key in merged.queue.items)) {
          this.queueRepo.deleteHard(localQ.episode_key);
        }
      }

      // 3. Progress
      const existingProg = this.progressRepo.listAllRaw();
      const localProgByKey = new Map<EpisodeKey, ProgressDbRow>(
        existingProg.map((p) => [p.episode_key, p]),
      );

      for (const [epKey, winP] of Object.entries(merged.progress.items)) {
        if (localFeeds.has(winP.feedKey) || winP.feedKey.startsWith('l_')) continue;
        const localP = localProgByKey.get(epKey);

        const changedRemotely =
          winP.deviceId !== state.deviceId &&
          (!localP ||
            winP.updatedAt > localP.updated_at ||
            (winP.updatedAt === localP.updated_at &&
              (winP.positionMs !== localP.position_ms || winP.state !== localP.state)));

        const localWon =
          localP !== undefined &&
          localP.sync_dirty !== 0 &&
          localP.updated_at >= winP.updatedAt &&
          localP.device_id === winP.deviceId &&
          localP.position_ms === winP.positionMs &&
          localP.state === winP.state;

        this.progressRepo.upsert(
          {
            episodeKey: epKey,
            feedKey: winP.feedKey,
            positionMs: winP.positionMs,
            state: winP.state,
            updatedAt: winP.updatedAt,
            deviceId: winP.deviceId,
            ...(winP.durationMs !== undefined ? { durationMs: winP.durationMs } : {}),
            ...(winP.playedAt !== undefined && winP.playedAt !== null ? { playedAt: winP.playedAt } : {}),
          },
          { syncDirty: localWon, identity: winP.identity },
        );

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

      for (const localP of existingProg) {
        if (localFeeds.has(localP.feed_key) || localP.feed_key.startsWith('l_')) continue;
        if (localP.sync_dirty === 0 && !(localP.episode_key in merged.progress.items)) {
          this.progressRepo.delete(localP.episode_key);
        }
      }

      // Raise floors monotonically
      const curState = this.ensureSyncStateRow('MiniPod Desktop');
      this.db
        .prepare(
          `UPDATE sync_state SET
             floor_subscriptions = MAX(floor_subscriptions, ?),
             floor_queue = MAX(floor_queue, ?),
             floor_progress = MAX(floor_progress, ?),
             hlc_last = MAX(hlc_last, ?)
           WHERE id = 1`,
        )
        .run(
          merged.subscriptions.floor,
          merged.queue.floor,
          merged.progress.floor,
          Math.max(this.hlc.current(), curState.hlc_last),
        );
    });

    if (downloadsToDelete.length > 0) {
      this.onDeleteDownloads?.(downloadsToDelete);
    }

    return { resumeHints, feedsToRefresh };
  }

  async markClean(pushed: SyncEntityMaps): Promise<void> {
    transaction(this.db, () => {
      const clearFeed = this.db.prepare(
        "UPDATE feeds SET sync_dirty = 0 WHERE feed_key = ? AND kind = 'RSS' AND updated_at = ?",
      );
      for (const [feedKey, sub] of Object.entries(pushed.subscriptions.items)) {
        clearFeed.run(feedKey, sub.updatedAt);
      }

      const clearQueue = this.db.prepare(
        'UPDATE queue SET sync_dirty = 0 WHERE episode_key = ? AND updated_at = ?',
      );
      for (const [epKey, q] of Object.entries(pushed.queue.items)) {
        clearQueue.run(epKey, q.updatedAt);
      }

      const clearProg = this.db.prepare(
        'UPDATE progress SET sync_dirty = 0 WHERE episode_key = ? AND updated_at = ?',
      );
      for (const [epKey, p] of Object.entries(pushed.progress.items)) {
        clearProg.run(epKey, p.updatedAt);
      }
    });
  }

  async purgeBelowFloors(floors: SyncState['floors']): Promise<void> {
    transaction(this.db, () => {
      if (floors.subscriptions > 0) {
        this.db
          .prepare(
            "DELETE FROM feeds WHERE kind = 'RSS' AND subscribed = 0 AND deleted_at IS NOT NULL AND sync_dirty = 0 AND updated_at <= ?",
          )
          .run(floors.subscriptions);
      }
      if (floors.queue > 0) {
        this.db
          .prepare(
            'DELETE FROM queue WHERE removed = 1 AND sync_dirty = 0 AND updated_at <= ?',
          )
          .run(floors.queue);
      }
      if (floors.progress > 0) {
        this.db
          .prepare(
            "DELETE FROM progress WHERE state = 'PLAYED' AND sync_dirty = 0 AND updated_at <= ?",
          )
          .run(floors.progress);
      }
    });
  }

  async markAllDirty(): Promise<void> {
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE feeds SET sync_dirty = 1 WHERE kind = 'RSS' AND (subscribed = 1 OR deleted_at IS NOT NULL)",
        )
        .run();
      this.db
        .prepare("UPDATE queue SET sync_dirty = 1 WHERE feed_key NOT LIKE 'l_%'")
        .run();
      this.db
        .prepare("UPDATE progress SET sync_dirty = 1 WHERE feed_key NOT LIKE 'l_%'")
        .run();
    });
  }
}
