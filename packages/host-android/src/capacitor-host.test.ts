import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64, episodeKey as deriveEpisodeKey } from '@minipod/core';
import { createCapacitorPlatformHost, extractActionSendInput } from './capacitor-host';
import { createMemoryPreferences } from './storage/idb';
import {
  wrapNativeBridge,
  type MiniPodEventMap,
  type MiniPodNativeBridge,
  type MiniPodPlugin,
  type NativeJournalSnapshot,
} from './plugin-types';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:psc="http://podlove.org/simple-chapters">
  <channel>
    <title>Android Test Pod</title>
    <link>https://pod.example.com</link>
    <description>Test feed</description>
    <item>
      <guid>ep-1</guid>
      <title>Episode One</title>
      <enclosure url="https://pod.example.com/ep1.mp3" type="audio/mpeg" length="1000" />
      <pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <guid>ep-2</guid>
      <title>Episode Two</title>
      <enclosure url="https://pod.example.com/ep2.mp3" type="audio/mpeg" length="1000" />
      <pubDate>Thu, 30 Oct 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

function createTestPluginHarness() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let journal: NativeJournalSnapshot = { completed: [] };
  const safFiles = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const deletedLocalFiles: string[] = [];
  const callOrder: string[] = [];

  const emitNative = <K extends keyof MiniPodEventMap>(event: K, payload: MiniPodEventMap[K]) => {
    for (const cb of listeners.get(event) ?? []) {
      cb(payload);
    }
  };

  const plugin: MiniPodPlugin = {
    http: vi.fn(async (req) => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      finalUrl: req.url,
      chain: [],
      bodyBase64: encodeBase64(new TextEncoder().encode(SAMPLE_RSS)),
    })),
    httpToFile: vi.fn(async (req) => ({
      path: `/data/user/0/dev.minipod.app/files/${req.destPath}`,
      size: 4096,
      mime: 'audio/mpeg',
    })),
    cancelDownload: vi.fn(async () => undefined),
    deleteLocalFile: vi.fn(async ({ path }) => {
      deletedLocalFiles.push(path);
    }),
    readLocalFileRange: vi.fn(async ({ start, length }) => {
      const dummy = new Uint8Array(start + length);
      dummy.fill(0xab, start, start + length);
      return { base64: encodeBase64(dummy.subarray(start, start + length)) };
    }),
    saf: {
      pick: vi.fn(async () => null),
      stat: vi.fn(async ({ uri }) => {
        const hit = safFiles.get(uri);
        if (!hit) return { exists: false };
        return { exists: true, size: hit.bytes.length, mtimeMs: hit.mtimeMs };
      }),
      read: vi.fn(async ({ uri }) => {
        const hit = safFiles.get(uri);
        if (!hit) throw new Error('FileNotFoundException');
        return { base64: encodeBase64(hit.bytes) };
      }),
      readRange: vi.fn(async ({ uri, start, length }) => {
        const hit = safFiles.get(uri);
        if (!hit) return { base64: '' };
        return { base64: encodeBase64(hit.bytes.subarray(start, start + length)) };
      }),
      write: vi.fn(async ({ uri, base64 }) => {
        callOrder.push('saf.write');
        safFiles.set(uri, {
          bytes: decodeBase64(base64),
          mtimeMs: Date.now(),
        });
      }),
      listTree: vi.fn(async () => ({
        entries: [
          {
            uri: 'content://tree/doc/folder.jpg',
            name: 'folder.jpg',
            mime: 'image/jpeg',
            size: 4,
            mtimeMs: 1_700_000_000_000,
            isDirectory: false,
          },
          {
            uri: 'content://tree/doc/01-intro.mp3',
            name: '01-intro.mp3',
            mime: 'audio/mpeg',
            size: 16,
            mtimeMs: 1_700_000_005_000,
            isDirectory: false,
          },
        ],
      })),
    },
    media: {
      load: vi.fn(async (p) => ({
        episodeKey: p.episodeKey,
        playing: false,
        buffering: false,
        positionMs: p.startMs,
        durationMs: 120_000,
        speed: p.speed,
      })),
      setQueue: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      seekTo: vi.fn(async () => undefined),
      setSpeed: vi.fn(async () => undefined),
      setSleepTimer: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({
        playing: false,
        buffering: false,
        positionMs: 0,
        speed: 1,
      })),
      readJournal: vi.fn(async () => {
        callOrder.push('media.readJournal');
        return journal;
      }),
      clearJournal: vi.fn(async () => {
        callOrder.push('media.clearJournal');
        journal = { completed: [] };
      }),
      ackFlush: vi.fn(async () => {
        callOrder.push('media.ackFlush');
      }),
    },
    auth: {
      isGoogleSignInAvailable: vi.fn(async () => ({ available: false })),
      googleSignIn: vi.fn(async () => ({ supported: false })),
    },
    openExternal: vi.fn(async () => undefined),
    getLaunchIntent: vi.fn(async () => null),
    addListener: vi.fn(async (eventName, cb) => {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      const fn = cb as (payload: unknown) => void;
      set.add(fn);
      return {
        remove: async () => {
          set?.delete(fn);
        },
      };
    }),
  };

  return {
    plugin,
    emitNative,
    setJournal: (j: NativeJournalSnapshot) => {
      journal = j;
    },
    safFiles,
    deletedLocalFiles,
    callOrder,
  };
}

describe('CapacitorPlatformHost', () => {
  it('reconciles native playback journal on startup and runs immediate sync + ackFlush on hidden pause', async () => {
    const harness = createTestPluginHarness();
    const idbFactory = new IDBFactory();
    const preferences = createMemoryPreferences();
    let visible = true;

    const first = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory,
      dbName: 'host-journal-test',
      preferences,
      schedulerHost: {
        now: () => Date.now(),
        setTimeout: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        setInterval: (fn, ms) => {
          const id = setInterval(fn, ms);
          return () => clearInterval(id);
        },
        isVisible: () => visible,
        isMetered: () => false,
        isOnline: () => true,
      },
    });

    // Subscribe to feed, queue ep-1 & ep-2, download ep-1, enable deleteDownloadWhenPlayed & SAF sync
    const feed = await first.host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');
    const ep2Key = deriveEpisodeKey(feed.feedKey, 'ep-2');

    await first.host.queue.add(ep1Key);
    await first.host.queue.add(ep2Key);
    await first.host.episodes.download(ep1Key);
    await first.host.settings.update({ deleteDownloadWhenPlayed: true });

    const syncUri = 'content://saf/minipod-sync-v1.json';
    await first.host.sync.configure({
      provider: { id: 'saf', documentUri: syncUri },
      wifiOnly: false,
      deviceName: 'Pixel 8',
    });

    // Simulate process death & native PlaybackService marathon while WebView was dead:
    // ep-1 completed natively, ep-2 reached 47_000 ms!
    await first.host.dispose();

    const laterMs = Date.now() + 60_000;
    harness.setJournal({
      completed: [{ episodeKey: ep1Key, durationMs: 120_000, endedWallMs: laterMs }],
      current: { episodeKey: ep2Key, positionMs: 47_000, durationMs: 180_000, wallMs: laterMs + 5_000 },
    });

    const second = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory,
      dbName: 'host-journal-test',
      preferences,
      schedulerHost: {
        now: () => Date.now(),
        setTimeout: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        setInterval: (fn, ms) => {
          const id = setInterval(fn, ms);
          return () => clearInterval(id);
        },
        isVisible: () => visible,
        isMetered: () => false,
        isOnline: () => true,
      },
    });

    // Verify journal reconciliation applied BEFORE UI queries:
    // - ep1 marked PLAYED, removed from queue, and its download deleted!
    // - ep2 updated to IN_PROGRESS @ 47_000 ms!
    // - clearJournal called after IDB commit!
    const ep1Prog = await second.host.progress.get(ep1Key);
    const ep2Prog = await second.host.progress.get(ep2Key);
    const remainingQueue = await second.host.queue.list();

    expect(ep1Prog?.state).toBe('PLAYED');
    expect(ep2Prog).toMatchObject({ state: 'IN_PROGRESS', positionMs: 47_000 });
    expect(remainingQueue.map((r) => r.episode.episodeKey)).toEqual([ep2Key]);
    expect(harness.deletedLocalFiles.length).toBe(1);
    expect(harness.plugin.media.clearJournal).toHaveBeenCalled();

    // Now test hidden pause flush inside 15s native wake lock:
    await second.engine.load({
      episodeKey: ep2Key,
      source: await second.host.playback.sourceFor(ep2Key),
      startMs: 47_000,
      speed: 1,
      metadata: { title: 'Episode Two', durationMs: 180_000 },
      mediaType: 'AUDIO',
    });
    await second.engine.play();
    harness.emitNative('media-state', {
      episodeKey: ep2Key,
      playing: true,
      buffering: false,
      positionMs: 50_000,
      durationMs: 180_000,
      speed: 1,
    });
    await second.reconcileJournal();

    // Screen turns off, user pauses via Bluetooth earbuds at 63_000 ms
    visible = false;
    harness.callOrder.length = 0;
    harness.setJournal({
      completed: [],
      current: {
        episodeKey: ep2Key,
        positionMs: 63_000,
        durationMs: 180_000,
        wallMs: laterMs + 20_000,
      },
    });
    harness.emitNative('media-state', {
      episodeKey: ep2Key,
      playing: false,
      buffering: false,
      positionMs: 63_000,
      durationMs: 180_000,
      speed: 1,
    });

    // Wait briefly for async flush chain
    await new Promise((r) => setTimeout(r, 40));

    expect(harness.callOrder).toEqual([
      'media.readJournal',
      'media.clearJournal',
      'saf.write',
      'media.ackFlush',
    ]);

    const syncedJson = JSON.parse(
      new TextDecoder().decode(harness.safFiles.get(syncUri)!.bytes),
    ) as { progress: { items: Record<string, { positionMs: number }> } };
    expect(syncedJson.progress.items[ep2Key]?.positionMs).toBe(63_000);

    await second.host.dispose();
  });

  it('scans SAF local folders, resolves embedded chapter images to data: URLs, and extracts ACTION_SEND links', async () => {
    const harness = createTestPluginHarness();
    harness.safFiles.set('content://tree/doc/folder.jpg', {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mtimeMs: 1_700_000_000_000,
    });
    harness.safFiles.set('content://tree/doc/01-intro.mp3', {
      bytes: new Uint8Array(16),
      mtimeMs: 1_700_000_005_000,
    });

    const { host, syncStore } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-saf-folder-test',
      preferences: createMemoryPreferences(),
    });

    const localFeed = await host.feeds.addLocalFolder({
      ref: 'content://tree/primary%3AAudiobooks',
      displayName: 'My Audiobooks',
    });
    expect(localFeed.kind).toBe('LOCAL');
    expect(localFeed.imageUrl).toMatch(/^data:image\/jpeg;base64,/);

    const eps = await host.episodes.list(localFeed.feedKey, 'all');
    expect(eps.items).toHaveLength(1);
    const epKey = eps.items[0]!.episode.episodeKey;

    // Seed an embedded APIC chapter slice and verify `chapterImage` returns a `data:` URL
    await syncStore.saveMergedChapters(epKey, [
      {
        startMs: 0,
        title: 'Intro',
        source: 'ID3',
        embeddedImage: { offset: 2, length: 4, mime: 'image/png' },
      },
    ]);
    const chImg = await host.episodes.chapterImage(epKey, 0);
    expect(chImg).toMatch(/^data:image\/png;base64,/);

    expect(
      extractActionSendInput('Listen to this show! https://feeds.example.com/show.xml.'),
    ).toBe('https://feeds.example.com/show.xml');

    await host.dispose();
  });

  it('checks GitHub releases via native HTTP and downloads/installs signed APKs via MiniPod bridge', async () => {
    const harness = createTestPluginHarness();
    const downloadSpy = vi.fn(async ({ version }: { url: string; version: string }) => ({
      filePath: `/data/user/0/dev.minipod.app/cache/updates/minipod-${version}.apk`,
      sizeBytes: 4_123_456,
      installerLaunched: true,
      installed: true,
      needsPermission: false,
    }));
    const installSpy = vi.fn(async ({ filePath }: { filePath: string }) => ({
      filePath,
      installerLaunched: true,
      installed: true,
      needsPermission: false,
    }));

    const wrapped = wrapNativeBridge({
      downloadAndInstallApk: downloadSpy,
      installApkFile: installSpy,
    } as unknown as MiniPodNativeBridge);
    expect(await wrapped.installApkFile!({ filePath: '/cache/updates/minipod-0.1.2.apk' })).toMatchObject({
      installerLaunched: true,
      needsPermission: false,
    });

    const pluginWithUpdater: MiniPodPlugin = {
      ...harness.plugin,
      http: vi.fn(async (req) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        finalUrl: req.url,
        chain: [],
        bodyBase64: encodeBase64(
          new TextEncoder().encode(
            JSON.stringify({
              tag_name: 'v0.1.2',
              name: 'MiniPod v0.1.2',
              body: 'Android auto-updater',
              published_at: '2026-10-30T15:00:00Z',
              html_url: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
              assets: [
                {
                  name: 'minipod-v0.1.2.apk',
                  browser_download_url:
                    'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
                  size: 4_123_456,
                },
              ],
            }),
          ),
        ),
      })),
      downloadAndInstallApk: downloadSpy,
      installApkFile: installSpy,
    };

    const { host } = await createCapacitorPlatformHost({
      plugin: pluginWithUpdater,
      appVersion: '0.1.0',
      idbFactory: new IDBFactory(),
      dbName: 'host-updater-test',
      preferences: createMemoryPreferences(),
    });

    const checkRes = await host.updater!.check();
    expect(checkRes.updateAvailable).toBe(true);
    expect(checkRes.release?.version).toBe('0.1.2');

    const applyRes = await host.updater!.apply();
    expect(applyRes.method).toBe('android-apk');
    expect(applyRes.targetVersion).toBe('0.1.2');
    expect(downloadSpy).toHaveBeenCalledWith({
      url: 'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
      version: '0.1.2',
    });

    await host.dispose();
  });

  it('normalizes blank episode imageUrl to feed imageUrl in native marathon queue sources', async () => {
    const rssWithFeedCover = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <title>Cover Pod</title>
          <itunes:image href="https://pod.example.com/feed-cover.jpg" />
          <item>
            <guid>ep-playing</guid>
            <title>Playing Ep</title>
            <enclosure url="https://pod.example.com/1.mp3" type="audio/mpeg" />
          </item>
          <item>
            <guid>ep-queued</guid>
            <title>Queued Ep</title>
            <itunes:image href="   " />
            <enclosure url="https://pod.example.com/2.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>`;

    const harness = createTestPluginHarness();
    harness.plugin.http = vi.fn(async (req) => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      finalUrl: req.url,
      chain: [],
      bodyBase64: encodeBase64(new TextEncoder().encode(rssWithFeedCover)),
    }));

    const { host, db } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      appVersion: '0.1.2',
      idbFactory: new IDBFactory(),
      dbName: 'host-artwork-fallback-test',
      preferences: createMemoryPreferences(),
    });

    const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-playing');
    const ep2Key = deriveEpisodeKey(feed.feedKey, 'ep-queued');

    // Simulate legacy empty-string imageUrl in IndexedDB record
    const existingEp2 = await db.get('episodes', ep2Key);
    expect(existingEp2?.imageUrl).toBe('https://pod.example.com/feed-cover.jpg');
    await db.put('episodes', { ...existingEp2!, imageUrl: '   ' });

    await host.queue.add(ep1Key);
    await host.queue.add(ep2Key);

    harness.emitNative('media-state', {
      episodeKey: ep1Key,
      playing: true,
      buffering: false,
      positionMs: 1_000,
      durationMs: 60_000,
      speed: 1,
    });

    const queueSources = await host.playback.queueSources();
    expect(queueSources).toHaveLength(1);
    expect(queueSources[0]?.episodeKey).toBe(ep2Key);
    expect(queueSources[0]?.metadata.artworkUrl).toBe('https://pod.example.com/feed-cover.jpg');

    await host.dispose();
  });

  it('seamlessly falls back to Google Drive SAF DocumentsProvider when googleSignIn returns a safUri on self-signed APK', async () => {
    const driveSafUri =
      'content://com.google.android.apps.docs.storage/document/acc%3D1%3Bdoc%3Dminipod-sync-v1.json';
    const harness = createTestPluginHarness();
    harness.plugin.auth.isGoogleSignInAvailable = vi.fn(async () => ({ available: true }));
    harness.plugin.auth.googleSignIn = vi.fn(async () => ({
      supported: true,
      safUri: driveSafUri,
      displayName: 'minipod-sync-v1.json',
    }));

    const { host } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-drive-saf-fallback-test',
      preferences: createMemoryPreferences(),
    });

    await host.feeds.subscribe('https://pod.example.com/rss.xml');

    await expect(host.sync.authorize('drive-appdata')).resolves.toBeUndefined();
    const status = await host.sync.configure({
      provider: { id: 'drive-appdata' },
      wifiOnly: false,
      deviceName: 'Pixel 9',
    });

    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('saf');

    const savedSettings = await host.settings.get();
    expect(savedSettings.sync.provider).toEqual({
      id: 'saf',
      documentUri: driveSafUri,
    });

    const syncedEntry = harness.safFiles.get(driveSafUri);
    expect(syncedEntry).toBeDefined();
    const syncedDoc = JSON.parse(new TextDecoder().decode(syncedEntry!.bytes)) as {
      schemaVersion: number;
      subscriptions: { items: Record<string, { url: string }> };
    };
    expect(syncedDoc.schemaVersion).toBe(1);
    expect(
      Object.values(syncedDoc.subscriptions.items).some(
        (f) => f.url === 'https://pod.example.com/rss.xml',
      ),
    ).toBe(true);

    await host.dispose();
  });

  it('persists accountHint when Google Drive OAuth authorization returns accountEmail', async () => {
    const harness = createTestPluginHarness();
    const googleSignInSpy = vi.fn(async () => ({
      supported: true,
      accessToken: 'mock-direct-android-oauth-token',
      expiresAt: Date.now() + 3600_000,
      accountEmail: 'listener@gmail.com',
    }));
    harness.plugin.auth.isGoogleSignInAvailable = vi.fn(async () => ({ available: true }));
    harness.plugin.auth.googleSignIn = googleSignInSpy;

    const origHttp = harness.plugin.http;
    harness.plugin.http = vi.fn(async (req) => {
      if (req.url.startsWith('https://www.googleapis.com/drive/v3/files')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          finalUrl: req.url,
          chain: [],
          bodyBase64: encodeBase64(new TextEncoder().encode(JSON.stringify({ files: [] }))),
        };
      }
      if (req.url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          finalUrl: req.url,
          chain: [],
          bodyBase64: encodeBase64(
            new TextEncoder().encode(
              JSON.stringify({ id: 'drive-file-1', md5Checksum: 'abc123', version: '1' }),
            ),
          ),
        };
      }
      return origHttp(req);
    });

    const { host } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-drive-oauth-hint-test',
      preferences: createMemoryPreferences(),
    });

    await expect(host.sync.authorize('drive-appdata')).resolves.toBeUndefined();
    const status = await host.sync.configure({
      provider: { id: 'drive-appdata' },
      wifiOnly: false,
      deviceName: 'Pixel 9 Pro',
    });

    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('drive-appdata');

    const savedSettings = await host.settings.get();
    expect(savedSettings.sync.provider).toEqual({
      id: 'drive-appdata',
      accountHint: 'listener@gmail.com',
    });

    await host.dispose();
  });
});
