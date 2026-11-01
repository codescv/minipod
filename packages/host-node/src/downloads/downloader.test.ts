import { episodeKey as deriveEpisodeKey, feedKey as deriveFeedKey, HybridLogicalClock, type HostEvent } from '@minipod/core';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodesRepository } from '../db/repositories/episodes';
import { FeedsRepository } from '../db/repositories/feeds';
import { openDatabase } from '../db/sqlite';
import { EpisodeDownloader } from './downloader';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('EpisodeDownloader', () => {
  it('stopping an in-flight download aborts it, removes the deterministic .part file, and settles to NONE', async () => {
    const downloadsDir = mkdtempSync(join(tmpdir(), 'minipod-dl-cancel-'));
    tempDirs.push(downloadsDir);

    const db = openDatabase(':memory:');
    const feeds = new FeedsRepository(db);
    const episodes = new EpisodesRepository(db);
    const feedUrl = 'https://pod.example.com/feed.xml';
    const fk = deriveFeedKey(feedUrl);
    feeds.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url: feedUrl,
      subscribed: true,
      parsed: { type: 'rss20', title: 'Show', episodes: [] },
      hlc: new HybridLogicalClock(0, () => 1_700_000_000_000),
      nowWallMs: 1_700_000_000_000,
    });
    const feedId = (db.prepare('SELECT id FROM feeds WHERE feed_key = ?').get(fk) as { id: number }).id;
    const ek = deriveEpisodeKey(fk, 'ep-1');
    episodes.ensureStubEpisode(feedId, fk, ek, {
      identity: 'ep-1',
      title: 'Episode One',
      feedUrl,
      enclosureUrl: 'https://pod.example.com/ep1.mp3',
      enclosureMime: 'audio/mpeg',
    });

    // Upstream streams one chunk and then stalls until aborted.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('PARTIAL_AUDIO_BYTES'));
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '100000' },
      });
    }) as unknown as typeof fetch;

    const events: HostEvent[] = [];
    const downloader = new EpisodeDownloader({
      db,
      downloadsDir,
      userAgent: 'MiniPod-Test',
      fetchImpl,
      getCredentials: () => undefined,
      emit: (ev) => events.push(ev),
    });

    const partPath = join(downloadsDir, `${ek}.mp3.part`);
    const downloadPromise = downloader.download(ek);
    await vi.waitFor(() => {
      expect(existsSync(partPath)).toBe(true);
      expect(statSync(partPath).size).toBeGreaterThan(0);
    });
    expect(episodes.getRawByKey(ek)?.download_state).toBe('RUNNING');

    await downloader.deleteDownload(ek);
    await expect(downloadPromise).resolves.toBeUndefined();

    expect(existsSync(partPath)).toBe(false);
    expect(existsSync(join(downloadsDir, `${ek}.mp3`))).toBe(false);
    expect(episodes.getRawByKey(ek)?.download_state).toBe('NONE');
    const states = events
      .filter((e): e is Extract<HostEvent, { type: 'download-updated' }> => e.type === 'download-updated')
      .map((e) => e.state);
    expect(states).not.toContain('FAILED');
    expect(states[states.length - 1]).toBe('NONE');

    downloader.dispose();
    db.close();
  });
});
