import {
  classifyMediaType,
  compareQueueOrder,
  type Episode,
  type EpisodeKey,
  type FeedKey,
  type QueueEntry,
  type QueueRow,
  type QueueStub,
} from '@minipod/core';
import type { Database } from '../sqlite';
import { transaction } from '../sqlite';
import { rowToEpisode, type EpisodeDbRow } from './episodes';
import { rowToProgressRecord, type ProgressDbRow } from './progress';

export interface QueueDbRow {
  episode_key: string;
  feed_key: string;
  pos: string;
  added_at: number;
  updated_at: number;
  removed: number;
  device_id: string;
  stub_json: string | null;
  sync_dirty: number;
}

export function parseQueueStubJson(json: string | null): QueueStub | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as QueueStub;
  } catch {
    return undefined;
  }
}

export function rowToQueueEntry(row: QueueDbRow): QueueEntry {
  const stub = row.removed === 0 ? parseQueueStubJson(row.stub_json) : undefined;
  return {
    episodeKey: row.episode_key,
    feedKey: row.feed_key,
    pos: row.pos,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    removed: row.removed !== 0,
    deviceId: row.device_id,
    ...(stub !== undefined ? { stub } : {}),
  };
}

function episodeFromStub(episodeKey: EpisodeKey, feedKey: FeedKey, stub: QueueStub | undefined): Episode {
  if (!stub) {
    return {
      episodeKey,
      feedKey,
      identity: episodeKey,
      isStub: true,
      title: 'Queued Episode',
      mediaType: 'AUDIO',
      downloadState: 'NONE',
    };
  }
  return {
    episodeKey,
    feedKey,
    identity: stub.identity,
    isStub: true,
    title: stub.title,
    mediaType: classifyMediaType(stub.enclosureMime, stub.enclosureUrl),
    downloadState: 'NONE',
    ...(stub.enclosureUrl !== undefined ? { enclosureUrl: stub.enclosureUrl } : {}),
    ...(stub.enclosureMime !== undefined ? { enclosureMime: stub.enclosureMime } : {}),
    ...(stub.durationMs !== undefined ? { durationMs: stub.durationMs } : {}),
    ...(stub.imageUrl !== undefined ? { imageUrl: stub.imageUrl } : {}),
    ...(stub.pubDate !== undefined ? { pubDate: stub.pubDate } : {}),
  };
}

export class QueueRepository {
  constructor(private readonly db: Database) {}

  listAllEntries(): QueueEntry[] {
    const rows = this.db.prepare('SELECT * FROM queue').all() as unknown as QueueDbRow[];
    return rows.map(rowToQueueEntry);
  }

  listAllRaw(): QueueDbRow[] {
    return this.db.prepare('SELECT * FROM queue').all() as unknown as QueueDbRow[];
  }

  getEntry(episodeKey: EpisodeKey): QueueEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM queue WHERE episode_key = ?')
      .get(episodeKey) as QueueDbRow | undefined;
    return row ? rowToQueueEntry(row) : undefined;
  }

  isQueued(episodeKey: EpisodeKey): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM queue WHERE episode_key = ? AND removed = 0')
      .get(episodeKey) as { ok?: number } | undefined;
    return row?.ok === 1;
  }

  /**
   * Queue view per ARCHITECTURE.md §6.3:
   * `queue WHERE removed = 0 ORDER BY pos, added_at, episode_key` LEFT JOIN `episodes` LEFT JOIN `progress`.
   * Guaranteed never to hide a synced queue entry even if its episode row is a stub.
   */
  listActiveRows(): QueueRow[] {
    const qRows = this.db
      .prepare('SELECT * FROM queue WHERE removed = 0')
      .all() as unknown as QueueDbRow[];

    const entries = qRows.map(rowToQueueEntry).sort(compareQueueOrder);
    if (entries.length === 0) return [];

    const epStmt = this.db.prepare(
      `SELECT e.*, f.feed_key AS feed_key_str
       FROM episodes e
       JOIN feeds f ON f.id = e.feed_id
       WHERE e.episode_key = ?`,
    );
    const progStmt = this.db.prepare('SELECT * FROM progress WHERE episode_key = ?');

    const out: QueueRow[] = [];
    for (const entry of entries) {
      const epRow = epStmt.get(entry.episodeKey) as (EpisodeDbRow & { feed_key_str: string }) | undefined;
      const episode = epRow
        ? rowToEpisode(epRow, epRow.feed_key_str)
        : episodeFromStub(entry.episodeKey, entry.feedKey, entry.stub);
      const progRow = progStmt.get(entry.episodeKey) as ProgressDbRow | undefined;
      out.push({
        entry,
        episode,
        ...(progRow ? { progress: rowToProgressRecord(progRow) } : {}),
      });
    }
    return out;
  }

  upsertEntries(entries: readonly QueueEntry[], syncDirty = true): void {
    if (entries.length === 0) return;
    const dirty = syncDirty ? 1 : 0;
    transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO queue
         (episode_key, feed_key, pos, added_at, updated_at, removed, device_id, stub_json, sync_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(episode_key) DO UPDATE SET
           feed_key = excluded.feed_key,
           pos = excluded.pos,
           added_at = excluded.added_at,
           updated_at = excluded.updated_at,
           removed = excluded.removed,
           device_id = excluded.device_id,
           stub_json = excluded.stub_json,
           sync_dirty = excluded.sync_dirty`,
      );
      for (const e of entries) {
        stmt.run(
          e.episodeKey,
          e.feedKey,
          e.pos,
          e.addedAt,
          e.updatedAt,
          e.removed ? 1 : 0,
          e.deviceId,
          !e.removed && e.stub ? JSON.stringify(e.stub) : null,
          dirty,
        );
      }
    });
  }

  deleteHard(episodeKey: EpisodeKey): void {
    this.db.prepare('DELETE FROM queue WHERE episode_key = ?').run(episodeKey);
  }
}
