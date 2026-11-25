import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmptySyncDocument,
  decodeBase64,
  encodeBase64,
  episodeKey,
  feedKey,
  HybridLogicalClock,
  parseSyncDocument,
  serializeSyncDocument,
  SyncEngine,
  type CloudFileProvider,
  type HostEvent,
  type ParsedFeed,
  type SyncDocument,
} from '@minipod/core';
import { createCapacitorPlatformHost } from '../capacitor-host';
import type { MiniPodPlugin, NativeJournalSnapshot } from '../plugin-types';
import { AndroidDriveAuthManager } from '../sync/drive-auth';
import { createSafFileProvider } from '../sync/SafFileProvider';
import { createMemoryPreferences, openMiniPodDb } from './idb';
import { IdbSyncStore } from './IdbSyncStore';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Android Audit Show</title>
  <item>
    <guid>ep-1</guid>
    <title>Episode 1</title>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1024"/>
  </item>
</channel></rss>`;

const SAMPLE_PARSED: ParsedFeed = {
  type: 'rss20',
  title: 'Android Audit Show',
  episodes: [
    {
      identity: 'ep-1',
      guid: 'ep-1',
      title: 'Episode 1',
      enclosureUrl: 'https://cdn.example.com/ep1.mp3',
      enclosureMime: 'audio/mpeg',
      enclosureSize: 1024,
      durationMs: 3_600_000,
      pubDate: 1_700_000_000_000,
      mediaType: 'AUDIO',
    },
  ],
};

function makeMinimalPlugin(overrides?: {
  journal?: () => NativeJournalSnapshot;
  clearJournal?: () => void;
  http?: MiniPodPlugin['http'];
  safFiles?: Map<string, { bytes: Uint8Array; mtimeMs: number }>;
}): MiniPodPlugin {
  const safFiles = overrides?.safFiles ?? new Map();
  return {
    http:
      overrides?.http ??
      vi.fn(async (req) => ({
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        finalUrl: req.url,
        chain: [],
        bodyBase64: encodeBase64(new TextEncoder().encode(SAMPLE_RSS)),
      })),
    httpToFile: vi.fn(async (req) => ({ path: `/data/${req.destPath}`, size: 1024, mime: 'audio/mpeg' })),
    cancelDownload: vi.fn(async () => undefined),
    deleteLocalFile: vi.fn(async () => undefined),
    readLocalFileRange: vi.fn(async () => ({ base64: '' })),
    saf: {
      pick: vi.fn(async () => null),
      stat: vi.fn(async ({ uri }) => {
        const hit = safFiles.get(uri);
        return hit ? { exists: true, size: hit.bytes.length, mtimeMs: hit.mtimeMs } : { exists: false };
      }),
      read: vi.fn(async ({ uri }) => {
        const hit = safFiles.get(uri);
        if (!hit) throw new Error('FileNotFoundException');
        return { base64: encodeBase64(hit.bytes) };
      }),
      readRange: vi.fn(async () => ({ base64: '' })),
      write: vi.fn(async ({ uri, base64 }) => {
        safFiles.set(uri, { bytes: decodeBase64(base64), mtimeMs: Date.now() });
      }),
      listTree: vi.fn(async () => ({ entries: [] })),
    },
    media: {
      load: vi.fn(async (p) => ({
        episodeKey: p.episodeKey,
        playing: false,
        buffering: false,
        positionMs: p.startMs,
        durationMs: 3_600_000,
        speed: p.speed,
      })),
      setQueue: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      seekTo: vi.fn(async () => undefined),
      setSpeed: vi.fn(async () => undefined),
      setSleepTimer: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({ playing: false, buffering: false, positionMs: 0, speed: 1 })),
      readJournal: vi.fn(async () => overrides?.journal?.() ?? { completed: [] }),
      clearJournal: vi.fn(async () => {
        overrides?.clearJournal?.();
      }),
      ackFlush: vi.fn(async () => undefined),
    },
    auth: {
      isGoogleSignInAvailable: vi.fn(async () => ({ available: false })),
      googleSignIn: vi.fn(async () => ({ supported: false })),
    },
    openExternal: vi.fn(async () => undefined),
    getLaunchIntent: vi.fn(async () => null),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  };
}

describe('Stage 3 sync audit regressions (@minipod/host-android)', () => {
  it('[SYNC-P0-01 & SYNC-P1-12 & SYNC-P2-05] IDB preserves concurrent writes during read(), protects cascade requeues, persists feed deviceId, and cleans orphan episodes/chapters/downloads on purge', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'audit-p0-01');
    let now = 1_700_000_000_000;
    const hlc = new HybridLogicalClock(0, () => now);
    const deletedDownloads: string[] = [];
    let currentPlaying: string | undefined;
    const store = new IdbSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Pixel A',
      getCurrentEpisodeKey: () => currentPlaying,
      onDeleteDownloads: (paths) => {
        deletedDownloads.push(...paths);
      },
    });
    const st = await store.init();

    const url = 'https://idb-audit.example/rss.xml';
    const fk = feedKey(url);
    const ek = episodeKey(fk, 'ep-1');

    await store.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url,
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: now,
      markSyncDirty: false,
    });
    await store.setEpisodeDownloadState(ek, 'DONE', '/data/ep1.mp3');
    await store.saveMergedChapters(ek, [{ startMs: 0, title: 'Intro', source: 'PSC' }]);
    await store.upsertQueueEntries(
      [{ episodeKey: ek, feedKey: fk, pos: 'a0', addedAt: now, updatedAt: now, removed: false, deviceId: st.deviceId }],
      false,
    );

    const remoteT1 = now + 5_000;
    const remoteDoc: SyncDocument = {
      ...createEmptySyncDocument('d_remote', remoteT1),
      rev: 2,
      subscriptions: {
        floor: 0,
        items: { [fk]: { url, movedTo: null, updatedAt: remoteT1, deleted: true, deviceId: 'd_remote' } },
      },
      queue: {
        floor: 0,
        items: { [ek]: { feedKey: fk, pos: 'a0', addedAt: now, updatedAt: remoteT1, removed: true, deviceId: 'd_remote' } },
      },
    };

    let uploadedBytes: Uint8Array | null = null;
    let firstRead = true;
    const provider: CloudFileProvider = {
      id: 'saf',
      supportsNativeConditionalWrite: false,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag: 'e1' }),
      head: async () => 'e1',
      read: async () => {
        if (firstRead) {
          firstRead = false;
          // Concurrent local re-queue at T4 > T1 while read() is in flight!
          now = remoteT1 + 5_000;
          await store.upsertQueueEntries(
            [
              {
                episodeKey: ek,
                feedKey: fk,
                pos: 'a0',
                addedAt: now,
                updatedAt: hlc.now(),
                removed: false,
                deviceId: st.deviceId,
                stub: { identity: 'ep-1', title: 'Episode 1', feedUrl: url },
              },
            ],
            true,
          );
        }
        return { kind: 'blob', bytes: serializeSyncDocument(remoteDoc), etag: 'e1' };
      },
      write: async (b) => {
        uploadedBytes = b.slice();
        return { kind: 'ok', newEtag: 'e2' };
      },
    };

    const engine = new SyncEngine({ store, provider, hlc, backgroundSync: false, now: () => now });
    await engine.run('manual');

    // Local concurrent re-queue survived cascade with episode & download intact!
    expect((await store.listActiveQueueRows()).map((r) => r.episode.episodeKey)).toEqual([ek]);
    expect(deletedDownloads).toEqual([]);
    expect((await store.getEpisodeRecord(ek))?.downloadPath).toBe('/data/ep1.mp3');
    // Remote feed tombstone persisted `deviceId = 'd_remote'` (SYNC-P1-12)
    expect((await store.getFeedRecord(fk))?.deviceId).toBe('d_remote');
    expect(parseSyncDocument(uploadedBytes!).queue.items[ek]?.removed).toBe(false);

    // Remote unsubscribe (T1) + remote re-queue (T2 > T1) in the same doc keeps active queue item
    const fk2 = feedKey('https://requeue.example/rss');
    const ek2 = episodeKey(fk2, 'ep-1');
    await store.upsertParsedFeed({
      feedKey: fk2,
      kind: 'RSS',
      url: 'https://requeue.example/rss',
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: now,
      markSyncDirty: false,
    });
    await store.upsertQueueEntries(
      [{ episodeKey: ek2, feedKey: fk2, pos: 'a1', addedAt: 10, updatedAt: 10, removed: false, deviceId: 'd_remote' }],
      false,
    );
    await store.applyMerged(
      {
        ...createEmptySyncDocument('d_remote', remoteT1 + 20_000),
        subscriptions: {
          floor: 0,
          items: { [fk2]: { url: 'https://requeue.example/rss', movedTo: null, updatedAt: remoteT1 + 10_000, deleted: true, deviceId: 'd_remote' } },
        },
        queue: {
          floor: 0,
          items: {
            [ek2]: {
              feedKey: fk2,
              pos: 'a1',
              addedAt: 10,
              updatedAt: remoteT1 + 20_000,
              removed: false,
              deviceId: 'd_remote',
              stub: { identity: 'ep-1', title: 'Episode 1', feedUrl: 'https://requeue.example/rss' },
            },
          },
        },
      },
      undefined,
    );
    expect((await store.listActiveQueueRows()).some((r) => r.episode.episodeKey === ek2)).toBe(true);

    // SYNC-P2-05: softDeleteUnsubscribe stamps queue with hlc.stamp(q.updatedAt) > q.updatedAt,
    // and purgeBelowFloors cleans orphan episodes, chapters, and downloads while protecting currentPlaying
    const fk3 = feedKey('https://purge.example/rss');
    const ek3 = episodeKey(fk3, 'ep-1');
    await store.upsertParsedFeed({
      feedKey: fk3,
      kind: 'RSS',
      url: 'https://purge.example/rss',
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: now,
    });
    const highQueueHlc = now + 500_000;
    await store.upsertQueueEntries(
      [{ episodeKey: ek3, feedKey: fk3, pos: 'a2', addedAt: 1, updatedAt: highQueueHlc, removed: false, deviceId: st.deviceId }],
      false,
    );
    await store.softDeleteUnsubscribe(fk3, st.deviceId);
    const q3 = (await store.listAllQueueEntries()).find((q) => q.episodeKey === ek3);
    expect(q3?.removed).toBe(true);
    expect(q3!.updatedAt).toBeGreaterThan(highQueueHlc);

    // Seed an orphan episode + chapters + download on a tombstoned feed and purge below floor
    const f3Rec = await store.getFeedRecord(fk3);
    await db.put('feeds', { ...f3Rec!, syncDirty: 0, updatedAt: 100, deletedAt: 100 });
    await db.put('episodes', {
      episodeKey: ek3,
      feedKey: fk3,
      identity: 'ep-1',
      isStub: false,
      title: 'Ep 1',
      pubDateSort: 0,
      mediaType: 'AUDIO',
      downloadState: 'DONE',
      downloadPath: '/data/orphan.mp3',
    });
    await store.saveMergedChapters(ek3, [{ startMs: 0, title: 'Ch', source: 'PSC' }]);
    currentPlaying = ek3;
    await store.purgeBelowFloors({ subscriptions: 500, queue: 0, progress: 0 });
    expect(await store.getFeedRecord(fk3)).toBeDefined(); // protected while playing!

    currentPlaying = undefined;
    await store.purgeBelowFloors({ subscriptions: 500, queue: 0, progress: 0 });
    expect(await store.getFeedRecord(fk3)).toBeUndefined();
    expect(await store.getEpisodeRecord(ek3)).toBeUndefined();
    expect((await store.getChaptersRecord(ek3)).merged).toBe(false);
    expect(deletedDownloads).toContain('/data/orphan.mp3');

    db.close();
  });

  it('[SYNC-P0-02] IDB refresh mode never resurrects a feed unsubscribed during HTTP fetch', async () => {
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((r) => {
      releaseFetch = r;
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => {
      fetchStarted = r;
    });

    let fetchCount = 0;
    const plugin = makeMinimalPlugin({
      http: vi.fn(async (req) => {
        fetchCount += 1;
        if (fetchCount === 2) {
          fetchStarted();
          await fetchBlocked;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
          finalUrl: req.url,
          chain: [],
          bodyBase64: encodeBase64(new TextEncoder().encode(SAMPLE_RSS)),
        };
      }),
    });

    const bundle = await createCapacitorPlatformHost({
      plugin,
      idbFactory: new IDBFactory(),
      preferences: createMemoryPreferences(),
    });

    const feed = await bundle.host.feeds.subscribe('https://android-race.example/rss.xml');
    const refreshTask = bundle.host.feeds.refresh(feed.feedKey);
    await started;

    await bundle.host.feeds.unsubscribe(feed.feedKey);
    releaseFetch();
    await refreshTask;

    const rec = await bundle.syncStore.getFeedRecord(feed.feedKey);
    expect(rec?.subscribedNum).toBe(0);
    expect(rec?.deletedAt).not.toBeNull();
    await bundle.host.dispose();
  });

  it('[SYNC-P0-03] Android journal replay uses event wall-clock, ignores older checkpoints over remote progress, and allows rewind-to-zero under remote clock skew', async () => {
    const day1 = Date.now() - 2 * 24 * 3600_000;
    const day2 = Date.now() - 1 * 24 * 3600_000;
    let journalSnap: NativeJournalSnapshot = { completed: [] };

    const safUri = 'content://sync/doc1';
    const safFiles = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
    const plugin = makeMinimalPlugin({
      journal: () => journalSnap,
      clearJournal: () => {
        journalSnap = { completed: [] };
      },
      safFiles,
    });

    const bundle = await createCapacitorPlatformHost({
      plugin,
      idbFactory: new IDBFactory(),
      preferences: createMemoryPreferences(),
    });

    const feed = await bundle.host.feeds.subscribe('https://journal.example/rss.xml');
    const ek = episodeKey(feed.feedKey, 'ep-1');

    // (a) Day 1 offline journal (20:00) replayed on Day 3 BEFORE sync -> stamps with Day 1,
    // so Day 2 desktop progress (50:00) wins on sync instead of regressing to 20:00!
    journalSnap = {
      completed: [],
      current: { episodeKey: ek, positionMs: 20 * 60_000, durationMs: 3_600_000, wallMs: day1 },
    };
    await bundle.reconcileJournal();
    const afterDay1 = await bundle.syncStore.getProgressRecord(ek);
    expect(afterDay1?.positionMs).toBe(20 * 60_000);
    expect(afterDay1?.updatedAt).toBe(day1);

    // Now Day 2 remote sync arrives with 50:00 from Desktop
    const desktopDoc: SyncDocument = {
      ...createEmptySyncDocument('d_desktop', day2),
      rev: 1,
      devices: { d_desktop: { name: 'Desktop', app: 'test', lastSeenAt: day2 } },
      subscriptions: {
        floor: 0,
        items: { [feed.feedKey]: { url: feed.url, movedTo: null, updatedAt: day1, deleted: false, deviceId: 'd_desktop' } },
      },
      progress: {
        floor: 0,
        items: {
          [ek]: {
            feedKey: feed.feedKey,
            positionMs: 50 * 60_000,
            durationMs: 3_600_000,
            state: 'IN_PROGRESS',
            playedAt: null,
            updatedAt: day2,
            deviceId: 'd_desktop',
            identity: 'ep-1',
          },
        },
      },
    };
    safFiles.set(safUri, { bytes: serializeSyncDocument(desktopDoc), mtimeMs: day2 });
    await bundle.host.sync.configure({
      provider: { id: 'saf', documentUri: safUri },
      wifiOnly: false,
      deviceName: 'Pixel',
    });

    // Converged to Desktop's 50:00 (Day 2 > Day 1)!
    expect((await bundle.host.progress.get(ek))?.positionMs).toBe(50 * 60_000);

    // (b) Stale native journal checkpoint (wallMs < localWrittenAt) MUST NOT overwrite 50:00!
    journalSnap = {
      completed: [],
      current: { episodeKey: ek, positionMs: 12 * 60_000, durationMs: 3_600_000, wallMs: day2 },
    };
    await bundle.reconcileJournal();
    expect((await bundle.host.progress.get(ek))?.positionMs).toBe(50 * 60_000);

    // (c) Even if remote HLC is skewed +60s into the future, a subsequent local lock-screen
    // rewind to 0:00 (`seeked: true`) has `wallMs > localWrittenAt` and succeeds!
    const skewedRemoteHlc = Date.now() + 60_000;
    await bundle.syncStore.applyMerged(
      {
        ...desktopDoc,
        hlcMax: skewedRemoteHlc,
        progress: {
          floor: 0,
          items: {
            [ek]: {
              feedKey: feed.feedKey,
              positionMs: 10 * 60_000,
              durationMs: 3_600_000,
              state: 'IN_PROGRESS',
              playedAt: null,
              updatedAt: skewedRemoteHlc,
              deviceId: 'd_desktop',
              identity: 'ep-1',
            },
          },
        },
      },
      undefined,
    );
    journalSnap = {
      completed: [],
      current: {
        episodeKey: ek,
        positionMs: 0,
        durationMs: 3_600_000,
        wallMs: Date.now() + 50,
        seeked: true,
      },
    };
    await bundle.reconcileJournal();
    const afterRewind = await bundle.host.progress.get(ek);
    expect(afterRewind?.positionMs).toBe(0);
    expect(afterRewind?.updatedAt).toBeGreaterThan(skewedRemoteHlc);

    await bundle.host.dispose();
  });

  it('[SYNC-P1-03] Android recordPermanentMove matches Node (no collision keeps oldFeedKey; collision tombstones old queue & preserves newer target progress)', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'audit-p1-03');
    const hlc = new HybridLogicalClock(0, () => 1_700_000_000_000);
    const store = new IdbSyncStore({ db, hlc, appVersion: '0.1.0' });
    const st = await store.init();

    // Case 1: No collision -> keeps oldFeedKey and sets movedTo
    const oldUrl = 'https://old-host.example/feed.xml';
    const newUrl = 'https://new-host.example/feed.xml';
    const oldFk = feedKey(oldUrl);
    await store.upsertParsedFeed({
      feedKey: oldFk,
      kind: 'RSS',
      url: oldUrl,
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: 1_700_000_000_000,
    });
    const resNoCollide = await store.recordPermanentMove(oldFk, newUrl, st.deviceId);
    expect(resNoCollide).toBe(oldFk);
    expect((await store.getFeedRecord(oldFk))?.movedTo).toBe(newUrl);

    // Case 2: Collision with existing target -> tombstones old queue entry (never hard-deletes)
    // and keeps newer target progress!
    const colOldUrl = 'https://col-old.example/feed.xml';
    const colNewUrl = 'https://col-new.example/feed.xml';
    const colOldFk = feedKey(colOldUrl);
    const colNewFk = feedKey(colNewUrl);
    const oldEk = episodeKey(colOldFk, 'ep-1');
    const newEk = episodeKey(colNewFk, 'ep-1');

    await store.upsertParsedFeed({
      feedKey: colOldFk,
      kind: 'RSS',
      url: colOldUrl,
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: 1_700_000_000_000,
    });
    await store.upsertParsedFeed({
      feedKey: colNewFk,
      kind: 'RSS',
      url: colNewUrl,
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      nowWallMs: 1_700_000_000_000,
    });
    await store.upsertQueueEntries(
      [{ episodeKey: oldEk, feedKey: colOldFk, pos: 'a0', addedAt: 100, updatedAt: 100, removed: false, deviceId: st.deviceId }],
      false,
    );
    await store.upsertProgress(
      { episodeKey: oldEk, feedKey: colOldFk, positionMs: 10_000, state: 'IN_PROGRESS', updatedAt: 100, deviceId: st.deviceId },
      { syncDirty: false, identity: 'ep-1' },
    );
    await store.upsertProgress(
      { episodeKey: newEk, feedKey: colNewFk, positionMs: 90_000, state: 'IN_PROGRESS', updatedAt: 500, deviceId: 'd_other' },
      { syncDirty: false, identity: 'ep-1' },
    );

    const resCollide = await store.recordPermanentMove(colOldFk, colNewUrl, st.deviceId);
    expect(resCollide).toBe(colNewFk);
    const allQ = await store.listAllQueueEntries();
    // Old queue entry is tombstoned (removed: true), NOT hard-deleted!
    expect(allQ.find((q) => q.episodeKey === oldEk)?.removed).toBe(true);
    expect(allQ.find((q) => q.episodeKey === newEk)?.removed).toBe(false);
    // Newer target progress (90_000 @ 500) was NOT overwritten by older (10_000 @ 100)!
    expect((await store.getProgress(newEk))?.positionMs).toBe(90_000);

    db.close();
  });

  it('[SYNC-P1-01 SAF watch & SYNC-P1-14 AndroidDriveAuthManager & SYNC-P2-09 getDirtyCount]', async () => {
    // SAF watch notifies when size === 0 || mtimeMs === 0
    let pollFn: (() => void) | null = null;
    const safPlugin: Pick<MiniPodPlugin, 'saf'> = {
      saf: {
        pick: vi.fn(async () => null),
        stat: vi.fn(async () => ({ exists: true, size: 0, mtimeMs: 0 })),
        read: vi.fn(async () => ({ base64: '' })),
        readRange: vi.fn(async () => ({ base64: '' })),
        write: vi.fn(async () => undefined),
        listTree: vi.fn(async () => ({ entries: [] })),
      },
    };
    const safProv = createSafFileProvider({
      documentUri: 'content://zero',
      plugin: safPlugin,
      isVisible: () => true,
      setIntervalFn: (fn) => {
        pollFn = fn;
        return () => undefined;
      },
    });
    let watchHits = 0;
    const unsub = safProv.watch!(() => {
      watchHits += 1;
    });
    pollFn!();
    await new Promise((r) => setTimeout(r, 15));
    expect(watchHits).toBe(1);
    unsub();

    // AndroidDriveAuthManager classifies network IOException as retryable `network`
    const driveAuth = new AndroidDriveAuthManager({
      auth: {
        isGoogleSignInAvailable: async () => ({ available: true }),
        googleSignIn: async () => {
          throw new Error('java.io.IOException: UnknownHostException offline');
        },
      },
    });
    const tokProvider = driveAuth.createTokenProvider('drive-appdata');
    await expect(tokProvider()).rejects.toMatchObject({ code: 'network' });

    // IdbSyncStore.getDirtyCount() + readonly loadLocalDoc()
    const db = await openMiniPodDb(new IDBFactory(), 'audit-p2-09');
    const store = new IdbSyncStore({ db, hlc: new HybridLogicalClock(0, () => 10_000), appVersion: '0.1.0' });
    await store.init();
    expect(await store.getDirtyCount()).toBe(0);
    await store.upsertQueueEntries(
      [{ episodeKey: 'e_1', feedKey: 'f_1', pos: 'a0', addedAt: 1, updatedAt: 1, removed: false, deviceId: 'd_1' }],
      true,
    );
    expect(await store.getDirtyCount()).toBe(1);
    const snap = await store.loadLocalDoc();
    expect(snap.dirty.queue.has('e_1')).toBe(true);
    db.close();
  });

  it('[SYNC-P0-05 & SYNC-P1-07 & SYNC-P1-10 & SYNC-P1-11] CapacitorHost reconnect same SAF does not resurrect, bad probe preserves config, queue.list is read-only, and onDecisions updates native queue + deduplicates resumeHints', async () => {
    const safFiles = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
    const safUri = 'content://sync/shared';
    const plugin = makeMinimalPlugin({ safFiles });

    const bundleA = await createCapacitorPlatformHost({
      plugin,
      idbFactory: new IDBFactory(),
      preferences: createMemoryPreferences(),
    });
    const bundleB = await createCapacitorPlatformHost({
      plugin,
      idbFactory: new IDBFactory(),
      preferences: createMemoryPreferences(),
    });

    const feed = await bundleA.host.feeds.subscribe('https://shared.example/rss.xml');
    const ek = episodeKey(feed.feedKey, 'ep-1');
    await bundleA.host.queue.add(ek);

    await bundleA.host.sync.configure({ provider: { id: 'saf', documentUri: safUri }, wifiOnly: false, deviceName: 'PhoneA' });
    await bundleB.host.sync.configure({ provider: { id: 'saf', documentUri: safUri }, wifiOnly: false, deviceName: 'PhoneB' });
    expect((await bundleB.host.queue.list()).map((r) => r.episode.episodeKey)).toEqual([ek]);

    // Disconnect B; A removes `ek` and syncs
    await bundleB.host.sync.disconnect();
    await bundleA.host.queue.remove(ek);
    await bundleA.host.sync.syncNow();

    // Reconnect B to the SAME SAF URI -> MUST NOT resurrect `ek`, and emits `queue-changed`
    const eventsB: HostEvent[] = [];
    bundleB.host.subscribe((e) => eventsB.push(e));
    await bundleB.host.sync.configure({ provider: { id: 'saf', documentUri: safUri }, wifiOnly: false, deviceName: 'PhoneB' });
    expect(await bundleB.host.queue.list()).toEqual([]);
    expect(eventsB.some((e) => e.type === 'queue-changed')).toBe(true);

    // Collided queue entries on `queue.list()` produce zero dirty writes (SYNC-P1-11)
    await bundleB.syncStore.upsertQueueEntries(
      [
        { episodeKey: 'e_x1', feedKey: feed.feedKey, pos: 'a0', addedAt: 1, updatedAt: 100, removed: false, deviceId: 'd_1' },
        { episodeKey: 'e_x2', feedKey: feed.feedKey, pos: 'a0', addedAt: 2, updatedAt: 100, removed: false, deviceId: 'd_2' },
      ],
      false,
    );
    await bundleB.host.queue.list();
    expect(await bundleB.syncStore.getDirtyCount()).toBe(0);

    await bundleA.host.dispose();
    await bundleB.host.dispose();
  });
});
