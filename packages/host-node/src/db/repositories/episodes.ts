import {
  classifyMediaType,
  episodeKey as computeEpisodeKey,
  MiniPodError,
  type DownloadState,
  type Episode,
  type EpisodeFilter,
  type EpisodeKey,
  type EpisodeRow,
  type FeedKey,
  type MediaType,
  type Page,
  type ParsedEpisode,
  type QueueStub,
} from '@minipod/core';
import type { Database } from '../sqlite';
import { transaction } from '../sqlite';
import { ChaptersRepository } from './chapters';
import { rowToProgressRecord, type ProgressDbRow } from './progress';

export interface EpisodeDbRow {
  id: number;
  feed_id: number;
  episode_key: string;
  identity: string;
  is_stub: number;
  title: string;
  description: string | null;
  link: string | null;
  image_url: string | null;
  pub_date: number | null;
  duration_ms: number | null;
  enclosure_url: string | null;
  enclosure_mime: string | null;
  enclosure_size: number | null;
  media_type: MediaType;
  chapters_url: string | null;
  chapters_type: string | null;
  transcript_url: string | null;
  transcript_type: string | null;
  download_path: string | null;
  download_state: DownloadState;
  chapters_merged: number;
  local_mtime_ms: number | null;
}

export function rowToEpisode(row: EpisodeDbRow, feedKey: FeedKey): Episode {
  return {
    episodeKey: row.episode_key,
    feedKey,
    identity: row.identity,
    isStub: row.is_stub !== 0,
    title: row.title,
    mediaType: row.media_type,
    downloadState: row.download_state,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.link !== null ? { link: row.link } : {}),
    ...(row.image_url !== null ? { imageUrl: row.image_url } : {}),
    ...(row.pub_date !== null ? { pubDate: row.pub_date } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.enclosure_url !== null ? { enclosureUrl: row.enclosure_url } : {}),
    ...(row.enclosure_mime !== null ? { enclosureMime: row.enclosure_mime } : {}),
    ...(row.enclosure_size !== null ? { enclosureSize: row.enclosure_size } : {}),
    ...(row.chapters_url !== null ? { chaptersUrl: row.chapters_url } : {}),
    ...(row.chapters_type !== null ? { chaptersType: row.chapters_type } : {}),
    ...(row.transcript_url !== null ? { transcriptUrl: row.transcript_url } : {}),
    ...(row.transcript_type !== null ? { transcriptType: row.transcript_type } : {}),
    ...(row.download_path !== null ? { downloadPath: row.download_path } : {}),
  };
}

const DEFAULT_PAGE_SIZE = 50;

export class EpisodesRepository {
  private readonly chaptersRepo: ChaptersRepository;

  constructor(private readonly db: Database) {
    this.chaptersRepo = new ChaptersRepository(db);
  }

  getRawByKey(episodeKey: EpisodeKey): (EpisodeDbRow & { feed_key: string }) | undefined {
    return this.db
      .prepare(
        `SELECT e.*, f.feed_key
         FROM episodes e
         JOIN feeds f ON f.id = e.feed_id
         WHERE e.episode_key = ?`,
      )
      .get(episodeKey) as (EpisodeDbRow & { feed_key: string }) | undefined;
  }

  getByKey(episodeKey: EpisodeKey): Episode | undefined {
    const row = this.getRawByKey(episodeKey);
    return row ? rowToEpisode(row, row.feed_key) : undefined;
  }

  getRow(episodeKey: EpisodeKey): EpisodeRow {
    const raw = this.getRawByKey(episodeKey);
    if (!raw) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    const episode = rowToEpisode(raw, raw.feed_key);
    const progRow = this.db
      .prepare('SELECT * FROM progress WHERE episode_key = ?')
      .get(episodeKey) as ProgressDbRow | undefined;
    const inQueueRow = this.db
      .prepare('SELECT 1 AS ok FROM queue WHERE episode_key = ? AND removed = 0')
      .get(episodeKey) as { ok?: number } | undefined;

    return {
      episode,
      inQueue: inQueueRow?.ok === 1,
      ...(progRow ? { progress: rowToProgressRecord(progRow) } : {}),
    };
  }

  list(feedKey: FeedKey, filter: EpisodeFilter = 'all', cursor?: string): Page<EpisodeRow> {
    const feedRow = this.db
      .prepare('SELECT id FROM feeds WHERE feed_key = ?')
      .get(feedKey) as { id: number } | undefined;
    if (!feedRow) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }

    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;

    let filterClause = '';
    if (filter === 'downloaded') {
      filterClause = "AND e.download_state = 'DONE'";
    } else if (filter === 'unplayed') {
      filterClause = "AND (p.state IS NULL OR p.state != 'PLAYED')";
    }

    const rows = this.db
      .prepare(
        `SELECT e.*,
                p.position_ms AS p_position_ms,
                p.duration_ms AS p_duration_ms,
                p.state AS p_state,
                p.played_at AS p_played_at,
                p.updated_at AS p_updated_at,
                p.device_id AS p_device_id,
                CASE WHEN q.episode_key IS NOT NULL AND q.removed = 0 THEN 1 ELSE 0 END AS in_queue
         FROM episodes e
         LEFT JOIN progress p ON p.episode_key = e.episode_key
         LEFT JOIN queue q ON q.episode_key = e.episode_key
         WHERE e.feed_id = ? ${filterClause}
         ORDER BY COALESCE(e.pub_date, 0) DESC, e.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(feedRow.id, DEFAULT_PAGE_SIZE + 1, offset) as unknown as Array<
      EpisodeDbRow & {
        p_position_ms: number | null;
        p_duration_ms: number | null;
        p_state: ProgressDbRow['state'] | null;
        p_played_at: number | null;
        p_updated_at: number | null;
        p_device_id: string | null;
        in_queue: number;
      }
    >;

    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const slice = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const items: EpisodeRow[] = slice.map((r) => {
      const episode = rowToEpisode(r, feedKey);
      const progress =
        r.p_state !== null && r.p_updated_at !== null && r.p_device_id !== null
          ? {
              episodeKey: r.episode_key,
              feedKey,
              positionMs: r.p_position_ms ?? 0,
              state: r.p_state,
              updatedAt: r.p_updated_at,
              deviceId: r.p_device_id,
              ...(r.p_duration_ms !== null ? { durationMs: r.p_duration_ms } : {}),
              ...(r.p_played_at !== null ? { playedAt: r.p_played_at } : {}),
            }
          : undefined;
      return {
        episode,
        inQueue: r.in_queue === 1,
        ...(progress ? { progress } : {}),
      };
    });

    return {
      items,
      ...(hasMore ? { nextCursor: String(offset + DEFAULT_PAGE_SIZE) } : {}),
    };
  }

  /**
   * Upserts parsed episodes for a feed, preserving existing download state & paths
   * and replacing `is_stub = 1` rows cleanly. Returns count of newly inserted episodes.
   */
  upsertParsedEpisodes(
    feedId: number,
    feedKey: FeedKey,
    parsedEpisodes: readonly ParsedEpisode[],
    options?: { readonly fallbackImageUrl?: string | undefined; readonly localMtimeByIdentity?: ReadonlyMap<string, number> },
  ): number {
    let addedCount = 0;
    transaction(this.db, () => {
      const selectExisting = this.db.prepare(
        'SELECT id, is_stub FROM episodes WHERE episode_key = ?',
      );
      const insertStmt = this.db.prepare(
        `INSERT INTO episodes
         (feed_id, episode_key, identity, is_stub, title, description, link, image_url,
          pub_date, duration_ms, enclosure_url, enclosure_mime, enclosure_size, media_type,
          chapters_url, chapters_type, transcript_url, transcript_type, local_mtime_ms)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateStmt = this.db.prepare(
        `UPDATE episodes SET
           feed_id = ?,
           identity = ?,
           is_stub = 0,
           title = ?,
           description = COALESCE(?, description),
           link = COALESCE(?, link),
           image_url = COALESCE(?, image_url),
           pub_date = COALESCE(?, pub_date),
           duration_ms = COALESCE(?, duration_ms),
           enclosure_url = COALESCE(?, enclosure_url),
           enclosure_mime = COALESCE(?, enclosure_mime),
           enclosure_size = COALESCE(?, enclosure_size),
           media_type = ?,
           chapters_url = ?,
           chapters_type = ?,
           transcript_url = ?,
           transcript_type = ?,
           local_mtime_ms = COALESCE(?, local_mtime_ms)
         WHERE id = ?`,
      );

      for (const ep of parsedEpisodes) {
        const epKey = computeEpisodeKey(feedKey, ep.identity);
        const existing = selectExisting.get(epKey) as { id: number; is_stub: number } | undefined;
        const img = ep.imageUrl ?? options?.fallbackImageUrl ?? null;
        const mtime = options?.localMtimeByIdentity?.get(ep.identity) ?? null;

        let episodeId: number;
        if (!existing) {
          const res = insertStmt.run(
            feedId,
            epKey,
            ep.identity,
            ep.title,
            ep.description ?? null,
            ep.link ?? null,
            img,
            ep.pubDate ?? null,
            ep.durationMs ?? null,
            ep.enclosureUrl ?? null,
            ep.enclosureMime ?? null,
            ep.enclosureSize ?? null,
            ep.mediaType,
            ep.chaptersUrl ?? null,
            ep.chaptersType ?? null,
            ep.transcriptUrl ?? null,
            ep.transcriptType ?? null,
            mtime,
          );
          episodeId = Number(res.lastInsertRowid);
          addedCount += 1;
        } else {
          updateStmt.run(
            feedId,
            ep.identity,
            ep.title,
            ep.description ?? null,
            ep.link ?? null,
            img,
            ep.pubDate ?? null,
            ep.durationMs ?? null,
            ep.enclosureUrl ?? null,
            ep.enclosureMime ?? null,
            ep.enclosureSize ?? null,
            ep.mediaType,
            ep.chaptersUrl ?? null,
            ep.chaptersType ?? null,
            ep.transcriptUrl ?? null,
            ep.transcriptType ?? null,
            mtime,
            existing.id,
          );
          episodeId = existing.id;
          if (existing.is_stub !== 0) {
            addedCount += 1;
          }
        }

        if (ep.chapters && ep.chapters.length > 0) {
          this.chaptersRepo.saveFeedChapters(episodeId, ep.chapters);
        }
      }
    });
    return addedCount;
  }

  /**
   * Materialises a stub episode from a sync `QueueStub` if the episode does not yet exist locally (§7.6).
   */
  ensureStubEpisode(feedId: number, feedKey: FeedKey, episodeKey: EpisodeKey, stub: QueueStub | undefined): void {
    const existing = this.db
      .prepare('SELECT id FROM episodes WHERE episode_key = ?')
      .get(episodeKey) as { id: number } | undefined;
    if (existing) return;

    const identity = stub?.identity ?? episodeKey;
    const title = stub?.title ?? 'Queued Episode';
    const mediaType = classifyMediaType(stub?.enclosureMime, stub?.enclosureUrl);

    this.db
      .prepare(
        `INSERT INTO episodes
         (feed_id, episode_key, identity, is_stub, title, image_url, pub_date,
          duration_ms, enclosure_url, enclosure_mime, media_type, download_state)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'NONE')`,
      )
      .run(
        feedId,
        episodeKey,
        identity,
        title,
        stub?.imageUrl ?? null,
        stub?.pubDate ?? null,
        stub?.durationMs ?? null,
        stub?.enclosureUrl ?? null,
        stub?.enclosureMime ?? null,
        mediaType,
      );
  }

  setDownloadState(
    episodeKey: EpisodeKey,
    state: DownloadState,
    downloadPath?: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE episodes
         SET download_state = ?, download_path = ?
         WHERE episode_key = ?`,
      )
      .run(state, downloadPath ?? null, episodeKey);
  }
}
