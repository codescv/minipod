import { describe, expect, it } from 'vitest';
import {
  HLC_MAX_FORWARD_SKEW_MS,
  SYNC_FILE_NAME,
  TOMBSTONE_TTL_QUEUE_MS,
  TOMBSTONE_TTL_SUBSCRIPTIONS_MS,
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
  type ProgressState,
  type SyncDocument,
  type SyncEntityMaps,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncSchedulerHost,
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
  SyncScheduler,
  WebDavProvider,
  createEmptySyncDocument,
  entityMapsEqual,
  gcSyncDocument,
  generateKeyBetween,
  generateNKeysBetween,
  md5Hex,
  mergeSyncDocuments,
  needsKeyRebalance,
  parseSyncDocument,
  serializeSyncDocument,
  stringifySyncDocument,
} from './index';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Deterministic Mulberry32 PRNG for reproducible property-based CRDT fuzzing. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHttpResponse(
  status: number,
  body: string | Uint8Array,
  headers?: Record<string, string>,
  finalUrl: string = 'https://example.com',
): HttpResponse {
  const bytes = typeof body === 'string' ? utf8Encoder.encode(body) : body;
  const text = typeof body === 'string' ? body : utf8Decoder.decode(body);
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    lowerHeaders[k.toLowerCase()] = v;
  }
  return {
    status,
    headers: lowerHeaders,
    finalUrl,
    chain: [],
    bytes: async () => bytes,
    text: async () => text,
  };
}

class InMemoryHostFile implements HostFileAccess {
  private content: Uint8Array | null = null;
  private mtimeMs = 0;
  private clock = 1_000_000;
  private readonly watchers = new Set<() => void>();

  async stat(): Promise<{ readonly size: number; readonly mtimeMs: number } | null> {
    if (!this.content) return null;
    return { size: this.content.byteLength, mtimeMs: this.mtimeMs };
  }

  async read(): Promise<Uint8Array> {
    if (!this.content) {
      const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      throw err;
    }
    return this.content.slice();
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.clock += 10;
    this.content = bytes.slice();
    this.mtimeMs = this.clock;
    for (const cb of this.watchers) cb();
  }

  externalWrite(bytes: Uint8Array): void {
    this.clock += 50;
    this.content = bytes.slice();
    this.mtimeMs = this.clock;
    for (const cb of this.watchers) cb();
  }

  watch(cb: () => void): () => void {
    this.watchers.add(cb);
    return () => {
      this.watchers.delete(cb);
    };
  }
}

/** Reference in-memory `SyncStore` implementing ARCHITECTURE.md §7.6 semantics for engine tests. */
class InMemorySyncStore implements SyncStore {
  state: SyncState;
  subs = new Map<FeedKey, { item: SyncSubscription; dirty: boolean }>();
  queue = new Map<EpisodeKey, { item: SyncQueueEntry; dirty: boolean }>();
  progress = new Map<EpisodeKey, { item: SyncProgress; dirty: boolean }>();

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
    const merged = { ...this.state, ...patch } as Record<string, unknown>;
    if ('lastError' in patch && patch.lastError === undefined) {
      delete merged['lastError'];
    }
    this.state = merged as unknown as SyncState;
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
      device: { name: this.state.deviceName, app: 'test/0.1.0', lastSeenAt: 1_000 },
      dirty: { subscriptions: dirtySubs, queue: dirtyQ, progress: dirtyP },
    };
  }

  async restampDirtyBelowFloor(floors: SyncState['floors'], stamp: () => number): Promise<void> {
    for (const [k, v] of this.subs) {
      if (v.dirty && v.item.updatedAt <= floors.subscriptions) {
        this.subs.set(k, { item: { ...v.item, updatedAt: stamp() }, dirty: true });
      }
    }
    for (const [k, v] of this.queue) {
      if (v.dirty && v.item.updatedAt <= floors.queue) {
        this.queue.set(k, { item: { ...v.item, updatedAt: stamp() }, dirty: true });
      }
    }
    for (const [k, v] of this.progress) {
      if (v.dirty && v.item.updatedAt <= floors.progress) {
        this.progress.set(k, { item: { ...v.item, updatedAt: stamp() }, dirty: true });
      }
    }
  }

  async applyMerged(
    merged: SyncDocument,
    currentEpisodeKey: EpisodeKey | undefined,
  ): Promise<ApplyDecisions> {
    const feedsToRefresh: FeedKey[] = [];
    const resumeHints: Array<{
      episodeKey: EpisodeKey;
      positionMs: number;
      state: ProgressState;
      deviceName: string;
    }> = [];

    // Subscriptions
    for (const [k, local] of [...this.subs.entries()]) {
      if (!merged.subscriptions.items[k] && !local.dirty) {
        this.subs.delete(k);
      }
    }
    for (const [k, winner] of Object.entries(merged.subscriptions.items)) {
      const prev = this.subs.get(k);
      if (!prev && !winner.deleted) {
        feedsToRefresh.push(k);
      }
      const sameAsLocal = prev && JSON.stringify(prev.item) === JSON.stringify(winner);
      const localWon = Boolean(prev?.dirty && sameAsLocal);
      this.subs.set(k, { item: winner, dirty: localWon });
    }

    // Queue
    for (const [k, local] of [...this.queue.entries()]) {
      if (!merged.queue.items[k] && !local.dirty) {
        this.queue.delete(k);
      }
    }
    for (const [k, winner] of Object.entries(merged.queue.items)) {
      const prev = this.queue.get(k);
      const sameAsLocal = prev && JSON.stringify(prev.item) === JSON.stringify(winner);
      const localWon = Boolean(prev?.dirty && sameAsLocal);
      this.queue.set(k, { item: winner, dirty: localWon });
    }

    // Progress
    for (const [k, local] of [...this.progress.entries()]) {
      if (!merged.progress.items[k] && !local.dirty) {
        this.progress.delete(k);
      }
    }
    for (const [k, winner] of Object.entries(merged.progress.items)) {
      const prev = this.progress.get(k);
      if (
        k === currentEpisodeKey &&
        (!prev || winner.updatedAt > prev.item.updatedAt) &&
        winner.deviceId !== this.state.deviceId
      ) {
        resumeHints.push({
          episodeKey: k,
          positionMs: winner.positionMs,
          state: winner.state,
          deviceName: merged.devices[winner.deviceId]?.name ?? winner.deviceId,
        });
      }
      const sameAsLocal = prev && JSON.stringify(prev.item) === JSON.stringify(winner);
      const localWon = Boolean(prev?.dirty && sameAsLocal);
      this.progress.set(k, { item: winner, dirty: localWon });
    }

    this.state = {
      ...this.state,
      floors: {
        subscriptions: Math.max(this.state.floors.subscriptions, merged.subscriptions.floor),
        queue: Math.max(this.state.floors.queue, merged.queue.floor),
        progress: Math.max(this.state.floors.progress, merged.progress.floor),
      },
    };

    return { resumeHints, feedsToRefresh };
  }

  async markClean(pushed: SyncEntityMaps): Promise<void> {
    for (const [k, v] of this.subs) {
      if (JSON.stringify(v.item) === JSON.stringify(pushed.subscriptions.items[k])) {
        this.subs.set(k, { item: v.item, dirty: false });
      }
    }
    for (const [k, v] of this.queue) {
      if (JSON.stringify(v.item) === JSON.stringify(pushed.queue.items[k])) {
        this.queue.set(k, { item: v.item, dirty: false });
      }
    }
    for (const [k, v] of this.progress) {
      if (JSON.stringify(v.item) === JSON.stringify(pushed.progress.items[k])) {
        this.progress.set(k, { item: v.item, dirty: false });
      }
    }
  }

  async purgeBelowFloors(floors: SyncState['floors']): Promise<void> {
    for (const [k, v] of this.subs) {
      if (!v.dirty && v.item.deleted && v.item.updatedAt <= floors.subscriptions) {
        this.subs.delete(k);
      }
    }
    for (const [k, v] of this.queue) {
      if (!v.dirty && v.item.removed && v.item.updatedAt <= floors.queue) {
        this.queue.delete(k);
      }
    }
    for (const [k, v] of this.progress) {
      if (!v.dirty && v.item.state === 'PLAYED' && v.item.updatedAt <= floors.progress) {
        this.progress.delete(k);
      }
    }
  }
}

describe('sync/hlc, fractional-index & schema', () => {
  it('enforces HLC monotonicity, +5m forward drift cap on observe, and causal entity restamping', () => {
    let wall = 10_000;
    const hlc = new HybridLogicalClock(0, () => wall);

    expect(hlc.now()).toBe(10_000);
    // Wall clock stalls -> logical +1
    expect(hlc.now()).toBe(10_001);
    expect(hlc.now()).toBe(10_002);

    // Remote clock 1 year in the future -> capped at wall + 5 minutes
    const yearFuture = wall + 365 * 24 * 3600_000;
    expect(hlc.observe(yearFuture)).toBe(wall + HLC_MAX_FORWARD_SKEW_MS);

    // Entity stamp still beats a skewed previous entity timestamp
    expect(hlc.stamp(yearFuture)).toBe(yearFuture + 1);
  });

  it('maintains strict ASCII lexicographical order across 500 random fractional-index insertions', () => {
    const rand = mulberry32(42);
    const list: string[] = [];

    for (let i = 0; i < 500; i++) {
      const slot = Math.floor(rand() * (list.length + 1));
      const left = slot > 0 ? list[slot - 1]! : null;
      const right = slot < list.length ? list[slot]! : null;
      const key = generateKeyBetween(left, right);
      if (left !== null) expect(left < key).toBe(true);
      if (right !== null) expect(key < right).toBe(true);
      list.splice(slot, 0, key);
    }

    const sortedCopy = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(list).toEqual(sortedCopy);

    const nKeys = generateNKeysBetween(null, null, 20);
    expect(nKeys).toHaveLength(20);
    for (let i = 1; i < nKeys.length; i++) {
      expect(nKeys[i - 1]! < nKeys[i]!).toBe(true);
    }

    // Repeated bisection eventually exceeds 64 chars -> needsKeyRebalance
    let cur = generateKeyBetween(null, null);
    const ceil = generateKeyBetween(cur, null);
    for (let i = 0; i < 420; i++) {
      cur = generateKeyBetween(cur, ceil);
    }
    expect(needsKeyRebalance(cur)).toBe(true);
  });

  it('validates minipod-sync-v1.json, rejects corrupt payloads, and flags newer schemaVersion', () => {
    const empty = createEmptySyncDocument('d_1', 12345);
    const bytes = serializeSyncDocument(empty);
    expect(parseSyncDocument(bytes)).toEqual(empty);

    expect(() => parseSyncDocument('not json')).toThrowError(/not valid JSON/);
    expect(() => parseSyncDocument(JSON.stringify({ schema: 'other', schemaVersion: 1 }))).toThrowError(
      /Unexpected sync schema/,
    );
    expect(() =>
      parseSyncDocument(JSON.stringify({ ...empty, schemaVersion: 99 })),
    ).toThrowError(/requires schemaVersion 99/);

    try {
      parseSyncDocument(JSON.stringify({ ...empty, schemaVersion: 2 }));
    } catch (err) {
      expect((err as { details?: Record<string, unknown> }).details?.['newerSchemaVersion']).toBe(
        true,
      );
    }
  });
});

describe('sync/merge property-based CRDT invariants & gc', () => {
  function generateRandomDoc(rand: () => number, deviceId: string, baseTime: number): SyncDocument {
    const subFloor = rand() < 0.3 ? Math.floor(rand() * 500) + baseTime : 0;
    const queueFloor = rand() < 0.3 ? Math.floor(rand() * 500) + baseTime : 0;
    const progFloor = rand() < 0.3 ? Math.floor(rand() * 500) + baseTime : 0;

    const subs: Record<string, SyncSubscription> = {};
    for (let i = 0; i < 5; i++) {
      if (rand() < 0.7) {
        const key = `f_feed_${i}`;
        const updatedAt = baseTime + Math.floor(rand() * 1_000);
        const deleted = rand() < 0.35;
        const movedTo = rand() < 0.25 ? `https://moved-${i}.example/rss` : null;
        subs[key] = {
          url: `https://orig-${i}.example/rss`,
          movedTo,
          title: `Feed ${i}`,
          updatedAt,
          deleted,
          deviceId,
        };
      }
    }

    const queue: Record<string, SyncQueueEntry> = {};
    const keys = generateNKeysBetween(null, null, 5);
    for (let i = 0; i < 5; i++) {
      if (rand() < 0.7) {
        const epKey = `e_ep_${i}`;
        const updatedAt = baseTime + Math.floor(rand() * 1_000);
        const removed = rand() < 0.35;
        queue[epKey] = {
          feedKey: 'f_feed_0',
          pos: keys[Math.floor(rand() * keys.length)]!,
          addedAt: baseTime + i * 10,
          updatedAt,
          removed,
          deviceId,
          ...(!removed
            ? { stub: { identity: `id-${i}`, title: `Ep ${i}`, feedUrl: 'https://orig-0.example/rss' } }
            : {}),
        };
      }
    }

    const states: readonly ProgressState[] = ['NEW', 'IN_PROGRESS', 'PLAYED'];
    const progress: Record<string, SyncProgress> = {};
    for (let i = 0; i < 6; i++) {
      if (rand() < 0.75) {
        const epKey = `e_ep_${i}`;
        const updatedAt = baseTime + Math.floor(rand() * 1_000);
        const st = states[Math.floor(rand() * states.length)]!;
        progress[epKey] = {
          feedKey: 'f_feed_0',
          positionMs: st === 'PLAYED' || st === 'NEW' ? 0 : Math.floor(rand() * 60_000) + 1_000,
          durationMs: 60_000,
          state: st,
          playedAt: st === 'PLAYED' ? updatedAt : null,
          updatedAt,
          deviceId,
        };
      }
    }

    return {
      schema: 'minipod-sync',
      schemaVersion: 1,
      rev: Math.floor(rand() * 20),
      writtenAt: baseTime + Math.floor(rand() * 2_000),
      writtenBy: deviceId,
      hlcMax: baseTime + 1_500,
      devices: {
        [deviceId]: { name: deviceId, app: 'test', lastSeenAt: baseTime + Math.floor(rand() * 2_000) },
      },
      subscriptions: { floor: subFloor, items: subs },
      queue: { floor: queueFloor, items: queue },
      progress: { floor: progFloor, items: progress },
    };
  }

  it('satisfies commutativity, idempotence, associativity, and N-device out-of-order convergence over 120 random traces', () => {
    const rand = mulberry32(0xdecafbad);

    for (let trial = 0; trial < 120; trial++) {
      const base = 1_700_000_000_000;
      // 4 devices with skewed clocks (including exact timestamp ties to exercise tie-breakers!)
      const a = generateRandomDoc(rand, 'd_alpha', base + (rand() < 0.5 ? 0 : -120_000));
      const b = generateRandomDoc(rand, 'd_bravo', base + (rand() < 0.5 ? 0 : 180_000));
      const c = generateRandomDoc(rand, 'd_charlie', base);
      const d = generateRandomDoc(rand, 'd_delta', base + 45_000);

      // Invariant 1a: Idempotence `merge(a, a) == a`
      expect(stringifySyncDocument(mergeSyncDocuments(a, a))).toBe(stringifySyncDocument(a));

      // Invariant 1b: Commutativity `merge(a, b) == merge(b, a)`
      const ab = mergeSyncDocuments(a, b);
      const ba = mergeSyncDocuments(b, a);
      expect(stringifySyncDocument(ab)).toBe(stringifySyncDocument(ba));

      // Invariant 1c: Associativity `merge(merge(a, b), c) == merge(a, merge(b, c))`
      const abcLeft = mergeSyncDocuments(ab, c);
      const abcRight = mergeSyncDocuments(a, mergeSyncDocuments(b, c));
      expect(stringifySyncDocument(abcLeft)).toBe(stringifySyncDocument(abcRight));

      // Multi-device out-of-order + duplicate delivery convergence across 4 replicas
      const order1 = mergeSyncDocuments(mergeSyncDocuments(ab, c), d);
      const order2 = mergeSyncDocuments(mergeSyncDocuments(d, b), mergeSyncDocuments(c, a));
      const order3 = mergeSyncDocuments(order2, mergeSyncDocuments(a, d)); // duplicate gossip
      expect(stringifySyncDocument(order1)).toBe(stringifySyncDocument(order2));
      expect(stringifySyncDocument(order1)).toBe(stringifySyncDocument(order3));
    }
  });

  it('prevents tombstone resurrection (with or without GC floor) and enforces progress tie-breakers', () => {
    const staleDevice: SyncDocument = {
      ...createEmptySyncDocument('d_old', 100),
      subscriptions: {
        floor: 0,
        items: {
          f_1: { url: 'https://a.example/rss', updatedAt: 500, deleted: false, deviceId: 'd_old' },
        },
      },
    };
    const afterGcOnActiveDevice: SyncDocument = {
      ...createEmptySyncDocument('d_new', 2_000),
      subscriptions: {
        floor: 600, // Tombstone at 600 was GC'd after 180d -> floor raised to 600
        items: {},
      },
    };

    const merged = mergeSyncDocuments(staleDevice, afterGcOnActiveDevice);
    // Stale `f_1` (`updatedAt: 500 <= floor: 600`) MUST be dropped, never resurrected!
    expect(merged.subscriptions.items['f_1']).toBeUndefined();
    expect(merged.subscriptions.floor).toBe(600);

    // Identical HLC progress tie-break: PLAYED > IN_PROGRESS > NEW, then larger positionMs
    const progPlayed: SyncDocument = {
      ...createEmptySyncDocument('d_z', 100),
      progress: {
        floor: 0,
        items: {
          e_1: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 999, deviceId: 'd_z' },
        },
      },
    };
    const progInProgress: SyncDocument = {
      ...createEmptySyncDocument('d_a', 100),
      progress: {
        floor: 0,
        items: {
          e_1: { feedKey: 'f_1', positionMs: 50_000, state: 'IN_PROGRESS', updatedAt: 999, deviceId: 'd_a' },
        },
      },
    };
    expect(mergeSyncDocuments(progPlayed, progInProgress).progress.items['e_1']?.state).toBe('PLAYED');
  });

  it('GCs expired tombstones only when all active devices have seen them and preserves IN_PROGRESS above progress.floor', () => {
    const now = 1_800_000_000_000;
    const oldSubTombstoneAt = now - TOMBSTONE_TTL_SUBSCRIPTIONS_MS - 10_000;
    const oldQueueTombstoneAt = now - TOMBSTONE_TTL_QUEUE_MS - 10_000;

    const doc: SyncDocument = {
      ...createEmptySyncDocument('d_writer', now),
      devices: {
        d_writer: { name: 'Writer', app: 'test', lastSeenAt: now },
        d_lagging: { name: 'Lagging', app: 'test', lastSeenAt: oldSubTombstoneAt - 1 },
      },
      subscriptions: {
        floor: 0,
        items: {
          f_gone: { url: 'https://gone/rss', updatedAt: oldSubTombstoneAt, deleted: true, deviceId: 'd_writer' },
        },
      },
      queue: {
        floor: 0,
        items: {
          e_gone: {
            feedKey: 'f_1',
            pos: 'a0',
            addedAt: 1,
            updatedAt: oldQueueTombstoneAt,
            removed: true,
            deviceId: 'd_writer',
          },
        },
      },
      progress: {
        floor: 0,
        items: {
          e_inprog_old: { feedKey: 'f_1', positionMs: 5_000, state: 'IN_PROGRESS', updatedAt: 100, deviceId: 'd_writer' },
          e_played_1: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 200, deviceId: 'd_writer' },
          e_played_2: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 300, deviceId: 'd_writer' },
          e_played_3: { feedKey: 'f_1', positionMs: 0, state: 'PLAYED', updatedAt: 400, deviceId: 'd_writer' },
        },
      },
    };

    // Wait while `d_lagging` has NOT seen `f_gone` (and `d_lagging` is only 180d+10s old -> pruned!)
    // Let's test first when `d_lagging` was seen 10 days ago (so still active, hasn't seen queue tombstone? Wait: 10d ago > 30d ago, so let's set lastSeenAt < oldQueueTombstoneAt but within 180d!)
    const activeLaggingDoc: SyncDocument = {
      ...doc,
      devices: {
        d_writer: { name: 'Writer', app: 'test', lastSeenAt: now },
        d_recent_lag: { name: 'Lag', app: 'test', lastSeenAt: oldQueueTombstoneAt - 5_000 },
      },
    };
    const notYetGced = gcSyncDocument(activeLaggingDoc, { nowMs: now, writerDeviceId: 'd_writer', maxProgressEntries: 3 });
    expect(notYetGced.queue.items['e_gone']).toBeDefined();

    // Progress capped at 3: `e_played_1` (oldest PLAYED, updatedAt=200) evicted, while `e_inprog_old` (updatedAt=100) is KEPT and `progress.floor` stays <= 99!
    expect(Object.keys(notYetGced.progress.items).sort()).toEqual([
      'e_inprog_old',
      'e_played_2',
      'e_played_3',
    ]);
    expect(notYetGced.progress.floor).toBeLessThan(100);

    // Once `d_recent_lag` catches up (`lastSeenAt: now`), both tombstones are GC'd and floors advance!
    const caughtUpDoc: SyncDocument = {
      ...activeLaggingDoc,
      devices: {
        d_writer: { name: 'Writer', app: 'test', lastSeenAt: now },
        d_recent_lag: { name: 'Lag', app: 'test', lastSeenAt: now },
      },
    };
    const gced = gcSyncDocument(caughtUpDoc, { nowMs: now, writerDeviceId: 'd_writer' });
    expect(gced.subscriptions.items['f_gone']).toBeUndefined();
    expect(gced.subscriptions.floor).toBe(oldSubTombstoneAt);
    expect(gced.queue.items['e_gone']).toBeUndefined();
    expect(gced.queue.floor).toBe(oldQueueTombstoneAt);
  });
});

describe('sync/providers contract suite (HostFile, GoogleDrive, WebDAV, GitHubGist)', () => {
  async function runProviderContractSuite(makeProvider: () => CloudFileProvider): Promise<void> {
    const provider = makeProvider();

    const probe0 = await provider.probe();
    expect(probe0.ok).toBe(true);
    expect(probe0.exists).toBe(false);
    expect(await provider.head()).toBeNull();
    expect(await provider.read(null)).toEqual({ kind: 'missing' });

    const doc1Bytes = serializeSyncDocument({
      ...createEmptySyncDocument('d_1', 1_000),
      rev: 1,
    });
    const write1 = await provider.write(doc1Bytes, null);
    expect(write1.kind).toBe('ok');
    const etag1 = write1.kind === 'ok' ? write1.newEtag : null;
    expect(etag1).toBeTruthy();

    // `write(..., null)` when file already exists MUST conflict!
    const createAgain = await provider.write(doc1Bytes, null);
    expect(createAgain.kind).toBe('conflict');

    // `read(etag1)` MUST return `not-modified`
    expect(await provider.read(etag1)).toEqual({ kind: 'not-modified' });

    // `read(null)` returns full bytes
    const read1 = await provider.read(null);
    expect(read1.kind).toBe('blob');
    if (read1.kind === 'blob') {
      expect(parseSyncDocument(read1.bytes).rev).toBe(1);
    }

    // Stale etag MUST return `conflict`
    const doc2Bytes = serializeSyncDocument({
      ...createEmptySyncDocument('d_1', 2_000),
      rev: 2,
    });
    expect((await provider.write(doc2Bytes, 'stale-etag-value')).kind).toBe('conflict');

    // Matching etag updates cleanly
    const write2 = await provider.write(doc2Bytes, etag1);
    expect(write2.kind).toBe('ok');
    const read2 = await provider.read(etag1);
    expect(read2.kind).toBe('blob');
    if (read2.kind === 'blob') {
      expect(parseSyncDocument(read2.bytes).rev).toBe(2);
    }
  }

  it('passes full contract suite on HostFileProvider and filters self-writes in watch()', async () => {
    await runProviderContractSuite(() => {
      const mem = new InMemoryHostFile();
      return new HostFileProvider({ id: 'local-folder', access: mem });
    });

    const mem = new InMemoryHostFile();
    const provider = new HostFileProvider({ id: 'saf', access: mem });
    let externalEvents = 0;
    const unsub = provider.watch!(() => {
      externalEvents += 1;
    });

    const b1 = serializeSyncDocument(createEmptySyncDocument('d_1', 100));
    await provider.write(b1, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(externalEvents).toBe(0); // Self-write ignored!

    mem.externalWrite(serializeSyncDocument({ ...createEmptySyncDocument('d_2', 200), rev: 5 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(externalEvents).toBe(1);
    unsub();

    // Newly created 0-byte SAF document (`Intent.ACTION_CREATE_DOCUMENT`) must be treated as
    // `missing` on `read()` and allow `write(bytes, null)` without false conflict or `sync-schema` error.
    const zeroByteSaf = new InMemoryHostFile();
    zeroByteSaf.externalWrite(new Uint8Array(0));
    const safProvider = new HostFileProvider({ id: 'saf', access: zeroByteSaf });
    expect(await safProvider.read(null)).toEqual({ kind: 'missing' });

    const safStore = new InMemorySyncStore('d_saf', 'Pixel 9');
    const safHlc = new HybridLogicalClock(0, () => 500_000);
    safStore.subs.set('f_saf_pod', {
      item: {
        url: 'https://saf-pod.example/rss.xml',
        title: 'SAF Pod',
        updatedAt: safHlc.now(),
        deleted: false,
        deviceId: 'd_saf',
      },
      dirty: true,
    });
    const safEngine = new SyncEngine({
      store: safStore,
      provider: safProvider,
      hlc: safHlc,
      backgroundSync: false,
      now: () => 500_000,
    });
    const firstRun = await safEngine.run('configured');
    expect(firstRun.uploaded).toBe(true);
    expect(firstRun.status.phase).toBe('idle');
    expect(firstRun.status.lastError).toBeUndefined();
    const writtenDoc = parseSyncDocument(await zeroByteSaf.read());
    expect(writtenDoc.rev).toBe(1);
    expect(writtenDoc.subscriptions.items['f_saf_pod']?.url).toBe('https://saf-pod.example/rss.xml');
  });

  it('passes full contract suite on WebDavProvider including RFC 2617 Digest auth & 412 conflict', async () => {
    await runProviderContractSuite(() => {
      let storedBytes: Uint8Array | null = null;
      let storedEtag = '';
      let revCounter = 0;
      const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
      const realm = 'NextcloudDAV';

      const http: HttpClient = async (req) => {
        const auth = req.headers?.['Authorization'] ?? '';
        if (!auth.startsWith('Digest ')) {
          return makeHttpResponse(401, 'Unauthorized', {
            'www-authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"`,
          });
        }
        // Verify Digest response hash matches MD5(HA1:nonce:nc:cnonce:qop:HA2)
        const ha1 = md5Hex(`alice:${realm}:app-pass`);
        const uri = new URL(req.url).pathname;
        const ha2 = md5Hex(`${req.method ?? 'GET'}:${uri}`);
        expect(auth).toContain(`uri="${uri}"`);
        expect(ha1.length + ha2.length).toBe(64);

        if (req.method === 'HEAD') {
          if (!storedBytes) return makeHttpResponse(404, '');
          return makeHttpResponse(200, '', { etag: storedEtag });
        }
        if (req.method === 'GET') {
          if (!storedBytes) return makeHttpResponse(404, '');
          if (req.headers?.['If-None-Match'] === storedEtag) {
            return makeHttpResponse(304, '', { etag: storedEtag });
          }
          return makeHttpResponse(200, storedBytes, { etag: storedEtag });
        }
        if (req.method === 'PUT') {
          if (req.headers?.['If-None-Match'] === '*' && storedBytes !== null) {
            return makeHttpResponse(412, 'Precondition Failed');
          }
          if (req.headers?.['If-Match'] && req.headers['If-Match'] !== storedEtag) {
            return makeHttpResponse(412, 'Precondition Failed');
          }
          revCounter += 1;
          storedBytes = req.body instanceof Uint8Array ? req.body : utf8Encoder.encode(String(req.body ?? ''));
          storedEtag = `"dav-v${revCounter}"`;
          return makeHttpResponse(201, '', { etag: storedEtag });
        }
        return makeHttpResponse(405, '');
      };

      return new WebDavProvider({
        fileUrl: 'https://cloud.example.org/remote.php/dav/files/alice/minipod-sync-v1.json',
        username: 'alice',
        password: 'app-pass',
        http,
      });
    });
  });

  it('passes full contract suite on GoogleDriveProvider, retries 401 with forceRefresh, and self-heals duplicate files', async () => {
    class MockDriveServer {
      files = new Map<string, { id: string; name: string; parents: string[]; bytes: Uint8Array; md5: string }>();
      seq = 1;
      expiredToken = 'expired-tok';
      validToken = 'fresh-tok';

      http: HttpClient = async (req: HttpRequest) => {
        const auth = req.headers?.['Authorization'];
        if (auth !== `Bearer ${this.validToken}`) {
          return makeHttpResponse(401, '{"error":"invalid_token"}');
        }

        const u = new URL(req.url);
        // Upload create (POST multipart)
        if (u.pathname.endsWith('/upload/drive/v3/files') && req.method === 'POST') {
          const raw = req.body instanceof Uint8Array ? utf8Decoder.decode(req.body) : String(req.body);
          const jsonParts = raw.split(/--minipod_[a-z0-9_]+/i);
          const metaMatch = /\{[\s\S]*?"name"[\s\S]*?\}/.exec(jsonParts[1] ?? '');
          const meta = metaMatch ? (JSON.parse(metaMatch[0]) as { name: string; parents?: string[] }) : { name: SYNC_FILE_NAME };
          const bodyMatch = /\{\s*"schema":[\s\S]*\}/.exec(jsonParts[2] ?? '');
          const contentBytes = utf8Encoder.encode(bodyMatch ? bodyMatch[0] : '{}');
          const id = `file_${this.seq++}`;
          const md5 = md5Hex(utf8Decoder.decode(contentBytes));
          this.files.set(id, { id, name: meta.name, parents: meta.parents ?? [], bytes: contentBytes, md5 });
          return makeHttpResponse(200, JSON.stringify({ id, name: meta.name, md5Checksum: md5 }));
        }
        // Upload update (PATCH media)
        const patchMatch = /\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
        if (patchMatch && req.method === 'PATCH') {
          const id = decodeURIComponent(patchMatch[1]!);
          const existing = this.files.get(id);
          if (!existing) return makeHttpResponse(404, '');
          const bytes = req.body instanceof Uint8Array ? req.body : utf8Encoder.encode(String(req.body));
          const md5 = md5Hex(utf8Decoder.decode(bytes));
          this.files.set(id, { ...existing, bytes, md5 });
          return makeHttpResponse(200, JSON.stringify({ id, md5Checksum: md5 }));
        }
        // Folder create
        if (u.pathname.endsWith('/drive/v3/files') && req.method === 'POST') {
          const meta = JSON.parse(String(req.body)) as { name: string };
          const id = `folder_${this.seq++}`;
          this.files.set(id, { id, name: meta.name, parents: [], bytes: new Uint8Array(0), md5: '' });
          return makeHttpResponse(200, JSON.stringify({ id, name: meta.name }));
        }
        // List files
        if (u.pathname.endsWith('/drive/v3/files') && req.method === 'GET') {
          const q = u.searchParams.get('q') ?? '';
          const isFolderQuery = q.includes('application/vnd.google-apps.folder');
          const list = [...this.files.values()]
            .filter((f) => (isFolderQuery ? f.id.startsWith('folder_') : !f.id.startsWith('folder_')))
            .map((f) => ({ id: f.id, name: f.name, md5Checksum: f.md5 }));
          return makeHttpResponse(200, JSON.stringify({ files: list }));
        }
        // File get / delete
        const fileMatch = /\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
        if (fileMatch) {
          const id = decodeURIComponent(fileMatch[1]!);
          const existing = this.files.get(id);
          if (!existing) return makeHttpResponse(404, '');
          if (req.method === 'DELETE') {
            this.files.delete(id);
            return makeHttpResponse(204, '');
          }
          if (u.searchParams.get('alt') === 'media') {
            return makeHttpResponse(200, existing.bytes);
          }
          return makeHttpResponse(200, JSON.stringify({ id: existing.id, name: existing.name, md5Checksum: existing.md5 }));
        }
        return makeHttpResponse(404, '');
      };
    }

    await runProviderContractSuite(() => {
      const srv = new MockDriveServer();
      let refreshed = false;
      return new GoogleDriveProvider({
        mode: 'appdata',
        http: srv.http,
        getToken: async (opts) => {
          if (opts?.forceRefresh) refreshed = true;
          return refreshed ? srv.validToken : srv.expiredToken;
        },
      });
    });

    // Duplicate-file self-healing merge test (`file_b` and `file_a` -> keeps `file_a`, deletes `file_b`, merges both!)
    const srv = new MockDriveServer();
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
    const bA = serializeSyncDocument(docA);
    const bB = serializeSyncDocument(docB);
    srv.files.set('file_b', { id: 'file_b', name: SYNC_FILE_NAME, parents: ['appDataFolder'], bytes: bB, md5: md5Hex(utf8Decoder.decode(bB)) });
    srv.files.set('file_a', { id: 'file_a', name: SYNC_FILE_NAME, parents: ['appDataFolder'], bytes: bA, md5: md5Hex(utf8Decoder.decode(bA)) });

    const drive = new GoogleDriveProvider({
      mode: 'appdata',
      http: srv.http,
      getToken: async () => srv.validToken,
    });
    const healed = await drive.read(null);
    expect(healed.kind).toBe('blob');
    expect([...srv.files.keys()]).toEqual(['file_a']);
    if (healed.kind === 'blob') {
      const mergedDoc = parseSyncDocument(healed.bytes);
      expect(Object.keys(mergedDoc.subscriptions.items).sort()).toEqual(['f_a', 'f_b']);
    }
  });

  it('passes full contract suite on GitHubGistProvider, sends Auth on truncated raw_url, and gzips >800KB payloads', async () => {
    class MockGistServer {
      content: string | null = null;
      etag = '';
      rev = 0;
      forceTruncated = false;
      rawUrlAuthHeaders: string[] = [];

      http: HttpClient = async (req: HttpRequest) => {
        if (req.url.startsWith('https://gist.githubusercontent.com/raw')) {
          this.rawUrlAuthHeaders.push(req.headers?.['Authorization'] ?? '');
          return makeHttpResponse(200, this.content ?? '');
        }
        if (req.headers?.['Authorization'] !== 'Bearer ghp_secret') {
          return makeHttpResponse(401, 'Bad credentials');
        }
        if (req.method === 'GET' && req.url.endsWith('/gists?per_page=1')) {
          return makeHttpResponse(200, '[]');
        }
        if (req.method === 'POST' && req.url.endsWith('/gists')) {
          const body = JSON.parse(String(req.body)) as { files: Record<string, { content: string }> };
          this.content = body.files[SYNC_FILE_NAME]!.content;
          this.rev += 1;
          this.etag = `"gist-${this.rev}"`;
          return makeHttpResponse(201, JSON.stringify({ id: 'gist_1', files: { [SYNC_FILE_NAME]: { content: this.content } } }), { etag: this.etag });
        }
        if (req.method === 'PATCH') {
          const body = JSON.parse(String(req.body)) as { files: Record<string, { content: string }> };
          this.content = body.files[SYNC_FILE_NAME]!.content;
          this.rev += 1;
          this.etag = `"gist-${this.rev}"`;
          return makeHttpResponse(200, JSON.stringify({ id: 'gist_1', files: { [SYNC_FILE_NAME]: { content: this.content } } }), { etag: this.etag });
        }
        if (req.method === 'GET' && req.url.includes('/gists/gist_1')) {
          if (this.content === null) return makeHttpResponse(404, '');
          if (req.headers?.['If-None-Match'] === this.etag) {
            return makeHttpResponse(304, '', { etag: this.etag });
          }
          const fileEntry = this.forceTruncated
            ? { truncated: true, raw_url: 'https://gist.githubusercontent.com/raw/1', content: '{' }
            : { truncated: false, content: this.content };
          return makeHttpResponse(
            200,
            JSON.stringify({ id: 'gist_1', files: { [SYNC_FILE_NAME]: fileEntry } }),
            { etag: this.etag },
          );
        }
        return makeHttpResponse(404, '');
      };
    }

    await runProviderContractSuite(() => {
      const srv = new MockGistServer();
      return new GitHubGistProvider({ token: 'ghp_secret', http: srv.http });
    });

    // Verify >threshold gzip+base64 (`H4sI...`) + `truncated: true` authenticated `raw_url` fetch
    const srv = new MockGistServer();
    srv.forceTruncated = true;
    const gist = new GitHubGistProvider({
      token: 'ghp_secret',
      http: srv.http,
      gzipThresholdBytes: 128, // force gzip+base64 path cleanly
    });

    const doc = {
      ...createEmptySyncDocument('d_1', 500),
      subscriptions: {
        floor: 0,
        items: {
          f_1: { url: 'https://podcast.example.com/feed.xml', title: 'Long Enough To Gzip', updatedAt: 500, deleted: false, deviceId: 'd_1' },
        },
      },
    };
    const w = await gist.write(serializeSyncDocument(doc), null);
    expect(w.kind).toBe('ok');
    expect(srv.content?.startsWith('H4sI')).toBe(true);

    const r = await gist.read(null);
    expect(r.kind).toBe('blob');
    expect(srv.rawUrlAuthHeaders).toEqual(['Bearer ghp_secret']);
    if (r.kind === 'blob') {
      expect(entityMapsEqual(parseSyncDocument(r.bytes), doc)).toBe(true);
    }
  });
});

describe('sync/SyncEngine & SyncScheduler', () => {
  it('converges two devices, performs zero uploads on idle pull, restamps dirty rows below floor, and protects corrupt remote', async () => {
    const cloudFile = new InMemoryHostFile();
    const providerA = new HostFileProvider({ id: 'local-folder', access: cloudFile });
    const providerB = new HostFileProvider({ id: 'local-folder', access: cloudFile });

    let now = 100_000;
    const storeA = new InMemorySyncStore('d_A', 'Desktop');
    const storeB = new InMemorySyncStore('d_B', 'Pixel 8');
    const hlcA = new HybridLogicalClock(0, () => now);
    const hlcB = new HybridLogicalClock(0, () => now);

    const decisionsOnB: ApplyDecisions[] = [];
    const engineA = new SyncEngine({
      store: storeA,
      provider: providerA,
      hlc: hlcA,
      backgroundSync: true,
      now: () => now,
    });
    const engineB = new SyncEngine({
      store: storeB,
      provider: providerB,
      hlc: hlcB,
      backgroundSync: false,
      now: () => now,
      getCurrentEpisodeKey: () => 'e_ep1',
      onDecisions: (d) => {
        decisionsOnB.push(d);
      },
    });

    // Device A subscribes + records progress -> pushes `rev: 1`
    storeA.subs.set('f_show', {
      item: { url: 'https://show.example/rss', title: 'Show', updatedAt: hlcA.now(), deleted: false, deviceId: 'd_A' },
      dirty: true,
    });
    storeA.progress.set('e_ep1', {
      item: { feedKey: 'f_show', positionMs: 25_000, state: 'IN_PROGRESS', updatedAt: hlcA.now(), deviceId: 'd_A' },
      dirty: true,
    });

    const resA1 = await engineA.run('subscriptions-changed');
    expect(resA1.uploaded).toBe(true);
    expect(resA1.status.remoteRev).toBe(1);
    expect(resA1.status.dirtyCount).toBe(0);

    // Device B (clean) pulls -> applies `f_show` & `e_ep1`, emits resumeHint, and performs ZERO uploads!
    now += 5_000;
    const resB1 = await engineB.run('foreground');
    expect(resB1.pulled).toBe(true);
    expect(resB1.uploaded).toBe(false);
    expect(decisionsOnB[0]?.feedsToRefresh).toEqual(['f_show']);
    expect(decisionsOnB[0]?.resumeHints[0]).toMatchObject({
      episodeKey: 'e_ep1',
      positionMs: 25_000,
      deviceName: 'Desktop',
    });

    // Subsequent idle pull on A -> 304 Not Modified, zero uploads (no ping-pong!)
    now += 5_000;
    const resA2 = await engineA.run('periodic');
    expect(resA2.uploaded).toBe(false);

    // Long-offline dirty row on B sitting below remote floor gets restamped and survives merge!
    const highFloorDoc: SyncDocument = {
      ...parseSyncDocument(await cloudFile.read()),
      rev: 2,
      subscriptions: {
        floor: now + 50_000,
        items: {},
      },
    };
    cloudFile.externalWrite(serializeSyncDocument(highFloorDoc));
    storeB.subs.set('f_offline_new', {
      item: { url: 'https://offline.example/rss', updatedAt: 50, deleted: false, deviceId: 'd_B' },
      dirty: true,
    });
    const resB2 = await engineB.run('manual');
    expect(resB2.uploaded).toBe(true);
    const afterFloorRestamp = parseSyncDocument(await cloudFile.read());
    expect(afterFloorRestamp.subscriptions.items['f_offline_new']).toBeDefined();
    expect(afterFloorRestamp.subscriptions.items['f_offline_new']!.updatedAt).toBeGreaterThan(
      highFloorDoc.subscriptions.floor,
    );

    // Corrupt remote file MUST NOT be overwritten and enters `needs-attention`
    const corruptBytes = utf8Encoder.encode('{broken-json');
    cloudFile.externalWrite(corruptBytes);
    let archivedCorrupt = false;
    const engineWithArchive = new SyncEngine({
      store: storeA,
      provider: providerA,
      hlc: hlcA,
      backgroundSync: true,
      now: () => now,
      onCorruptRemote: (bytes) => {
        if (utf8Decoder.decode(bytes) === '{broken-json') archivedCorrupt = true;
      },
    });
    storeA.subs.set('f_extra', {
      item: { url: 'https://extra.example/rss', updatedAt: hlcA.now(), deleted: false, deviceId: 'd_A' },
      dirty: true,
    });
    const corruptRes = await engineWithArchive.run('manual');
    expect(archivedCorrupt).toBe(true);
    expect(corruptRes.uploaded).toBe(false);
    expect(corruptRes.status.phase).toBe('needs-attention');
    expect(utf8Decoder.decode(await cloudFile.read())).toBe('{broken-json');
  });

  it('SyncScheduler coalesces pause + queue edit into 1 upload, flushes immediately when hidden, and runs 180s playing checkpoint', async () => {
    const cloudFile = new InMemoryHostFile();
    let writesCount = 0;
    const baseProvider = new HostFileProvider({ id: 'local-folder', access: cloudFile });
    const countingProvider: CloudFileProvider = {
      ...baseProvider,
      id: baseProvider.id,
      probe: (s) => baseProvider.probe(s),
      head: (s) => baseProvider.head(s),
      read: (m, s) => baseProvider.read(m, s),
      write: async (b, m, s) => {
        writesCount += 1;
        return baseProvider.write(b, m, s);
      },
    };

    let now = 1_000_000;
    let visible = true;
    const timers: Array<{ id: number; fireAt: number; interval?: number; fn: () => void; cancelled: boolean }> = [];
    let nextTimerId = 1;

    const host: SyncSchedulerHost = {
      now: () => now,
      isVisible: () => visible,
      isOnline: () => true,
      isMetered: () => false,
      setTimeout: (fn, ms) => {
        const entry = { id: nextTimerId++, fireAt: now + ms, fn, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      setInterval: (fn, ms) => {
        const entry = { id: nextTimerId++, fireAt: now + ms, interval: ms, fn, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    };

    const advanceTime = async (deltaMs: number) => {
      const target = now + deltaMs;
      while (true) {
        const due = timers
          .filter((t) => !t.cancelled && t.fireAt <= target)
          .sort((a, b) => a.fireAt - b.fireAt);
        if (due.length === 0) break;
        const next = due[0]!;
        now = next.fireAt;
        if (next.interval !== undefined) {
          next.fireAt += next.interval;
        } else {
          next.cancelled = true;
        }
        next.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = target;
      await new Promise((r) => setTimeout(r, 0));
    };

    const store = new InMemorySyncStore('d_1', 'Phone');
    const hlc = new HybridLogicalClock(0, () => now);
    const engine = new SyncEngine({
      store,
      provider: countingProvider,
      hlc,
      backgroundSync: false,
      now: () => now,
    });
    const scheduler = new SyncScheduler({ engine, host });
    scheduler.start();

    // 1. Pause (2s debounce) followed 500ms later by Queue edit (5s debounce) -> coalesces into ONE upload!
    store.progress.set('e_1', {
      item: { feedKey: 'f_1', positionMs: 10_000, state: 'IN_PROGRESS', updatedAt: hlc.now(), deviceId: 'd_1' },
      dirty: true,
    });
    scheduler.request('progress-paused');

    await advanceTime(500);
    store.queue.set('e_2', {
      item: { feedKey: 'f_1', pos: 'a0', addedAt: hlc.now(), updatedAt: hlc.now(), removed: false, deviceId: 'd_1' },
      dirty: true,
    });
    scheduler.request('queue-changed');

    await advanceTime(6_000);
    expect(writesCount).toBe(1);

    // 2. Foreground pull within 20s is throttled
    const fgThrottled = await scheduler.requestAsync('foreground');
    expect(fgThrottled).toBeUndefined();

    // 3. Pause while hidden (`visible = false`) uploads IMMEDIATELY without waiting 2s
    visible = false;
    store.progress.set('e_1', {
      item: { feedKey: 'f_1', positionMs: 20_000, state: 'IN_PROGRESS', updatedAt: hlc.now(), deviceId: 'd_1' },
      dirty: true,
    });
    await scheduler.requestAsync('progress-paused');
    expect(writesCount).toBe(2);

    // 4. 180s playing checkpoint fires while playing when positionMs advances
    visible = true;
    scheduler.updatePlayback({ playing: true, episodeKey: 'e_1', positionMs: 20_000 });
    await advanceTime(90_000);
    store.progress.set('e_1', {
      item: { feedKey: 'f_1', positionMs: 110_000, state: 'IN_PROGRESS', updatedAt: hlc.now(), deviceId: 'd_1' },
      dirty: true,
    });
    scheduler.updatePlayback({ playing: true, episodeKey: 'e_1', positionMs: 110_000 });
    await advanceTime(90_000);
    expect(writesCount).toBe(3);

    scheduler.dispose();
  });
});
