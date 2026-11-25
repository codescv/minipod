import {
  createEmptySyncDocument,
  episodeKey,
  feedKey,
  HybridLogicalClock,
  parseSyncDocument,
  serializeSyncDocument,
  SyncEngine,
  type CloudFileProvider,
  type HostEvent,
  type HttpClient,
  type ParsedFeed,
  type SyncDocument,
} from '@minipod/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostEventStream } from '../client/events';
import { FeedRefresher } from '../feeds/refresher';
import { createNodePlatformHost } from '../server/context';
import { SettingsStore } from '../settings/store';
import { DesktopDriveAuthManager } from '../sync/drive-oauth';
import { NodeSyncService } from '../sync/scheduler-host';
import { FeedsRepository } from './repositories/feeds';
import { ProgressRepository } from './repositories/progress';
import { QueueRepository } from './repositories/queue';
import { openDatabase } from './sqlite';
import { SqliteSyncStore } from './SqliteSyncStore';

const SAMPLE_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Audit Show</title>
  <item>
    <guid>ep-1</guid>
    <title>Episode 1</title>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1024"/>
  </item>
</channel></rss>`;

const SAMPLE_PARSED: ParsedFeed = {
  type: 'rss20',
  title: 'Audit Show',
  episodes: [
    {
      identity: 'ep-1',
      guid: 'ep-1',
      title: 'Episode 1',
      enclosureUrl: 'https://cdn.example.com/ep1.mp3',
      enclosureMime: 'audio/mpeg',
      enclosureSize: 1024,
      durationMs: 60_000,
      pubDate: 1_700_000_000_000,
      mediaType: 'AUDIO',
    },
  ],
};

describe('Stage 3 sync audit regressions (@minipod/host-node)', () => {
  it('[SYNC-P0-01] preserves concurrent local writes during read(), remote unsubscribe+requeue, and local concurrent requeue vs remote unsubscribe cascade', async () => {
    const db = openDatabase(':memory:');
    let now = 1_700_000_000_000;
    const hlc = new HybridLogicalClock(0, () => now);
    const deletedDownloads: string[] = [];
    const store = new SqliteSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Desktop A',
      onDeleteDownloads: (paths) => deletedDownloads.push(...paths),
    });
    const feedsRepo = new FeedsRepository(db);
    const queueRepo = new QueueRepository(db);
    const progressRepo = new ProgressRepository(db);
    const st = store.getSyncStateSync();

    const url = 'https://audit.example/rss.xml';
    const fk = feedKey(url);
    const ek = episodeKey(fk, 'ep-1');

    // Setup initial synced subscription + queued episode with download + progress
    feedsRepo.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url,
      subscribed: true,
      deviceId: st.deviceId,
      parsed: SAMPLE_PARSED,
      hlc,
      nowWallMs: now,
      markSyncDirty: false,
    });
    db.prepare("UPDATE episodes SET download_state = 'DONE', download_path = '/tmp/ep1.mp3' WHERE episode_key = ?").run(ek);
    queueRepo.upsertEntries(
      [{ episodeKey: ek, feedKey: fk, pos: 'a0', addedAt: now, updatedAt: now, removed: false, deviceId: st.deviceId }],
      false,
    );
    progressRepo.upsert(
      { episodeKey: ek, feedKey: fk, positionMs: 10_000, durationMs: 60_000, state: 'IN_PROGRESS', updatedAt: now, deviceId: st.deviceId },
      { syncDirty: false, identity: 'ep-1' },
    );

    // (a) Concurrent local edits while `provider.read()` is in flight (progress save + local re-queue at T4 > remote unsubscribe T1)
    const remoteT1 = now + 5_000;
    const remoteDoc: SyncDocument = {
      ...createEmptySyncDocument('d_remote', remoteT1),
      rev: 2,
      subscriptions: {
        floor: 0,
        items: {
          [fk]: { url, movedTo: null, updatedAt: remoteT1, deleted: true, deviceId: 'd_remote' },
        },
      },
      queue: {
        floor: 0,
        items: {
          [ek]: { feedKey: fk, pos: 'a0', addedAt: now, updatedAt: remoteT1, removed: true, deviceId: 'd_remote' },
        },
      },
      progress: {
        floor: 0,
        items: {
          [ek]: { feedKey: fk, positionMs: 20_000, durationMs: 60_000, state: 'IN_PROGRESS', playedAt: null, updatedAt: remoteT1, deviceId: 'd_remote', identity: 'ep-1' },
        },
      },
    };

    let uploadedBytes: Uint8Array | null = null;
    let firstRead = true;
    const provider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag: 'e1' }),
      head: async () => 'e1',
      read: async () => {
        if (firstRead) {
          firstRead = false;
          // Simulate concurrent local user edits AFTER `loadLocalDoc()` and BEFORE `read()` resolves!
          now = remoteT1 + 5_000; // T4 > T1
          const t4Queue = hlc.now();
          queueRepo.upsertEntries(
            [
              {
                episodeKey: ek,
                feedKey: fk,
                pos: 'a0',
                addedAt: now,
                updatedAt: t4Queue,
                removed: false,
                deviceId: st.deviceId,
                stub: { identity: 'ep-1', title: 'Episode 1', feedUrl: url },
              },
            ],
            true,
          );
          const t4Prog = hlc.now();
          progressRepo.upsert(
            { episodeKey: ek, feedKey: fk, positionMs: 0, durationMs: 60_000, state: 'PLAYED', playedAt: t4Prog, updatedAt: t4Prog, deviceId: st.deviceId },
            { syncDirty: true, identity: 'ep-1' },
          );
        }
        return { kind: 'blob', bytes: serializeSyncDocument(remoteDoc), etag: 'e1' };
      },
      write: async (b) => {
        uploadedBytes = b.slice();
        return { kind: 'ok', newEtag: 'e2' };
      },
    };

    const engine = new SyncEngine({ store, provider, hlc, backgroundSync: true, now: () => now });
    const res = await engine.run('manual');
    expect(res.uploaded).toBe(true);

    // Concurrent local re-queue (T4 > T1) MUST survive remote unsubscribe cascade (T1) — episode & download preserved!
    expect(queueRepo.listAllRaw().find((q) => q.episode_key === ek)?.removed).toBe(0);
    expect(deletedDownloads).toEqual([]);
    expect(db.prepare('SELECT download_path FROM episodes WHERE episode_key = ?').get(ek)).toEqual({
      download_path: '/tmp/ep1.mp3',
    });
    // Concurrent local PLAYED progress MUST survive and be uploaded!
    expect(progressRepo.get(ek)?.state).toBe('PLAYED');
    const uploadedDoc = parseSyncDocument(uploadedBytes!);
    expect(uploadedDoc.queue.items[ek]?.removed).toBe(false);
    expect(uploadedDoc.progress.items[ek]?.state).toBe('PLAYED');

    // (b) Remote doc carries BOTH feed unsubscribe tombstone (T1) AND newer active queue re-add (T2 > T1)
    const db2 = openDatabase(':memory:');
    const hlc2 = new HybridLogicalClock(0, () => 1_700_000_000_000);
    const store2 = new SqliteSyncStore({ db: db2, hlc: hlc2, appVersion: '0.1.0', defaultDeviceName: 'Desktop B' });
    const feeds2 = new FeedsRepository(db2);
    const queue2 = new QueueRepository(db2);
    feeds2.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url,
      subscribed: true,
      deviceId: store2.getSyncStateSync().deviceId,
      parsed: SAMPLE_PARSED,
      hlc: hlc2,
      nowWallMs: 1_700_000_000_000,
      markSyncDirty: false,
    });
    queue2.upsertEntries(
      [{ episodeKey: ek, feedKey: fk, pos: 'a0', addedAt: 100, updatedAt: 100, removed: false, deviceId: 'd_remote' }],
      false,
    );
    const tUnsub = 1_700_000_050_000;
    const tRequeue = 1_700_000_060_000;
    const docUnsubAndRequeue: SyncDocument = {
      ...createEmptySyncDocument('d_remote', tRequeue),
      rev: 3,
      subscriptions: {
        floor: 0,
        items: { [fk]: { url, movedTo: null, updatedAt: tUnsub, deleted: true, deviceId: 'd_remote' } },
      },
      queue: {
        floor: 0,
        items: {
          [ek]: {
            feedKey: fk,
            pos: 'a0',
            addedAt: 100,
            updatedAt: tRequeue,
            removed: false,
            deviceId: 'd_remote',
            stub: { identity: 'ep-1', title: 'Episode 1', feedUrl: url },
          },
        },
      },
    };
    await store2.applyMerged(docUnsubAndRequeue, undefined);
    const qAfter = queue2.listAllRaw().find((q) => q.episode_key === ek);
    expect(qAfter?.removed).toBe(0);
    expect(qAfter?.updated_at).toBe(tRequeue);
    expect(qAfter?.sync_dirty).toBe(0);

    db.close();
    db2.close();
  });

  it('[SYNC-P0-02] in-flight FeedRefresher.refresh() racing with unsubscribe never resurrects feed', async () => {
    const db = openDatabase(':memory:');
    const hlc = new HybridLogicalClock(0, () => 1_700_000_000_000);
    const store = new SqliteSyncStore({ db, hlc, appVersion: '0.1.0' });
    const feedsRepo = new FeedsRepository(db);
    const url = 'https://race.example/rss.xml';
    const fk = feedKey(url);
    const deviceId = store.getSyncStateSync().deviceId;

    feedsRepo.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url,
      subscribed: true,
      deviceId,
      parsed: SAMPLE_PARSED,
      hlc,
      nowWallMs: 1_700_000_000_000,
    });

    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((r) => {
      releaseFetch = r;
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => {
      fetchStarted = r;
    });

    const http: HttpClient = async () => {
      fetchStarted();
      await fetchBlocked;
      return {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        finalUrl: url,
        chain: [],
        bytes: async () => new TextEncoder().encode(SAMPLE_RSS_XML),
        text: async () => SAMPLE_RSS_XML,
      };
    };

    const refresher = new FeedRefresher({
      db,
      http,
      hlc,
      userAgent: 'MiniPod/test',
      getDeviceId: () => deviceId,
      getCredentials: () => undefined,
      emit: () => undefined,
    });

    const refreshTask = refresher.refresh(fk);
    await started;

    // User unsubscribes while HTTP fetch is in flight!
    feedsRepo.softDeleteUnsubscribe(fk, hlc, deviceId);
    expect(feedsRepo.isSubscribed(fk)).toBe(false);

    releaseFetch();
    await refreshTask;

    // Feed MUST stay unsubscribed / tombstoned!
    const row = feedsRepo.getRaw(fk);
    expect(row?.subscribed).toBe(0);
    expect(row?.deleted_at).not.toBeNull();
    db.close();
  });

  it('[SYNC-P0-05 & SYNC-P1-10 & SYNC-P1-07 & SYNC-P1-11 & SYNC-P2-06] reconnect same folder does not resurrect, bad probe preserves config, queue.list is read-only, and purgeBelowFloors protects playing episode + cleans downloads', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'minipod-sync-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'minipod-sync-b-'));
    try {
      const hostA = createNodePlatformHost({ dataDir: ':memory:', deviceName: 'NodeA' });
      const hostB = createNodePlatformHost({ dataDir: ':memory:', deviceName: 'NodeB' });

      const url = 'https://s10.example/rss.xml';
      const fk = feedKey(url);
      const ek = episodeKey(fk, 'ep-1');

      // Seed feed + queue item on A and sync both A and B to dirA
      const feedsA = new FeedsRepository(hostA.db);
      const queueA = new QueueRepository(hostA.db);
      const hlcSeed = new HybridLogicalClock();
      feedsA.upsertParsedFeed({
        feedKey: fk,
        kind: 'RSS',
        url,
        subscribed: true,
        deviceId: hostA.syncStore.getSyncStateSync().deviceId,
        parsed: SAMPLE_PARSED,
        hlc: hlcSeed,
        nowWallMs: Date.now(),
        markSyncDirty: true,
      });
      queueA.upsertEntries(
        [
          {
            episodeKey: ek,
            feedKey: fk,
            pos: 'a0',
            addedAt: hlcSeed.now(),
            updatedAt: hlcSeed.now(),
            removed: false,
            deviceId: hostA.syncStore.getSyncStateSync().deviceId,
            stub: { identity: 'ep-1', title: 'Episode 1', feedUrl: url },
          },
        ],
        true,
      );

      await hostA.host.sync.configure({ provider: { id: 'local-folder', folderPath: dirA }, wifiOnly: false, deviceName: 'NodeA' });
      await hostB.host.sync.configure({ provider: { id: 'local-folder', folderPath: dirA }, wifiOnly: false, deviceName: 'NodeB' });
      expect((await hostB.host.queue.list()).map((r) => r.episode.episodeKey)).toEqual([ek]);

      // Probe failure MUST NOT overwrite existing sync_state or provider!
      await expect(
        hostB.host.sync.configure({
          provider: { id: 'local-folder', folderPath: join(dirB, 'does-not-exist') },
          wifiOnly: false,
          deviceName: 'NodeB',
        }),
      ).rejects.toThrow();
      expect(hostB.syncService.engine.getProvider()).not.toBeNull();
      expect(hostB.syncStore.getSyncStateSync().lastRemoteFingerprint).toContain(dirA);

      // B disconnects; A removes queue item and syncs
      await hostB.host.sync.disconnect();
      await hostA.host.queue.remove(ek);
      await hostA.host.sync.syncNow();

      // Track emitted events on B when reconnecting to the SAME folder (dirA)
      const eventsB: HostEvent[] = [];
      hostB.host.subscribe((e) => eventsB.push(e));
      await hostB.host.sync.configure({ provider: { id: 'local-folder', folderPath: dirA }, wifiOnly: false, deviceName: 'NodeB' });

      // SYNC-P0-05 (S10): Reconnecting SAME folder MUST NOT resurrect deleted queue item `ek`!
      expect(await hostB.host.queue.list()).toEqual([]);
      // SYNC-P1-07: Remote-only queue change emitted `queue-changed`!
      expect(eventsB.some((e) => e.type === 'queue-changed')).toBe(true);

      // SYNC-P1-11: Collided queue entries on `queue.list()` produce ZERO DB writes
      const queueB = new QueueRepository(hostB.db);
      queueB.upsertEntries(
        [
          { episodeKey: 'e_c1', feedKey: fk, pos: 'a0', addedAt: 1, updatedAt: 100, removed: false, deviceId: 'd_x' },
          { episodeKey: 'e_c2', feedKey: fk, pos: 'a0', addedAt: 2, updatedAt: 100, removed: false, deviceId: 'd_y' },
        ],
        false,
      );
      await hostB.host.queue.list();
      expect(queueB.listAllRaw().filter((r) => r.sync_dirty !== 0)).toHaveLength(0);

      // SYNC-P2-06: purgeBelowFloors protects currently playing episode and cleans download files on purge
      const purgedDownloads: string[] = [];
      let playingKey: string | undefined = ek;
      const storeWithDl = new SqliteSyncStore({
        db: hostA.db,
        hlc: new HybridLogicalClock(),
        appVersion: '0.1.0',
        getCurrentEpisodeKey: () => playingKey,
        onDeleteDownloads: (p) => purgedDownloads.push(...p),
      });
      hostA.db
        .prepare("UPDATE feeds SET subscribed = 0, deleted_at = 500, updated_at = 500, sync_dirty = 0 WHERE feed_key = ?")
        .run(fk);
      hostA.db
        .prepare("UPDATE episodes SET download_state = 'DONE', download_path = '/tmp/keep-while-playing.mp3' WHERE episode_key = ?")
        .run(ek);

      // While playing: feed MUST NOT be hard-deleted!
      await storeWithDl.purgeBelowFloors({ subscriptions: 1000, queue: 0, progress: 0 });
      expect(feedsA.getRaw(fk)).toBeDefined();
      expect(purgedDownloads).toEqual([]);

      // After playback stops: feed is deleted AND download path is reported for cleanup!
      playingKey = undefined;
      await storeWithDl.purgeBelowFloors({ subscriptions: 1000, queue: 0, progress: 0 });
      expect(feedsA.getRaw(fk)).toBeUndefined();
      expect(purgedDownloads).toEqual(['/tmp/keep-while-playing.mp3']);

      await hostA.host.dispose();
      await hostB.host.dispose();
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('[SYNC-P1-08 & SYNC-P1-12] persists subscription device_id and eliminates progress COALESCE ping-pong', async () => {
    const dbA = openDatabase(':memory:');
    const dbB = openDatabase(':memory:');
    const now = 1_750_000_000_000;
    const hlcA = new HybridLogicalClock(0, () => now);
    const hlcB = new HybridLogicalClock(0, () => now);
    const storeA = new SqliteSyncStore({ db: dbA, hlc: hlcA, appVersion: '0.1.0', defaultDeviceName: 'A' });
    const storeB = new SqliteSyncStore({ db: dbB, hlc: hlcB, appVersion: '0.1.0', defaultDeviceName: 'B' });

    // Force deterministic device IDs so B < A lexicographically
    await storeA.setSyncState({ deviceId: 'd_ffff' });
    await storeB.setSyncState({ deviceId: 'd_0001' });

    const fk = feedKey('https://pingpong.example/rss');
    const ek = episodeKey(fk, 'ep-1');
    new FeedsRepository(dbA).upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url: 'https://pingpong.example/rss',
      subscribed: true,
      deviceId: 'd_ffff',
      parsed: SAMPLE_PARSED,
      hlc: hlcA,
      nowWallMs: now,
    });
    // A has progress without durationMs; B has stale local progress WITH durationMs at earlier HLC
    new ProgressRepository(dbA).upsert(
      { episodeKey: ek, feedKey: fk, positionMs: 30_000, state: 'IN_PROGRESS', updatedAt: now + 100, deviceId: 'd_ffff' },
      { syncDirty: true, identity: 'ep-1' },
    );
    new ProgressRepository(dbB).upsert(
      { episodeKey: ek, feedKey: fk, positionMs: 10_000, durationMs: 99_000, state: 'IN_PROGRESS', updatedAt: now, deviceId: 'd_0001' },
      { syncDirty: false, identity: 'ep-1' },
    );

    let cloudBytes: Uint8Array | null = null;
    let etag = 'v0';
    const cloud: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: cloudBytes !== null, etag: cloudBytes ? etag : null }),
      head: async () => (cloudBytes ? etag : null),
      read: async (m) => {
        if (!cloudBytes) return { kind: 'missing' };
        if (m === etag) return { kind: 'not-modified' };
        return { kind: 'blob', bytes: cloudBytes, etag };
      },
      write: async (b) => {
        cloudBytes = b.slice();
        etag = `v${etag.length + 1}`;
        return { kind: 'ok', newEtag: etag };
      },
    };

    const engA = new SyncEngine({ store: storeA, provider: cloud, hlc: hlcA, backgroundSync: true, now: () => now });
    const engB = new SyncEngine({ store: storeB, provider: cloud, hlc: hlcB, backgroundSync: true, now: () => now });

    await engA.run('manual');
    await engB.run('manual'); // pulls A's feed & progress (and registers d_0001)
    // Verify B persisted `device_id = 'd_ffff'` and overwrote durationMs -> undefined (no COALESCE retention!)
    expect(new FeedsRepository(dbB).getRaw(fk)?.device_id).toBe('d_ffff');
    expect(new ProgressRepository(dbB).getRaw(ek)?.duration_ms).toBeNull();

    // Subsequent syncs on A and B MUST be completely silent (zero ping-pong!)
    expect((await engA.run('manual')).uploaded).toBe(false);
    expect((await engB.run('manual')).uploaded).toBe(false);

    dbA.close();
    dbB.close();
  });

  it('[SYNC-P1-14 & SYNC-P2-08] Drive OAuth 503 HTML refresh returns network error, and SSE HostEventStream reconnects on clean EOF', async () => {
    const db = openDatabase(':memory:');
    const settingsStore = new SettingsStore(db, ':memory:', 'Desktop');
    settingsStore.setDriveOAuthClient({ clientId: 'cid-1' });
    settingsStore.setDriveTokens({
      accessToken: 'expired',
      refreshToken: 'ref-1',
      expiresAt: 1,
    });

    const authMgr = new DesktopDriveAuthManager({
      settingsStore,
      http: async () => ({
        status: 503,
        headers: { 'content-type': 'text/html' },
        finalUrl: 'https://oauth2.googleapis.com/token',
        chain: [],
        bytes: async () => new TextEncoder().encode('<html>503 Service Unavailable</html>'),
        text: async () => '<html>503 Service Unavailable</html>',
      }),
      openExternal: async () => undefined,
    });
    const tokenProvider = authMgr.createTokenProvider();
    await expect(tokenProvider({ forceRefresh: true })).rejects.toMatchObject({ code: 'network' });
    db.close();

    // SSE reconnect on clean EOF
    let connectCount = 0;
    const fetchMock: typeof fetch = async () => {
      connectCount += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"feeds-changed"}\n\n'));
          controller.close(); // Clean EOF!
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const sse = new HostEventStream({ url: 'http://127.0.0.1/api/events', fetchImpl: fetchMock, reconnectDelayMs: 15 });
    const received: HostEvent[] = [];
    const unsub = sse.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 80));
    unsub();
    sse.dispose();
    expect(connectCount).toBeGreaterThanOrEqual(2);
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('[SYNC-P1-07] NodeSyncService handleDecisions excludes resumeHints keys from plain progress-changed', async () => {
    const db = openDatabase(':memory:');
    const now = 1_700_000_000_000;
    const hlc = new HybridLogicalClock(0, () => now);
    const store = new SqliteSyncStore({ db, hlc, appVersion: '0.1.0' });
    const settingsStore = new SettingsStore(db, ':memory:', 'Desktop');
    const emitted: HostEvent[] = [];

    const service = new NodeSyncService({
      store,
      settingsStore,
      http: async () => {
        throw new Error('unused');
      },
      hlc,
      userAgent: 'MiniPod/test',
      openExternal: async () => undefined,
      getCurrentEpisodeKey: () => 'e_playing',
      emit: (e) => emitted.push(e),
      onRefreshFeeds: () => undefined,
    });

    const remoteDoc: SyncDocument = {
      ...createEmptySyncDocument('d_other', now + 1000),
      rev: 1,
      devices: { d_other: { name: 'Phone', app: 'test', lastSeenAt: now + 1000 } },
      progress: {
        floor: 0,
        items: {
          e_playing: { feedKey: 'f_1', positionMs: 45_000, state: 'IN_PROGRESS', playedAt: null, updatedAt: now + 1000, deviceId: 'd_other' },
          e_other: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', playedAt: now + 1000, updatedAt: now + 1000, deviceId: 'd_other' },
        },
      },
    };
    service.engine.setProvider({
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag: 'e1' }),
      head: async () => 'e1',
      read: async () => ({ kind: 'blob', bytes: serializeSyncDocument(remoteDoc), etag: 'e1' }),
      write: async () => ({ kind: 'ok', newEtag: 'e2' }),
    });

    await service.syncNow();
    const progEvents = emitted.filter((e) => e.type === 'progress-changed');
    // `e_playing` appears ONLY ONCE with `fromSync` (no duplicate plain `progress-changed`)
    const playingEvs = progEvents.filter((e) => e.episodeKey === 'e_playing');
    expect(playingEvs).toHaveLength(1);
    expect(playingEvs[0]?.fromSync?.deviceName).toBe('Phone');
    // `e_other` appears as plain `progress-changed` without `fromSync`
    const otherEvs = progEvents.filter((e) => e.episodeKey === 'e_other');
    expect(otherEvs).toHaveLength(1);
    expect(otherEvs[0]?.fromSync).toBeUndefined();

    await service.dispose(0);
    db.close();
  });
});
