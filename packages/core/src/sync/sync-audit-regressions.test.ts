import { describe, expect, it } from 'vitest';
import { MiniPodError } from '../errors';
import { queueAdd, queueEnsureAtHead, queuePlayNext } from '../queue/ops';
import { stampMarkPlayed, stampProgressSave } from '../progress/ProgressRecorder';
import {
  HLC_MAX_FORWARD_SKEW_MS,
  SYNC_FILE_NAME,
  TOMBSTONE_TTL_QUEUE_MS,
  type ApplyDecisions,
  type CloudFileProvider,
  type DeviceId,
  type EpisodeKey,
  type FeedKey,
  type HostFileAccess,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type LocalSyncSnapshot,
  type QueueEntry,
  type RestampBelowFloorOptions,
  type SyncDocument,
  type SyncEntityMaps,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncState,
  type SyncStore,
  type SyncSubscription,
} from '../types';
import {
  GitHubGistProvider,
  GoogleDriveProvider,
  HostFileProvider,
  HybridLogicalClock,
  SyncEngine,
  WebDavProvider,
  createEmptySyncDocument,
  gcSyncDocument,
  md5Hex,
  mergeSyncDocuments,
  parseSyncDocument,
  pickProgress,
  pickQueueEntry,
  pickSubscription,
  serializeSyncDocument,
  validateOrderKey,
} from './index';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeResp(
  status: number,
  body: string | Uint8Array,
  headers?: Record<string, string>,
  finalUrl = 'https://example.com',
): HttpResponse {
  const bytes = typeof body === 'string' ? enc.encode(body) : body;
  const text = typeof body === 'string' ? body : dec.decode(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    lower[k.toLowerCase()] = v;
  }
  return {
    status,
    headers: lower,
    finalUrl,
    chain: [],
    bytes: async () => bytes,
    text: async () => text,
  };
}

class TestMemorySyncStore implements SyncStore {
  state: SyncState;
  subs = new Map<FeedKey, { item: SyncSubscription; dirty: boolean }>();
  queue = new Map<EpisodeKey, { item: SyncQueueEntry; dirty: boolean }>();
  progress = new Map<EpisodeKey, { item: SyncProgress; dirty: boolean }>();
  setSyncStateCalls = 0;

  constructor(deviceId: DeviceId, deviceName: string) {
    this.state = {
      deviceId,
      deviceName,
      remoteEtag: null,
      remoteFileId: null,
      remoteRev: 0,
      floors: { subscriptions: 0, queue: 0, progress: 0 },
      hlcLast: 0,
    };
  }

  async getSyncState(): Promise<SyncState> {
    return this.state;
  }

  async setSyncState(patch: Partial<SyncState>): Promise<void> {
    this.setSyncStateCalls += 1;
    const merged = { ...this.state, ...patch } as Record<string, unknown>;
    if ('lastError' in patch && patch.lastError === undefined) delete merged['lastError'];
    if ('lastPullAt' in patch && patch.lastPullAt === undefined) delete merged['lastPullAt'];
    if ('lastPushAt' in patch && patch.lastPushAt === undefined) delete merged['lastPushAt'];
    this.state = merged as unknown as SyncState;
  }

  async getDirtyCount(): Promise<number> {
    let n = 0;
    for (const v of this.subs.values()) if (v.dirty) n++;
    for (const v of this.queue.values()) if (v.dirty) n++;
    for (const v of this.progress.values()) if (v.dirty) n++;
    return n;
  }

  async loadLocalDoc(): Promise<LocalSyncSnapshot> {
    const subItems: Record<string, SyncSubscription> = {};
    const dirtySubs = new Set<FeedKey>();
    for (const [k, v] of this.subs) {
      subItems[k] = v.item;
      if (v.dirty) dirtySubs.add(k);
    }
    const qItems: Record<string, SyncQueueEntry> = {};
    const dirtyQ = new Set<EpisodeKey>();
    for (const [k, v] of this.queue) {
      qItems[k] = v.item;
      if (v.dirty) dirtyQ.add(k);
    }
    const pItems: Record<string, SyncProgress> = {};
    const dirtyP = new Set<EpisodeKey>();
    for (const [k, v] of this.progress) {
      pItems[k] = v.item;
      if (v.dirty) dirtyP.add(k);
    }
    return {
      maps: {
        subscriptions: { floor: this.state.floors.subscriptions, items: subItems },
        queue: { floor: this.state.floors.queue, items: qItems },
        progress: { floor: this.state.floors.progress, items: pItems },
      },
      device: { name: this.state.deviceName, app: 'test/1', lastSeenAt: 1_000 },
      dirty: { subscriptions: dirtySubs, queue: dirtyQ, progress: dirtyP },
    };
  }

  async restampDirtyBelowFloor(
    floors: SyncState['floors'],
    stamp: () => number,
    options?: RestampBelowFloorOptions,
  ): Promise<void> {
    const incClean = options?.includeCleanLive === true;
    for (const [k, v] of this.subs) {
      if (options?.excludeKeys?.subscriptions?.has(k)) continue;
      if (v.item.updatedAt > floors.subscriptions) continue;
      if (v.dirty || (incClean && !v.item.deleted)) {
        this.subs.set(k, {
          item: { ...v.item, updatedAt: Math.max(stamp(), floors.subscriptions + 1), deviceId: this.state.deviceId },
          dirty: true,
        });
      }
    }
    for (const [k, v] of this.queue) {
      if (options?.excludeKeys?.queue?.has(k)) continue;
      if (v.item.updatedAt > floors.queue) continue;
      if (v.dirty || (incClean && !v.item.removed)) {
        this.queue.set(k, {
          item: { ...v.item, updatedAt: Math.max(stamp(), floors.queue + 1), deviceId: this.state.deviceId },
          dirty: true,
        });
      }
    }
    for (const [k, v] of this.progress) {
      if (options?.excludeKeys?.progress?.has(k)) continue;
      if (v.item.updatedAt > floors.progress) continue;
      if (v.dirty || incClean) {
        this.progress.set(k, {
          item: { ...v.item, updatedAt: Math.max(stamp(), floors.progress + 1), deviceId: this.state.deviceId },
          dirty: true,
        });
      }
    }
  }

  async applyMerged(merged: SyncDocument): Promise<ApplyDecisions> {
    for (const [k, v] of [...this.subs.entries()]) {
      if (!merged.subscriptions.items[k] && !v.dirty) this.subs.delete(k);
    }
    for (const [k, w] of Object.entries(merged.subscriptions.items)) {
      const prev = this.subs.get(k);
      if (prev && prev.dirty && prev.item.updatedAt > w.updatedAt) continue;
      this.subs.set(k, { item: w, dirty: Boolean(prev?.dirty && prev.item.updatedAt === w.updatedAt) });
    }
    for (const [k, v] of [...this.queue.entries()]) {
      if (!merged.queue.items[k] && !v.dirty) this.queue.delete(k);
    }
    for (const [k, w] of Object.entries(merged.queue.items)) {
      const prev = this.queue.get(k);
      if (prev && prev.dirty && prev.item.updatedAt > w.updatedAt) continue;
      this.queue.set(k, { item: w, dirty: Boolean(prev?.dirty && prev.item.updatedAt === w.updatedAt) });
    }
    for (const [k, v] of [...this.progress.entries()]) {
      if (!merged.progress.items[k] && !v.dirty) this.progress.delete(k);
    }
    for (const [k, w] of Object.entries(merged.progress.items)) {
      const prev = this.progress.get(k);
      if (prev && prev.dirty && prev.item.updatedAt > w.updatedAt) continue;
      this.progress.set(k, { item: w, dirty: Boolean(prev?.dirty && prev.item.updatedAt === w.updatedAt) });
    }
    this.state = {
      ...this.state,
      floors: {
        subscriptions: Math.max(this.state.floors.subscriptions, merged.subscriptions.floor),
        queue: Math.max(this.state.floors.queue, merged.queue.floor),
        progress: Math.max(this.state.floors.progress, merged.progress.floor),
      },
    };
    return { resumeHints: [], feedsToRefresh: [] };
  }

  async markClean(pushed: SyncEntityMaps): Promise<void> {
    for (const [k, v] of this.subs) {
      if (pushed.subscriptions.items[k]?.updatedAt === v.item.updatedAt) {
        this.subs.set(k, { item: v.item, dirty: false });
      }
    }
    for (const [k, v] of this.queue) {
      if (pushed.queue.items[k]?.updatedAt === v.item.updatedAt) {
        this.queue.set(k, { item: v.item, dirty: false });
      }
    }
    for (const [k, v] of this.progress) {
      if (pushed.progress.items[k]?.updatedAt === v.item.updatedAt) {
        this.progress.set(k, { item: v.item, dirty: false });
      }
    }
  }

  async purgeBelowFloors(floors: SyncState['floors']): Promise<void> {
    for (const [k, v] of this.subs) {
      if (!v.dirty && v.item.deleted && v.item.updatedAt <= floors.subscriptions) this.subs.delete(k);
    }
    for (const [k, v] of this.queue) {
      if (!v.dirty && v.item.removed && v.item.updatedAt <= floors.queue) this.queue.delete(k);
    }
    for (const [k, v] of this.progress) {
      if (!v.dirty && v.item.state === 'PLAYED' && v.item.updatedAt <= floors.progress) this.progress.delete(k);
    }
  }
}

describe('Stage 3 sync audit regressions (@minipod/core)', () => {
  it('[SYNC-P0-04] 304 + dirty preserves remote devices (GC barrier) and restamps dirty rows below known floors', async () => {
    let remoteBytes: Uint8Array | null = null;
    let remoteEtag = 'etag-1';
    const provider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: remoteBytes !== null, etag: remoteBytes ? remoteEtag : null }),
      head: async () => (remoteBytes ? remoteEtag : null),
      read: async (ifNoneMatch) => {
        if (!remoteBytes) return { kind: 'missing' };
        if (ifNoneMatch === remoteEtag) return { kind: 'not-modified' };
        return { kind: 'blob', bytes: remoteBytes, etag: remoteEtag };
      },
      write: async (bytes) => {
        remoteBytes = bytes.slice();
        remoteEtag = `etag-${remoteEtag.length + 1}`;
        return { kind: 'ok', newEtag: remoteEtag };
      },
    };

    const now = 2_000_000_000_000;
    const oldQueueTombstoneAt = now - TOMBSTONE_TTL_QUEUE_MS - 10_000;
    // Initial remote doc contains Device A, lagging Device B, and an expired queue tombstone B has not seen
    const initialRemote: SyncDocument = {
      ...createEmptySyncDocument('d_A', now),
      rev: 5,
      devices: {
        d_A: { name: 'Desktop', app: 'test/1', lastSeenAt: now },
        d_B: { name: 'Phone', app: 'test/1', lastSeenAt: oldQueueTombstoneAt - 5_000 },
      },
      subscriptions: {
        floor: now + 10 * 24 * 3600_000, // remote sub floor 10 days ahead of A's lagging wall clock
        items: {},
      },
      queue: {
        floor: 0,
        items: {
          e_tomb: {
            feedKey: 'f_1',
            pos: 'a0',
            addedAt: 1,
            updatedAt: oldQueueTombstoneAt,
            removed: true,
            deviceId: 'd_A',
          },
        },
      },
    };
    remoteBytes = serializeSyncDocument(initialRemote);

    // Device A pulls once via blob -> caches `remoteDevices` and `floors`
    const storeA = new TestMemorySyncStore('d_A', 'Desktop');
    const hlcA = new HybridLogicalClock(0, () => now);
    const engineA = new SyncEngine({ store: storeA, provider, hlc: hlcA, backgroundSync: true, now: () => now });
    await engineA.run('manual');
    expect(Object.keys(storeA.state.remoteDevices ?? {}).sort()).toEqual(['d_A', 'd_B']);

    // Now Device A makes a local dirty subscription addition whose timestamp is below `state.floors.subscriptions`
    storeA.subs.set('f_lagging_new', {
      item: {
        url: 'https://lagging.example/rss',
        movedTo: null,
        updatedAt: now, // strictly below subscriptions.floor (now + 10d)!
        deleted: false,
        deviceId: 'd_A',
      },
      dirty: true,
    });

    // Next cycle hits 304 `not-modified` with dirtyTotal > 0 -> MUST keep `d_B` in devices, NOT GC `e_tomb`,
    // AND restamp `f_lagging_new` strictly above `floors.subscriptions`!
    const res = await engineA.run('subscriptions-changed');
    expect(res.uploaded).toBe(true);
    const uploaded = parseSyncDocument(remoteBytes!);
    expect(Object.keys(uploaded.devices).sort()).toEqual(['d_A', 'd_B']);
    expect(uploaded.queue.items['e_tomb']).toBeDefined();
    expect(uploaded.subscriptions.items['f_lagging_new']!.updatedAt).toBeGreaterThan(
      initialRemote.subscriptions.floor,
    );
  });

  it('[SYNC-P0-05] newLineage protects clean live local items below floor while not resurrecting remote tombstones or >180d same-lineage deletions', async () => {
    const now = 1_900_000_000_000;
    const subFloor = now - 5_000;
    const remoteDoc: SyncDocument = {
      ...createEmptySyncDocument('d_other', now),
      rev: 10,
      subscriptions: {
        floor: subFloor,
        items: {
          f_deleted_remote: {
            url: 'https://del.example/rss',
            updatedAt: now - 1_000,
            deleted: true,
            deviceId: 'd_other',
          },
        },
      },
    };
    let remoteBytes = serializeSyncDocument(remoteDoc);
    const provider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag: 'e1' }),
      head: async () => 'e1',
      read: async () => ({ kind: 'blob', bytes: remoteBytes, etag: 'e1' }),
      write: async (b) => {
        remoteBytes = b.slice();
        return { kind: 'ok', newEtag: 'e2' };
      },
    };

    // Case 1: First-time / switched remote (`newLineage = true`) with clean live local subscription below floor
    const storeNew = new TestMemorySyncStore('d_new', 'New Phone');
    storeNew.subs.set('f_local_live', {
      item: { url: 'https://local.example/rss', updatedAt: subFloor - 10_000, deleted: false, deviceId: 'd_new' },
      dirty: false, // clean!
    });
    storeNew.subs.set('f_deleted_remote', {
      item: { url: 'https://del.example/rss', updatedAt: subFloor - 10_000, deleted: false, deviceId: 'd_new' },
      dirty: false,
    });

    const engineNew = new SyncEngine({
      store: storeNew,
      provider,
      hlc: new HybridLogicalClock(0, () => now),
      backgroundSync: false,
      now: () => now,
    });
    const res1 = await engineNew.run('configured');
    expect(res1.uploaded).toBe(true);
    const afterNew = parseSyncDocument(remoteBytes);
    // Clean live local sub absent from remote survived & was restamped above floor
    expect(afterNew.subscriptions.items['f_local_live']?.deleted).toBe(false);
    expect(afterNew.subscriptions.items['f_local_live']!.updatedAt).toBeGreaterThan(subFloor);
    // Remote tombstone was NOT resurrected
    expect(afterNew.subscriptions.items['f_deleted_remote']?.deleted).toBe(true);

    // Case 2: Same lineage returning after >180d (pruned from `devices`, `remoteRev > 0`, `!pendingLineageReset`)
    remoteBytes = serializeSyncDocument(remoteDoc);
    const storeReturning = new TestMemorySyncStore('d_returning', 'Old Laptop');
    storeReturning.state = {
      ...storeReturning.state,
      remoteRev: 4,
      lastPullAt: now - 200 * 24 * 3600_000,
    };
    storeReturning.subs.set('f_gced_while_offline', {
      item: { url: 'https://gced.example/rss', updatedAt: 1_000, deleted: false, deviceId: 'd_returning' },
      dirty: false,
    });
    const engineRet = new SyncEngine({
      store: storeReturning,
      provider,
      hlc: new HybridLogicalClock(0, () => now),
      backgroundSync: false,
      now: () => now,
    });
    await engineRet.run('manual');
    const afterRet = parseSyncDocument(remoteBytes);
    // Clean stale item below remote floor MUST NOT resurrect on same lineage!
    expect(afterRet.subscriptions.items['f_gced_while_offline']).toBeUndefined();
  });

  it('[SYNC-P1-01] HostFileProvider fixes SAF size=0/mtime=0 deadlock, racy-git equal-length writes, strong fast-path, racy->strong upgrade, torn reads, and EPERM platform split', async () => {
    // (a) SAF stat always returns { size: 0, mtimeMs: 0 }
    let safBytes = serializeSyncDocument(createEmptySyncDocument('d_1', 100));
    const safAccess: HostFileAccess = {
      stat: async () => ({ size: 0, mtimeMs: 0 }),
      read: async () => safBytes.slice(),
      write: async (b) => {
        safBytes = b.slice();
      },
    };
    const safProvider = new HostFileProvider({ id: 'saf', access: safAccess });
    const r1 = await safProvider.read(null);
    expect(r1.kind).toBe('blob');
    if (r1.kind === 'blob') {
      expect(r1.etag).toMatch(/^v2:racy:[0-9a-f]{16}$/);
      const w1 = await safProvider.write(
        serializeSyncDocument({ ...createEmptySyncDocument('d_1', 200), rev: 2 }),
        r1.etag,
      );
      expect(w1.kind).toBe('ok');
      if (w1.kind === 'ok') {
        expect(await safProvider.read(w1.newEtag)).toEqual({ kind: 'not-modified' });
      }
    }

    // (b) Racy-git: write & equal-length external modification within same 1s mtime window
    let nowMs = 100_500;
    let fileBytes = enc.encode('{"a":1111}');
    let fileMtime = 100_000;
    let racyReadCalls = 0;
    const racyAccess: HostFileAccess = {
      stat: async () => ({ size: fileBytes.byteLength, mtimeMs: fileMtime }),
      read: async () => {
        racyReadCalls += 1;
        return fileBytes.slice();
      },
      write: async (b) => {
        fileBytes = b.slice();
        fileMtime = nowMs;
      },
    };
    const racyProvider = new HostFileProvider({ id: 'local-folder', access: racyAccess, now: () => nowMs });
    const racyRead1 = await racyProvider.read(null);
    expect(racyRead1.kind).toBe('blob');
    const etagRacy = racyRead1.kind === 'blob' ? racyRead1.etag : null;
    expect(etagRacy).toMatch(/^v2:racy:/);

    // Same-length external overwrite at identical mtimeMs=100_000, even 10 seconds later!
    fileBytes = enc.encode('{"a":2222}');
    nowMs += 10_000;
    const racyRead2 = await racyProvider.read(etagRacy);
    expect(racyRead2.kind).toBe('blob');
    if (racyRead2.kind === 'blob') {
      expect(dec.decode(racyRead2.bytes)).toBe('{"a":2222}');
      // Now `nowMs - fileMtime = 10_500 >= 2_000`, so `racyRead2.etag` is strong!
      expect(racyRead2.etag).toMatch(/^v2:100000:10:[0-9a-f]{16}$/);
      // Strong stat fast path MUST return not-modified with ZERO `access.read()` calls!
      const readsBeforeFastPath = racyReadCalls;
      const fast304 = await racyProvider.read(racyRead2.etag);
      expect(fast304).toEqual({ kind: 'not-modified' });
      expect(racyReadCalls).toBe(readsBeforeFastPath);
    }
    const racyWriteConflict = await racyProvider.write(enc.encode('{"a":3333}'), etagRacy);
    expect(racyWriteConflict.kind).toBe('conflict');

    // (b2) Racy-to-strong ETag upgrade after our own write via SyncEngine (S7)
    let engineNow = 200_000;
    let engineFileBytes: Uint8Array | null = null;
    let engineFileMtime = 0;
    let engineAccessReads = 0;
    const engineAccess: HostFileAccess = {
      stat: async () =>
        engineFileBytes ? { size: engineFileBytes.byteLength, mtimeMs: engineFileMtime } : null,
      read: async () => {
        engineAccessReads += 1;
        return engineFileBytes!.slice();
      },
      write: async (b) => {
        engineFileBytes = b.slice();
        engineFileMtime = engineNow;
      },
    };
    const upgProvider = new HostFileProvider({
      id: 'local-folder',
      access: engineAccess,
      now: () => engineNow,
    });
    const upgStore = new TestMemorySyncStore('d_upg', 'Desktop');
    const upgEngine = new SyncEngine({
      store: upgStore,
      provider: upgProvider,
      hlc: new HybridLogicalClock(0, () => engineNow),
      backgroundSync: true,
      now: () => engineNow,
    });
    // Initial write creates a racy ETag (mtime === now)
    await upgEngine.run('manual');
    expect(upgStore.state.remoteEtag).toMatch(/^v2:racy:/);

    // Advance >= 2s: next read returns `not-modified` with upgraded strong ETag and engine persists it
    engineNow += 5_000;
    await upgEngine.run('periodic');
    expect(upgStore.state.remoteEtag).toMatch(/^v2:200000:\d+:[0-9a-f]{16}$/);

    // Subsequent periodic cycle hits strong stat fast-path with ZERO `access.read()` calls!
    const readsAfterUpgrade = engineAccessReads;
    await upgEngine.run('periodic');
    expect(engineAccessReads).toBe(readsAfterUpgrade);

    // (c) Torn read retries when stat changes mid-read
    let readCall = 0;
    let statCall = 0;
    const tornAccess: HostFileAccess = {
      stat: async () => {
        statCall += 1;
        // stat 1 (initial): mtime 1000; stat 2 (post-read 1): mtime 2000 (mismatch -> retry!)
        // stat 3 (pre-read 2): mtime 2000; stat 4 (post-read 2): mtime 2000 (consistent!)
        return statCall === 1 ? { size: 10, mtimeMs: 1000 } : { size: 10, mtimeMs: 2000 };
      },
      read: async () => {
        readCall += 1;
        return enc.encode(readCall === 1 ? '{"v":1111}' : '{"v":2222}');
      },
      write: async () => undefined,
    };
    const tornProvider = new HostFileProvider({ id: 'local-folder', access: tornAccess, now: () => 50_000 });
    const tornRes = await tornProvider.read(null);
    expect(tornRes.kind).toBe('blob');
    expect(readCall).toBe(2);
    if (tornRes.kind === 'blob') {
      expect(dec.decode(tornRes.bytes)).toBe('{"v":2222}');
      expect(tornRes.etag).toContain('v2:2000:10:');
    }

    // (d) Torn read exhaustion across all 3 attempts throws retryable `network` (S6)
    let exhaustTick = 0;
    const alwaysTornAccess: HostFileAccess = {
      stat: async () => ({ size: 10, mtimeMs: 1000 + ++exhaustTick * 1000 }),
      read: async () => enc.encode('{"v":1111}'),
      write: async () => undefined,
    };
    const alwaysTornProvider = new HostFileProvider({
      id: 'local-folder',
      access: alwaysTornAccess,
      now: () => 100_000,
    });
    await expect(alwaysTornProvider.read(null)).rejects.toMatchObject({ code: 'network' });

    // (e) EPERM is non-retryable `sync-auth` on macOS (TCC), retryable on win32
    const epermErr = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const epermAccess: HostFileAccess = {
      stat: async () => {
        throw epermErr;
      },
      read: async () => {
        throw epermErr;
      },
      write: async () => {
        throw epermErr;
      },
    };
    const macProv = new HostFileProvider({ id: 'local-folder', access: epermAccess, platform: 'darwin' });
    await expect(macProv.read(null)).rejects.toMatchObject({ code: 'sync-auth' });
    expect((await macProv.write(enc.encode('{}'), null))).toMatchObject({ kind: 'failed', retryable: false });

    const winProv = new HostFileProvider({ id: 'local-folder', access: epermAccess, platform: 'win32' });
    await expect(winProv.read(null)).rejects.toMatchObject({ code: 'network' });
    expect((await winProv.write(enc.encode('{}'), null))).toMatchObject({ kind: 'failed', retryable: true });
  });

  it('[SYNC-P1-02 & SYNC-P1-09 & SYNC-P1-14] GoogleDriveProvider aborts duplicate healing safely, trashes duplicates, heals drive-file folders & POST->relist, handles missing md5, and splits 403 rate-limit vs auth', async () => {
    const docA: SyncDocument = {
      ...createEmptySyncDocument('d_a', 100),
      subscriptions: {
        floor: 0,
        items: { f_a: { url: 'https://a.example/rss', updatedAt: 100, deleted: false, deviceId: 'd_a' } },
      },
    };
    const docB: SyncDocument = {
      ...createEmptySyncDocument('d_b', 200),
      subscriptions: {
        floor: 0,
        items: { f_b: { url: 'https://b.example/rss', updatedAt: 200, deleted: false, deviceId: 'd_b' } },
      },
    };
    const docV1 = serializeSyncDocument(docA);
    const docV1B = serializeSyncDocument(docB);
    const docV2 = enc.encode(JSON.stringify({ ...createEmptySyncDocument('d_b', 200), schemaVersion: 2 }));

    // (a) newerSchemaVersion duplicate -> throws sync-schema with ZERO DELETE/trash calls
    let deleteOrTrashCount = 0;
    const httpNewerSchema: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE' || (req.method === 'PATCH' && !u.pathname.includes('/upload/'))) {
        deleteOrTrashCount += 1;
        return makeResp(200, '{}');
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [{ id: 'f_1', name: SYNC_FILE_NAME }, { id: 'f_2', name: SYNC_FILE_NAME }] }));
      }
      if (u.pathname.endsWith('/f_1')) return makeResp(200, docV1);
      if (u.pathname.endsWith('/f_2')) return makeResp(200, docV2);
      return makeResp(404, '');
    };
    const driveSchema = new GoogleDriveProvider({ mode: 'appdata', http: httpNewerSchema, getToken: async () => 'tok' });
    await expect(driveSchema.read(null)).rejects.toMatchObject({ code: 'sync-schema' });
    expect(deleteOrTrashCount).toBe(0);

    // (a2) Duplicate download 503 -> throws network with ZERO DELETE/trash calls
    deleteOrTrashCount = 0;
    const httpDl503: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE' || (req.method === 'PATCH' && !u.pathname.includes('/upload/'))) {
        deleteOrTrashCount += 1;
        return makeResp(200, '{}');
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [{ id: 'f_1', name: SYNC_FILE_NAME }, { id: 'f_2', name: SYNC_FILE_NAME }] }));
      }
      if (u.pathname.endsWith('/f_1')) return makeResp(200, docV1);
      if (u.pathname.endsWith('/f_2')) return makeResp(503, 'Service Unavailable');
      return makeResp(404, '');
    };
    const driveDl503 = new GoogleDriveProvider({ mode: 'appdata', http: httpDl503, getToken: async () => 'tok' });
    await expect(driveDl503.read(null)).rejects.toMatchObject({ code: 'network' });
    expect(deleteOrTrashCount).toBe(0);

    // (b) Survivor PATCH returns 500 with distinct docs -> throws network with ZERO DELETE/trash calls
    deleteOrTrashCount = 0;
    const httpPatchFail: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE' || (req.method === 'PATCH' && !u.pathname.includes('/upload/'))) {
        deleteOrTrashCount += 1;
        return makeResp(200, '{}');
      }
      if (req.method === 'PATCH') return makeResp(500, 'Internal Error');
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [{ id: 'f_1', name: SYNC_FILE_NAME }, { id: 'f_2', name: SYNC_FILE_NAME }] }));
      }
      if (u.pathname.endsWith('/f_1')) return makeResp(200, docV1);
      if (u.pathname.endsWith('/f_2')) return makeResp(200, docV1B);
      return makeResp(404, '');
    };
    const drivePatchFail = new GoogleDriveProvider({ mode: 'appdata', http: httpPatchFail, getToken: async () => 'tok' });
    await expect(drivePatchFail.read(null)).rejects.toMatchObject({ code: 'network' });
    expect(deleteOrTrashCount).toBe(0);

    // (b2) Unparseable non-survivor dup is kept untouched AND survivor is NOT needlessly re-PATCHed
    let uploadPatchCount = 0;
    deleteOrTrashCount = 0;
    const httpCorruptDup: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE' || (req.method === 'PATCH' && !u.pathname.includes('/upload/'))) {
        deleteOrTrashCount += 1;
        return makeResp(200, '{}');
      }
      if (req.method === 'PATCH' && u.pathname.includes('/upload/')) {
        uploadPatchCount += 1;
        return makeResp(200, JSON.stringify({ id: 'f_1', md5Checksum: md5Hex(dec.decode(docV1)) }));
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [{ id: 'f_1', name: SYNC_FILE_NAME, md5Checksum: md5Hex(dec.decode(docV1)) }, { id: 'f_2', name: SYNC_FILE_NAME }] }));
      }
      if (u.pathname.endsWith('/f_1')) return makeResp(200, docV1);
      if (u.pathname.endsWith('/f_2')) return makeResp(200, '{corrupt json');
      return makeResp(404, '');
    };
    const driveCorruptDup = new GoogleDriveProvider({ mode: 'appdata', http: httpCorruptDup, getToken: async () => 'tok' });
    const corruptRes = await driveCorruptDup.read(null);
    expect(corruptRes.kind).toBe('blob');
    expect(deleteOrTrashCount).toBe(0);
    expect(uploadPatchCount).toBe(0);

    // (c) Cached `initialFileId = 'f_2'` lists on first session call, heals to `'f_1'`, trashes `'f_2'`,
    // AND re-lists again after 24h!
    let nowDrive = 1_000_000;
    let listCalls = 0;
    const trashedIds: string[] = [];
    let hardDeletes = 0;
    let survivorBytes = docV1;
    let hasDupF2 = true;
    const httpSplitBrain: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE') {
        hardDeletes += 1;
        return makeResp(204, '');
      }
      if (req.method === 'PATCH' && !u.pathname.includes('/upload/')) {
        const id = u.pathname.split('/').pop()!;
        trashedIds.push(id);
        if (id === 'f_2') hasDupF2 = false;
        return makeResp(200, JSON.stringify({ id, trashed: true }));
      }
      if (req.method === 'PATCH' && u.pathname.includes('/upload/')) {
        survivorBytes = req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body));
        return makeResp(200, JSON.stringify({ id: 'f_1', md5Checksum: md5Hex(dec.decode(survivorBytes)) }));
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        listCalls += 1;
        const files = hasDupF2
          ? [{ id: 'f_1', name: SYNC_FILE_NAME, md5Checksum: md5Hex(dec.decode(survivorBytes)) }, { id: 'f_2', name: SYNC_FILE_NAME }]
          : [{ id: 'f_1', name: SYNC_FILE_NAME, md5Checksum: md5Hex(dec.decode(survivorBytes)) }];
        return makeResp(200, JSON.stringify({ files }));
      }
      if (u.pathname.endsWith('/f_1')) {
        if (u.searchParams.get('alt') === 'media') return makeResp(200, survivorBytes);
        return makeResp(200, JSON.stringify({ id: 'f_1', name: SYNC_FILE_NAME, md5Checksum: md5Hex(dec.decode(survivorBytes)) }));
      }
      if (u.pathname.endsWith('/f_2')) return makeResp(200, docV1B);
      return makeResp(404, '');
    };
    const driveSplit = new GoogleDriveProvider({
      mode: 'appdata',
      initialFileId: 'f_2',
      http: httpSplitBrain,
      getToken: async () => 'tok',
      now: () => nowDrive,
    });
    const healed = await driveSplit.read(null);
    expect(healed.kind).toBe('blob');
    expect(driveSplit.getFileId()).toBe('f_1');
    expect(trashedIds).toEqual(['f_2']);
    expect(hardDeletes).toBe(0);
    expect(listCalls).toBe(1);

    // Within 24h: uses direct GET by cached fileId (no list call)
    nowDrive += 12 * 3600_000;
    await driveSplit.head();
    expect(listCalls).toBe(1);

    // After 24h: re-lists automatically
    nowDrive += 13 * 3600_000;
    await driveSplit.head();
    expect(listCalls).toBe(2);

    // (c2) drive-file duplicate-folder merge: merges files across two `MiniPod` folders and TRASHES
    // (never DELETEs) duplicate file & empty duplicate folder (S8)
    const dfFiles = new Map<string, { id: string; parents: string[]; bytes: Uint8Array; isFolder?: boolean }>([
      ['folder_1', { id: 'folder_1', parents: [], bytes: new Uint8Array(0), isFolder: true }],
      ['folder_2', { id: 'folder_2', parents: [], bytes: new Uint8Array(0), isFolder: true }],
      ['file_1', { id: 'file_1', parents: ['folder_1'], bytes: docV1 }],
      ['file_2', { id: 'file_2', parents: ['folder_2'], bytes: docV1B }],
    ]);
    const dfTrashed: string[] = [];
    let dfHardDeletes = 0;
    const httpDriveFile: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'DELETE') {
        dfHardDeletes += 1;
        return makeResp(204, '');
      }
      if (req.method === 'PATCH' && !u.pathname.includes('/upload/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop()!);
        dfTrashed.push(id);
        dfFiles.delete(id);
        return makeResp(200, JSON.stringify({ id, trashed: true }));
      }
      if (req.method === 'PATCH' && u.pathname.includes('/upload/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop()!);
        const cur = dfFiles.get(id)!;
        const b = req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body));
        dfFiles.set(id, { ...cur, bytes: b });
        return makeResp(200, JSON.stringify({ id, md5Checksum: md5Hex(dec.decode(b)), parents: cur.parents }));
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        const q = u.searchParams.get('q') ?? '';
        if (q.includes('application/vnd.google-apps.folder')) {
          const folders = [...dfFiles.values()].filter((f) => f.isFolder).map((f) => ({ id: f.id, name: 'MiniPod' }));
          return makeResp(200, JSON.stringify({ files: folders }));
        }
        if (q.includes("'folder_2' in parents") && !q.includes(' or ')) {
          const kids = [...dfFiles.values()].filter((f) => f.parents.includes('folder_2')).map((f) => ({ id: f.id }));
          return makeResp(200, JSON.stringify({ files: kids }));
        }
        const syncFiles = [...dfFiles.values()]
          .filter((f) => !f.isFolder)
          .map((f) => ({ id: f.id, name: SYNC_FILE_NAME, md5Checksum: md5Hex(dec.decode(f.bytes)), parents: f.parents }));
        return makeResp(200, JSON.stringify({ files: syncFiles }));
      }
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const hit = dfFiles.get(id);
      if (!hit) return makeResp(404, '');
      if (u.searchParams.get('alt') === 'media') return makeResp(200, hit.bytes);
      return makeResp(200, JSON.stringify({ id: hit.id, md5Checksum: md5Hex(dec.decode(hit.bytes)), parents: hit.parents }));
    };
    const driveFileProv = new GoogleDriveProvider({ mode: 'file', http: httpDriveFile, getToken: async () => 'tok' });
    const dfRead = await driveFileProv.read(null);
    expect(dfRead.kind).toBe('blob');
    expect(dfHardDeletes).toBe(0);
    expect(dfTrashed.sort()).toEqual(['file_2', 'folder_2']);
    if (dfRead.kind === 'blob') {
      const mergedDoc = parseSyncDocument(dfRead.bytes);
      expect(Object.keys(mergedDoc.subscriptions.items).sort()).toEqual(['f_a', 'f_b']);
    }

    // (c3) B2 regression: POST->relist detects concurrent first-time creation, merges into survivor,
    // and returns `newEtag: null` so the next SyncEngine cycle pulls the other device's entities!
    const concurrentFiles = new Map<string, { id: string; bytes: Uint8Array }>();
    let listAttempt = 0;
    const httpConcurrentCreate: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (req.method === 'POST' && u.pathname.includes('/upload/')) {
        // Device B raced and already created `file_a` right before our POST created `file_b`!
        concurrentFiles.set('file_a', { id: 'file_a', bytes: docV1 });
        concurrentFiles.set('file_b', { id: 'file_b', bytes: docV1B });
        return makeResp(200, JSON.stringify({ id: 'file_b', md5Checksum: md5Hex(dec.decode(docV1B)) }));
      }
      if (req.method === 'PATCH' && u.pathname.includes('/upload/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop()!);
        const b = req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body));
        concurrentFiles.set(id, { id, bytes: b });
        return makeResp(200, JSON.stringify({ id, md5Checksum: md5Hex(dec.decode(b)) }));
      }
      if (req.method === 'PATCH' && !u.pathname.includes('/upload/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop()!);
        concurrentFiles.delete(id);
        return makeResp(200, JSON.stringify({ id, trashed: true }));
      }
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        listAttempt += 1;
        if (listAttempt === 1) {
          // Pre-write check sees missing
          return makeResp(200, JSON.stringify({ files: [] }));
        }
        const files = [...concurrentFiles.values()].map((f) => ({
          id: f.id,
          name: SYNC_FILE_NAME,
          md5Checksum: md5Hex(dec.decode(f.bytes)),
        }));
        return makeResp(200, JSON.stringify({ files }));
      }
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const hit = concurrentFiles.get(id);
      if (!hit) return makeResp(404, '');
      if (u.searchParams.get('alt') === 'media') return makeResp(200, hit.bytes);
      return makeResp(200, JSON.stringify({ id: hit.id, md5Checksum: md5Hex(dec.decode(hit.bytes)) }));
    };
    const driveB2 = new GoogleDriveProvider({ mode: 'appdata', http: httpConcurrentCreate, getToken: async () => 'tok' });
    const wB2 = await driveB2.write(docV1B, null);
    expect(wB2).toEqual({ kind: 'ok', newEtag: null });
    // Because `newEtag` is `null`, the next `read(null)` pulls the merged doc containing `f_a`!
    const rAfterB2 = await driveB2.read(null);
    expect(rAfterB2.kind).toBe('blob');
    if (rAfterB2.kind === 'blob') {
      expect(Object.keys(parseSyncDocument(rAfterB2.bytes).subscriptions.items).sort()).toEqual(['f_a', 'f_b']);
    }

    // (d) Missing `md5Checksum` falls back to `${id}:${version}` so changes & conflicts are still detected
    let fileVer = '1';
    let verBytes = docV1;
    const httpNoMd5: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [{ id: 'f_nomd5', name: SYNC_FILE_NAME, version: fileVer }] }));
      }
      if (u.pathname.endsWith('/f_nomd5')) {
        if (u.searchParams.get('alt') === 'media') return makeResp(200, verBytes);
        return makeResp(200, JSON.stringify({ id: 'f_nomd5', name: SYNC_FILE_NAME, version: fileVer }));
      }
      return makeResp(404, '');
    };
    const driveNoMd5 = new GoogleDriveProvider({ mode: 'appdata', http: httpNoMd5, getToken: async () => 'tok' });
    const nm1 = await driveNoMd5.read(null);
    expect(nm1.kind).toBe('blob');
    const nmEtag1 = nm1.kind === 'blob' ? nm1.etag : null;
    expect(nmEtag1).toBe('f_nomd5:1');
    fileVer = '2';
    verBytes = docV1B;
    const nm2 = await driveNoMd5.read(nmEtag1);
    expect(nm2.kind).toBe('blob');
    expect(await driveNoMd5.write(docV1, nmEtag1)).toEqual({ kind: 'conflict' });

    // (e) 403 rateLimitExceeded -> retryable `network`; non-rate-limit 403 -> non-retryable `sync-auth` (read + write)
    const httpRateLimit: HttpClient = async () =>
      makeResp(403, JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }));
    const driveRate = new GoogleDriveProvider({ mode: 'appdata', http: httpRateLimit, getToken: async () => 'tok' });
    await expect(driveRate.read(null)).rejects.toMatchObject({ code: 'network' });

    const httpAuth403: HttpClient = async (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
        return makeResp(200, JSON.stringify({ files: [] }));
      }
      return makeResp(403, JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }));
    };
    const driveAuth403Read = new GoogleDriveProvider({
      mode: 'appdata',
      http: async () => makeResp(403, JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } })),
      getToken: async () => 'tok',
    });
    await expect(driveAuth403Read.read(null)).rejects.toMatchObject({ code: 'sync-auth' });
    const driveAuth403Write = new GoogleDriveProvider({ mode: 'appdata', http: httpAuth403, getToken: async () => 'tok' });
    const w403 = await driveAuth403Write.write(docV1, null);
    expect(w403.kind).toBe('failed');
    if (w403.kind === 'failed') {
      expect(w403.retryable).toBe(false);
      expect(MiniPodError.wrap(w403.cause, 'network').code).toBe('sync-auth');
    }
  });

  it('[SYNC-P1-04] expired dirty tombstone folded into floor by GC is marked clean and purged on first upload', async () => {
    const now = 2_000_000_000_000;
    const oldTombAt = now - TOMBSTONE_TTL_QUEUE_MS - 60_000;
    let remoteBytes: Uint8Array | null = null;
    let etag = 'e0';
    const provider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: remoteBytes !== null, etag: remoteBytes ? etag : null }),
      head: async () => (remoteBytes ? etag : null),
      read: async (m) => {
        if (!remoteBytes) return { kind: 'missing' };
        if (m === etag) return { kind: 'not-modified' };
        return { kind: 'blob', bytes: remoteBytes, etag };
      },
      write: async (b) => {
        remoteBytes = b.slice();
        etag = `e${etag.length + 1}`;
        return { kind: 'ok', newEtag: etag };
      },
    };

    const store = new TestMemorySyncStore('d_1', 'Desktop');
    store.queue.set('e_old', {
      item: { feedKey: 'f_1', pos: 'a0', addedAt: 1, updatedAt: oldTombAt, removed: true, deviceId: 'd_1' },
      dirty: true,
    });
    const engine = new SyncEngine({
      store,
      provider,
      hlc: new HybridLogicalClock(0, () => now),
      backgroundSync: true,
      now: () => now,
    });

    const r1 = await engine.run('manual');
    expect(r1.uploaded).toBe(true);
    expect(await store.getDirtyCount()).toBe(0);
    expect(store.queue.has('e_old')).toBe(false);

    const r2 = await engine.run('periodic');
    expect(r2.uploaded).toBe(false);
  });

  it('[SYNC-P1-08 & SYNC-P2-03] pickProgress/pickQueueEntry are key-order independent and pickSubscription movedTo is associative', () => {
    const p1 = {
      feedKey: 'f_1',
      positionMs: 1000,
      state: 'IN_PROGRESS' as const,
      playedAt: null,
      updatedAt: 500,
      deviceId: 'd_1',
      durationMs: 60_000,
    };
    const p2 = {
      updatedAt: 500,
      deviceId: 'd_1',
      durationMs: 60_000,
      feedKey: 'f_1',
      playedAt: null,
      positionMs: 1000,
      state: 'IN_PROGRESS' as const,
    };
    expect(pickProgress(p1, p2)).toEqual(pickProgress(p2, p1));

    const q1: SyncQueueEntry = {
      feedKey: 'f_1',
      pos: 'a0',
      addedAt: 10,
      updatedAt: 500,
      removed: false,
      deviceId: 'd_1',
      stub: { identity: 'id1', title: 'T', feedUrl: 'https://x' },
    };
    const q2: SyncQueueEntry = {
      deviceId: 'd_1',
      removed: false,
      updatedAt: 500,
      addedAt: 10,
      pos: 'a0',
      feedKey: 'f_1',
      stub: { feedUrl: 'https://x', title: 'T', identity: 'id1' },
    };
    expect(pickQueueEntry(q1, q2)).toEqual(pickQueueEntry(q2, q1));

    // 3-way equal-HLC movedTo associativity
    const subA: SyncSubscription = { url: 'https://orig', movedTo: null, updatedAt: 100, deleted: false, deviceId: 'd_1' };
    const subB: SyncSubscription = { url: 'https://orig', movedTo: 'https://b', updatedAt: 100, deleted: false, deviceId: 'd_2' };
    const subC: SyncSubscription = { url: 'https://orig', movedTo: 'https://c', updatedAt: 100, deleted: false, deviceId: 'd_3' };
    expect(pickSubscription(pickSubscription(subA, subB), subC)).toEqual(
      pickSubscription(subA, pickSubscription(subB, subC)),
    );
    expect(pickSubscription(pickSubscription(subA, subB), subC).movedTo).toBe('https://b');
  });

  it('[SYNC-P1-10 & SYNC-P2-02] setProvider+drainActiveCycle isolates stale in-flight cycle and run() coalesces without abort cross-kill', async () => {
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((r) => {
      releaseRead = r;
    });
    let resolveBlockedRead!: () => void;
    const blockedRead = new Promise<void>((r) => {
      resolveBlockedRead = r;
    });

    const slowProvider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag: 'e1' }),
      head: async () => 'e1',
      read: async () => {
        releaseRead();
        await blockedRead;
        return { kind: 'blob', bytes: serializeSyncDocument(createEmptySyncDocument('d_old', 100)), etag: 'e_stale' };
      },
      write: async () => ({ kind: 'ok', newEtag: 'e_stale2' }),
    };

    const store = new TestMemorySyncStore('d_self', 'Desktop');
    const engine = new SyncEngine({
      store,
      provider: slowProvider,
      hlc: new HybridLogicalClock(0, () => 10_000),
      backgroundSync: true,
      now: () => 10_000,
    });

    const cyclePromise = engine.run('manual');
    await readStarted;

    // Disconnect / switch provider while read is in flight
    engine.setProvider(null);
    resolveBlockedRead();
    await engine.drainActiveCycle();
    await cyclePromise;

    // Stale read MUST NOT write `remoteEtag: 'e_stale'` into store!
    expect(store.state.remoteEtag).toBeNull();
    expect(store.setSyncStateCalls).toBe(0);

    // Caller 1 aborts while Caller 2 queues a rerun -> Caller 2's rerun MUST still execute!
    let reads = 0;
    const rerunProvider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: false, etag: null }),
      head: async () => null,
      read: async (_m, sig) => {
        reads += 1;
        if (reads === 1) {
          await new Promise<void>((resolve) => {
            sig?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new MiniPodError('cancelled', 'aborted');
        }
        return { kind: 'missing' };
      },
      write: async () => ({ kind: 'ok', newEtag: 'e_ok' }),
    };
    engine.setProvider(rerunProvider);
    const ac1 = new AbortController();
    const p1 = engine.run('manual', { signal: ac1.signal });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = engine.run('manual'); // no abort signal!
    ac1.abort();
    const finalRes = await p2;
    await p1;
    expect(reads).toBe(2);
    expect(finalRes.uploaded).toBe(true);
  });

  it('[SYNC-P1-11 & SYNC-P2-07] queue ops jitter head/tail/midpoint per device, localize collision repair, and reject malformed remote pos', () => {
    const hlcA = new HybridLogicalClock(0, () => 1000);
    const hlcB = new HybridLogicalClock(0, () => 1000);
    const baseEntries: QueueEntry[] = [
      { episodeKey: 'e_1', feedKey: 'f_1', pos: 'a0', addedAt: 1, updatedAt: 1, removed: false, deviceId: 'd_0' },
      { episodeKey: 'e_2', feedKey: 'f_1', pos: 'a1', addedAt: 2, updatedAt: 2, removed: false, deviceId: 'd_0' },
    ];

    // Concurrent tail add from 2 devices -> distinct valid keys
    const tailA = queueAdd(baseEntries, { episodeKey: 'e_a', feedKey: 'f_1' }, { hlc: hlcA, deviceId: 'd_alpha' })[0]!;
    const tailB = queueAdd(baseEntries, { episodeKey: 'e_b', feedKey: 'f_1' }, { hlc: hlcB, deviceId: 'd_beta' })[0]!;
    expect(tailA.pos).not.toBe(tailB.pos);
    expect(() => validateOrderKey(tailA.pos)).not.toThrow();
    expect(() => validateOrderKey(tailB.pos)).not.toThrow();
    expect(tailA.pos > 'a1').toBe(true);
    expect(tailB.pos > 'a1').toBe(true);

    // Concurrent midpoint `queuePlayNext` from 2 devices -> distinct valid keys strictly in ('a0', 'a1')
    const midA = queuePlayNext(baseEntries, { episodeKey: 'e_ma', feedKey: 'f_1' }, { hlc: hlcA, deviceId: 'd_alpha' }, 'e_1')[0]!;
    const midB = queuePlayNext(baseEntries, { episodeKey: 'e_mb', feedKey: 'f_1' }, { hlc: hlcB, deviceId: 'd_beta' }, 'e_1')[0]!;
    expect(midA.pos).not.toBe(midB.pos);
    expect(() => validateOrderKey(midA.pos)).not.toThrow();
    expect(() => validateOrderKey(midB.pos)).not.toThrow();
    expect(midA.pos > 'a0' && midA.pos < 'a1').toBe(true);
    expect(midB.pos > 'a0' && midB.pos < 'a1').toBe(true);

    // Concurrent head ensure from 2 devices -> distinct valid keys < 'a0'
    const headA = queueEnsureAtHead(baseEntries, { episodeKey: 'e_ha', feedKey: 'f_1' }, { hlc: hlcA, deviceId: 'd_alpha' })[0]!;
    const headB = queueEnsureAtHead(baseEntries, { episodeKey: 'e_hb', feedKey: 'f_1' }, { hlc: hlcB, deviceId: 'd_beta' })[0]!;
    expect(headA.pos).not.toBe(headB.pos);
    expect(headA.pos < 'a0' && headB.pos < 'a0').toBe(true);

    // Localized collision repair: [A(a0), B(a1), C(a1), D(a2)] inserting X between B and C MUST NOT touch A or D!
    const collided: QueueEntry[] = [
      { episodeKey: 'e_A', feedKey: 'f_1', pos: 'a0', addedAt: 1, updatedAt: 10, removed: false, deviceId: 'd_0' },
      { episodeKey: 'e_B', feedKey: 'f_1', pos: 'a1', addedAt: 2, updatedAt: 20, removed: false, deviceId: 'd_0' },
      { episodeKey: 'e_C', feedKey: 'f_1', pos: 'a1', addedAt: 3, updatedAt: 30, removed: false, deviceId: 'd_0' },
      { episodeKey: 'e_D', feedKey: 'f_1', pos: 'a2', addedAt: 4, updatedAt: 40, removed: false, deviceId: 'd_0' },
    ];
    const repaired = queuePlayNext(collided, { episodeKey: 'e_X', feedKey: 'f_1' }, { hlc: hlcA, deviceId: 'd_alpha' }, 'e_B');
    const touchedKeys = repaired.map((r) => r.episodeKey);
    expect(touchedKeys).not.toContain('e_A');
    expect(touchedKeys).not.toContain('e_D');
    expect(touchedKeys).toContain('e_X');
    for (const r of repaired) {
      expect(r.pos > 'a0' && r.pos < 'a2').toBe(true);
    }

    // S1 regression: malformed remote active queue `pos` is accepted by parser (no whole-doc rejection)
    // and self-healed locally on subsequent queue operations without throwing!
    const badDoc = {
      ...createEmptySyncDocument('d_bad', 100),
      queue: {
        floor: 0,
        items: {
          e_bad: { feedKey: 'f_1', pos: '!!!invalid', addedAt: 1, updatedAt: 100, removed: false, deviceId: 'd_bad' },
        },
      },
    };
    const parsedBad = parseSyncDocument(JSON.stringify(badDoc));
    expect(parsedBad.queue.items['e_bad']?.pos).toBe('!!!invalid');
    const badEntries: QueueEntry[] = [
      { episodeKey: 'e_bad', feedKey: 'f_1', pos: '!!!invalid', addedAt: 1, updatedAt: 100, removed: false, deviceId: 'd_bad' },
    ];
    const healedAfterAdd = queueAdd(badEntries, { episodeKey: 'e_new', feedKey: 'f_1' }, { hlc: hlcA, deviceId: 'd_alpha' });
    expect(healedAfterAdd.length).toBeGreaterThanOrEqual(1);
    for (const r of healedAfterAdd) {
      expect(() => validateOrderKey(r.pos)).not.toThrow();
    }
  });

  it('[SYNC-P1-13] 50k progress soft-cap GC never evicts PLAYED above oldestNonPlayed (zero resurrection ping-pong)', () => {
    const now = 1_800_000_000_000;
    const doc: SyncDocument = {
      ...createEmptySyncDocument('d_1', now),
      progress: {
        floor: 0,
        items: {
          e_inprog: { feedKey: 'f_1', positionMs: 5000, state: 'IN_PROGRESS', updatedAt: 100, deviceId: 'd_1' },
          e_p1: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 1000, deviceId: 'd_1' },
          e_p2: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 1001, deviceId: 'd_1' },
          e_p3: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 1002, deviceId: 'd_1' },
        },
      },
    };
    // Because IN_PROGRESS@100 is older than all PLAYED entries, NO PLAYED entry can be covered by floor -> soft cap preserves all 4
    const gced = gcSyncDocument(doc, { nowMs: now, writerDeviceId: 'd_1', maxProgressEntries: 2 });
    expect(Object.keys(gced.progress.items).sort()).toEqual(['e_inprog', 'e_p1', 'e_p2', 'e_p3']);
    expect(gced.progress.floor).toBe(0);
  });

  it('[SYNC-P1-14 & SYNC-P2-08] WebDAV weak/missing ETag & multi-challenge Digest; Gist 404 recreate, updated_at consistency, 403 rate-limit & auto-discovery', async () => {
    // WebDAV: multi-challenge Digest + missing ETag + weak ETag
    const putHeaders: Array<Record<string, string>> = [];
    let headCallsAfterPut = 0;
    let putDone = false;
    const davHttp: HttpClient = async (req: HttpRequest) => {
      const auth = req.headers?.['Authorization'] ?? '';
      if (!auth.startsWith('Digest ')) {
        return makeResp(401, 'Auth', {
          'www-authenticate': 'Basic realm="DAV", Digest realm="Nextcloud", qop="auth", nonce="abc123"',
        });
      }
      if (req.method === 'GET') {
        return makeResp(200, '{}', { etag: 'W/"weak-1"' });
      }
      if (req.method === 'PUT') {
        putHeaders.push(req.headers ?? {});
        putDone = true;
        return makeResp(204, ''); // omits ETag!
      }
      if (req.method === 'HEAD') {
        if (putDone) headCallsAfterPut += 1;
        return makeResp(200, '');
      }
      return makeResp(405, '');
    };
    const dav = new WebDavProvider({ fileUrl: 'https://dav.example/sync.json', username: 'u', password: 'p', http: davHttp });
    const davRead = await dav.read(null);
    expect(davRead.kind).toBe('blob');
    const davWrite = await dav.write(enc.encode('{}'), davRead.kind === 'blob' ? davRead.etag : null);
    expect(davWrite).toEqual({ kind: 'ok', newEtag: null });
    expect(putHeaders[0]?.['If-Match']).toBeUndefined(); // weak ETag omitted
    expect(headCallsAfterPut).toBe(0); // no racy head() after PUT

    // WebDAV GET without ETag header -> subsequent `write(bytes, null)` omits `If-None-Match`
    const noEtagPutHeaders: Array<Record<string, string>> = [];
    const davNoEtagHttp: HttpClient = async (req: HttpRequest) => {
      if (req.method === 'GET') return makeResp(200, '{}'); // no ETag header
      if (req.method === 'PUT') {
        noEtagPutHeaders.push(req.headers ?? {});
        return makeResp(204, '');
      }
      return makeResp(405, '');
    };
    const davNoEtag = new WebDavProvider({
      fileUrl: 'https://dav.example/no-etag.json',
      username: 'u',
      password: 'p',
      http: davNoEtagHttp,
    });
    const rNoEtag = await davNoEtag.read(null);
    expect(rNoEtag.kind).toBe('blob');
    expect(rNoEtag.kind === 'blob' ? rNoEtag.etag : 'x').toBeNull();
    const wNoEtag = await davNoEtag.write(enc.encode('{}'), null);
    expect(wNoEtag).toEqual({ kind: 'ok', newEtag: null });
    expect(noEtagPutHeaders[0]?.['If-None-Match']).toBeUndefined();

    // Gist: auto-discovers existing secret gist, uses `history[0].version` for sub-second resolution (S9),
    // retries discovery after 500 without creating a duplicate (S10), 404 recreates, and body-only 403 rate limit -> network
    let gistDeleted = false;
    let postCount = 0;
    let commitSha = 'sha_commit_1';
    const gistHttp: HttpClient = async (req: HttpRequest) => {
      if (req.method === 'GET' && req.url.includes('/gists?per_page=100')) {
        return makeResp(
          200,
          JSON.stringify([
            { id: 'gist_existing', public: false, files: { [SYNC_FILE_NAME]: { filename: SYNC_FILE_NAME } } },
          ]),
        );
      }
      if (req.method === 'GET' && req.url.includes('/gists/gist_existing')) {
        if (gistDeleted) return makeResp(404, '');
        return makeResp(
          200,
          JSON.stringify({
            id: 'gist_existing',
            updated_at: '2026-01-01T00:00:00Z',
            history: [{ version: commitSha }],
            files: { [SYNC_FILE_NAME]: { content: JSON.stringify(createEmptySyncDocument('d_1', 100)) } },
          }),
          { etag: '"strong-get-etag"' },
        );
      }
      if (req.method === 'PATCH' && req.url.includes('/gists/gist_existing')) {
        commitSha = 'sha_commit_2';
        return makeResp(
          200,
          JSON.stringify({
            id: 'gist_existing',
            updated_at: '2026-01-01T00:00:00Z', // SAME second as GET!
            history: [{ version: commitSha }],
            files: {},
          }),
          { etag: 'W/"weak-patch-etag"' },
        );
      }
      if (req.method === 'POST' && req.url.endsWith('/gists')) {
        postCount += 1;
        return makeResp(201, JSON.stringify({ id: 'gist_recreated', updated_at: '2026-01-01T00:02:00Z', history: [{ version: 'sha_commit_3' }], files: {} }));
      }
      return makeResp(404, '');
    };
    const gist = new GitHubGistProvider({ token: 'ghp_tok', http: gistHttp });
    const gr1 = await gist.read(null);
    expect(gr1.kind).toBe('blob');
    expect(gist.getGistId()).toBe('gist_existing');
    expect(gr1.kind === 'blob' ? gr1.etag : null).toBe('sha_commit_1');

    // Write uses `history[0].version` consistently and advances tag even within same `updated_at` second (S9)
    const gw1 = await gist.write(
      serializeSyncDocument(createEmptySyncDocument('d_1', 200)),
      gr1.kind === 'blob' ? gr1.etag : null,
    );
    expect(gw1).toEqual({ kind: 'ok', newEtag: 'sha_commit_2' });
    // Stale `sha_commit_1` now detects conflict even though `updated_at` stayed in the same second!
    expect(await gist.write(serializeSyncDocument(createEmptySyncDocument('d_1', 250)), 'sha_commit_1')).toEqual({
      kind: 'conflict',
    });

    // S10: Gist discovery 500 throws retryable `network`, never POSTs duplicate, and retries discovery on next call!
    let discCalls = 0;
    let discPosts = 0;
    const discGist = new GitHubGistProvider({
      token: 'ghp_tok',
      http: async (req) => {
        if (req.method === 'GET' && req.url.includes('/gists?per_page=100')) {
          discCalls += 1;
          if (discCalls === 1) return makeResp(500, 'Upstream error');
          return makeResp(
            200,
            JSON.stringify([{ id: 'gist_found_on_retry', public: false, files: { [SYNC_FILE_NAME]: { filename: SYNC_FILE_NAME } } }]),
          );
        }
        if (req.method === 'POST') {
          discPosts += 1;
          return makeResp(201, JSON.stringify({ id: 'gist_dup' }));
        }
        if (req.method === 'GET' && req.url.includes('/gists/gist_found_on_retry')) {
          return makeResp(200, JSON.stringify({
            id: 'gist_found_on_retry',
            history: [{ version: 'v1' }],
            files: { [SYNC_FILE_NAME]: { content: JSON.stringify(createEmptySyncDocument('d_1', 100)) } },
          }));
        }
        return makeResp(404, '');
      },
    });
    const wDiscFail = await discGist.write(serializeSyncDocument(createEmptySyncDocument('d_1', 100)), null);
    expect(wDiscFail).toMatchObject({ kind: 'failed', retryable: true });
    expect(discPosts).toBe(0);
    const rDiscRetry = await discGist.read(null);
    expect(rDiscRetry.kind).toBe('blob');
    expect(discGist.getGistId()).toBe('gist_found_on_retry');

    // Gist deleted remotely -> read clears gistId, next write recreates via POST!
    gistDeleted = true;
    expect(await gist.read(null)).toEqual({ kind: 'missing' });
    expect(gist.getGistId()).toBeUndefined();
    const gw2 = await gist.write(serializeSyncDocument(createEmptySyncDocument('d_1', 300)), null);
    expect(gw2.kind).toBe('ok');
    expect(postCount).toBe(1);
    expect(gist.getGistId()).toBe('gist_recreated');

    // 403 rate limit (header AND body-only secondary rate limit) -> `network`
    const rateGist = new GitHubGistProvider({
      token: 'ghp_tok',
      gistId: 'g_1',
      http: async () => makeResp(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' }),
    });
    await expect(rateGist.read(null)).rejects.toMatchObject({ code: 'network' });
    const bodyRateGist = new GitHubGistProvider({
      token: 'ghp_tok',
      gistId: 'g_1',
      http: async () => makeResp(403, '{"message":"You have exceeded a secondary rate limit"}'),
    });
    await expect(bodyRateGist.read(null)).rejects.toMatchObject({ code: 'network' });
  });

  it('[SYNC-P2-01 & SYNC-P2-04 & B1] HLC restore guards backward jumps while clamping forward poisoning, skewed remote hlcMax does not poison hlcLast, and read-only device heartbeats every 24h', async () => {
    // B1: HLC restore preserves monotonicity on normal backward clock jumps (within +5m)
    // while clamping any poisoned future timestamp to `wall + HLC_MAX_FORWARD_SKEW_MS`!
    const wall = 1_000_000;
    const hlc = new HybridLogicalClock(0, () => wall);
    hlc.restore(wall + 120_000);
    expect(hlc.current()).toBe(wall + 120_000);
    hlc.restore(wall + 10 * HLC_MAX_FORWARD_SKEW_MS);
    expect(hlc.current()).toBe(wall + HLC_MAX_FORWARD_SKEW_MS);

    // Event-time stamping does not advance global HLC
    const hlcEvent = new HybridLogicalClock(0, () => 5_000_000);
    const saved = stampProgressSave(
      { episodeKey: 'e_1', positionMs: 120_000, state: 'IN_PROGRESS' },
      { feedKey: 'f_1', hlc: hlcEvent, deviceId: 'd_1', eventWallMs: 1_000_000 },
    );
    expect(saved.updatedAt).toBe(1_000_000);
    const played = stampMarkPlayed({
      episodeKey: 'e_1',
      feedKey: 'f_1',
      played: true,
      hlc: hlcEvent,
      deviceId: 'd_1',
      previous: saved,
      eventWallMs: 1_005_000,
    });
    expect(played.updatedAt).toBe(1_005_000);

    // Skewed remote hlcMax (1 year ahead) MUST NOT poison `state.hlcLast` + 24h read-only heartbeat
    let now = 2_000_000_000;
    const skewedRemote: SyncDocument = {
      ...createEmptySyncDocument('d_skew', now),
      rev: 1,
      hlcMax: now + 365 * 24 * 3600_000,
      devices: { d_skew: { name: 'Skew', app: 'test', lastSeenAt: now } },
    };
    let bytes = serializeSyncDocument(skewedRemote);
    let etag = 'e1';
    const provider: CloudFileProvider = {
      id: 'webdav',
      supportsNativeConditionalWrite: true,
      supportsCheapHead: true,
      probe: async () => ({ ok: true, exists: true, etag }),
      head: async () => etag,
      read: async (m) => (m === etag ? { kind: 'not-modified' } : { kind: 'blob', bytes, etag }),
      write: async (b) => {
        bytes = b.slice();
        etag = `e${etag.length + 1}`;
        return { kind: 'ok', newEtag: etag };
      },
    };
    const store = new TestMemorySyncStore('d_ro', 'ReadOnly');
    const roHlc = new HybridLogicalClock(0, () => now);
    const engine = new SyncEngine({ store, provider, hlc: roHlc, backgroundSync: false, now: () => now });

    // First pull registers d_ro in devices
    const r1 = await engine.run('foreground');
    expect(r1.uploaded).toBe(true);
    expect(store.state.hlcLast).toBeLessThanOrEqual(now + HLC_MAX_FORWARD_SKEW_MS + 10);

    // Within 24h: no upload even on fresh blob
    now += 12 * 3600_000;
    etag = 'e_changed_by_other';
    const r2 = await engine.run('periodic');
    expect(r2.uploaded).toBe(false);

    // After >= 24h: read-only device uploads heartbeat!
    now += 13 * 3600_000;
    etag = 'e_changed_again';
    const r3 = await engine.run('periodic');
    expect(r3.uploaded).toBe(true);
    expect(parseSyncDocument(bytes).devices['d_ro']?.lastSeenAt).toBe(now);
  });
});
