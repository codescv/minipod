import {
  PROGRESS_MAX_ENTRIES,
  QUEUE_MAX_ENTRIES,
  SUBSCRIPTIONS_MAX_ENTRIES,
  TOMBSTONE_TTL_QUEUE_MS,
  TOMBSTONE_TTL_SUBSCRIPTIONS_MS,
  type DeviceId,
  type EpochMs,
  type HlcMs,
  type SyncDevice,
  type SyncDocument,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncSubscription,
} from '../types';
import { computeEntityMapsHlcMax } from './schema';

export interface SyncGcOptions {
  readonly nowMs: EpochMs;
  readonly writerDeviceId?: DeviceId;
  readonly subscriptionTombstoneTtlMs?: number;
  readonly queueTombstoneTtlMs?: number;
  readonly maxProgressEntries?: number;
  readonly maxQueueEntries?: number;
  readonly maxSubscriptionEntries?: number;
}

/**
 * Writer-side garbage collection of expired tombstones and excess `PLAYED` progress entries
 * (ARCHITECTURE.md §7.7).
 *
 * Rules:
 * 1. Device entries unseen for `> 180d` (except `writerDeviceId`) are dropped.
 * 2. Subscription tombstones (`deleted === true`) older than `180d` and Queue tombstones
 *    (`removed === true`) older than `30d` are GC'd **only** when every remaining device
 *    has `lastSeenAt > tombstone.updatedAt`, raising the map's `floor`.
 * 3. Progress entries exceeding `PROGRESS_MAX_ENTRIES` (`50_000`) evict oldest `PLAYED`
 *    entries first; `progress.floor` is raised only to
 *    `min(maxEvictedUpdatedAt, oldestRetainedNonPlayedUpdatedAt - 1)` so no retained
 *    `IN_PROGRESS` / `NEW` entry ever sits at or below `progress.floor`.
 */
export function gcSyncDocument(doc: SyncDocument, options: SyncGcOptions): SyncDocument {
  const nowMs = options.nowMs;
  const subTtl = options.subscriptionTombstoneTtlMs ?? TOMBSTONE_TTL_SUBSCRIPTIONS_MS;
  const queueTtl = options.queueTombstoneTtlMs ?? TOMBSTONE_TTL_QUEUE_MS;
  const maxProgress = options.maxProgressEntries ?? PROGRESS_MAX_ENTRIES;
  const maxQueue = options.maxQueueEntries ?? QUEUE_MAX_ENTRIES;
  const maxSubs = options.maxSubscriptionEntries ?? SUBSCRIPTIONS_MAX_ENTRIES;

  // 1. Prune stale devices (> 180d unseen)
  const devices: Record<DeviceId, SyncDevice> = {};
  for (const [id, dev] of Object.entries(doc.devices)) {
    if (id === options.writerDeviceId || nowMs - dev.lastSeenAt <= subTtl) {
      devices[id] = dev;
    }
  }
  const activeDeviceList = Object.values(devices);

  const allDevicesHaveSeen = (tombstoneUpdatedAt: HlcMs): boolean =>
    activeDeviceList.every((d) => d.lastSeenAt > tombstoneUpdatedAt);

  // 2. Subscriptions tombstone GC (180d) + hard cap safety
  let subFloor = doc.subscriptions.floor;
  const subEntries = Object.entries(doc.subscriptions.items);
  const retainedSubs: [string, SyncSubscription][] = [];
  for (const [key, sub] of subEntries) {
    if (
      sub.deleted &&
      nowMs - sub.updatedAt > subTtl &&
      allDevicesHaveSeen(sub.updatedAt)
    ) {
      if (sub.updatedAt > subFloor) subFloor = sub.updatedAt;
    } else {
      retainedSubs.push([key, sub]);
    }
  }

  // If still above hard cap (5,000), evict oldest tombstones first
  if (retainedSubs.length > maxSubs) {
    const tombstones = retainedSubs.filter(([, s]) => s.deleted).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = retainedSubs.length - maxSubs;
    const toDrop = new Set(tombstones.slice(0, excess).map(([k]) => k));
    const filtered: [string, SyncSubscription][] = [];
    for (const entry of retainedSubs) {
      if (toDrop.has(entry[0])) {
        if (entry[1].updatedAt > subFloor) subFloor = entry[1].updatedAt;
      } else {
        filtered.push(entry);
      }
    }
    retainedSubs.length = 0;
    retainedSubs.push(...filtered);
  }

  const subscriptionsItems: Record<string, SyncSubscription> = {};
  for (const [k, v] of retainedSubs) {
    subscriptionsItems[k] = v;
  }

  // 3. Queue tombstone GC (30d) + hard cap (1,000)
  let queueFloor = doc.queue.floor;
  const queueEntries = Object.entries(doc.queue.items);
  const retainedQueue: [string, SyncQueueEntry][] = [];
  for (const [key, q] of queueEntries) {
    if (
      q.removed &&
      nowMs - q.updatedAt > queueTtl &&
      allDevicesHaveSeen(q.updatedAt)
    ) {
      if (q.updatedAt > queueFloor) queueFloor = q.updatedAt;
    } else {
      retainedQueue.push([key, q]);
    }
  }

  if (retainedQueue.length > maxQueue) {
    const tombstones = retainedQueue.filter(([, q]) => q.removed).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = retainedQueue.length - maxQueue;
    const toDrop = new Set(tombstones.slice(0, excess).map(([k]) => k));
    const filtered: [string, SyncQueueEntry][] = [];
    for (const entry of retainedQueue) {
      if (toDrop.has(entry[0])) {
        if (entry[1].updatedAt > queueFloor) queueFloor = entry[1].updatedAt;
      } else {
        filtered.push(entry);
      }
    }
    retainedQueue.length = 0;
    retainedQueue.push(...filtered);
  }

  const queueItems: Record<string, SyncQueueEntry> = {};
  for (const [k, v] of retainedQueue) {
    queueItems[k] = v;
  }

  // 4. Progress cap eviction (50,000 entries; oldest PLAYED evicted first, preserving IN_PROGRESS/NEW above floor)
  let progressFloor = doc.progress.floor;
  const allProgress = Object.entries(doc.progress.items);
  let retainedProgress = allProgress;

  if (allProgress.length > maxProgress) {
    const excessCount = allProgress.length - maxProgress;
    const playedSorted = allProgress
      .filter(([, p]) => p.state === 'PLAYED')
      .sort((a, b) =>
        a[1].updatedAt !== b[1].updatedAt
          ? a[1].updatedAt - b[1].updatedAt
          : a[0] < b[0]
            ? -1
            : 1,
      );

    const evictedKeys = new Set<string>();
    let maxEvictedUpdatedAt = 0;

    for (let i = 0; i < playedSorted.length && evictedKeys.size < excessCount; i++) {
      const [k, p] = playedSorted[i]!;
      evictedKeys.add(k);
      if (p.updatedAt > maxEvictedUpdatedAt) {
        maxEvictedUpdatedAt = p.updatedAt;
      }
    }

    retainedProgress = allProgress.filter(([k]) => !evictedKeys.has(k));

    if (evictedKeys.size > 0) {
      let oldestRetainedActive = Number.POSITIVE_INFINITY;
      for (const [, p] of retainedProgress) {
        if (p.state !== 'PLAYED' && p.updatedAt < oldestRetainedActive) {
          oldestRetainedActive = p.updatedAt;
        }
        // Also ensure no retained PLAYED entry sits <= new floor
        if (p.updatedAt < oldestRetainedActive) {
          oldestRetainedActive = p.updatedAt;
        }
      }

      const ceiling = Number.isFinite(oldestRetainedActive)
        ? Math.max(0, oldestRetainedActive - 1)
        : maxEvictedUpdatedAt;
      const candidateFloor = Math.min(maxEvictedUpdatedAt, ceiling);
      if (candidateFloor > progressFloor) {
        progressFloor = candidateFloor;
      }
    }
  }

  const progressItems: Record<string, SyncProgress> = {};
  for (const [k, v] of retainedProgress) {
    progressItems[k] = v;
  }

  const subscriptions = { floor: subFloor, items: subscriptionsItems };
  const queue = { floor: queueFloor, items: queueItems };
  const progress = { floor: progressFloor, items: progressItems };

  const hlcMax = Math.max(doc.hlcMax, computeEntityMapsHlcMax({ subscriptions, queue, progress }));

  return {
    ...doc,
    hlcMax,
    devices,
    subscriptions,
    queue,
    progress,
  };
}
