import type { Chapter, ChapterSource } from '@minipod/core';
import type { Database } from '../sqlite';
import { transaction } from '../sqlite';

interface ChapterRow {
  episode_id: number;
  start_ms: number;
  title: string | null;
  link: string | null;
  image_url: string | null;
  embedded_image_json: string | null;
  source: ChapterSource;
  is_feed_psc: number;
}

function rowToChapter(row: ChapterRow): Chapter {
  let embeddedImage: Chapter['embeddedImage'];
  if (row.embedded_image_json) {
    try {
      const parsed = JSON.parse(row.embedded_image_json) as {
        offset: number;
        length: number;
        mime: string;
      };
      if (
        typeof parsed.offset === 'number' &&
        typeof parsed.length === 'number' &&
        typeof parsed.mime === 'string'
      ) {
        embeddedImage = parsed;
      }
    } catch {
      embeddedImage = undefined;
    }
  }
  return {
    startMs: row.start_ms,
    source: row.source,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.link !== null ? { link: row.link } : {}),
    ...(row.image_url !== null ? { imageUrl: row.image_url } : {}),
    ...(embeddedImage !== undefined ? { embeddedImage } : {}),
  };
}

export class ChaptersRepository {
  constructor(private readonly db: Database) {}

  getFeedChapters(episodeId: number): Chapter[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM chapters WHERE episode_id = ? AND is_feed_psc = 1 ORDER BY start_ms ASC',
      )
      .all(episodeId) as unknown as ChapterRow[];
    return rows.map(rowToChapter);
  }

  getMergedChapters(episodeId: number): Chapter[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM chapters WHERE episode_id = ? AND is_feed_psc = 0 ORDER BY start_ms ASC',
      )
      .all(episodeId) as unknown as ChapterRow[];
    return rows.map(rowToChapter);
  }

  saveFeedChapters(episodeId: number, chapters: readonly Chapter[]): void {
    transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM chapters WHERE episode_id = ? AND is_feed_psc = 1')
        .run(episodeId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO chapters
         (episode_id, start_ms, title, link, image_url, embedded_image_json, source, is_feed_psc)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      for (const ch of chapters) {
        insert.run(
          episodeId,
          Math.max(0, Math.trunc(ch.startMs)),
          ch.title ?? null,
          ch.link ?? null,
          ch.imageUrl ?? null,
          ch.embeddedImage ? JSON.stringify(ch.embeddedImage) : null,
          ch.source,
        );
      }
    });
  }

  saveMergedChapters(episodeId: number, chapters: readonly Chapter[]): void {
    transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM chapters WHERE episode_id = ? AND is_feed_psc = 0')
        .run(episodeId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO chapters
         (episode_id, start_ms, title, link, image_url, embedded_image_json, source, is_feed_psc)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      );
      for (const ch of chapters) {
        insert.run(
          episodeId,
          Math.max(0, Math.trunc(ch.startMs)),
          ch.title ?? null,
          ch.link ?? null,
          ch.imageUrl ?? null,
          ch.embeddedImage ? JSON.stringify(ch.embeddedImage) : null,
          ch.source,
        );
      }
      this.db.prepare('UPDATE episodes SET chapters_merged = 1 WHERE id = ?').run(episodeId);
    });
  }
}
