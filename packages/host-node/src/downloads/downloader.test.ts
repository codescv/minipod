import {
  encodeBasicAuthHeaders,
  episodeKey as deriveEpisodeKey,
  feedKey as deriveFeedKey,
  HybridLogicalClock,
  type EpisodeKey,
  type HostEvent,
} from '@minipod/core';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodesRepository } from '../db/repositories/episodes';
import { FeedsRepository } from '../db/repositories/feeds';
import { openDatabase } from '../db/sqlite';
import { EpisodeDownloader, MAX_CONCURRENT_DOWNLOADS, type EpisodeDownloaderDeps } from './downloader';
import {
  abortableSleep,
  backoffDelayMs,
  isRetryableDownloadError,
  parseRetryAfterMs,
  resolveRetryOptions,
} from './retry-policy';

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

    it('partial stream failure with auto-retry disabled marks FAILED + keeps .part; manual retry sends `Range: bytes=<N>-`, emits the resumed % immediately, appends, and finishes DONE with the exact payload', async () => {
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
        retry: { maxRetries: 0 },
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

// ---------------------------------------------------------------------------
// Download queue (max 3 concurrent, FIFO) + automatic retry
// ---------------------------------------------------------------------------

type DownloadUpdated = Extract<HostEvent, { type: 'download-updated' }>;

const PAYLOAD = new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(10)); // 360 bytes

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function rangeOf(init?: RequestInit): string | undefined {
  return ((init?.headers ?? {}) as Record<string, string>)['Range'];
}

/** Serves `PAYLOAD` honouring `Range: bytes=<n>-` (206 + Content-Range). */
function payloadResponse(init?: RequestInit): Response {
  const m = /^bytes=(\d+)-$/.exec(rangeOf(init) ?? '');
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
}

/** Streams `bytes`, then the connection drops mid-body. */
function droppingResponse(bytes: Uint8Array, init?: RequestInit, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      setTimeout(() => controller.error(new TypeError('network connection lost')), 1);
    },
  });
  const range = /^bytes=(\d+)-$/.exec(rangeOf(init) ?? '');
  return new Response(body, {
    status: range ? 206 : status,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(PAYLOAD.byteLength),
      ...(range ? { 'content-range': `bytes ${range[1]}-${PAYLOAD.byteLength - 1}/${PAYLOAD.byteLength}` } : {}),
    },
  });
}

/** Streams one chunk then stalls until the request is aborted. */
function stallingResponse(init?: RequestInit): Response {
  const signal = init?.signal;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('PARTIAL'));
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-length': '100000' } });
}

function makeEnv(episodeCount: number) {
  const downloadsDir = mkdtempSync(join(tmpdir(), 'minipod-dl-queue-'));
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
  const keys: EpisodeKey[] = [];
  const urls: string[] = [];
  for (let i = 1; i <= episodeCount; i++) {
    const ek = deriveEpisodeKey(fk, `ep-${i}`);
    const url = `https://pod.example.com/ep${i}.mp3`;
    episodes.ensureStubEpisode(feedId, fk, ek, {
      identity: `ep-${i}`,
      title: `Episode ${i}`,
      feedUrl,
      enclosureUrl: url,
      enclosureMime: 'audio/mpeg',
    });
    keys.push(ek);
    urls.push(url);
  }
  const events: HostEvent[] = [];
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => undefined);
  const partPath = (i: number) => join(downloadsDir, `${keys[i]}.mp3.part`);
  const finalPath = (i: number) => join(downloadsDir, `${keys[i]}.mp3`);
  const stateOf = (i: number) => episodes.getRawByKey(keys[i]!)?.download_state;
  const dlEvents = (key?: EpisodeKey) =>
    events.filter((e): e is DownloadUpdated => e.type === 'download-updated' && (key === undefined || e.episodeKey === key));
  const create = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra?: Partial<EpisodeDownloaderDeps>) =>
    new EpisodeDownloader({
      db,
      downloadsDir,
      userAgent: 'MiniPod-Test',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => fetchImpl(urlOf(input), init)) as typeof fetch,
      getCredentials: () => undefined,
      emit: (ev) => events.push(ev),
      ...extra,
      retry: { sleep, random: () => 0.5, ...extra?.retry },
    });
  return { db, downloadsDir, episodes, keys, urls, events, sleep, partPath, finalPath, stateOf, dlEvents, create };
}

describe('EpisodeDownloader queue (max 3 concurrent, FIFO)', () => {
  it('7 concurrent download() calls never exceed 3 in flight and promote QUEUED items in FIFO order', async () => {
    const env = makeEnv(7);
    expect(MAX_CONCURRENT_DOWNLOADS).toBe(3);
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const downloader = env.create(async (url) => {
      started.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = new Promise<void>((resolve) => gates.set(url, resolve));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate;
          controller.enqueue(PAYLOAD);
          inFlight -= 1;
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(PAYLOAD.byteLength) } });
    });

    const promises = env.keys.map((k) => downloader.download(k));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(env.urls.slice(0, 3));
    expect(downloader.getQueueSnapshot()).toEqual({ running: env.keys.slice(0, 3), queued: env.keys.slice(3) });
    for (let i = 3; i < 7; i++) {
      expect(env.stateOf(i)).toBe('QUEUED');
      expect(env.dlEvents(env.keys[i])).toEqual([
        { type: 'download-updated', episodeKey: env.keys[i], state: 'QUEUED', progress: 0 },
      ]);
    }

    // Finishing ep2 (out of order) frees one slot → ep4 (head of the queue) starts, not ep7.
    gates.get(env.urls[1]!)!();
    await promises[1];
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started[3]).toBe(env.urls[3]);
    expect(env.stateOf(1)).toBe('DONE');

    // Drain the rest one gate at a time; never more than 3 transfers in flight.
    for (let round = 0; round < 10 && started.length <= 7; round++) {
      for (const [url, release] of gates) {
        gates.delete(url);
        release();
      }
      await new Promise((r) => setTimeout(r, 5));
      if (env.keys.every((_k, i) => env.stateOf(i) === 'DONE')) break;
    }
    await Promise.all(promises);
    expect(started).toEqual(env.urls);
    expect(maxInFlight).toBe(3);
    for (let i = 0; i < 7; i++) {
      expect(env.stateOf(i)).toBe('DONE');
      expect(new Uint8Array(readFileSync(env.finalPath(i)))).toEqual(PAYLOAD);
    }
    expect(downloader.getQueueSnapshot()).toEqual({ running: [], queued: [] });
    downloader.dispose();
    env.db.close();
  });

  it('dedupes download() per episode while QUEUED or RUNNING (same promise, single fetch)', async () => {
    const env = makeEnv(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === env.urls[0]) await gate;
      return payloadResponse(init);
    });
    const downloader = env.create(fetchImpl, { maxConcurrent: 1 });

    const a1 = downloader.download(env.keys[0]!);
    const b1 = downloader.download(env.keys[1]!); // QUEUED behind ep1
    expect(downloader.download(env.keys[0]!)).toBe(a1);
    expect(downloader.download(env.keys[1]!)).toBe(b1);
    release();
    await Promise.all([a1, b1]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(env.dlEvents(env.keys[1]).filter((e) => e.state === 'QUEUED')).toHaveLength(1);
    downloader.dispose();
    env.db.close();
  });

  it('cancelling a QUEUED item removes it with zero fetches, deletes its .part and settles NONE', async () => {
    const env = makeEnv(2);
    writeFileSync(env.partPath(1), PAYLOAD.slice(0, 40)); // leftover from an earlier failure
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === env.urls[0]) await gate;
      return payloadResponse(init);
    });
    const downloader = env.create(fetchImpl, { maxConcurrent: 1 });
    const a = downloader.download(env.keys[0]!);
    const b = downloader.download(env.keys[1]!);
    // A leftover `.part` keeps the last known percentage: no `progress: 0` on QUEUED.
    expect(env.dlEvents(env.keys[1])[0]).toEqual({ type: 'download-updated', episodeKey: env.keys[1], state: 'QUEUED' });

    await downloader.deleteDownload(env.keys[1]!);
    await expect(b).resolves.toBeUndefined();
    expect(env.stateOf(1)).toBe('NONE');
    expect(existsSync(env.partPath(1))).toBe(false);
    expect(downloader.getQueueSnapshot().queued).toEqual([]);

    release();
    await a;
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([env.urls[0]]);
    expect(env.stateOf(0)).toBe('DONE');
    expect(env.stateOf(1)).toBe('NONE');
    downloader.dispose();
    env.db.close();
  });

  it('cancelling a RUNNING item aborts it, deletes its .part and promotes the next QUEUED item', async () => {
    const env = makeEnv(2);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      url === env.urls[0] ? stallingResponse(init) : payloadResponse(init),
    );
    const downloader = env.create(fetchImpl, { maxConcurrent: 1 });
    const a = downloader.download(env.keys[0]!);
    const b = downloader.download(env.keys[1]!);
    await vi.waitFor(() => expect(statSync(env.partPath(0)).size).toBeGreaterThan(0));
    expect(env.stateOf(1)).toBe('QUEUED');

    await downloader.deleteDownload(env.keys[0]!);
    await expect(a).resolves.toBeUndefined();
    expect(env.stateOf(0)).toBe('NONE');
    expect(existsSync(env.partPath(0))).toBe(false);
    expect(env.dlEvents(env.keys[0]).map((e) => e.state)).not.toContain('FAILED');

    await b;
    expect(env.stateOf(1)).toBe('DONE');
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([env.urls[0], env.urls[1]]);
    downloader.dispose();
    env.db.close();
  });

  it('cancelAll() stops RUNNING and QUEUED downloads without promoting any of them', async () => {
    const env = makeEnv(4);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => stallingResponse(init));
    const downloader = env.create(fetchImpl, { maxConcurrent: 2 });
    const promises = env.keys.map((k) => downloader.download(k));
    await vi.waitFor(() => {
      expect(statSync(env.partPath(0)).size).toBeGreaterThan(0);
      expect(statSync(env.partPath(1)).size).toBeGreaterThan(0);
    });

    await downloader.cancelAll();
    await Promise.all(promises);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(env.urls.slice(0, 2));
    for (let i = 0; i < 4; i++) {
      expect(env.stateOf(i)).toBe('NONE');
      expect(existsSync(env.partPath(i))).toBe(false);
      expect(env.dlEvents(env.keys[i]).at(-1)?.state).toBe('NONE');
    }
    expect(downloader.getQueueSnapshot()).toEqual({ running: [], queued: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    downloader.dispose();
    env.db.close();
  });

  it('failStaleInFlightDownloads() treats in-memory QUEUED items as live', async () => {
    const env = makeEnv(2);
    const downloader = env.create(async (_url, init) => stallingResponse(init), { maxConcurrent: 1 });
    const promises = env.keys.map((k) => downloader.download(k));
    expect(env.stateOf(1)).toBe('QUEUED');
    expect(downloader.failStaleInFlightDownloads()).toEqual([]);
    expect(env.stateOf(1)).toBe('QUEUED');
    await downloader.cancelAll();
    await Promise.all(promises);
    downloader.dispose();
    env.db.close();
  });
});

describe('EpisodeDownloader automatic retry', () => {
  const FIRST_CHUNK = 151;

  it('a mid-stream drop stays RUNNING, backs off, and resumes the kept .part via `Range` (206 append) to DONE', async () => {
    const env = makeEnv(1);
    const ranges: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      ranges.push(rangeOf(init));
      return ranges.length === 1 ? droppingResponse(PAYLOAD.slice(0, FIRST_CHUNK), init) : payloadResponse(init);
    });
    const downloader = env.create(fetchImpl);
    await downloader.download(env.keys[0]!);

    expect(ranges).toEqual([undefined, `bytes=${FIRST_CHUNK}-`]);
    expect(env.sleep).toHaveBeenCalledTimes(1);
    expect(env.sleep.mock.calls[0]![0]).toBe(1500);
    expect(env.stateOf(0)).toBe('DONE');
    expect(new Uint8Array(readFileSync(env.finalPath(0)))).toEqual(PAYLOAD);
    const states = env.dlEvents().map((e) => e.state);
    expect(states).not.toContain('FAILED');
    expect(states[0]).toBe('QUEUED');
    expect(states.at(-1)).toBe('DONE');
    // The resumed snapshot keeps the earlier progress rather than flashing back to 0%.
    const resumed = env.dlEvents().filter((e) => e.state === 'RUNNING' && e.progress !== undefined && e.progress > 0);
    expect(resumed[0]?.progress).toBeCloseTo(FIRST_CHUNK / PAYLOAD.byteLength, 5);
    downloader.dispose();
    env.db.close();
  });

  it('honours `Retry-After` on 503 / 429 (seconds and HTTP-date, capped at 30s)', async () => {
    const env = makeEnv(1);
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) return new Response('busy', { status: 503, headers: { 'retry-after': '7' } });
      if (call === 2) {
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': new Date(Date.now() + 120_000).toUTCString() },
        });
      }
      return payloadResponse(init);
    });
    const downloader = env.create(fetchImpl);
    await downloader.download(env.keys[0]!);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(env.sleep.mock.calls.map((c) => c[0])).toEqual([7000, 30_000]);
    expect(env.stateOf(0)).toBe('DONE');
    expect(env.dlEvents().map((e) => e.state)).not.toContain('FAILED');
    downloader.dispose();
    env.db.close();
  });

  it('retries connection errors and stalled (timed-out) responses with exponential backoff', async () => {
    const env = makeEnv(1);
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      if (call === 2) {
        // Headers arrive but the body never produces a byte (and ignores abort).
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return payloadResponse(init);
    });
    const downloader = env.create(fetchImpl, { stallTimeoutMs: 30 });
    await downloader.download(env.keys[0]!);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(env.sleep.mock.calls.map((c) => c[0])).toEqual([1500, 4000]);
    expect(env.stateOf(0)).toBe('DONE');
    downloader.dispose();
    env.db.close();
  });

  it('does not retry 404 (single fetch) → FAILED', async () => {
    const env = makeEnv(1);
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const downloader = env.create(fetchImpl);
    await expect(downloader.download(env.keys[0]!)).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('404') });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env.sleep).not.toHaveBeenCalled();
    expect(env.stateOf(0)).toBe('FAILED');
    expect(env.dlEvents().at(-1)).toMatchObject({ state: 'FAILED', error: { code: 'network', details: { status: 404 } } });
    downloader.dispose();
    env.db.close();
  });

  it('does not retry 401 (only the auth-candidate fetches) → FAILED', async () => {
    const env = makeEnv(1);
    const creds = { username: 'user', password: 'pässword' };
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
    const downloader = env.create(fetchImpl, { getCredentials: () => creds });
    await expect(downloader.download(env.keys[0]!)).rejects.toMatchObject({ code: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + encodeBasicAuthHeaders(creds).length);
    expect(env.sleep).not.toHaveBeenCalled();
    expect(env.stateOf(0)).toBe('FAILED');
    downloader.dispose();
    env.db.close();
  });

  it('cancelling during the backoff sleep aborts immediately (even if the injected sleep ignores the signal)', async () => {
    const env = makeEnv(1);
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 500 }));
    const hangingSleep = vi.fn((_ms: number, _signal: AbortSignal) => new Promise<void>(() => undefined));
    const downloader = env.create(fetchImpl, { retry: { sleep: hangingSleep } });
    const p = downloader.download(env.keys[0]!);
    await vi.waitFor(() => expect(hangingSleep).toHaveBeenCalledTimes(1));
    expect(env.stateOf(0)).toBe('RUNNING');
    await downloader.deleteDownload(env.keys[0]!);
    await expect(p).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env.stateOf(0)).toBe('NONE');
    expect(env.dlEvents().map((e) => e.state)).not.toContain('FAILED');
    downloader.dispose();
    env.db.close();
  });

  it('the default backoff sleep honours AbortSignal (a 60s backoff is cut short by deleteDownload)', async () => {
    const env = makeEnv(1);
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 502 }));
    const downloader = env.create(fetchImpl, { retry: { sleep: abortableSleep, delaysMs: [60_000] } });
    const p = downloader.download(env.keys[0]!);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    await downloader.deleteDownload(env.keys[0]!);
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(env.stateOf(0)).toBe('NONE');
    downloader.dispose();
    env.db.close();
  });

  it('exhausting the retries (3) surfaces a single FAILED and keeps the .part for 继续下载', async () => {
    const env = makeEnv(1);
    const ranges: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      ranges.push(rangeOf(init));
      return droppingResponse(PAYLOAD.slice(0, 10), init);
    });
    const downloader = env.create(fetchImpl);
    await expect(downloader.download(env.keys[0]!)).rejects.toMatchObject({ code: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(ranges).toEqual([undefined, 'bytes=10-', 'bytes=20-', 'bytes=30-']);
    expect(env.sleep.mock.calls.map((c) => c[0])).toEqual([1500, 4000, 10_000]);
    expect(env.stateOf(0)).toBe('FAILED');
    expect(statSync(env.partPath(0)).size).toBe(40);
    const states = env.dlEvents().map((e) => e.state);
    expect(states.filter((s) => s === 'FAILED')).toHaveLength(1);
    expect(states.at(-1)).toBe('FAILED');
    downloader.dispose();
    env.db.close();
  });

  it('an attempt with real progress resets the failure counter, but the hard cap still bounds total attempts', async () => {
    const env = makeEnv(2);
    // Each attempt writes 10 bytes (≥ progressResetBytes) and then drops: only the hard cap stops it.
    const progressing = vi.fn(async (_url: string, init?: RequestInit) => droppingResponse(PAYLOAD.slice(0, 10), init));
    const d1 = env.create(progressing, { retry: { maxRetries: 1, progressResetBytes: 10, maxTotalAttempts: 6 } });
    await expect(d1.download(env.keys[0]!)).rejects.toMatchObject({ code: 'network' });
    expect(progressing).toHaveBeenCalledTimes(6);
    expect(env.sleep.mock.calls.map((c) => c[0])).toEqual([1500, 1500, 1500, 1500, 1500]);
    expect(statSync(env.partPath(0)).size).toBe(60);
    d1.dispose();

    // Same budget, but attempts that write nothing do not reset the counter → 1 + maxRetries.
    env.sleep.mockClear();
    const empty = vi.fn(async (_url: string, init?: RequestInit) => droppingResponse(new Uint8Array(0), init));
    const d2 = env.create(empty, { retry: { maxRetries: 1, progressResetBytes: 10, maxTotalAttempts: 6 } });
    await expect(d2.download(env.keys[1]!)).rejects.toMatchObject({ code: 'network' });
    expect(empty).toHaveBeenCalledTimes(2);
    expect(env.sleep.mock.calls.map((c) => c[0])).toEqual([1500]);
    d2.dispose();
    env.db.close();
  });

  it('restarts from 0 when a 206 answers a different offset than the `.part` size', async () => {
    const env = makeEnv(1);
    writeFileSync(env.partPath(0), PAYLOAD.slice(0, 40));
    const ranges: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      ranges.push(rangeOf(init));
      if (rangeOf(init)) {
        return new Response(PAYLOAD.slice(100), {
          status: 206,
          headers: { 'content-range': `bytes 100-${PAYLOAD.byteLength - 1}/${PAYLOAD.byteLength}` },
        });
      }
      return payloadResponse(init);
    });
    const downloader = env.create(fetchImpl);
    await downloader.download(env.keys[0]!);
    expect(ranges).toEqual(['bytes=40-', undefined]);
    expect(new Uint8Array(readFileSync(env.finalPath(0)))).toEqual(PAYLOAD);
    expect(env.sleep).not.toHaveBeenCalled();
    downloader.dispose();
    env.db.close();
  });
});

describe('retry-policy', () => {
  it('classifies transient vs permanent failures', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(isRetryableDownloadError(new TypeError('fetch failed', { cause: coded('ENOTFOUND') }))).toBe(true);
    expect(isRetryableDownloadError(new TypeError('fetch failed', { cause: coded('UND_ERR_CONNECT_TIMEOUT') }))).toBe(true);
    expect(isRetryableDownloadError(coded('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe(true);
    expect(isRetryableDownloadError(coded('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isRetryableDownloadError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isRetryableDownloadError(coded('ENOSPC'))).toBe(false);
    expect(isRetryableDownloadError(coded('EACCES'))).toBe(false);
    expect(isRetryableDownloadError(new TypeError('Failed to parse URL', { cause: coded('ERR_INVALID_URL') }))).toBe(false);
    expect(isRetryableDownloadError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('parses Retry-After and computes jittered backoff', () => {
    expect(parseRetryAfterMs('12', 0)).toBe(12_000);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 4_000)).toBe(6_000);
    expect(parseRetryAfterMs('garbage', 0)).toBeUndefined();
    const opts = resolveRetryOptions({ random: () => 0 });
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, opts))).toEqual([1200, 3200, 8000, 8000]);
    const hi = resolveRetryOptions({ random: () => 0.999999 });
    expect(backoffDelayMs(1, hi)).toBe(1800);
  });
});
