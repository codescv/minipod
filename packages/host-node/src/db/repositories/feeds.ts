import {
  episodeKey as computeEpisodeKey,
  feedKey as computeFeedKey,
  MiniPodError,
  type DeviceId,
  type EpisodeKey,
  type Feed,
  type FeedKey,
  type FeedKind,
  type HlcMs,
  type HybridLogicalClock,
  type ParsedFeed,
} from '@minipod/core';
import type { Database } from '../sqlite';
import { transaction } from '../sqlite';
import { EpisodesRepository } from './episodes';
import { ProgressRepository } from './progress';
import { QueueRepository, rowToQueueEntry, type QueueDbRow } from './queue';

export interface FeedDbRow {
  id: number;
  feed_key: string;
  kind: FeedKind;
  subscribed: number;
  url: string;
  moved_to: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  link: string | null;
  image_url: string | null;
  language: string | null;
  funding_url: string | null;
  local_cover_path: string | null;
  has_credentials: number;
  etag: string | null;
  last_modified: string | null;
  next_page_url: string | null;
  last_refreshed_at: number | null;
  last_episode_at: number | null;
  added_at: number;
  updated_at: number;
  deleted_at: number | null;
  sync_dirty: number;
}

export function rowToFeed(row: FeedDbRow): Feed {
  return {
    feedKey: row.feed_key,
    kind: row.kind,
    subscribed: row.subscribed !== 0,
    url: row.url,
    hasCredentials: row.has_credentials !== 0,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.author !== null ? { author: row.author } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.link !== null ? { link: row.link } : {}),
    ...(row.image_url !== null ? { imageUrl: row.image_url } : {}),
    ...(row.language !== null ? { language: row.language } : {}),
    ...(row.funding_url !== null ? { fundingUrl: row.funding_url } : {}),
    ...(row.next_page_url !== null ? { nextPageUrl: row.next_page_url } : {}),
    ...(row.last_refreshed_at !== null ? { lastRefreshedAt: row.last_refreshed_at } : {}),
    ...(row.last_episode_at !== null ? { lastEpisodeAt: row.last_episode_at } : {}),
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
  };
}

export class FeedsRepository {
  private readonly episodesRepo: EpisodesRepository;
  private readonly progressRepo: ProgressRepository;
  private readonly queueRepo: QueueRepository;

  constructor(private readonly db: Database) {
    this.episodesRepo = new EpisodesRepository(db);
    this.progressRepo = new ProgressRepository(db);
    this.queueRepo = new QueueRepository(db);
  }

  listSubscribed(): Feed[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM feeds
         WHERE subscribed = 1 AND deleted_at IS NULL
         ORDER BY COALESCE(last_episode_at, added_at) DESC, id DESC`,
      )
      .all() as unknown as FeedDbRow[];
    return rows.map(rowToFeed);
  }

  listAllRaw(): FeedDbRow[] {
    return this.db.prepare('SELECT * FROM feeds').all() as unknown as FeedDbRow[];
  }

  getRaw(feedKey: FeedKey): FeedDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM feeds WHERE feed_key = ?')
      .get(feedKey) as FeedDbRow | undefined;
  }

  get(feedKey: FeedKey): Feed {
    const row = this.getRaw(feedKey);
    if (!row) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }
    return rowToFeed(row);
  }

  isSubscribed(feedKey: FeedKey): boolean {
    const row = this.db
      .prepare('SELECT subscribed, deleted_at FROM feeds WHERE feed_key = ?')
      .get(feedKey) as { subscribed: number; deleted_at: number | null } | undefined;
    return Boolean(row && row.subscribed !== 0 && row.deleted_at === null);
  }

  /**
   * Ensures a feed stub (`subscribed = 0`, `sync_dirty = 0`) exists for previewing or
   * materialising synced queue items (§6.3). Never downgrades an already-subscribed row.
   */
  ensureFeedStub(
    feedKey: FeedKey,
    input: {
      readonly kind?: FeedKind;
      readonly url: string;
      readonly title?: string | undefined;
      readonly imageUrl?: string | undefined;
      readonly nowHlc: HlcMs;
    },
  ): FeedDbRow {
    const existing = this.getRaw(feedKey);
    if (existing) {
      if ((input.title && !existing.title) || (input.imageUrl && !existing.image_url)) {
        this.db
          .prepare(
            `UPDATE feeds
             SET title = COALESCE(title, ?),
                 image_url = COALESCE(image_url, ?)
             WHERE id = ?`,
          )
          .run(input.title ?? null, input.imageUrl ?? null, existing.id);
        return this.getRaw(feedKey)!;
      }
      return existing;
    }

    this.db
      .prepare(
        `INSERT INTO feeds
         (feed_key, kind, subscribed, url, title, image_url, added_at, updated_at, sync_dirty)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        feedKey,
        input.kind ?? 'RSS',
        input.url,
        input.title ?? null,
        input.imageUrl ?? null,
        input.nowHlc,
        input.nowHlc,
      );
    return this.getRaw(feedKey)!;
  }

  /**
   * Upserts a parsed RSS/Atom or Local Folder feed and its episodes inside one transaction.
   */
  upsertParsedFeed(options: {
    readonly feedKey: FeedKey;
    readonly kind: FeedKind;
    readonly url: string;
    readonly subscribed: boolean;
    readonly parsed: ParsedFeed;
    readonly hlc: HybridLogicalClock;
    readonly nowWallMs: number;
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
    readonly movedTo?: string | undefined;
    readonly hasCredentials?: boolean | undefined;
    readonly localCoverPath?: string | null | undefined;
    readonly overrideImageUrl?: string | undefined;
    readonly localMtimeByIdentity?: ReadonlyMap<string, number> | undefined;
    readonly markSyncDirty?: boolean | undefined;
  }): { readonly feed: Feed; readonly addedEpisodes: number } {
    return transaction(this.db, () => {
      const existing = this.getRaw(options.feedKey);
      const imageUrl = options.overrideImageUrl ?? options.parsed.imageUrl ?? existing?.image_url ?? undefined;

      let feedId: number;
      if (!existing) {
        const stamp = options.hlc.now();
        const dirty = options.markSyncDirty ?? (options.subscribed && options.kind === 'RSS') ? 1 : 0;
        const res = this.db
          .prepare(
            `INSERT INTO feeds
             (feed_key, kind, subscribed, url, moved_to, title, author, description, link,
              image_url, language, funding_url, local_cover_path, has_credentials,
              etag, last_modified, next_page_url, last_refreshed_at, added_at, updated_at, deleted_at, sync_dirty)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            options.feedKey,
            options.kind,
            options.subscribed ? 1 : 0,
            options.url,
            options.movedTo ?? null,
            options.parsed.title ?? null,
            options.parsed.author ?? null,
            options.parsed.description ?? null,
            options.parsed.link ?? null,
            imageUrl ?? null,
            options.parsed.language ?? null,
            options.parsed.fundingUrl ?? null,
            options.localCoverPath ?? null,
            options.hasCredentials ? 1 : 0,
            options.etag ?? null,
            options.lastModified ?? null,
            options.parsed.nextPageUrl ?? null,
            options.nowWallMs,
            stamp,
            stamp,
            dirty,
          );
        feedId = Number(res.lastInsertRowid);
      } else {
        const subscribingNow = options.subscribed && (existing.subscribed === 0 || existing.deleted_at !== null);
        const urlMoved = options.movedTo !== undefined && options.movedTo !== existing.moved_to;
        const nextUpdatedAt =
          subscribingNow || urlMoved ? options.hlc.stamp(existing.updated_at) : existing.updated_at;
        const nextAddedAt = subscribingNow ? nextUpdatedAt : existing.added_at;
        const nextDirty =
          options.markSyncDirty !== undefined
            ? options.markSyncDirty
              ? 1
              : existing.sync_dirty
            : subscribingNow || urlMoved
              ? options.kind === 'RSS'
                ? 1
                : 0
              : existing.sync_dirty;

        const nextSubscribed = options.subscribed ? 1 : existing.subscribed;
        const nextDeletedAt = options.subscribed ? null : existing.deleted_at;

        this.db
          .prepare(
            `UPDATE feeds SET
               subscribed = ?,
               url = ?,
               moved_to = COALESCE(?, moved_to),
               title = COALESCE(?, title),
               author = COALESCE(?, author),
               description = COALESCE(?, description),
               link = COALESCE(?, link),
               image_url = COALESCE(?, image_url),
               language = COALESCE(?, language),
               funding_url = COALESCE(?, funding_url),
               local_cover_path = COALESCE(?, local_cover_path),
               has_credentials = ?,
               etag = COALESCE(?, etag),
               last_modified = COALESCE(?, last_modified),
               next_page_url = ?,
               last_refreshed_at = ?,
               added_at = ?,
               updated_at = ?,
               deleted_at = ?,
               sync_dirty = ?
             WHERE id = ?`,
          )
          .run(
            nextSubscribed,
            options.url,
            options.movedTo ?? null,
            options.parsed.title ?? null,
            options.parsed.author ?? null,
            options.parsed.description ?? null,
            options.parsed.link ?? null,
            imageUrl ?? null,
            options.parsed.language ?? null,
            options.parsed.fundingUrl ?? null,
            options.localCoverPath !== undefined ? options.localCoverPath : existing.local_cover_path,
            options.hasCredentials !== undefined ? (options.hasCredentials ? 1 : 0) : existing.has_credentials,
            options.etag ?? null,
            options.lastModified ?? null,
            options.parsed.nextPageUrl ?? null,
            options.nowWallMs,
            nextAddedAt,
            nextUpdatedAt,
            nextDeletedAt,
            nextDirty,
            existing.id,
          );
        feedId = existing.id;
      }

      const addedEpisodes = this.episodesRepo.upsertParsedEpisodes(
        feedId,
        options.feedKey,
        options.parsed.episodes,
        {
          fallbackImageUrl: imageUrl,
          ...(options.localMtimeByIdentity ? { localMtimeByIdentity: options.localMtimeByIdentity } : {}),
        },
      );

      const maxPub = this.db
        .prepare('SELECT MAX(pub_date) AS max_pub FROM episodes WHERE feed_id = ?')
        .get(feedId) as { max_pub: number | null } | undefined;
      if (maxPub && maxPub.max_pub !== null) {
        this.db
          .prepare('UPDATE feeds SET last_episode_at = ? WHERE id = ?')
          .run(maxPub.max_pub, feedId);
      }

      return { feed: this.get(options.feedKey), addedEpisodes };
    });
  }

  /**
   * Soft-deletes a subscription (ARCHITECTURE.md §6.3):
   * - Sets `subscribed = 0`, `deleted_at = stamp`, `updated_at = stamp`, `sync_dirty = 1` (for RSS).
   * - Collects download paths for deletion.
   * - Tombstones (`removed = 1`, fresh `updated_at`) every active `queue` row of that `feed_key`.
   * - Deletes episodes of that feed that are NOT currently playing and NOT referenced by queue.
   * - Preserves `progress`.
   */
  softDeleteUnsubscribe(
    feedKey: FeedKey,
    hlc: HybridLogicalClock,
    deviceId: DeviceId,
    options?: {
      readonly currentPlayingKey?: EpisodeKey | undefined;
      readonly stampOverride?: HlcMs | undefined;
      readonly syncDirty?: boolean | undefined;
    },
  ): readonly string[] {
    return transaction(this.db, () => {
      const feed = this.getRaw(feedKey);
      if (!feed) return [];

      const stamp = options?.stampOverride ?? hlc.stamp(feed.updated_at);
      const dirty =
        options?.syncDirty !== undefined
          ? options.syncDirty
            ? 1
            : 0
          : feed.kind === 'RSS'
            ? 1
            : 0;

      if (feed.kind === 'LOCAL') {
        // Local folders never sync: collect downloads and delete row cleanly unless playing
        const dlRows = this.db
          .prepare('SELECT download_path FROM episodes WHERE feed_id = ? AND download_path IS NOT NULL')
          .all(feed.id) as Array<{ download_path: string }>;
        this.db
          .prepare('DELETE FROM queue WHERE feed_key = ?')
          .run(feedKey);
        this.db.prepare('DELETE FROM feeds WHERE id = ?').run(feed.id);
        return dlRows.map((r) => r.download_path);
      }

      this.db
        .prepare(
          `UPDATE feeds
           SET subscribed = 0, deleted_at = ?, updated_at = ?, sync_dirty = ?
           WHERE id = ?`,
        )
        .run(stamp, stamp, dirty, feed.id);

      // Tombstone active queue items of this feed
      const activeQueueRows = this.db
        .prepare('SELECT * FROM queue WHERE feed_key = ? AND removed = 0')
        .all(feedKey) as unknown as QueueDbRow[];
      if (activeQueueRows.length > 0) {
        const tombstones = activeQueueRows.map((q) => {
          const entry = rowToQueueEntry(q);
          return {
            episodeKey: entry.episodeKey,
            feedKey: entry.feedKey,
            pos: entry.pos,
            addedAt: entry.addedAt,
            updatedAt: hlc.stamp(entry.updatedAt),
            removed: true,
            deviceId,
          };
        });
        this.queueRepo.upsertEntries(tombstones, options?.syncDirty ?? true);
      }

      const dlRows = this.db
        .prepare('SELECT episode_key, download_path FROM episodes WHERE feed_id = ? AND download_path IS NOT NULL')
        .all(feed.id) as Array<{ episode_key: string; download_path: string }>;

      const playingKey = options?.currentPlayingKey;
      const downloadPaths: string[] = [];
      for (const dl of dlRows) {
        if (dl.episode_key !== playingKey) {
          downloadPaths.push(dl.download_path);
          this.db
            .prepare("UPDATE episodes SET download_state = 'NONE', download_path = NULL WHERE episode_key = ?")
            .run(dl.episode_key);
        }
      }

      if (playingKey) {
        this.db
          .prepare('DELETE FROM episodes WHERE feed_id = ? AND episode_key != ?')
          .run(feed.id, playingKey);
      } else {
        this.db.prepare('DELETE FROM episodes WHERE feed_id = ?').run(feed.id);
      }

      return downloadPaths;
    });
  }

  /**
   * Records a permanent feed URL move (301/308, `http->https`, or `<itunes:new-feed-url>`, §4.1.3).
   * If `feedKey(newUrl)` already exists as a distinct row, aliases the old row into the surviving
   * row (tombstoning old key and re-keying queue & progress by `identity`).
   */
  recordPermanentMove(
    oldFeedKey: FeedKey,
    newUrl: string,
    hlc: HybridLogicalClock,
    deviceId: DeviceId,
  ): FeedKey {
    return transaction(this.db, () => {
      const existing = this.getRaw(oldFeedKey);
      if (!existing || existing.kind !== 'RSS') return oldFeedKey;

      const targetKey = computeFeedKey(newUrl);
      const stamp = hlc.stamp(existing.updated_at);

      if (targetKey === oldFeedKey) {
        // E.g. http:// -> https:// on same host/path has identical scheme-less feedKey!
        if (existing.url !== newUrl || existing.moved_to !== newUrl) {
          this.db
            .prepare(
              `UPDATE feeds
               SET url = ?, moved_to = ?, updated_at = ?, sync_dirty = 1
               WHERE id = ?`,
            )
            .run(newUrl, newUrl, stamp, existing.id);
        }
        return oldFeedKey;
      }

      const colliding = this.getRaw(targetKey);
      if (!colliding) {
        // Keep original feedKey and record movedTo + updated fetch url per §4.1.3 ("recorded as movedTo on the original key")
        this.db
          .prepare(
            `UPDATE feeds
             SET url = ?, moved_to = ?, updated_at = ?, sync_dirty = 1
             WHERE id = ?`,
          )
          .run(newUrl, newUrl, stamp, existing.id);
        return oldFeedKey;
      }

      // Alias oldFeedKey into surviving targetKey row (§4.1.3)
      const survivorStamp = hlc.stamp(colliding.updated_at);
      this.db
        .prepare(
          `UPDATE feeds
           SET subscribed = CASE WHEN ? = 1 THEN 1 ELSE subscribed END,
               deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END,
               url = ?,
               updated_at = ?,
               sync_dirty = 1
           WHERE id = ?`,
        )
        .run(existing.subscribed, existing.subscribed, newUrl, survivorStamp, colliding.id);

      // Tombstone old key with moved_to pointer
      this.db
        .prepare(
          `UPDATE feeds
           SET subscribed = 0, moved_to = ?, deleted_at = ?, updated_at = ?, sync_dirty = 1
           WHERE id = ?`,
        )
        .run(newUrl, stamp, stamp, existing.id);

      // Re-key progress & queue via identity
      this.progressRepo.rekeyFeed(oldFeedKey, targetKey, (id) => computeEpisodeKey(targetKey, id));

      const oldQueue = this.db
        .prepare('SELECT * FROM queue WHERE feed_key = ? AND removed = 0')
        .all(oldFeedKey) as unknown as QueueDbRow[];
      for (const qRow of oldQueue) {
        const entry = rowToQueueEntry(qRow);
        const identity =
          entry.stub?.identity ??
          ((
            this.db
              .prepare('SELECT identity FROM episodes WHERE episode_key = ?')
              .get(entry.episodeKey) as { identity?: string } | undefined
          )?.identity);
        if (!identity) continue;
        const newEpKey = computeEpisodeKey(targetKey, identity);
        this.queueRepo.upsertEntries(
          [
            {
              ...entry,
              removed: true,
              updatedAt: hlc.stamp(entry.updatedAt),
              deviceId,
            },
            {
              ...entry,
              episodeKey: newEpKey,
              feedKey: targetKey,
              updatedAt: hlc.stamp(entry.updatedAt),
              deviceId,
            },
          ],
          true,
        );
      }

      return targetKey;
    });
  }

  setHasCredentials(feedKey: FeedKey, hasCredentials: boolean, hlc: HybridLogicalClock): void {
    const row = this.getRaw(feedKey);
    if (!row) return;
    const nextVal = hasCredentials ? 1 : 0;
    if (row.has_credentials === nextVal) return;
    const stamp = hlc.stamp(row.updated_at);
    this.db
      .prepare('UPDATE feeds SET has_credentials = ?, updated_at = ?, sync_dirty = 1 WHERE id = ?')
      .run(nextVal, stamp, row.id);
  }

  updateConditionalHeaders(
    feedKey: FeedKey,
    headers: { readonly etag?: string | undefined; readonly lastModified?: string | undefined; readonly refreshedAt: number },
  ): void {
    this.db
      .prepare(
        `UPDATE feeds
         SET etag = COALESCE(?, etag),
             last_modified = COALESCE(?, last_modified),
             last_refreshed_at = ?
         WHERE feed_key = ?`,
      )
      .run(headers.etag ?? null, headers.lastModified ?? null, headers.refreshedAt, feedKey);
  }

  updateNextPageUrl(feedKey: FeedKey, nextPageUrl: string | undefined): void {
    this.db
      .prepare('UPDATE feeds SET next_page_url = ? WHERE feed_key = ?')
      .run(nextPageUrl ?? null, feedKey);
  }

  /**
   * Purges feed stubs (`subscribed = 0 AND deleted_at IS NULL`) that have no queued, playing,
   * downloaded, or in-progress episodes and are not in `activePreviewFeedKeys` (§6.3).
   */
  purgeUnusedStubs(protectedFeedKeys: ReadonlySet<FeedKey>, currentPlayingEpisodeKey?: EpisodeKey): void {
    const stubs = this.db
      .prepare('SELECT id, feed_key FROM feeds WHERE subscribed = 0 AND deleted_at IS NULL')
      .all() as Array<{ id: number; feed_key: string }>;

    for (const stub of stubs) {
      if (protectedFeedKeys.has(stub.feed_key)) continue;
      const activeQ = this.db
        .prepare('SELECT 1 AS ok FROM queue WHERE feed_key = ? AND removed = 0 LIMIT 1')
        .get(stub.feed_key) as { ok?: number } | undefined;
      if (activeQ?.ok === 1) continue;

      const activeDl = this.db
        .prepare("SELECT 1 AS ok FROM episodes WHERE feed_id = ? AND download_state != 'NONE' LIMIT 1")
        .get(stub.id) as { ok?: number } | undefined;
      if (activeDl?.ok === 1) continue;

      const activeProg = this.db
        .prepare("SELECT 1 AS ok FROM progress WHERE feed_key = ? AND state = 'IN_PROGRESS' LIMIT 1")
        .get(stub.feed_key) as { ok?: number } | undefined;
      if (activeProg?.ok === 1) continue;

      if (currentPlayingEpisodeKey) {
        const playingEp = this.db
          .prepare('SELECT 1 AS ok FROM episodes WHERE feed_id = ? AND episode_key = ? LIMIT 1')
          .get(stub.id, currentPlayingEpisodeKey) as { ok?: number } | undefined;
        if (playingEp?.ok === 1) continue;
      }

      this.db.prepare('DELETE FROM feeds WHERE id = ?').run(stub.id);
    }
  }
}
