import { episodeKey as deriveEpisodeKey, feedKey as deriveFeedKey, HybridLogicalClock, type HostEvent } from '@minipod/core';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  describe('failed downloads keep their `.part` and resume via HTTP Range (继续下载)', () => {
    const PAYLOAD = new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(10)); // 360 bytes
    const FIRST_CHUNK = 151;

    const setup = () => {
      const downloadsDir = mkdtempSync(join(tmpdir(), 'minipod-dl-resume-'));
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
      return { downloadsDir, db, episodes, ek, partPath: join(downloadsDir, `${ek}.mp3.part`), finalPath: join(downloadsDir, `${ek}.mp3`) };
    };

    const downloadEvents = (events: HostEvent[]) =>
      events.filter(
        (e): e is Extract<HostEvent, { type: 'download-updated' }> => e.type === 'download-updated',
      );

    it('partial stream failure marks FAILED + keeps .part; retry sends `Range: bytes=<N>-`, emits the resumed % immediately, appends, and finishes DONE with the exact payload', async () => {
      const { downloadsDir, db, episodes, ek, partPath, finalPath } = setup();
      const rangeHeaders: (string | undefined)[] = [];
      let call = 0;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        rangeHeaders.push(headers['Range']);
        if (call === 1) {
          // Sends the first chunk, then the connection drops (network error mid-body).
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PAYLOAD.slice(0, FIRST_CHUNK));
              setTimeout(() => controller.error(new TypeError('network connection lost')), 5);
            },
          });
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg', 'content-length': String(PAYLOAD.byteLength) },
          });
        }
        const m = /^bytes=(\d+)-$/.exec(headers['Range'] ?? '');
        const start = m ? Number.parseInt(m[1]!, 10) : 0;
        const rest = PAYLOAD.slice(start);
        return new Response(rest, {
          status: m ? 206 : 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(rest.byteLength),
            ...(m ? { 'content-range': `bytes ${start}-${PAYLOAD.byteLength - 1}/${PAYLOAD.byteLength}` } : {}),
          },
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

      await expect(downloader.download(ek)).rejects.toMatchObject({ code: 'network' });
      expect(episodes.getRawByKey(ek)?.download_state).toBe('FAILED');
      expect(existsSync(partPath)).toBe(true);
      expect(statSync(partPath).size).toBe(FIRST_CHUNK);
      expect(existsSync(finalPath)).toBe(false);
      expect(downloadEvents(events).at(-1)?.state).toBe('FAILED');

      // Retry (继续下载)
      events.length = 0;
      await downloader.download(ek);
      expect(rangeHeaders).toEqual([undefined, `bytes=${FIRST_CHUNK}-`]);
      expect(episodes.getRawByKey(ek)?.download_state).toBe('DONE');
      expect(existsSync(partPath)).toBe(false);
      expect(new Uint8Array(readFileSync(finalPath))).toEqual(PAYLOAD);

      const dl = downloadEvents(events);
      // Never flashes back to 0% while resuming: the first emitted progress is the resumed fraction.
      const firstWithProgress = dl.find((e) => e.progress !== undefined);
      expect(firstWithProgress?.state).toBe('RUNNING');
      expect(firstWithProgress?.progress).toBeCloseTo(FIRST_CHUNK / PAYLOAD.byteLength, 5);
      expect(dl.some((e) => e.progress === 0)).toBe(false);
      expect(dl.at(-1)).toMatchObject({ state: 'DONE', progress: 1 });

      downloader.dispose();
      db.close();
    });

    it('restarts from 0 when the server answers 416 to a stale `.part`', async () => {
      const { downloadsDir, db, episodes, ek, partPath, finalPath } = setup();
      writeFileSync(partPath, PAYLOAD.slice(0, 40));
      const rangeHeaders: (string | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        rangeHeaders.push(headers['Range']);
        if (headers['Range']) {
          return new Response(null, { status: 416 });
        }
        return new Response(PAYLOAD, {
          status: 200,
          headers: { 'content-length': String(PAYLOAD.byteLength) },
        });
      }) as unknown as typeof fetch;
      const downloader = new EpisodeDownloader({
        db,
        downloadsDir,
        userAgent: 'MiniPod-Test',
        fetchImpl,
        getCredentials: () => undefined,
        emit: () => undefined,
      });
      await downloader.download(ek);
      expect(rangeHeaders).toEqual(['bytes=40-', undefined]);
      expect(episodes.getRawByKey(ek)?.download_state).toBe('DONE');
      expect(new Uint8Array(readFileSync(finalPath))).toEqual(PAYLOAD);
      downloader.dispose();
      db.close();
    });

    it('flips stale QUEUED/RUNNING rows (process killed mid-download) to FAILED on startup', () => {
      const { db, episodes, ek } = setup();
      episodes.setDownloadState(ek, 'RUNNING', null);
      const downloader = new EpisodeDownloader({
        db,
        downloadsDir: tmpdir(),
        userAgent: 'MiniPod-Test',
        getCredentials: () => undefined,
        emit: () => undefined,
      });
      expect(downloader.failStaleInFlightDownloads()).toEqual([ek]);
      expect(episodes.getRawByKey(ek)?.download_state).toBe('FAILED');
      expect(downloader.failStaleInFlightDownloads()).toEqual([]);
      downloader.dispose();
      db.close();
    });
  });
});
