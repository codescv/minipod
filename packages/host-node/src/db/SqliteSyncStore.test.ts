import {
  episodeKey,
  feedKey,
  HybridLogicalClock,
  mergeSyncDocuments,
  SYNC_SCHEMA_ID,
  SYNC_SCHEMA_VERSION,
  type ParsedFeed,
  type SyncDocument,
} from '@minipod/core';
import { describe, expect, it } from 'vitest';
import { EpisodesRepository } from './repositories/episodes';
import { FeedsRepository } from './repositories/feeds';
import { ProgressRepository } from './repositories/progress';
import { QueueRepository } from './repositories/queue';
import { openDatabase } from './sqlite';
import { SqliteSyncStore } from './SqliteSyncStore';

const SAMPLE_PARSED_FEED: ParsedFeed = {
  type: 'rss20',
  title: 'Test Show',
  author: 'Host',
  description: 'A test podcast',
  imageUrl: 'https://example.com/art.jpg',
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
    {
      identity: 'ep-2',
      guid: 'ep-2',
      title: 'Episode 2',
      enclosureUrl: 'https://cdn.example.com/ep2.mp3',
      enclosureMime: 'audio/mpeg',
      enclosureSize: 2048,
      durationMs: 120_000,
      pubDate: 1_700_086_400_000,
      mediaType: 'AUDIO',
    },
  ],
};

describe('SqliteSyncStore & SQLite repositories', () => {
  it('persists feeds, episodes, progress, queue, and soft-deletes on unsubscribe while keeping progress', async () => {
    const db = openDatabase(':memory:');
    const hlc = new HybridLogicalClock(0, () => 1_700_000_000_000);
    const store = new SqliteSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Test Linux',
    });

    const feedsRepo = new FeedsRepository(db);
    const episodesRepo = new EpisodesRepository(db);
    const progressRepo = new ProgressRepository(db);
    const queueRepo = new QueueRepository(db);

    const url = 'https://example.com/feed.xml';
    const fk = feedKey(url);
    const ek1 = episodeKey(fk, 'ep-1');

    feedsRepo.upsertParsedFeed({
      feedKey: fk,
      kind: 'RSS',
      url,
      subscribed: true,
      parsed: SAMPLE_PARSED_FEED,
      hlc,
      nowWallMs: 1_700_000_000_000,
    });

    expect(feedsRepo.listSubscribed()).toHaveLength(1);
    const page = episodesRepo.list(fk, 'all');
    expect(page.items).toHaveLength(2);

    const state = await store.getSyncState();
    progressRepo.upsert({
      episodeKey: ek1,
      feedKey: fk,
      positionMs: 15_000,
      durationMs: 60_000,
      state: 'IN_PROGRESS',
      updatedAt: hlc.now(),
      deviceId: state.deviceId,
    });

    queueRepo.upsertEntries([
      {
        episodeKey: ek1,
        feedKey: fk,
        pos: 'a0',
        addedAt: hlc.now(),
        updatedAt: hlc.now(),
        removed: false,
        deviceId: state.deviceId,
      },
    ]);
    expect(queueRepo.listActiveRows()).toHaveLength(1);

    // Unsubscribe soft-deletes subscription, tombstones queue, removes episodes, preserves progress
    feedsRepo.softDeleteUnsubscribe(fk, hlc, state.deviceId);
    expect(feedsRepo.listSubscribed()).toHaveLength(0);
    expect(queueRepo.listActiveRows()).toHaveLength(0);
    expect(progressRepo.get(ek1)?.positionMs).toBe(15_000);

    const snap = await store.loadLocalDoc();
    expect(snap.maps.subscriptions.items[fk]?.deleted).toBe(true);
    expect(snap.maps.queue.items[ek1]?.removed).toBe(true);
    expect(snap.maps.progress.items[ek1]?.positionMs).toBe(15_000);
    db.close();
  });

  it('merges remote sync documents atomically, materialises queue stubs, emits resumeHints, and excludes LOCAL feeds', async () => {
    const db = openDatabase(':memory:');
    const hlc = new HybridLogicalClock(0, () => 1_700_000_100_000);
    const store = new SqliteSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Desktop A',
    });
    const feedsRepo = new FeedsRepository(db);
    const queueRepo = new QueueRepository(db);

    // Add a LOCAL folder feed — must never appear in loadLocalDoc()
    feedsRepo.upsertParsedFeed({
      feedKey: 'l_local123',
      kind: 'LOCAL',
      url: 'local-folder:/tmp/audiobooks',
      subscribed: true,
      parsed: { type: 'rss20', title: 'Local Books', episodes: [] },
      hlc,
      nowWallMs: 1_700_000_100_000,
      markSyncDirty: false,
    });

    const localSnapBefore = await store.loadLocalDoc();
    expect(Object.keys(localSnapBefore.maps.subscriptions.items)).toHaveLength(0);

    const remoteUrl = 'https://remote.example.com/rss.xml';
    const remoteFk = feedKey(remoteUrl);
    const remoteEk = episodeKey(remoteFk, 'remote-guid-1');

    const remoteDoc: SyncDocument = {
      schema: SYNC_SCHEMA_ID,
      schemaVersion: SYNC_SCHEMA_VERSION,
      rev: 3,
      writtenAt: 1_700_000_200_000,
      writtenBy: 'd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      hlcMax: 1_700_000_200_000,
      devices: {
        d_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {
          name: 'Pixel 9',
          app: 'minipod/0.1.0',
          lastSeenAt: 1_700_000_200_000,
        },
      },
      subscriptions: {
        floor: 0,
        items: {
          [remoteFk]: {
            url: remoteUrl,
            movedTo: null,
            title: 'Remote Show',
            updatedAt: 1_700_000_150_000,
            deleted: false,
            deviceId: 'd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
      },
      queue: {
        floor: 0,
        items: {
          [remoteEk]: {
            feedKey: remoteFk,
            pos: 'a0',
            addedAt: 1_700_000_160_000,
            updatedAt: 1_700_000_160_000,
            removed: false,
            deviceId: 'd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            stub: {
              identity: 'remote-guid-1',
              title: 'Stubbed Remote Episode',
              feedTitle: 'Remote Show',
              feedUrl: remoteUrl,
              enclosureUrl: 'https://remote.example.com/ep1.mp3',
              enclosureMime: 'audio/mpeg',
              durationMs: 90_000,
            },
          },
        },
      },
      progress: {
        floor: 0,
        items: {
          [remoteEk]: {
            feedKey: remoteFk,
            identity: 'remote-guid-1',
            positionMs: 42_000,
            durationMs: 90_000,
            state: 'IN_PROGRESS',
            playedAt: null,
            updatedAt: 1_700_000_180_000,
            deviceId: 'd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
      },
    };

    const st = await store.getSyncState();
    const localDoc: SyncDocument = {
      schema: SYNC_SCHEMA_ID,
      schemaVersion: SYNC_SCHEMA_VERSION,
      rev: 0,
      writtenAt: 0,
      writtenBy: st.deviceId,
      hlcMax: hlc.current(),
      devices: {},
      subscriptions: localSnapBefore.maps.subscriptions,
      queue: localSnapBefore.maps.queue,
      progress: localSnapBefore.maps.progress,
    };

    const merged = mergeSyncDocuments(localDoc, remoteDoc);
    const decisions = await store.applyMerged(merged, remoteEk);

    expect(decisions.feedsToRefresh).toContain(remoteFk);
    expect(decisions.resumeHints).toEqual([
      {
        episodeKey: remoteEk,
        positionMs: 42_000,
        state: 'IN_PROGRESS',
        deviceName: 'Pixel 9',
      },
    ]);

    // Queue entry materialised as playable stub episode even before feed is refreshed!
    const qRows = queueRepo.listActiveRows();
    expect(qRows).toHaveLength(1);
    expect(qRows[0]?.episode.isStub).toBe(true);
    expect(qRows[0]?.episode.title).toBe('Stubbed Remote Episode');
    expect(qRows[0]?.progress?.positionMs).toBe(42_000);
    db.close();
  });
});
