import type { EpisodeKey, FeedKey, ProgressRecord, ProgressState } from '@minipod/core';
import type { Database } from '../sqlite';

export interface ProgressDbRow {
  episode_key: string;
  feed_key: string;
  identity: string | null;
  position_ms: number;
  duration_ms: number | null;
  state: ProgressState;
  played_at: number | null;
  updated_at: number;
  device_id: string;
  sync_dirty: number;
}

export function rowToProgressRecord(row: ProgressDbRow): ProgressRecord {
  return {
    episodeKey: row.episode_key,
    feedKey: row.feed_key,
    positionMs: row.position_ms,
    state: row.state,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.played_at !== null ? { playedAt: row.played_at } : {}),
  };
}

export class ProgressRepository {
  constructor(private readonly db: Database) {}

  get(episodeKey: EpisodeKey): ProgressRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM progress WHERE episode_key = ?')
      .get(episodeKey) as ProgressDbRow | undefined;
    return row ? rowToProgressRecord(row) : undefined;
  }

  getRaw(episodeKey: EpisodeKey): ProgressDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM progress WHERE episode_key = ?')
      .get(episodeKey) as ProgressDbRow | undefined;
  }

  listAllRaw(): ProgressDbRow[] {
    return this.db.prepare('SELECT * FROM progress').all() as unknown as ProgressDbRow[];
  }

  upsert(
    record: ProgressRecord,
    options?: { readonly syncDirty?: boolean; readonly identity?: string | undefined },
  ): void {
    const dirty = options?.syncDirty ?? true ? 1 : 0;
    const existing = this.getRaw(record.episodeKey);
    const identity =
      options?.identity ??
      existing?.identity ??
      ((
        this.db
          .prepare('SELECT identity FROM episodes WHERE episode_key = ?')
          .get(record.episodeKey) as { identity?: string } | undefined
      )?.identity ?? null);

    this.db
      .prepare(
        `INSERT INTO progress
         (episode_key, feed_key, identity, position_ms, duration_ms, state, played_at, updated_at, device_id, sync_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(episode_key) DO UPDATE SET
           feed_key = excluded.feed_key,
           identity = COALESCE(excluded.identity, progress.identity),
           position_ms = excluded.position_ms,
           duration_ms = COALESCE(excluded.duration_ms, progress.duration_ms),
           state = excluded.state,
           played_at = excluded.played_at,
           updated_at = excluded.updated_at,
           device_id = excluded.device_id,
           sync_dirty = excluded.sync_dirty`,
      )
      .run(
        record.episodeKey,
        record.feedKey,
        identity,
        record.positionMs,
        record.durationMs ?? null,
        record.state,
        record.playedAt ?? null,
        record.updatedAt,
        record.deviceId,
        dirty,
      );
  }

  delete(episodeKey: EpisodeKey): void {
    this.db.prepare('DELETE FROM progress WHERE episode_key = ?').run(episodeKey);
  }

  rekeyFeed(oldFeedKey: FeedKey, newFeedKey: FeedKey, rekeyEpisode: (identity: string) => EpisodeKey): void {
    const rows = this.db
      .prepare('SELECT * FROM progress WHERE feed_key = ?')
      .all(oldFeedKey) as unknown as ProgressDbRow[];
    for (const row of rows) {
      if (!row.identity) {
        this.db
          .prepare('UPDATE progress SET feed_key = ?, sync_dirty = 1 WHERE episode_key = ?')
          .run(newFeedKey, row.episode_key);
        continue;
      }
      const newEpKey = rekeyEpisode(row.identity);
      const targetExisting = this.getRaw(newEpKey);
      this.delete(row.episode_key);
      if (!targetExisting || row.updated_at > targetExisting.updated_at) {
        this.upsert(
          {
            episodeKey: newEpKey,
            feedKey: newFeedKey,
            positionMs: row.position_ms,
            state: row.state,
            updatedAt: row.updated_at,
            deviceId: row.device_id,
            ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
            ...(row.played_at !== null ? { playedAt: row.played_at } : {}),
          },
          { syncDirty: true, identity: row.identity },
        );
      }
    }
  }
}
