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
  HLC_MAX_FORWARD_SKEW_MS,
  HybridLogicalClock,
  toSyncQueueEntry,
  type ApplyDecisions,
  type DeviceId,
  type EpisodeKey,
  type FeedKey,
  type HlcMs,
  type LocalSyncSnapshot,
  type MiniPodErrorShape,
  type RestampBelowFloorOptions,
  type SyncDevice,
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
  remote_devices_json?: string | null;
  last_remote_fingerprint?: string | null;
  pending_lineage_reset?: number | null;
}

export interface SqliteSyncStoreDeps {
  readonly db: Database;
  readonly hlc: HybridLogicalClock;
  readonly appVersion: string;
  readonly defaultDeviceName?: string;
  readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
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

function subscriptionCoreMatches(row: FeedDbRow, remote: SyncSubscription): boolean {
  const localDeleted = row.deleted_at !== null || row.subscribed === 0;
  if (localDeleted !== remote.deleted) return false;
  const effectiveUrl = remote.movedTo || remote.url;
  // Compare against `(row.moved_to || row.url)` so permanentRedirect subscriptions match cleanly (SYNC-P1-12).
  if (!localDeleted && (row.moved_to || row.url) !== effectiveUrl) return false;
  return true;
}

function subscriptionFullyMatches(
  row: FeedDbRow,
  remote: SyncSubscription,
  fallbackDeviceId: DeviceId,
): boolean {
  if (!subscriptionCoreMatches(row, remote)) return false;
  if (row.updated_at !== remote.updatedAt) return false;
  if ((row.device_id || fallbackDeviceId) !== remote.deviceId) return false;
  if ((row.moved_to ?? null) !== (remote.movedTo ?? null)) return false;
  if ((row.has_credentials !== 0) !== Boolean(remote.hasCredentials)) return false;
  if (remote.title !== undefined && row.title === null) return false;
  if (remote.imageUrl !== undefined && row.image_url === null) return false;
  return true;
}

function feedRowToSyncSubscription(row: FeedDbRow, fallbackDeviceId: DeviceId): SyncSubscription {
  const deleted = row.deleted_at !== null;
  return {
    url: row.url,
    movedTo: row.moved_to ?? null,
    updatedAt: row.updated_at,
    deleted,
    deviceId: row.device_id || fallbackDeviceId,
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

function parseRemoteDevicesJson(json: string | null | undefined): Readonly<Record<DeviceId, SyncDevice>> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<DeviceId, SyncDevice>>;
    }
  } catch {
    // ignore corrupt metadata
  }
  return undefined;
}

export class SqliteSyncStore implements SyncStore {
  private readonly db: Database;
  private readonly hlc: HybridLogicalClock;
  private readonly appVersion: string;
  private readonly feedsRepo: FeedsRepository;
  private readonly episodesRepo: EpisodesRepository;
  private readonly progressRepo: ProgressRepository;
  private readonly queueRepo: QueueRepository;
  private readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
  private readonly onDeleteDownloads?: (paths: readonly string[]) => void;

  constructor(deps: SqliteSyncStoreDeps) {
    this.db = deps.db;
    this.hlc = deps.hlc;
    this.appVersion = deps.appVersion;
    this.feedsRepo = new FeedsRepository(deps.db);
    this.episodesRepo = new EpisodesRepository(deps.db);
    this.progressRepo = new ProgressRepository(deps.db);
    this.queueRepo = new QueueRepository(deps.db);
    if (deps.getCurrentEpisodeKey !== undefined) {
      this.getCurrentEpisodeKey = deps.getCurrentEpisodeKey;
    }
    if (deps.onDeleteDownloads !== undefined) {
      this.onDeleteDownloads = deps.onDeleteDownloads;
    }

    this.ensureSyncStateRow(deps.defaultDeviceName ?? defaultDesktopDeviceName(), true);
  }

  private queryMaxLocalEntityHlc(deviceId: DeviceId): HlcMs {
    const maxFeed = (
      this.db
        .prepare("SELECT MAX(updated_at) AS m FROM feeds WHERE kind = 'RSS' AND device_id = ?")
        .get(deviceId) as { m: number | null } | undefined
    )?.m ?? 0;
    const maxQueue = (
      this.db
        .prepare('SELECT MAX(updated_at) AS m FROM queue WHERE device_id = ?')
        .get(deviceId) as { m: number | null } | undefined
    )?.m ?? 0;
    const maxProg = (
      this.db
        .prepare('SELECT MAX(updated_at) AS m FROM progress WHERE device_id = ?')
        .get(deviceId) as { m: number | null } | undefined
    )?.m ?? 0;
    return Math.max(maxFeed, maxQueue, maxProg);
  }

  private ensureSyncStateRow(defaultName: string, restoreHlc: boolean = false): SyncStateRow {
    const existing = this.db
      .prepare('SELECT * FROM sync_state WHERE id = 1')
      .get() as SyncStateRow | undefined;
    if (existing) {
      if (restoreHlc) {
        // Heal any legacy forward-poisoned `hlc_last` and restore capped at `now + HLC_MAX_FORWARD_SKEW_MS`.
        const maxAllowed = Date.now() + HLC_MAX_FORWARD_SKEW_MS;
        let effectiveHlcLast = existing.hlc_last;
        if (effectiveHlcLast > maxAllowed) {
          effectiveHlcLast = maxAllowed;
          this.db.prepare('UPDATE sync_state SET hlc_last = ? WHERE id = 1').run(effectiveHlcLast);
        }
        const maxLocal = Math.max(effectiveHlcLast, this.queryMaxLocalEntityHlc(existing.device_id));
        if (maxLocal > this.hlc.current()) {
          this.hlc.restore(maxLocal);
        }
        if (effectiveHlcLast !== existing.hlc_last) {
          return { ...existing, hlc_last: effectiveHlcLast };
        }
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
    const remoteDevices = parseRemoteDevicesJson(row.remote_devices_json);
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
      ...(remoteDevices !== undefined ? { remoteDevices } : {}),
      ...(row.last_remote_fingerprint !== undefined ? { lastRemoteFingerprint: row.last_remote_fingerprint } : {}),
      ...(row.pending_lineage_reset ? { pendingLineageReset: true } : {}),
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
      const maxAllowedHlc = Date.now() + HLC_MAX_FORWARD_SKEW_MS;
      const clampedCurrentHlc = Math.min(current.hlc_last, maxAllowedHlc);
      const hlcLast = Math.min(
        Math.max(clampedCurrentHlc, patch.hlcLast ?? 0, this.hlc.current()),
        maxAllowedHlc,
      );
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
      const remoteDevicesJson =
        'remoteDevices' in patch
          ? patch.remoteDevices
            ? JSON.stringify(patch.remoteDevices)
            : null
          : (current.remote_devices_json ?? null);
      const lastRemoteFingerprint =
        'lastRemoteFingerprint' in patch
          ? (patch.lastRemoteFingerprint ?? null)
          : (current.last_remote_fingerprint ?? null);
      const pendingLineageReset =
        'pendingLineageReset' in patch
          ? patch.pendingLineageReset
            ? 1
            : 0
          : (current.pending_lineage_reset ?? 0);

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
             backoff_until = ?,
             remote_devices_json = ?,
             last_remote_fingerprint = ?,
             pending_lineage_reset = ?
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
          remoteDevicesJson,
          lastRemoteFingerprint,
          pendingLineageReset,
        );
    });
  }

  async getDirtyCount(): Promise<number> {
    const subCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM feeds WHERE kind = 'RSS' AND (subscribed = 1 OR deleted_at IS NOT NULL) AND sync_dirty = 1",
        )
        .get() as { c: number }
    ).c;
    const queueCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM queue WHERE sync_dirty = 1 AND feed_key NOT LIKE 'l_%'")
        .get() as { c: number }
    ).c;
    const progCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM progress WHERE sync_dirty = 1 AND feed_key NOT LIKE 'l_%'")
        .get() as { c: number }
    ).c;
    return subCount + queueCount + progCount;
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
    options?: RestampBelowFloorOptions,
  ): Promise<void> {
    const excludeSubs = options?.excludeKeys?.subscriptions;
    const excludeQueue = options?.excludeKeys?.queue;
    const excludeProg = options?.excludeKeys?.progress;
    const includeCleanLive = options?.includeCleanLive === true;

    transaction(this.db, () => {
      const state = this.getSyncStateSync();

      if (floors.subscriptions > 0) {
        const sql = includeCleanLive
          ? "SELECT id, feed_key, updated_at FROM feeds WHERE kind = 'RSS' AND ((sync_dirty = 1 AND (subscribed = 1 OR deleted_at IS NOT NULL)) OR (sync_dirty = 0 AND subscribed = 1 AND deleted_at IS NULL)) AND updated_at <= ?"
          : "SELECT id, feed_key, updated_at FROM feeds WHERE kind = 'RSS' AND sync_dirty = 1 AND (subscribed = 1 OR deleted_at IS NOT NULL) AND updated_at <= ?";
        const rows = this.db.prepare(sql).all(floors.subscriptions) as Array<{
          id: number;
          feed_key: string;
          updated_at: number;
        }>;
        for (const row of rows) {
          if (excludeSubs?.has(row.feed_key)) continue;
          const next = Math.max(stamp(), floors.subscriptions + 1, row.updated_at + 1);
          this.db
            .prepare(
              'UPDATE feeds SET updated_at = ?, deleted_at = CASE WHEN deleted_at IS NOT NULL THEN ? ELSE NULL END, device_id = ?, sync_dirty = 1 WHERE id = ?',
            )
            .run(next, next, state.deviceId, row.id);
        }
      }

      if (floors.queue > 0) {
        const sql = includeCleanLive
          ? "SELECT episode_key, updated_at FROM queue WHERE feed_key NOT LIKE 'l_%' AND (sync_dirty = 1 OR (sync_dirty = 0 AND removed = 0)) AND updated_at <= ?"
          : "SELECT episode_key, updated_at FROM queue WHERE feed_key NOT LIKE 'l_%' AND sync_dirty = 1 AND updated_at <= ?";
        const rows = this.db.prepare(sql).all(floors.queue) as Array<{
          episode_key: string;
          updated_at: number;
        }>;
        for (const row of rows) {
          if (excludeQueue?.has(row.episode_key)) continue;
          const next = Math.max(stamp(), floors.queue + 1, row.updated_at + 1);
          this.db
            .prepare('UPDATE queue SET updated_at = ?, device_id = ?, sync_dirty = 1 WHERE episode_key = ?')
            .run(next, state.deviceId, row.episode_key);
        }
      }

      if (floors.progress > 0) {
        const sql = includeCleanLive
          ? "SELECT episode_key, updated_at FROM progress WHERE feed_key NOT LIKE 'l_%' AND updated_at <= ?"
          : "SELECT episode_key, updated_at FROM progress WHERE feed_key NOT LIKE 'l_%' AND sync_dirty = 1 AND updated_at <= ?";
        const rows = this.db.prepare(sql).all(floors.progress) as Array<{
          episode_key: string;
          updated_at: number;
        }>;
        for (const row of rows) {
          if (excludeProg?.has(row.episode_key)) continue;
          const next = Math.max(stamp(), floors.progress + 1, row.updated_at + 1);
          this.db
            .prepare('UPDATE progress SET updated_at = ?, device_id = ?, sync_dirty = 1 WHERE episode_key = ?')
            .run(next, state.deviceId, row.episode_key);
        }
      }
    });
  }

  private canHardDeleteFeed(
    feedId: number,
    feedKey: FeedKey,
    currentEpisodeKey: EpisodeKey | undefined,
  ): boolean {
    if (currentEpisodeKey) {
      const playing = this.db
        .prepare('SELECT 1 AS ok FROM episodes WHERE feed_id = ? AND episode_key = ? LIMIT 1')
        .get(feedId, currentEpisodeKey) as { ok?: number } | undefined;
      if (playing?.ok === 1) return false;
    }
    const activeQ = this.db
      .prepare('SELECT 1 AS ok FROM queue WHERE feed_key = ? AND removed = 0 LIMIT 1')
      .get(feedKey) as { ok?: number } | undefined;
    if (activeQ?.ok === 1) return false;
    return true;
  }

  private collectFeedDownloadPaths(feedId: number): string[] {
    const rows = this.db
      .prepare('SELECT download_path FROM episodes WHERE feed_id = ? AND download_path IS NOT NULL')
      .all(feedId) as Array<{ download_path: string }>;
    return rows.map((r) => r.download_path);
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
    let subsChanged = false;
    let queueChanged = false;
    let progressChanged = false;
    const changedProgressKeys = new Set<EpisodeKey>();
    let hasConcurrentLocalEdits = false;

    transaction(this.db, () => {
      const state = this.getSyncStateSync();
      const localFeeds = this.getLocalFeedKeySet();

      // Unified transaction-start snapshots BEFORE any subscription cascade (SYNC-P0-01)
      const existingFeedRows = this.db
        .prepare("SELECT * FROM feeds WHERE kind = 'RSS'")
        .all() as unknown as FeedDbRow[];
      const localFeedByKey = new Map<FeedKey, FeedDbRow>(
        existingFeedRows.map((r) => [r.feed_key, r]),
      );

      const existingQueue = this.queueRepo.listAllRaw();
      const localQueueByKey = new Map<EpisodeKey, QueueDbRow>(
        existingQueue.map((q) => [q.episode_key, q]),
      );

      const existingProg = this.progressRepo.listAllRaw();
      const localProgByKey = new Map<EpisodeKey, ProgressDbRow>(
        existingProg.map((p) => [p.episode_key, p]),
      );

      // Helper: collect EVERY merged-active queue key for a feed so cascade never wipes
      // downloads/episodes that Step 2 will keep active in the merged queue.
      const collectMergedPreserveQueueKeys = (feedKey: FeedKey): ReadonlySet<EpisodeKey> => {
        const preserved = new Set<EpisodeKey>();
        for (const [epKey, q] of Object.entries(merged.queue.items)) {
          if (q.feedKey === feedKey && !q.removed) {
            preserved.add(epKey);
          }
        }
        return preserved;
      };

      // 1. Subscriptions (4-state updatedAt-first concurrent-edit guard, SYNC-P0-01)
      for (const [feedKey, winSub] of Object.entries(merged.subscriptions.items)) {
        const localRow = localFeedByKey.get(feedKey);
        const effectiveUrl = winSub.movedTo || winSub.url;

        if (!localRow) {
          if (!winSub.deleted) {
            this.db
              .prepare(
                `INSERT INTO feeds
                 (feed_key, kind, subscribed, url, moved_to, title, image_url, has_credentials,
                  added_at, updated_at, deleted_at, device_id, sync_dirty)
                 VALUES (?, 'RSS', 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
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
                winSub.deviceId,
              );
            feedsToRefresh.push(feedKey);
          } else {
            this.db
              .prepare(
                `INSERT INTO feeds
                 (feed_key, kind, subscribed, url, moved_to, title, image_url,
                  added_at, updated_at, deleted_at, device_id, sync_dirty)
                 VALUES (?, 'RSS', 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
                winSub.deviceId,
              );
          }
          subsChanged = true;
          continue;
        }

        // Concurrent local edit strictly newer than merged winner -> skip overwrite & keep dirty (SYNC-P0-01)
        if (localRow.sync_dirty !== 0 && localRow.updated_at > winSub.updatedAt) {
          hasConcurrentLocalEdits = true;
          continue;
        }

        if (localRow.updated_at === winSub.updatedAt) {
          if (localRow.sync_dirty !== 0 && subscriptionCoreMatches(localRow, winSub)) {
            // Preserve local dirty flag until upload `markClean` clears it
            continue;
          }
          if (localRow.sync_dirty === 0 && subscriptionFullyMatches(localRow, winSub, state.deviceId)) {
            // Already up-to-date & clean
            continue;
          }
        }

        if (!winSub.deleted) {
          const wasUnsubscribed = localRow.subscribed === 0 || localRow.deleted_at !== null;
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
                 device_id = ?,
                 sync_dirty = 0
               WHERE id = ?`,
            )
            .run(
              effectiveUrl,
              winSub.movedTo ?? null,
              winSub.title ?? null,
              winSub.imageUrl ?? null,
              winSub.hasCredentials ? 1 : 0,
              winSub.updatedAt,
              winSub.deviceId,
              localRow.id,
            );
          subsChanged = true;
          if (wasUnsubscribed) {
            feedsToRefresh.push(feedKey);
          }
        } else {
          // Winner is deleted tombstone
          if (localRow.subscribed !== 0 || localRow.deleted_at === null) {
            const preserveQueueKeys = collectMergedPreserveQueueKeys(feedKey);
            const dlPaths = this.feedsRepo.softDeleteUnsubscribe(
              feedKey,
              this.hlc,
              winSub.deviceId,
              {
                currentPlayingKey: currentEpisodeKey,
                stampOverride: winSub.updatedAt,
                syncDirty: false,
                preCascadeQueueByKey: localQueueByKey,
                preserveQueueKeys,
              },
            );
            downloadsToDelete.push(...dlPaths);
            subsChanged = true;
            queueChanged = true;
          } else {
            this.db
              .prepare(
                'UPDATE feeds SET updated_at = ?, deleted_at = ?, device_id = ?, sync_dirty = 0 WHERE id = ?',
              )
              .run(winSub.updatedAt, winSub.updatedAt, winSub.deviceId, localRow.id);
            subsChanged = true;
          }
        }
      }

      // Clean (`sync_dirty = 0`) RSS subscriptions absent from merged fell under remote floor -> soft-delete/purge
      for (const localRow of existingFeedRows) {
        if (localRow.sync_dirty !== 0) continue;
        if (localRow.subscribed === 0 && localRow.deleted_at === null) continue; // stub
        if (!(localRow.feed_key in merged.subscriptions.items)) {
          const floorStamp = Math.max(merged.subscriptions.floor, localRow.updated_at);
          const preserveQueueKeys = collectMergedPreserveQueueKeys(localRow.feed_key);
          if (localRow.subscribed !== 0) {
            const dlPaths = this.feedsRepo.softDeleteUnsubscribe(
              localRow.feed_key,
              this.hlc,
              state.deviceId,
              {
                currentPlayingKey: currentEpisodeKey,
                stampOverride: floorStamp,
                syncDirty: false,
                preCascadeQueueByKey: localQueueByKey,
                preserveQueueKeys,
              },
            );
            downloadsToDelete.push(...dlPaths);
            subsChanged = true;
            queueChanged = true;
          }
          // Protect currently playing or actively queued episodes & clean downloads before DELETE (SYNC-P2-06)
          if (
            preserveQueueKeys.size === 0 &&
            this.canHardDeleteFeed(localRow.id, localRow.feed_key, currentEpisodeKey)
          ) {
            downloadsToDelete.push(...this.collectFeedDownloadPaths(localRow.id));
            this.db
              .prepare('DELETE FROM feeds WHERE id = ? AND subscribed = 0')
              .run(localRow.id);
            subsChanged = true;
          }
        }
      }

      // 2. Queue (using pre-cascade `localQueueByKey` snapshot, SYNC-P0-01)
      const getCurrentQueueRow = this.db.prepare('SELECT * FROM queue WHERE episode_key = ?');

      for (const [epKey, winQ] of Object.entries(merged.queue.items)) {
        if (localFeeds.has(winQ.feedKey) || winQ.feedKey.startsWith('l_')) continue;
        const preQ = localQueueByKey.get(epKey);

        if (preQ) {
          // Concurrent local dirty write strictly newer than merged winner -> preserve!
          if (preQ.sync_dirty !== 0 && preQ.updated_at > winQ.updatedAt) {
            hasConcurrentLocalEdits = true;
            continue;
          }
          if (preQ.updated_at === winQ.updatedAt) {
            const coreMatch = (preQ.removed !== 0) === winQ.removed && preQ.pos === winQ.pos;
            if (preQ.sync_dirty !== 0 && coreMatch) {
              continue;
            }
            if (preQ.sync_dirty === 0) {
              const curQ = getCurrentQueueRow.get(epKey) as QueueDbRow | undefined;
              if (
                curQ &&
                curQ.updated_at === winQ.updatedAt &&
                (curQ.removed !== 0) === winQ.removed &&
                curQ.pos === winQ.pos &&
                curQ.device_id === winQ.deviceId &&
                curQ.added_at === winQ.addedAt &&
                curQ.feed_key === winQ.feedKey &&
                curQ.sync_dirty === 0
              ) {
                continue;
              }
            }
          }
        }

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

        const entry = fromSyncQueueEntry(epKey, winQ);
        this.queueRepo.upsertEntries([entry], false);
        queueChanged = true;
      }

      for (const localQ of existingQueue) {
        if (localFeeds.has(localQ.feed_key) || localQ.feed_key.startsWith('l_')) continue;
        if (localQ.sync_dirty === 0 && !(localQ.episode_key in merged.queue.items)) {
          this.queueRepo.deleteHard(localQ.episode_key);
          queueChanged = true;
        }
      }

      // 3. Progress (using pre-cascade `localProgByKey` snapshot, SYNC-P0-01, SYNC-P1-08)
      for (const [epKey, winP] of Object.entries(merged.progress.items)) {
        if (localFeeds.has(winP.feedKey) || winP.feedKey.startsWith('l_')) continue;
        const preP = localProgByKey.get(epKey);

        if (preP) {
          if (preP.sync_dirty !== 0 && preP.updated_at > winP.updatedAt) {
            hasConcurrentLocalEdits = true;
            continue;
          }
          if (preP.updated_at === winP.updatedAt) {
            const coreMatch = preP.state === winP.state && preP.position_ms === winP.positionMs;
            if (preP.sync_dirty !== 0 && coreMatch) {
              continue;
            }
            if (
              preP.sync_dirty === 0 &&
              coreMatch &&
              preP.device_id === winP.deviceId &&
              preP.feed_key === winP.feedKey &&
              (preP.duration_ms ?? undefined) === winP.durationMs &&
              (preP.played_at ?? null) === (winP.playedAt ?? null) &&
              (preP.identity ?? undefined) === winP.identity
            ) {
              continue;
            }
          }
        }

        const changedRemotely =
          winP.deviceId !== state.deviceId &&
          (!preP ||
            winP.updatedAt > preP.updated_at ||
            (winP.updatedAt === preP.updated_at &&
              (winP.positionMs !== preP.position_ms || winP.state !== preP.state)));

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
          { syncDirty: false, identity: winP.identity, fromSync: true },
        );
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

      for (const localP of existingProg) {
        if (localFeeds.has(localP.feed_key) || localP.feed_key.startsWith('l_')) continue;
        if (localP.sync_dirty === 0 && !(localP.episode_key in merged.progress.items)) {
          this.progressRepo.delete(localP.episode_key);
          progressChanged = true;
          changedProgressKeys.add(localP.episode_key);
        }
      }

      // Raise floors monotonically and persist bounded local HLC
      const curState = this.ensureSyncStateRow('MiniPod Desktop');
      const maxAllowedHlc = Date.now() + HLC_MAX_FORWARD_SKEW_MS;
      const nextHlcLast = Math.min(
        Math.max(Math.min(curState.hlc_last, maxAllowedHlc), this.hlc.current()),
        maxAllowedHlc,
      );
      this.db
        .prepare(
          `UPDATE sync_state SET
             floor_subscriptions = MAX(floor_subscriptions, ?),
             floor_queue = MAX(floor_queue, ?),
             floor_progress = MAX(floor_progress, ?),
             hlc_last = ?
           WHERE id = 1`,
        )
        .run(
          merged.subscriptions.floor,
          merged.queue.floor,
          merged.progress.floor,
          nextHlcLast,
        );
    });

    if (downloadsToDelete.length > 0) {
      this.onDeleteDownloads?.(downloadsToDelete);
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
    const downloadsToDelete: string[] = [];
    const currentEpKey = this.getCurrentEpisodeKey?.();

    transaction(this.db, () => {
      if (floors.subscriptions > 0) {
        const candidates = this.db
          .prepare(
            "SELECT id, feed_key FROM feeds WHERE kind = 'RSS' AND subscribed = 0 AND deleted_at IS NOT NULL AND sync_dirty = 0 AND updated_at <= ?",
          )
          .all(floors.subscriptions) as Array<{ id: number; feed_key: string }>;
        for (const cand of candidates) {
          // Never ON DELETE CASCADE a currently playing or actively queued episode, and clean download files (SYNC-P2-06).
          if (!this.canHardDeleteFeed(cand.id, cand.feed_key, currentEpKey)) {
            continue;
          }
          downloadsToDelete.push(...this.collectFeedDownloadPaths(cand.id));
          this.db.prepare('DELETE FROM feeds WHERE id = ?').run(cand.id);
        }
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

    if (downloadsToDelete.length > 0) {
      this.onDeleteDownloads?.(downloadsToDelete);
    }
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
