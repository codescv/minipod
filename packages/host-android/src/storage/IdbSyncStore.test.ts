import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  HybridLogicalClock,
  SYNC_SCHEMA_ID,
  SYNC_SCHEMA_VERSION,
  type SyncDocument,
} from '@minipod/core';
import {
  AndroidSecretsStore,
  createMemoryPreferences,
  openMiniPodDb,
} from './idb';
import { IdbSyncStore } from './IdbSyncStore';

describe('IdbSyncStore & AndroidSecretsStore', () => {
  it('initializes syncState singleton and keeps secrets out of IndexedDB', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'test-init');
    const hlc = new HybridLogicalClock(1_700_000_000_000, () => 1_700_000_000_000);
    const store = new IdbSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Pixel 8',
    });

    const st = await store.init();
    expect(st.deviceId).toMatch(/^d_[0-9a-f]{32}$/);
    expect(st.deviceName).toBe('Pixel 8');
    expect(st.remoteRev).toBe(0);

    const prefs = createMemoryPreferences();
    const secrets = new AndroidSecretsStore(prefs);
    await secrets.setFeedCredentials('f_secret', { username: 'alice', password: 'pw' });
    await secrets.saveSyncSecret({ id: 'webdav', password: 'dav-pw' });

    expect(await secrets.getFeedCredentials('f_secret')).toEqual({
      username: 'alice',
      password: 'pw',
    });
    expect(await secrets.getWebDavPassword()).toBe('dav-pw');

    // Secrets must never appear in IndexedDB settings row
    const settingsRow = await db.get('settings', 'app');
    expect(JSON.stringify(settingsRow)).not.toContain('dav-pw');
    db.close();
  });

  it('materializes queue stubs, emits resumeHints, soft-deletes unsubscribed feeds, and excludes LOCAL folders', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'test-merge');
    let wall = 1_700_000_000_000;
    const hlc = new HybridLogicalClock(0, () => wall);
    const deletedPaths: string[] = [];

    const store = new IdbSyncStore({
      db,
      hlc,
      appVersion: '0.1.0',
      defaultDeviceName: 'Pixel 8',
      onDeleteDownloads: (paths) => {
        deletedPaths.push(...paths);
      },
    });
    const localState = await store.init();

    // Seed a subscribed RSS feed with a downloaded episode + a LOCAL SAF folder feed
    await store.upsertParsedFeed({
      feedKey: 'f_old',
      kind: 'RSS',
      url: 'https://example.com/old.xml',
      subscribed: true,
      parsed: {
        type: 'rss20',
        title: 'Old Show',
        episodes: [
          {
            identity: 'ep-old-1',
            title: 'Old Ep 1',
            mediaType: 'AUDIO',
            enclosureUrl: 'https://example.com/old1.mp3',
          },
        ],
      },
      nowWallMs: wall,
      markSyncDirty: false,
    });

    const oldEps = await store.listEpisodes('f_old', 'all');
    const oldEpKey = oldEps.items[0]!.episode.episodeKey;
    await store.setEpisodeDownloadState(oldEpKey, 'DONE', 'downloads/old1.mp3');
    await store.upsertProgress(
      {
        episodeKey: oldEpKey,
        feedKey: 'f_old',
        positionMs: 12_000,
        state: 'IN_PROGRESS',
        updatedAt: hlc.now(),
        deviceId: localState.deviceId,
      },
      { syncDirty: false },
    );

    // Seed LOCAL SAF folder feed (must never leak into sync or get wiped by remote floor)
    await store.upsertParsedFeed({
      feedKey: 'l_local123',
      kind: 'LOCAL',
      url: 'local-folder:content://tree/primary%3AAudiobooks',
      subscribed: true,
      parsed: {
        type: 'rss20',
        title: 'Audiobooks',
        episodes: [
          {
            identity: 'ch1.mp3',
            title: 'Chapter 1',
            mediaType: 'AUDIO',
            enclosureUrl: 'content://doc/ch1.mp3',
          },
        ],
      },
      nowWallMs: wall,
      markSyncDirty: false,
    });

    const localSnapshot = await store.loadLocalDoc();
    expect(Object.keys(localSnapshot.maps.subscriptions.items)).toEqual(['f_old']);
    expect('l_local123' in localSnapshot.maps.subscriptions.items).toBe(false);

    // Build a merged remote document where:
    // - `f_old` was unsubscribed on Desktop (`deleted: true`)
    // - `f_new` was subscribed on Desktop
    // - `e_stub1` is queued with a stub from `f_unsub`
    // - `e_playing` (currently loaded in player) jumped to 95_000 ms on Desktop
    wall += 10_000;
    const remoteTs = wall;
    const mergedDoc: SyncDocument = {
      schema: SYNC_SCHEMA_ID,
      schemaVersion: SYNC_SCHEMA_VERSION,
      rev: 3,
      writtenAt: remoteTs,
      writtenBy: 'd_desktop000000000000000000000001',
      hlcMax: remoteTs,
      devices: {
        d_desktop000000000000000000000001: {
          name: 'Workstation',
          app: 'minipod/0.1.0',
          lastSeenAt: remoteTs,
        },
      },
      subscriptions: {
        floor: 0,
        items: {
          f_old: {
            url: 'https://example.com/old.xml',
            updatedAt: remoteTs,
            deleted: true,
            deviceId: 'd_desktop000000000000000000000001',
          },
          f_new: {
            url: 'https://example.com/new.xml',
            title: 'New Show',
            updatedAt: remoteTs,
            deleted: false,
            deviceId: 'd_desktop000000000000000000000001',
          },
        },
      },
      queue: {
        floor: 0,
        items: {
          e_stub1: {
            feedKey: 'f_unsub',
            pos: 'a0',
            addedAt: remoteTs,
            updatedAt: remoteTs,
            removed: false,
            deviceId: 'd_desktop000000000000000000000001',
            stub: {
              identity: 'guid-stub-1',
              title: 'Synced Stub Episode',
              feedTitle: 'Unsubscribed Show',
              feedUrl: 'https://example.com/unsub.xml',
              enclosureUrl: 'https://example.com/stub1.mp3',
              enclosureMime: 'audio/mpeg',
              durationMs: 180_000,
            },
          },
        },
      },
      progress: {
        floor: 0,
        items: {
          [oldEpKey]: {
            feedKey: 'f_old',
            identity: 'ep-old-1',
            positionMs: 12_000,
            state: 'IN_PROGRESS',
            playedAt: null,
            updatedAt: localState.hlcLast,
            deviceId: localState.deviceId,
          },
          e_stub1: {
            feedKey: 'f_unsub',
            identity: 'guid-stub-1',
            positionMs: 95_000,
            durationMs: 180_000,
            state: 'IN_PROGRESS',
            playedAt: null,
            updatedAt: remoteTs,
            deviceId: 'd_desktop000000000000000000000001',
          },
        },
      },
    };

    const decisions = await store.applyMerged(mergedDoc, 'e_stub1');

    expect(decisions.feedsToRefresh).toEqual(['f_new']);
    expect(decisions.resumeHints).toEqual([
      {
        episodeKey: 'e_stub1',
        positionMs: 95_000,
        state: 'IN_PROGRESS',
        deviceName: 'Workstation',
      },
    ]);

    // `f_old` download deleted & unsubscribed, while progress of `oldEpKey` is preserved (`§6.3`)
    expect(deletedPaths).toEqual(['downloads/old1.mp3']);
    const subscribed = await store.listSubscribedFeeds();
    expect(subscribed.map((f) => f.feedKey).sort()).toEqual(['f_new', 'l_local123']);
    expect((await store.getProgress(oldEpKey))?.positionMs).toBe(12_000);

    // Queue stub materialized and immediately playable
    const qRows = await store.listActiveQueueRows();
    expect(qRows).toHaveLength(1);
    expect(qRows[0]!.episode.episodeKey).toBe('e_stub1');
    expect(qRows[0]!.episode.isStub).toBe(true);
    expect(qRows[0]!.episode.enclosureUrl).toBe('https://example.com/stub1.mp3');

    db.close();
  });
  it('migrates a legacy schemaVersion 1 settings row with deleteDownloadWhenPlayed: false to schemaVersion 2 / true on init (b1d6d66b)', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'test-legacy-settings');
    await db.put('settings', {
      key: 'app',
      value: {
        schemaVersion: 1,
        deleteDownloadWhenPlayed: false,
        playbackSpeed: 1.5,
        uiLanguage: 'zh-CN',
      } as never,
    });
    const store = new IdbSyncStore({
      db,
      hlc: new HybridLogicalClock(),
      appVersion: '0.1.27',
      defaultDeviceName: 'Pixel 8',
    });
    await store.init();
    const row = await db.get('settings', 'app');
    expect(row?.value).toMatchObject({
      schemaVersion: 2,
      deleteDownloadWhenPlayed: true,
      // user choices are preserved, missing fields backfilled
      playbackSpeed: 1.5,
      uiLanguage: 'zh-CN',
      backgroundRefreshHours: 0,
    });

    // schemaVersion 2 rows (incl. an explicit opt-out) are left untouched on later inits
    await db.put('settings', { key: 'app', value: { ...row!.value, deleteDownloadWhenPlayed: false } });
    await store.init();
    expect((await db.get('settings', 'app'))?.value.deleteDownloadWhenPlayed).toBe(false);
    db.close();
  });

  it('failStaleInFlightDownloads keeps natively-active episodes; updateEpisodeDownloadStateIf only applies from the expected states (4daa0030)', async () => {
    const db = await openMiniPodDb(new IDBFactory(), 'test-download-states');
    const wall = 1_700_000_000_000;
    const store = new IdbSyncStore({
      db,
      hlc: new HybridLogicalClock(0, () => wall),
      appVersion: '0.1.0',
      defaultDeviceName: 'Pixel 8',
    });
    await store.init();
    await store.upsertParsedFeed({
      feedKey: 'f_dl',
      kind: 'RSS',
      url: 'https://example.com/dl.xml',
      subscribed: true,
      parsed: {
        type: 'rss20',
        title: 'DL Show',
        episodes: ['a', 'b', 'c'].map((id) => ({
          identity: `ep-${id}`,
          title: `Ep ${id}`,
          mediaType: 'AUDIO' as const,
          enclosureUrl: `https://example.com/${id}.mp3`,
        })),
      },
      nowWallMs: wall,
      markSyncDirty: false,
    });
    const keys = (await store.listEpisodes('f_dl', 'all')).items.map((r) => r.episode.episodeKey);
    const [a, b, c] = keys as [string, string, string];
    await store.setEpisodeDownloadState(a, 'RUNNING');
    await store.setEpisodeDownloadState(b, 'QUEUED');
    await store.setEpisodeDownloadState(c, 'QUEUED');

    expect(await store.failStaleInFlightDownloads(new Set([a, b]))).toEqual([c]);
    expect((await db.get('episodes', a))?.downloadState).toBe('RUNNING');
    expect((await db.get('episodes', b))?.downloadState).toBe('QUEUED');
    expect((await db.get('episodes', c))?.downloadState).toBe('FAILED');

    expect(await store.updateEpisodeDownloadStateIf(a, ['QUEUED', 'RUNNING'], 'DONE', 'downloads/a.mp3')).toBe(
      'RUNNING',
    );
    expect(await db.get('episodes', a)).toMatchObject({ downloadState: 'DONE', downloadPath: 'downloads/a.mp3' });
    // A late RUNNING must never resurrect over DONE / a cancelled NONE.
    expect(await store.updateEpisodeDownloadStateIf(a, ['QUEUED', 'RUNNING'], 'RUNNING')).toBeUndefined();
    expect((await db.get('episodes', a))?.downloadState).toBe('DONE');
    await store.setEpisodeDownloadState(b, 'NONE');
    expect(await store.updateEpisodeDownloadStateIf(b, ['QUEUED', 'RUNNING'], 'RUNNING')).toBeUndefined();
    expect((await db.get('episodes', b))?.downloadState).toBe('NONE');
    expect(await store.updateEpisodeDownloadStateIf('missing', ['NONE'], 'RUNNING')).toBeUndefined();
    db.close();
  });
});
