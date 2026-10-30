import {
  feedKey,
  HybridLogicalClock,
  SyncEngine,
  SYNC_FILE_NAME,
} from '@minipod/core';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedsRepository } from '../db/repositories/feeds';
import { openDatabase } from '../db/sqlite';
import { SqliteSyncStore } from '../db/SqliteSyncStore';
import { createLocalFolderFileProvider } from './LocalFolderFileProvider';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('LocalFolderFileProvider', () => {
  it('writes atomically via .tmp + rename, detects pre-write conflicts, and archives corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minipod-sync-folder-'));
    tempDirs.push(dir);

    const provider = createLocalFolderFileProvider(dir);
    const probeEmpty = await provider.probe();
    expect(probeEmpty).toEqual({ ok: true, exists: false, etag: null });

    const payload1 = new TextEncoder().encode('{"hello":1}');
    const write1 = await provider.write(payload1, null);
    expect(write1.kind).toBe('ok');
    const etag1 = write1.kind === 'ok' ? write1.newEtag : null;
    expect(etag1).toBeTruthy();

    // No lingering .tmp files
    expect(readdirSync(dir)).toEqual([SYNC_FILE_NAME]);

    // Conditional read with matching etag returns not-modified
    const notMod = await provider.read(etag1);
    expect(notMod.kind).toBe('not-modified');

    // Stale ifMatch returns conflict BEFORE overwriting bytes
    const conflict = await provider.write(new TextEncoder().encode('{"hello":2}'), 'stale-etag');
    expect(conflict.kind).toBe('conflict');

    const stillOrig = await provider.read(null);
    expect(stillOrig.kind).toBe('blob');
    if (stillOrig.kind === 'blob') {
      expect(new TextDecoder().decode(stillOrig.bytes)).toBe('{"hello":1}');
    }

    // Corrupt archive helper preserves original file alongside backup
    const archivedPath = provider.archiveCorrupt(new TextEncoder().encode('not-json'), 123456);
    expect(existsSync(archivedPath)).toBe(true);
    expect(existsSync(join(dir, SYNC_FILE_NAME))).toBe(true);
  });

  it('watches parent directory for external atomic renames while ignoring self-writes, and syncs two devices', async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), 'minipod-two-devices-'));
    tempDirs.push(sharedDir);

    const providerA = createLocalFolderFileProvider(sharedDir, { watchDebounceMs: 40 });
    const providerB = createLocalFolderFileProvider(sharedDir, { watchDebounceMs: 40 });

    let externalNotificationsOnA = 0;
    const unsubA = providerA.watch?.(() => {
      externalNotificationsOnA += 1;
    });

    const dbA = openDatabase(':memory:');
    const hlcA = new HybridLogicalClock(0, () => 1_700_100_000_000);
    const storeA = new SqliteSyncStore({ db: dbA, hlc: hlcA, appVersion: '0.1.0', defaultDeviceName: 'Mac' });
    const feedsA = new FeedsRepository(dbA);

    const dbB = openDatabase(':memory:');
    const hlcB = new HybridLogicalClock(0, () => 1_700_100_005_000);
    const storeB = new SqliteSyncStore({ db: dbB, hlc: hlcB, appVersion: '0.1.0', defaultDeviceName: 'Linux' });
    const feedsB = new FeedsRepository(dbB);

    const urlA = 'https://a.example.com/feed.xml';
    feedsA.upsertParsedFeed({
      feedKey: feedKey(urlA),
      kind: 'RSS',
      url: urlA,
      subscribed: true,
      parsed: { type: 'rss20', title: 'Show A', episodes: [] },
      hlc: hlcA,
      nowWallMs: 1_700_100_000_000,
    });

    const engineA = new SyncEngine({ store: storeA, provider: providerA, hlc: hlcA, backgroundSync: true });
    const engineB = new SyncEngine({ store: storeB, provider: providerB, hlc: hlcB, backgroundSync: true });

    const resA = await engineA.run('manual');
    expect(resA.uploaded).toBe(true);

    // Give watcher debounce window a moment — A's self-write must NOT trigger A's own watcher!
    await new Promise((r) => setTimeout(r, 120));
    expect(externalNotificationsOnA).toBe(0);

    // Device B subscribes to Show B and syncs into the same shared folder -> merges A + B and writes atomically!
    const urlB = 'https://b.example.com/feed.xml';
    feedsB.upsertParsedFeed({
      feedKey: feedKey(urlB),
      kind: 'RSS',
      url: urlB,
      subscribed: true,
      parsed: { type: 'rss20', title: 'Show B', episodes: [] },
      hlc: hlcB,
      nowWallMs: 1_700_100_005_000,
    });

    const resB = await engineB.run('manual');
    expect(resB.pulled).toBe(true);
    expect(resB.uploaded).toBe(true);
    expect(feedsB.listSubscribed().map((f) => f.title).sort()).toEqual(['Show A', 'Show B']);

    // Simulate cloud daemon atomic rename update if fs.watch didn't already fire, or verify watcher fires
    if (externalNotificationsOnA === 0) {
      const extTmp = join(sharedDir, '.cloud-daemon-incoming.tmp');
      writeFileSync(extTmp, join(sharedDir, SYNC_FILE_NAME));
      // Restore valid sync doc via engineB or wait
      rmSync(extTmp, { force: true });
    }

    // Device A pulls merged state -> sees Show A + Show B
    await engineA.run('remote-changed');
    expect(feedsA.listSubscribed().map((f) => f.title).sort()).toEqual(['Show A', 'Show B']);

    // Verify external rename triggers watcher
    let watchFired = false;
    const unsubTest = providerB.watch?.(() => {
      watchFired = true;
    });
    const incomingTmp = join(sharedDir, 'incoming-dropbox-sync');
    writeFileSync(incomingTmp, '{"external":true}');
    renameSync(incomingTmp, join(sharedDir, SYNC_FILE_NAME));
    await new Promise((r) => setTimeout(r, 150));
    expect(watchFired).toBe(true);

    unsubTest?.();
    unsubA?.();
    dbA.close();
    dbB.close();
  });
});
