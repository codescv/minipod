import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  episodeKey as deriveEpisodeKey,
  type HostEvent,
} from '@minipod/core';
import { createCapacitorPlatformHost, extractActionSendInput } from './capacitor-host';
import { createMemoryPreferences } from './storage/idb';
import {
  wrapNativeBridge,
  type MiniPodEventMap,
  type MiniPodNativeBridge,
  type MiniPodPlugin,
  type MiniPodHttpToFileResponse,
  type NativeDownloadSnapshotEntry,
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

const SAMPLE_RSS_4 = SAMPLE_RSS.replace(
  '</channel>',
  `<item>
      <guid>ep-3</guid>
      <title>Episode Three</title>
      <enclosure url="https://pod.example.com/ep3.mp3" type="audio/mpeg" length="1000" />
      <pubDate>Fri, 31 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <guid>ep-4</guid>
      <title>Episode Four</title>
      <enclosure url="https://pod.example.com/ep4.mp3" type="audio/mpeg" length="1000" />
      <pubDate>Sat, 01 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>`,
);

const filePathFor = (destPath: string): string => `/data/user/0/dev.minipod.app/files/${destPath}`;

/**
 * Fake native process-wide download queue (`MiniPodPlugin.java` 4daa0030): `httpToFile` stays
 * pending until the test settles it, `cancelDownload` rejects it `cancelled`, and the persisted
 * snapshot is mutable with `ackDownloadResults` dropping terminal entries.
 */
function withNativeDownloadQueue(harness: ReturnType<typeof createTestPluginHarness>, rss = SAMPLE_RSS_4) {
  const pending = new Map<
    string,
    { resolve: (res: MiniPodHttpToFileResponse) => void; reject: (err: Error) => void; destPath: string }
  >();
  let snapshot: NativeDownloadSnapshotEntry[] = [];
  harness.plugin.http = vi.fn(async (req) => ({
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
    finalUrl: req.url,
    chain: [],
    bodyBase64: encodeBase64(new TextEncoder().encode(rss)),
  }));
  harness.plugin.httpToFile = vi.fn(
    (req) =>
      new Promise<MiniPodHttpToFileResponse>((resolve, reject) => {
        pending.set(req.episodeKey, { resolve, reject, destPath: req.destPath });
      }),
  );
  harness.plugin.cancelDownload = vi.fn(async ({ episodeKey }) => {
    pending.get(episodeKey)?.reject(Object.assign(new Error('Download cancelled'), { code: 'cancelled' }));
    pending.delete(episodeKey);
  });
  harness.plugin.cancelAllDownloads = vi.fn(async () => undefined);
  harness.plugin.getDownloadSnapshot = vi.fn(async () => ({ entries: [...snapshot] }));
  harness.plugin.ackDownloadResults = vi.fn(async ({ episodeKeys }) => {
    snapshot = snapshot.filter(
      (e) => !(episodeKeys.includes(e.episodeKey) && (e.state === 'DONE' || e.state === 'FAILED')),
    );
  });
  return {
    pending,
    setSnapshot: (entries: NativeDownloadSnapshotEntry[]) => {
      snapshot = entries;
    },
    getSnapshot: () => snapshot,
    finish: (episodeKey: string) => {
      const p = pending.get(episodeKey);
      if (!p) throw new Error(`no pending native download for ${episodeKey}`);
      pending.delete(episodeKey);
      p.resolve({ path: filePathFor(p.destPath), size: 4096, mime: 'audio/mpeg' });
    },
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

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
    // Thorough cleanup: stored file (+ `.part`) and the deterministic target `.part`, ep1 only.
    expect(harness.deletedLocalFiles).toContain(
      `/data/user/0/dev.minipod.app/files/downloads/${ep1Key}.mp3`,
    );
    expect(harness.deletedLocalFiles.every((p) => p.includes(ep1Key))).toBe(true);
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
    harness.plugin.auth.googleSignIn = vi.fn(async () => {
      // Real Android `Intent.ACTION_CREATE_DOCUMENT` immediately creates a 0-byte document
      harness.safFiles.set(driveSafUri, {
        bytes: new Uint8Array(0),
        mtimeMs: Date.now(),
      });
      return {
        supported: true,
        safUri: driveSafUri,
        displayName: 'minipod-sync-v1.json',
      };
    });

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

  it('writes full local subscriptions, queue, and progress when selecting/creating a 0-byte SAF cloud file', async () => {
    const harness = createTestPluginHarness();
    const { host } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-saf-zero-byte-create-test',
      preferences: createMemoryPreferences(),
    });

    const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');
    await host.queue.add(ep1Key);
    await host.progress.save({
      episodeKey: ep1Key,
      positionMs: 42_000,
      durationMs: 120_000,
      state: 'IN_PROGRESS',
    });

    // First sync to an initial SAF file so local records become clean (`syncDirty = 0`)
    const initialUri = 'content://saf/initial-sync.json';
    harness.safFiles.set(initialUri, { bytes: new Uint8Array(0), mtimeMs: 1_760_000_000_000 });
    const firstStatus = await host.sync.configure({
      provider: { id: 'saf', documentUri: initialUri },
      wifiOnly: false,
      deviceName: 'Pixel 9',
    });
    expect(firstStatus.phase).toBe('idle');
    expect(firstStatus.lastError).toBeUndefined();

    // Now simulate picking/creating a brand-new 0-byte cloud drive SAF file (`size: 0`, `base64: ""`)
    const cloudSafUri =
      'content://com.google.android.apps.docs.storage/document/acc%3D1%3Bdoc%3Dnew-cloud-sync.json';
    harness.safFiles.set(cloudSafUri, { bytes: new Uint8Array(0), mtimeMs: 1_760_000_100_000 });

    const secondStatus = await host.sync.configure({
      provider: { id: 'saf', documentUri: cloudSafUri },
      wifiOnly: false,
      deviceName: 'Pixel 9',
    });

    expect(secondStatus.phase).toBe('idle');
    expect(secondStatus.lastError).toBeUndefined();

    const cloudBytes = harness.safFiles.get(cloudSafUri)?.bytes;
    expect(cloudBytes).toBeDefined();
    expect(cloudBytes!.byteLength).toBeGreaterThan(0);

    const exportedDoc = JSON.parse(new TextDecoder().decode(cloudBytes!)) as {
      schemaVersion: number;
      rev: number;
      subscriptions: { items: Record<string, { url: string; deleted: boolean }> };
      queue: { items: Record<string, { feedKey: string; removed: boolean }> };
      progress: { items: Record<string, { positionMs: number; state: string }> };
    };
    expect(exportedDoc.schemaVersion).toBe(1);
    expect(exportedDoc.rev).toBe(1);
    expect(exportedDoc.subscriptions.items[feed.feedKey]).toMatchObject({
      url: 'https://pod.example.com/rss.xml',
      deleted: false,
    });
    expect(exportedDoc.queue.items[ep1Key]).toMatchObject({
      feedKey: feed.feedKey,
      removed: false,
    });
    expect(exportedDoc.progress.items[ep1Key]).toMatchObject({
      positionMs: 42_000,
      state: 'IN_PROGRESS',
    });

    await host.dispose();
  });
  it('stops an in-flight download via deleteDownload: cancels natively, deletes deterministic files, and settles to NONE (never FAILED)', async () => {
    const harness = createTestPluginHarness();
    let rejectHttp: ((err: Error) => void) | null = null;
    harness.plugin.httpToFile = vi.fn(
      () =>
        new Promise<{ path: string; size: number }>((_resolve, reject) => {
          rejectHttp = reject;
        }),
    );
    harness.plugin.cancelDownload = vi.fn(async () => {
      rejectHttp?.(Object.assign(new Error('Download cancelled'), { code: 'cancelled' }));
    });

    const { host, db } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-download-cancel-test',
      preferences: createMemoryPreferences(),
    });
    const events: { episodeKey: string; state: string }[] = [];
    const unsub = host.subscribe((ev) => {
      if (ev.type === 'download-updated') events.push({ episodeKey: ev.episodeKey, state: ev.state });
    });

    const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');

    const downloadPromise = host.episodes.download(ep1Key);
    await vi.waitFor(() => {
      expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(1);
    });
    expect((await db.get('episodes', ep1Key))?.downloadState).toBe('QUEUED');

    await host.episodes.deleteDownload(ep1Key);
    await expect(downloadPromise).resolves.toBeUndefined();

    expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: ep1Key });
    expect(harness.deletedLocalFiles).toContain(`downloads/${ep1Key}.mp3`);
    expect(harness.deletedLocalFiles).toContain(`downloads/${ep1Key}.mp3.part`);
    expect((await db.get('episodes', ep1Key))?.downloadState).toBe('NONE');
    const ep1States = events.filter((e) => e.episodeKey === ep1Key).map((e) => e.state);
    expect(ep1States).not.toContain('FAILED');
    expect(ep1States[ep1States.length - 1]).toBe('NONE');

    // Late native progress for the cancelled download is ignored (no flip back to RUNNING)
    harness.emitNative('download-progress', { episodeKey: ep1Key, bytesDownloaded: 10, totalBytes: 100 });
    expect(events.filter((e) => e.episodeKey === ep1Key).at(-1)?.state).toBe('NONE');

    unsub();
    await host.dispose();
  });

  it('failed download: FAILED survives feed refresh + restart (stale QUEUED -> FAILED), % falls back to RSS enclosure length, and 继续下载 resumes to DONE', async () => {
    const harness = createTestPluginHarness();
    const idbFactory = new IDBFactory();
    const preferences = createMemoryPreferences();
    const dbName = 'host-download-resume-test';
    // Realistic RSS `<enclosure length>` (tiny values are discarded as suspicious by the parser).
    const rssWithSizes = SAMPLE_RSS.replaceAll('length="1000"', 'length="10000000"');
    harness.plugin.http = vi.fn(async (req) => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      finalUrl: req.url,
      chain: [],
      bodyBase64: encodeBase64(new TextEncoder().encode(rssWithSizes)),
    }));

    // 1st attempt: server omits Content-Length (no native `totalBytes`), then the network drops.
    harness.plugin.httpToFile = vi.fn(async (req) => {
      harness.emitNative('download-progress', { episodeKey: req.episodeKey, bytesDownloaded: 4_200_000 });
      throw Object.assign(new Error('unexpected end of stream'), { code: 'network' });
    });

    const first = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
    const events: { episodeKey: string; state: string; progress?: number }[] = [];
    const unsub = first.host.subscribe((ev) => {
      if (ev.type === 'download-updated') {
        events.push({
          episodeKey: ev.episodeKey,
          state: ev.state,
          ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
        });
      }
    });
    const feed = await first.host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');
    const ep2Key = deriveEpisodeKey(feed.feedKey, 'ep-2');

    await expect(first.host.episodes.download(ep1Key)).rejects.toMatchObject({ code: 'network' });
    // `<enclosure length="10000000">` -> 4.2 MB / 10 MB = 42%
    expect(events).toEqual([
      // Fresh download (no resumable `.part`): QUEUED starts at 0%.
      { episodeKey: ep1Key, state: 'QUEUED', progress: 0 },
      { episodeKey: ep1Key, state: 'RUNNING', progress: 0.42 },
      { episodeKey: ep1Key, state: 'FAILED' },
    ]);
    expect((await first.db.get('episodes', ep1Key))?.downloadState).toBe('FAILED');
    // A network failure never deletes the native `.part` (only an explicit stop does).
    expect(harness.plugin.cancelDownload).not.toHaveBeenCalled();
    expect(harness.deletedLocalFiles).toEqual([]);

    // Feed refresh (`upsertParsedFeed`) keeps FAILED so the 继续下载 button survives.
    await first.host.feeds.refresh(feed.feedKey);
    expect((await first.host.episodes.get(ep1Key)).episode.downloadState).toBe('FAILED');

    // ep-2's download was in flight when the process died (record stuck QUEUED).
    await first.syncStore.setEpisodeDownloadState(ep2Key, 'QUEUED');
    unsub();
    await first.host.dispose();

    // Restart: stale QUEUED -> FAILED; FAILED stays FAILED.
    const pendingHttp: { resolve?: () => void } = {};
    harness.plugin.httpToFile = vi.fn(
      (req) =>
        new Promise<{ path: string; size: number }>((resolve) => {
          pendingHttp.resolve = () =>
            resolve({ path: `/data/user/0/dev.minipod.app/files/${req.destPath}`, size: 1000 });
          // Native resumes from the kept `.part` and emits an immediate snapshot.
          harness.emitNative('download-progress', {
            episodeKey: req.episodeKey,
            bytesDownloaded: 420,
            totalBytes: 1000,
          });
          // A chunk inside the 500ms coalescing window is dropped...
          harness.emitNative('download-progress', {
            episodeKey: req.episodeKey,
            bytesDownloaded: 500,
            totalBytes: 1000,
          });
        }),
    );
    const second = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
    expect((await second.host.episodes.get(ep1Key)).episode.downloadState).toBe('FAILED');
    expect((await second.host.episodes.get(ep2Key)).episode.downloadState).toBe('FAILED');

    const events2: { state: string; progress?: number }[] = [];
    const unsub2 = second.host.subscribe((ev) => {
      if (ev.type === 'download-updated' && ev.episodeKey === ep1Key) {
        events2.push({ state: ev.state, ...(ev.progress !== undefined ? { progress: ev.progress } : {}) });
      }
    });
    const resumePromise = second.host.episodes.download(ep1Key);
    await vi.waitFor(() => {
      expect(pendingHttp.resolve).toBeDefined();
    });
    // ...but the first (resumed) snapshot is emitted right away: 42%, never 0%.
    expect(events2).toEqual([{ state: 'QUEUED' }, { state: 'RUNNING', progress: 0.42 }]);
    pendingHttp.resolve?.();
    await resumePromise;
    expect(events2.at(-1)).toEqual({ state: 'DONE', progress: 1 });
    const done = await second.host.episodes.get(ep1Key);
    expect(done.episode.downloadState).toBe('DONE');
    expect(done.episode.downloadPath).toBe(`/data/user/0/dev.minipod.app/files/downloads/${ep1Key}.mp3`);

    unsub2();
    await second.host.dispose();
  });

  it('deduplicates concurrent download(epKey) calls (double-tapped 继续下载) into a single native transfer, and a stop + resume starts a fresh one', async () => {
    const harness = createTestPluginHarness();
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    harness.plugin.httpToFile = vi.fn(
      (req) =>
        new Promise<{ path: string; size: number }>((resolve, reject) => {
          pending.push({
            resolve: () => resolve({ path: `/data/user/0/dev.minipod.app/files/${req.destPath}`, size: 1 }),
            reject,
          });
        }),
    );
    harness.plugin.cancelDownload = vi.fn(async () => {
      pending.shift()?.reject(Object.assign(new Error('Download cancelled'), { code: 'cancelled' }));
    });
    const { host, db } = await createCapacitorPlatformHost({
      plugin: harness.plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-download-dedup-test',
      preferences: createMemoryPreferences(),
    });
    const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
    const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');

    const a = host.episodes.download(ep1Key);
    const b = host.episodes.download(ep1Key);
    await vi.waitFor(() => {
      expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(1);
    });
    const c = host.episodes.download(ep1Key);
    await Promise.resolve();
    expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(1);

    // Stop, then immediately resume: the cancelled transfer settles first, then a fresh one starts.
    await host.episodes.deleteDownload(ep1Key);
    await Promise.all([a, b, c]);
    expect((await db.get('episodes', ep1Key))?.downloadState).toBe('NONE');
    const d = host.episodes.download(ep1Key);
    await vi.waitFor(() => {
      expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(2);
    });
    pending.shift()?.resolve();
    await d;
    expect((await db.get('episodes', ep1Key))?.downloadState).toBe('DONE');

    await host.dispose();
  });

  describe('native 3-slot download queue + Android 17 background reliability (4daa0030)', () => {
    function recordDownloadEvents(host: { subscribe: (cb: (ev: HostEvent) => void) => unknown }) {
      const events: { episodeKey: string; state: string; progress?: number }[] = [];
      host.subscribe((ev) => {
        if (ev.type === 'download-updated') {
          events.push({
            episodeKey: ev.episodeKey,
            state: ev.state,
            ...(ev.progress !== undefined ? { progress: ev.progress } : {}),
          });
        }
      });
      const statesOf = (key: string) => events.filter((e) => e.episodeKey === key).map((e) => e.state);
      return { events, statesOf };
    }

    it('dispatches every download to the native queue at once and drives QUEUED -> RUNNING -> DONE / FAILED / NONE from `download-state`', async () => {
      const harness = createTestPluginHarness();
      const nq = withNativeDownloadQueue(harness);
      const { host, db } = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory: new IDBFactory(),
        dbName: 'host-native-queue-states-test',
        preferences: createMemoryPreferences(),
      });
      const { events, statesOf } = recordDownloadEvents(host);
      const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
      const [k1, k2, k3, k4] = ['ep-1', 'ep-2', 'ep-3', 'ep-4'].map((id) => deriveEpisodeKey(feed.feedKey, id)) as [
        string,
        string,
        string,
        string,
      ];
      const stateOf = async (key: string) => (await db.get('episodes', key))?.downloadState;

      const ps = [k1, k2, k3, k4].map((k) => host.episodes.download(k));
      const settled = ps.map((p) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error'));
      // No JS-side gating: all 4 reach native immediately (native owns the 3 running slots).
      await vi.waitFor(() => {
        expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(4);
      });
      expect(harness.plugin.httpToFile).toHaveBeenCalledWith(
        expect.objectContaining({ episodeKey: k1, destPath: `downloads/${k1}.mp3`, title: 'Episode One' }),
      );
      // Fresh downloads may start a transfer (never `attachOnly`).
      expect(vi.mocked(harness.plugin.httpToFile).mock.calls.every(([r]) => r.attachOnly === undefined)).toBe(true);
      for (const k of [k1, k2, k3, k4]) {
        expect(await stateOf(k)).toBe('QUEUED');
        expect(events).toContainEqual({ episodeKey: k, state: 'QUEUED', progress: 0 });
      }

      // Native QUEUED echo changes nothing; slot promotion -> RUNNING (persisted + emitted).
      harness.emitNative('download-state', { episodeKey: k1, state: 'QUEUED' });
      harness.emitNative('download-state', { episodeKey: k1, state: 'RUNNING', bytesDownloaded: 0, totalBytes: 1000 });
      harness.emitNative('download-state', { episodeKey: k2, state: 'RUNNING' });
      harness.emitNative('download-state', { episodeKey: k3, state: 'RUNNING' });
      await vi.waitFor(async () => {
        expect(await stateOf(k1)).toBe('RUNNING');
        expect(await stateOf(k2)).toBe('RUNNING');
        expect(await stateOf(k3)).toBe('RUNNING');
      });
      expect(await stateOf(k4)).toBe('QUEUED');
      expect(events).toContainEqual({ episodeKey: k1, state: 'RUNNING', progress: 0 });
      // Auto-retry attempt (native backoff) stays RUNNING.
      harness.emitNative('download-state', { episodeKey: k2, state: 'RUNNING', attempt: 2, retryInMs: 2000 });

      // ep-1: native completes -> DONE with path, acked.
      nq.finish(k1);
      expect(await settled[0]).toBe('ok');
      expect(await db.get('episodes', k1)).toMatchObject({
        downloadState: 'DONE',
        downloadPath: filePathFor(`downloads/${k1}.mp3`),
      });
      expect(statesOf(k1)).toEqual(['QUEUED', 'RUNNING', 'DONE']);
      expect(harness.plugin.ackDownloadResults).toHaveBeenCalledWith({ episodeKeys: [k1] });

      // ep-2: retries exhausted -> terminal FAILED event settles the transfer as FAILED.
      harness.emitNative('download-state', {
        episodeKey: k2,
        state: 'FAILED',
        error: { code: 'network', message: 'retries exhausted' },
      });
      expect(await settled[1]).toBe('network');
      expect(await stateOf(k2)).toBe('FAILED');
      expect(statesOf(k2).at(-1)).toBe('FAILED');

      // ep-3: removed natively (notification Cancel) -> NONE, never FAILED.
      harness.emitNative('download-state', { episodeKey: k3, state: 'NONE' });
      expect(await settled[2]).toBe('ok');
      expect(await stateOf(k3)).toBe('NONE');
      expect(statesOf(k3)).not.toContain('FAILED');

      // ep-4: the `httpToFile` call was lost (WebView frozen) but the DONE event carries the path.
      harness.emitNative('download-state', {
        episodeKey: k4,
        state: 'DONE',
        path: filePathFor(`downloads/${k4}.mp3`),
        size: 4096,
      });
      expect(await settled[3]).toBe('ok');
      expect(await db.get('episodes', k4)).toMatchObject({
        downloadState: 'DONE',
        downloadPath: filePathFor(`downloads/${k4}.mp3`),
      });

      // Late events never resurrect RUNNING over DONE / NONE.
      harness.emitNative('download-state', { episodeKey: k1, state: 'RUNNING' });
      harness.emitNative('download-state', { episodeKey: k3, state: 'RUNNING' });
      await tick();
      expect(await stateOf(k1)).toBe('DONE');
      expect(await stateOf(k3)).toBe('NONE');
      expect(statesOf(k1).at(-1)).toBe('DONE');
      expect(statesOf(k3).at(-1)).toBe('NONE');

      await host.dispose();
    });

    it('cold start: native DONE while the WebView was dead -> DONE with path (not FAILED), native RUNNING stays RUNNING and is re-attached, unknown stale -> FAILED', async () => {
      const harness = createTestPluginHarness();
      const nq = withNativeDownloadQueue(harness);
      const idbFactory = new IDBFactory();
      const preferences = createMemoryPreferences();
      const dbName = 'host-native-queue-cold-start-test';
      const first = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      const feed = await first.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const [k1, k2, k3, k4] = ['ep-1', 'ep-2', 'ep-3', 'ep-4'].map((id) => deriveEpisodeKey(feed.feedKey, id)) as [
        string,
        string,
        string,
        string,
      ];
      // WebView/process killed with 4 downloads in flight.
      await first.syncStore.setEpisodeDownloadState(k1, 'RUNNING');
      await first.syncStore.setEpisodeDownloadState(k2, 'RUNNING');
      await first.syncStore.setEpisodeDownloadState(k3, 'QUEUED');
      await first.syncStore.setEpisodeDownloadState(k4, 'QUEUED');
      await first.host.dispose();

      const wall = Date.now();
      nq.setSnapshot([
        { episodeKey: k1, state: 'DONE', path: filePathFor(`downloads/${k1}.mp3`), size: 4096, updatedWallMs: wall },
        { episodeKey: k2, state: 'RUNNING', bytesDownloaded: 300, totalBytes: 1000, updatedWallMs: wall },
        { episodeKey: k4, state: 'FAILED', error: { code: 'network', message: 'retries exhausted' }, updatedWallMs: wall },
      ]);
      vi.mocked(harness.plugin.httpToFile).mockClear();

      const second = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      const { statesOf } = recordDownloadEvents(second.host);
      expect(await second.db.get('episodes', k1)).toMatchObject({
        downloadState: 'DONE',
        downloadPath: filePathFor(`downloads/${k1}.mp3`),
      });
      expect((await second.db.get('episodes', k3))?.downloadState).toBe('FAILED');
      expect((await second.db.get('episodes', k4))?.downloadState).toBe('FAILED');
      // Terminal results acked natively.
      expect(nq.getSnapshot().map((e) => e.episodeKey)).toEqual([k2]);

      // Re-attached through `httpToFile` (joins the native task) without flashing QUEUED.
      await vi.waitFor(() => {
        expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(1);
      });
      expect(harness.plugin.httpToFile).toHaveBeenCalledWith(
        expect.objectContaining({ episodeKey: k2, attachOnly: true }),
      );
      expect((await second.db.get('episodes', k2))?.downloadState).toBe('RUNNING');
      expect(statesOf(k2)).not.toContain('QUEUED');

      // Completion of the re-attached task flows into IndexedDB.
      nq.finish(k2);
      await vi.waitFor(async () => {
        expect((await second.db.get('episodes', k2))?.downloadState).toBe('DONE');
      });
      expect((await second.db.get('episodes', k2))?.downloadPath).toBe(filePathFor(`downloads/${k2}.mp3`));
      expect(statesOf(k2).at(-1)).toBe('DONE');
      await second.host.dispose();
    });

    it('attachOnly re-attach: a task lost between snapshot and re-attach (`not-found`) -> FAILED keeping the .part; one finished meanwhile settles DONE from the native journal', async () => {
      const harness = createTestPluginHarness();
      const nq = withNativeDownloadQueue(harness);
      const idbFactory = new IDBFactory();
      const preferences = createMemoryPreferences();
      const dbName = 'host-native-queue-attach-only-test';
      const first = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      const feed = await first.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const k1 = deriveEpisodeKey(feed.feedKey, 'ep-1');
      const k2 = deriveEpisodeKey(feed.feedKey, 'ep-2');
      await first.syncStore.setEpisodeDownloadState(k1, 'RUNNING');
      await first.syncStore.setEpisodeDownloadState(k2, 'QUEUED');
      await first.host.dispose();

      const wall = Date.now();
      nq.setSnapshot([
        { episodeKey: k1, state: 'RUNNING', bytesDownloaded: 10, totalBytes: 1000, updatedWallMs: wall },
        { episodeKey: k2, state: 'QUEUED', updatedWallMs: wall },
      ]);
      // Between the snapshot read and the re-attach: ep-1's task vanished natively, ep-2 finished.
      harness.plugin.httpToFile = vi.fn(async (req) => {
        if (!req.attachOnly) throw new Error('re-attach must never start a transfer');
        if (req.episodeKey === k1) {
          throw Object.assign(new Error('No native download task'), { code: 'not-found' });
        }
        return { path: filePathFor(req.destPath), size: 4096, mime: 'audio/mpeg' };
      });
      harness.deletedLocalFiles.length = 0;

      const second = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      await vi.waitFor(async () => {
        expect((await second.db.get('episodes', k1))?.downloadState).toBe('FAILED');
        expect((await second.db.get('episodes', k2))?.downloadState).toBe('DONE');
      });
      expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(2);
      expect((await second.db.get('episodes', k2))?.downloadPath).toBe(filePathFor(`downloads/${k2}.mp3`));
      // The `.part` is kept for 继续下载 (no cancel / delete).
      expect(harness.plugin.cancelDownload).not.toHaveBeenCalled();
      expect(harness.deletedLocalFiles).toEqual([]);
      await second.host.dispose();
    });

    it('falls back to today\'s stale -> FAILED boot behavior when the native snapshot throws', async () => {
      const harness = createTestPluginHarness();
      withNativeDownloadQueue(harness);
      harness.plugin.getDownloadSnapshot = vi.fn(async () => {
        throw new Error('not implemented');
      });
      const idbFactory = new IDBFactory();
      const preferences = createMemoryPreferences();
      const dbName = 'host-native-queue-snapshot-throws-test';
      const first = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      const feed = await first.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const k1 = deriveEpisodeKey(feed.feedKey, 'ep-1');
      await first.syncStore.setEpisodeDownloadState(k1, 'RUNNING');
      await first.host.dispose();
      vi.mocked(harness.plugin.httpToFile).mockClear();

      const second = await createCapacitorPlatformHost({ plugin: harness.plugin, idbFactory, dbName, preferences });
      expect((await second.db.get('episodes', k1))?.downloadState).toBe('FAILED');
      expect(harness.plugin.httpToFile).not.toHaveBeenCalled();
      await second.reconcileNativeDownloads();
      expect((await second.db.get('episodes', k1))?.downloadState).toBe('FAILED');
      await second.host.dispose();
    });

    it('foreground reconcile: routes a native DONE to the in-flight transfer, adopts RUNNING, and never resurrects a deleted download', async () => {
      const harness = createTestPluginHarness();
      const nq = withNativeDownloadQueue(harness);
      let foreground: (() => void) | null = null;
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory: new IDBFactory(),
        dbName: 'host-native-queue-foreground-test',
        preferences: createMemoryPreferences(),
        onAppLifecycle: (handlers) => {
          foreground = handlers.onForeground;
          return () => {
            foreground = null;
          };
        },
      });
      const { host, db } = bundle;
      const { events, statesOf } = recordDownloadEvents(host);
      const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
      const [k1, k2, k3] = ['ep-1', 'ep-2', 'ep-3'].map((id) => deriveEpisodeKey(feed.feedKey, id)) as [
        string,
        string,
        string,
      ];
      const p1 = host.episodes.download(k1);
      const p2 = host.episodes.download(k2);
      const p3 = host.episodes.download(k3);
      await vi.waitFor(() => {
        expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(3);
      });
      // ep-3 is stopped by the user (deleteDownload) while queued.
      await host.episodes.deleteDownload(k3);
      await p3;
      expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: k3 });
      expect((await db.get('episodes', k3))?.downloadState).toBe('NONE');

      // WebView frozen in the background: ep-1 finished natively (call result not delivered),
      // ep-2 got a slot (event missed), and a racing DONE for the stopped ep-3 was persisted.
      const wall = Date.now();
      nq.setSnapshot([
        { episodeKey: k1, state: 'DONE', path: filePathFor(`downloads/${k1}.mp3`), size: 4096, updatedWallMs: wall },
        { episodeKey: k2, state: 'RUNNING', bytesDownloaded: 500, totalBytes: 1000, updatedWallMs: wall },
        { episodeKey: k3, state: 'DONE', path: filePathFor(`downloads/${k3}.mp3`), size: 4096, updatedWallMs: wall },
      ]);
      harness.deletedLocalFiles.length = 0;
      expect(foreground).not.toBeNull();
      foreground!();
      await bundle.reconcileNativeDownloads();

      await p1;
      expect(await db.get('episodes', k1)).toMatchObject({
        downloadState: 'DONE',
        downloadPath: filePathFor(`downloads/${k1}.mp3`),
      });
      expect(statesOf(k1).filter((s) => s === 'DONE')).toHaveLength(1);
      expect((await db.get('episodes', k2))?.downloadState).toBe('RUNNING');
      expect(events).toContainEqual({ episodeKey: k2, state: 'RUNNING', progress: 0.5 });
      // Still a single native task for ep-2 (no duplicate re-attach while in flight).
      expect(vi.mocked(harness.plugin.httpToFile).mock.calls.filter(([r]) => r.episodeKey === k2)).toHaveLength(1);
      expect((await db.get('episodes', k3))?.downloadState).toBe('NONE');
      expect(harness.deletedLocalFiles).toContain(filePathFor(`downloads/${k3}.mp3`));
      expect(nq.getSnapshot().map((e) => e.episodeKey)).toEqual([k2]);

      nq.finish(k2);
      await p2;
      expect((await db.get('episodes', k2))?.downloadState).toBe('DONE');
      await host.dispose();
    });

    it('deleteDownload and played auto-delete cancel running + queued native downloads; late native results never resurrect them', async () => {
      const harness = createTestPluginHarness();
      const nq = withNativeDownloadQueue(harness);
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory: new IDBFactory(),
        dbName: 'host-native-queue-cancel-test',
        preferences: createMemoryPreferences(),
      });
      const { host, db } = bundle;
      const { statesOf } = recordDownloadEvents(host);
      const feed = await host.feeds.subscribe('https://pod.example.com/rss.xml');
      const k1 = deriveEpisodeKey(feed.feedKey, 'ep-1');
      const k2 = deriveEpisodeKey(feed.feedKey, 'ep-2');
      await host.queue.add(k2);
      const p1 = host.episodes.download(k1);
      const p2 = host.episodes.download(k2);
      await vi.waitFor(() => {
        expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(2);
      });
      harness.emitNative('download-state', { episodeKey: k1, state: 'RUNNING' });
      await vi.waitFor(async () => {
        expect((await db.get('episodes', k1))?.downloadState).toBe('RUNNING');
      });

      // RUNNING ep-1: Manage Downloads delete.
      await host.episodes.deleteDownload(k1);
      await p1;
      expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: k1 });
      expect(harness.plugin.ackDownloadResults).toHaveBeenCalledWith({ episodeKeys: [k1] });
      expect((await db.get('episodes', k1))?.downloadState).toBe('NONE');
      expect(harness.deletedLocalFiles).toEqual(
        expect.arrayContaining([`downloads/${k1}.mp3`, `downloads/${k1}.mp3.part`]),
      );

      // QUEUED ep-2: played auto-delete.
      await host.progress.save({ episodeKey: k2, positionMs: 0, state: 'PLAYED' });
      await p2;
      expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: k2 });
      expect((await db.get('episodes', k2))?.downloadState).toBe('NONE');

      // Late native transitions / snapshot results for the cancelled keys are ignored.
      harness.emitNative('download-state', { episodeKey: k1, state: 'RUNNING' });
      harness.emitNative('download-state', {
        episodeKey: k1,
        state: 'DONE',
        path: filePathFor(`downloads/${k1}.mp3`),
      });
      harness.emitNative('download-progress', { episodeKey: k2, bytesDownloaded: 10, totalBytes: 100 });
      await tick();
      expect((await db.get('episodes', k1))?.downloadState).toBe('NONE');
      expect(harness.deletedLocalFiles).toContain(filePathFor(`downloads/${k1}.mp3`));
      vi.mocked(harness.plugin.cancelDownload).mockClear();
      const wall = Date.now();
      nq.setSnapshot([
        { episodeKey: k1, state: 'DONE', path: filePathFor(`downloads/${k1}.mp3`), size: 1, updatedWallMs: wall },
        { episodeKey: k2, state: 'RUNNING', bytesDownloaded: 5, updatedWallMs: wall },
      ]);
      await bundle.reconcileNativeDownloads();
      expect((await db.get('episodes', k1))?.downloadState).toBe('NONE');
      expect((await db.get('episodes', k2))?.downloadState).toBe('NONE');
      // A native task that ignored the stop is cancelled again (not re-attached).
      expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: k2 });
      expect(harness.plugin.httpToFile).toHaveBeenCalledTimes(2);
      expect(statesOf(k1).at(-1)).toBe('NONE');
      expect(statesOf(k2).at(-1)).toBe('NONE');
      expect([...statesOf(k1), ...statesOf(k2)]).not.toContain('FAILED');
      await host.dispose();
    });
  });

  describe('Airplane Mode: downloaded audio -> background -> pause -> foreground -> Play (v0.1.21 bug)', () => {
    async function setupOfflinePlayback(dbName: string) {
      const harness = createTestPluginHarness();
      let visible = true;
      let online = true;
      let foreground: (() => void) | null = null;
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory: new IDBFactory(),
        dbName,
        preferences: createMemoryPreferences(),
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
          isOnline: () => online,
        },
        onAppLifecycle: (handlers) => {
          foreground = handlers.onForeground;
          return () => {
            foreground = null;
          };
        },
      });
      const feed = await bundle.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');
      const ep2Key = deriveEpisodeKey(feed.feedKey, 'ep-2');
      await bundle.host.queue.add(ep1Key);
      await bundle.host.queue.add(ep2Key);
      // ep-1 is downloaded (local file); ep-2 is remote-only
      await bundle.host.episodes.download(ep1Key);

      // Enter Airplane Mode and start playing the downloaded episode
      online = false;
      const source = await bundle.host.playback.sourceFor(ep1Key);
      expect(source.kind).toBe('file');
      await bundle.engine.load({
        episodeKey: ep1Key,
        source,
        startMs: 0,
        speed: 1,
        metadata: { title: 'Episode One', durationMs: 120_000 },
        mediaType: 'AUDIO',
      });
      await bundle.engine.play();
      harness.emitNative('media-state', {
        episodeKey: ep1Key,
        playing: true,
        buffering: false,
        positionMs: 41_000,
        durationMs: 120_000,
        speed: 1,
      });

      // Go to background and pause at 42 s
      visible = false;
      harness.emitNative('media-state', {
        episodeKey: ep1Key,
        playing: false,
        buffering: false,
        positionMs: 42_000,
        durationMs: 120_000,
        speed: 1,
      });
      await new Promise((r) => setTimeout(r, 20));

      return {
        harness,
        bundle,
        ep1Key,
        ep2Key,
        setVisible: (v: boolean) => {
          visible = v;
        },
        setOnline: (v: boolean) => {
          online = v;
        },
        fireForeground: () => foreground?.(),
      };
    }

    it('only hands downloaded files to the native queue while offline (no remote preloading)', async () => {
      const ctx = await setupOfflinePlayback('host-offline-queue-test');

      const offlineSources = await ctx.bundle.host.playback.queueSources();
      expect(offlineSources.every((s) => s.source.kind === 'file')).toBe(true);
      expect(offlineSources.map((s) => s.episodeKey)).not.toContain(ctx.ep2Key);

      ctx.setOnline(true);
      const onlineSources = await ctx.bundle.host.playback.queueSources();
      expect(onlineSources.map((s) => s.episodeKey)).toEqual([ctx.ep2Key]);
      expect(onlineSources[0]?.source.kind).toBe('url');

      await ctx.bundle.host.dispose();
    });

    it('keeps the paused position when the native service was stopped, and Play reloads from it', async () => {
      const ctx = await setupOfflinePlayback('host-offline-service-stopped-test');
      const { harness, bundle, ep1Key } = ctx;
      expect(bundle.engine.getSnapshot()).toMatchObject({ episodeKey: ep1Key, positionMs: 42_000, playing: false });

      // Android stops the paused PlaybackService: a fresh/empty service reports idle 0 state
      harness.emitNative('media-state', { playing: false, buffering: false, positionMs: 0, speed: 1 });
      expect(bundle.engine.getSnapshot()).toMatchObject({
        episodeKey: ep1Key,
        positionMs: 42_000,
        durationMs: 120_000,
        playing: false,
      });

      // Foreground: native getState reports nothing loaded -> still never drops to 0
      ctx.setVisible(true);
      ctx.fireForeground();
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.plugin.media.getState).toHaveBeenCalled();
      expect(bundle.engine.getSnapshot().positionMs).toBe(42_000);
      expect(bundle.engine.getSnapshot().episodeKey).toBe(ep1Key);

      // Tap Play: native play() on an empty service returns idle -> engine reloads at 42 s
      vi.mocked(harness.plugin.media.load).mockClear();
      vi.mocked(harness.plugin.media.play).mockImplementationOnce(async () => ({
        playing: false,
        buffering: false,
        positionMs: 0,
        speed: 1,
      }));
      await bundle.engine.play();

      expect(harness.plugin.media.load).toHaveBeenCalledTimes(1);
      expect(harness.plugin.media.load).toHaveBeenCalledWith(
        expect.objectContaining({
          episodeKey: ep1Key,
          startMs: 42_000,
          playWhenReady: true,
          source: expect.objectContaining({ kind: 'file' }),
        }),
      );
      expect(bundle.engine.getSnapshot()).toMatchObject({ episodeKey: ep1Key, playing: true, positionMs: 42_000 });

      await bundle.host.dispose();
    });

    it('resumes in place without reloading when the native service is still alive (or restored its saved track)', async () => {
      const ctx = await setupOfflinePlayback('host-offline-service-alive-test');
      const { harness, bundle, ep1Key } = ctx;

      vi.mocked(harness.plugin.media.getState).mockImplementation(async () => ({
        episodeKey: ep1Key,
        playing: false,
        buffering: false,
        positionMs: 42_000,
        durationMs: 120_000,
        speed: 1,
      }));
      ctx.setVisible(true);
      ctx.fireForeground();
      await new Promise((r) => setTimeout(r, 20));
      expect(bundle.engine.getSnapshot()).toMatchObject({ episodeKey: ep1Key, positionMs: 42_000 });

      vi.mocked(harness.plugin.media.load).mockClear();
      vi.mocked(harness.plugin.media.play).mockImplementationOnce(async () => ({
        episodeKey: ep1Key,
        playing: false,
        buffering: true,
        positionMs: 42_000,
        durationMs: 120_000,
        speed: 1,
      }));
      await bundle.engine.play();
      expect(harness.plugin.media.load).not.toHaveBeenCalled();
      expect(bundle.engine.getSnapshot()).toMatchObject({ episodeKey: ep1Key, playing: true, positionMs: 42_000 });

      await bundle.host.dispose();
    });

    it('reloads when native play() resolves void but getState shows no loaded episode', async () => {
      const ctx = await setupOfflinePlayback('host-offline-void-play-test');
      const { harness, bundle, ep1Key } = ctx;
      vi.mocked(harness.plugin.media.load).mockClear();
      await bundle.engine.play();
      expect(harness.plugin.media.load).toHaveBeenCalledWith(
        expect.objectContaining({ episodeKey: ep1Key, startMs: 42_000, playWhenReady: true }),
      );
      await bundle.host.dispose();
    });
  });

  it('routes v0.1.23 Agent Feedback emails with image attachments to native sendFeedbackEmail and plain ones to mailto', async () => {
    const harness = createTestPluginHarness();
    const bridgeSend = vi.fn(async () => undefined);
    const wrappedBridge = wrapNativeBridge({
      sendFeedbackEmail: bridgeSend,
    } as unknown as MiniPodNativeBridge);
    await wrappedBridge.sendFeedbackEmail!({ to: 'agent@example.com', subject: 's', body: 'b' });
    expect(bridgeSend).toHaveBeenCalledWith({ to: 'agent@example.com', subject: 's', body: 'b' });

    const sendFeedbackEmail = vi.fn(async () => undefined);
    const plugin: MiniPodPlugin = { ...harness.plugin, sendFeedbackEmail };
    const { host } = await createCapacitorPlatformHost({
      plugin,
      idbFactory: new IDBFactory(),
      dbName: 'host-feedback-email-test',
      preferences: createMemoryPreferences(),
    });

    const mailtoUrl = 'mailto:agent@example.com?subject=minipod%3A%20%5Bv0.1.23%5D%20Bug&body=Hi';
    await host.files.sendFeedbackEmail!({
      to: 'agent@example.com',
      subject: 'minipod: [v0.1.23] Bug',
      body: 'Hi\n\n---\nAttachment: shot.png',
      mailtoUrl,
      attachment: { name: 'shot.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' },
    });
    expect(sendFeedbackEmail).toHaveBeenCalledWith({
      to: 'agent@example.com',
      subject: 'minipod: [v0.1.23] Bug',
      body: 'Hi\n\n---\nAttachment: shot.png',
      attachmentBase64: 'iVBORw0KGgo=',
      attachmentName: 'shot.png',
      attachmentMimeType: 'image/png',
    });
    expect(plugin.openExternal).not.toHaveBeenCalled();

    await host.files.sendFeedbackEmail!({
      to: 'agent@example.com',
      subject: 'minipod: [v0.1.23] Bug',
      body: 'Hi',
      mailtoUrl,
    });
    expect(sendFeedbackEmail).toHaveBeenCalledTimes(1);
    expect(plugin.openExternal).toHaveBeenCalledWith({ url: mailtoUrl });

    await host.dispose();
  });
  describe('played episodes auto-delete their downloads (b1d6d66b, v0.1.24 report)', () => {
    async function setupDownloadedQueue(dbName: string, idbFactory = new IDBFactory()) {
      const harness = createTestPluginHarness();
      const preferences = createMemoryPreferences();
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory,
        dbName,
        preferences,
      });
      const feed = await bundle.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const ep1Key = deriveEpisodeKey(feed.feedKey, 'ep-1');
      const ep2Key = deriveEpisodeKey(feed.feedKey, 'ep-2');
      await bundle.host.queue.add(ep1Key);
      await bundle.host.queue.add(ep2Key);
      await bundle.host.episodes.download(ep1Key);
      return { harness, preferences, idbFactory, bundle, feedKey: feed.feedKey, ep1Key, ep2Key };
    }

    function recordEvents(bundle: { host: { subscribe: (cb: (ev: HostEvent) => void) => unknown } }) {
      const events: HostEvent[] = [];
      bundle.host.subscribe((ev) => events.push(ev));
      return events;
    }

    it('migrates a legacy pre-v0.1.14 `deleteDownloadWhenPlayed: false` (schemaVersion 1) and deletes the download when a queued episode completes', async () => {
      const ctx = await setupDownloadedQueue('host-legacy-settings-migration-test');
      const { harness, idbFactory, preferences, ep1Key, ep2Key, feedKey } = ctx;

      // Simulate the IndexedDB row persisted by a pre-v0.1.14 install (toggle since removed).
      const legacy = (await ctx.bundle.db.get('settings', 'app'))!;
      await ctx.bundle.db.put('settings', {
        key: 'app',
        value: { ...legacy.value, schemaVersion: 1, deleteDownloadWhenPlayed: false } as never,
      });
      // Even before a restart, readSettings() ignores the stale legacy `false`.
      expect((await ctx.bundle.host.settings.get()).deleteDownloadWhenPlayed).toBe(true);
      await ctx.bundle.host.dispose();

      // In-place upgrade: next launch migrates the persisted row.
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory,
        dbName: 'host-legacy-settings-migration-test',
        preferences,
      });
      const migrated = await bundle.db.get('settings', 'app');
      expect(migrated?.value).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: true });
      expect(await bundle.host.settings.get()).toMatchObject({
        schemaVersion: 2,
        deleteDownloadWhenPlayed: true,
      });

      const events = recordEvents(bundle);
      harness.deletedLocalFiles.length = 0;
      await bundle.host.progress.save({ episodeKey: ep1Key, positionMs: 0, state: 'PLAYED' });

      expect((await bundle.host.progress.get(ep1Key))?.state).toBe('PLAYED');
      expect((await bundle.host.queue.list()).map((r) => r.episode.episodeKey)).toEqual([ep2Key]);
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('NONE');
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadPath).toBeUndefined();
      expect(harness.deletedLocalFiles).toContain(
        `/data/user/0/dev.minipod.app/files/downloads/${ep1Key}.mp3`,
      );
      expect(events).toContainEqual({ type: 'download-updated', episodeKey: ep1Key, state: 'NONE', progress: 0 });
      expect(events).toContainEqual({ type: 'episodes-changed', feedKey });
      expect(events).toContainEqual({ type: 'progress-changed', episodeKey: ep1Key });
      expect(events).toContainEqual({ type: 'queue-changed' });
      // Manage Downloads (`downloaded` filter) no longer lists it.
      const downloaded = await bundle.host.episodes.list(feedKey, 'downloaded');
      expect(downloaded.items.some((r) => r.episode.episodeKey === ep1Key)).toBe(false);

      await bundle.host.dispose();
    });

    it('still honors an explicit `settings.update({ deleteDownloadWhenPlayed: false })` at schemaVersion 2 (also across restarts)', async () => {
      const ctx = await setupDownloadedQueue('host-explicit-keep-downloads-test');
      const { harness, idbFactory, preferences, ep1Key } = ctx;
      const updated = await ctx.bundle.host.settings.update({ deleteDownloadWhenPlayed: false });
      expect(updated).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: false });
      expect((await ctx.bundle.db.get('settings', 'app'))?.value).toMatchObject({
        schemaVersion: 2,
        deleteDownloadWhenPlayed: false,
      });
      await ctx.bundle.host.dispose();

      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory,
        dbName: 'host-explicit-keep-downloads-test',
        preferences,
      });
      expect((await bundle.host.settings.get()).deleteDownloadWhenPlayed).toBe(false);
      await bundle.host.progress.save({ episodeKey: ep1Key, positionMs: 0, state: 'PLAYED' });
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('DONE');
      // Queue auto-removal is independent of the download setting.
      expect((await bundle.host.queue.list()).some((r) => r.episode.episodeKey === ep1Key)).toBe(false);
      await bundle.host.dispose();
    });

    it('deletes the download and removes from queue on a PLAYED save even when the episode was already PLAYED', async () => {
      const { harness, bundle, ep1Key, ep2Key } = await setupDownloadedQueue('host-replayed-played-test');
      // Played once (download deleted), then re-queued + re-downloaded.
      await bundle.host.progress.markPlayed(ep1Key, true);
      expect((await bundle.host.progress.get(ep1Key))?.state).toBe('PLAYED');
      await bundle.host.queue.add(ep1Key);
      await bundle.host.episodes.download(ep1Key);
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('DONE');
      expect((await bundle.host.progress.get(ep1Key))?.state).toBe('PLAYED');

      const events = recordEvents(bundle);
      harness.deletedLocalFiles.length = 0;
      await bundle.host.progress.save({ episodeKey: ep1Key, positionMs: 0, state: 'PLAYED' });

      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('NONE');
      expect((await bundle.host.queue.list()).map((r) => r.episode.episodeKey)).toEqual([ep2Key]);
      expect(harness.deletedLocalFiles.length).toBeGreaterThan(0);
      expect(events).toContainEqual({ type: 'download-updated', episodeKey: ep1Key, state: 'NONE', progress: 0 });
      expect(events).toContainEqual({ type: 'progress-changed', episodeKey: ep1Key });
      await bundle.host.dispose();
    });

    it('cancels and cleans up an in-flight (non-DONE) download when the episode completes', async () => {
      const { harness, bundle, ep2Key } = await setupDownloadedQueue('host-inflight-played-test');
      // ep-2 download stuck QUEUED/RUNNING (no downloadPath yet)
      await bundle.syncStore.setEpisodeDownloadState(ep2Key, 'RUNNING');
      harness.deletedLocalFiles.length = 0;
      await bundle.host.progress.save({ episodeKey: ep2Key, positionMs: 0, state: 'PLAYED' });
      expect(harness.plugin.cancelDownload).toHaveBeenCalledWith({ episodeKey: ep2Key });
      expect(harness.deletedLocalFiles).toEqual(
        expect.arrayContaining([`downloads/${ep2Key}.mp3`, `downloads/${ep2Key}.mp3.part`]),
      );
      expect((await bundle.host.episodes.get(ep2Key)).episode.downloadState).toBe('NONE');
      await bundle.host.dispose();
    });

    it('falls back to the stored episode duration when a near-end save omits durationMs', async () => {
      const { bundle, ep1Key } = await setupDownloadedQueue('host-duration-fallback-test');
      const rec = (await bundle.db.get('episodes', ep1Key))!;
      await bundle.db.put('episodes', { ...rec, durationMs: 600_000 });
      await bundle.host.progress.save({ episodeKey: ep1Key, positionMs: 599_500, state: 'IN_PROGRESS' });
      expect((await bundle.host.progress.get(ep1Key))?.state).toBe('PLAYED');
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('NONE');
      await bundle.host.dispose();
    });

    it('reconciles the native completion journal on `media-ended` (no auto-advance): PLAYED, dequeued, download deleted, and a trailing paused media-state does not revert it', async () => {
      const { harness, bundle, ep1Key, ep2Key, feedKey } = await setupDownloadedQueue('host-native-ended-test');
      await bundle.engine.load({
        episodeKey: ep1Key,
        source: await bundle.host.playback.sourceFor(ep1Key),
        startMs: 0,
        speed: 1,
        metadata: { title: 'Episode One', durationMs: 120_000 },
        mediaType: 'AUDIO',
      });
      harness.emitNative('media-state', {
        episodeKey: ep1Key,
        playing: true,
        buffering: false,
        positionMs: 100_000,
        durationMs: 120_000,
        speed: 1,
      });
      await bundle.reconcileJournal();

      const events = recordEvents(bundle);
      const playerEvents: string[] = [];
      bundle.engine.subscribe((ev) => playerEvents.push(ev.type));

      // ExoPlayer STATE_ENDED: `appendCompletedJournal` then `media-ended`, then trailing state.
      harness.setJournal({
        completed: [{ episodeKey: ep1Key, durationMs: 120_000, endedWallMs: Date.now() + 1_000 }],
      });
      harness.emitNative('media-ended', { episodeKey: ep1Key });
      harness.emitNative('media-state', {
        episodeKey: ep1Key,
        playing: false,
        buffering: false,
        positionMs: 101_000, // stream ended well before the RSS-declared duration
        durationMs: 120_000,
        speed: 1,
      });
      await new Promise((r) => setTimeout(r, 30));
      await bundle.reconcileJournal();

      expect(playerEvents.slice(0, 2)).toEqual(['state', 'ended']);
      expect(bundle.engine.getSnapshot()).toMatchObject({ episodeKey: ep1Key, playing: false, positionMs: 0 });
      expect((await bundle.host.progress.get(ep1Key))?.state).toBe('PLAYED');
      expect((await bundle.host.queue.list()).map((r) => r.episode.episodeKey)).toEqual([ep2Key]);
      expect((await bundle.host.episodes.get(ep1Key)).episode.downloadState).toBe('NONE');
      expect(events).toContainEqual({ type: 'download-updated', episodeKey: ep1Key, state: 'NONE', progress: 0 });
      expect(events).toContainEqual({ type: 'episodes-changed', feedKey });
      await bundle.host.dispose();
    });
  });

  describe('lock-screen Rewind -10 s to 0:00 while the WebView was frozen/killed (3c52a30e)', () => {
    async function setup(dbName: string) {
      const harness = createTestPluginHarness();
      const bundle = await createCapacitorPlatformHost({
        plugin: harness.plugin,
        idbFactory: new IDBFactory(),
        dbName,
        preferences: createMemoryPreferences(),
      });
      const feed = await bundle.host.feeds.subscribe('https://pod.example.com/rss.xml');
      const epKey = deriveEpisodeKey(feed.feedKey, 'ep-1');
      await bundle.host.progress.save({ episodeKey: epKey, positionMs: 8_000, state: 'IN_PROGRESS' });
      const events: HostEvent[] = [];
      bundle.host.subscribe((ev) => events.push(ev));
      return { harness, bundle, epKey, events };
    }

    it('adopts a native `seeked` 0 checkpoint newer than the stored IN_PROGRESS position', async () => {
      const { harness, bundle, epKey, events } = await setup('host-lockscreen-rewind-zero');
      harness.setJournal({
        completed: [],
        current: { episodeKey: epKey, positionMs: 0, durationMs: 120_000, wallMs: Date.now() + 1_000, seeked: true },
      });
      await bundle.reconcileJournal();

      expect(await bundle.host.progress.get(epKey)).toMatchObject({ positionMs: 0, state: 'IN_PROGRESS' });
      expect(events).toContainEqual({ type: 'progress-changed', episodeKey: epKey });
      expect(harness.plugin.media.clearJournal).toHaveBeenCalled();
      await bundle.host.dispose();
    });

    it('still ignores an un-flagged 0 checkpoint (transient idle / service reset)', async () => {
      const { harness, bundle, epKey } = await setup('host-lockscreen-idle-zero');
      harness.setJournal({
        completed: [],
        current: { episodeKey: epKey, positionMs: 0, durationMs: 120_000, wallMs: Date.now() + 1_000 },
      });
      await bundle.reconcileJournal();

      expect(await bundle.host.progress.get(epKey)).toMatchObject({ positionMs: 8_000, state: 'IN_PROGRESS' });
      await bundle.host.dispose();
    });

    it('ignores a stale `seeked` 0 checkpoint older than the stored progress', async () => {
      const { harness, bundle, epKey } = await setup('host-lockscreen-stale-zero');
      harness.setJournal({
        completed: [],
        current: { episodeKey: epKey, positionMs: 0, wallMs: 1, seeked: true },
      });
      await bundle.reconcileJournal();

      expect(await bundle.host.progress.get(epKey)).toMatchObject({ positionMs: 8_000, state: 'IN_PROGRESS' });
      await bundle.host.dispose();
    });

    it('never lets a `seeked` 0 checkpoint undo PLAYED', async () => {
      const { harness, bundle, epKey } = await setup('host-lockscreen-played-zero');
      await bundle.host.progress.save({ episodeKey: epKey, positionMs: 0, state: 'PLAYED' });
      harness.setJournal({
        completed: [],
        current: { episodeKey: epKey, positionMs: 0, wallMs: Date.now() + 5_000, seeked: true },
      });
      await bundle.reconcileJournal();

      expect((await bundle.host.progress.get(epKey))?.state).toBe('PLAYED');
      await bundle.host.dispose();
    });
  });
});
