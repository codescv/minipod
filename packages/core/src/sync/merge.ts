import {
  SYNC_SCHEMA_ID,
  SYNC_SCHEMA_VERSION,
  type DeviceId,
  type ProgressState,
  type SyncDevice,
  type SyncDocument,
  type SyncMap,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncSubscription,
} from '../types';
import { computeEntityMapsHlcMax } from './schema';

const PROGRESS_STATE_RANK: Readonly<Record<ProgressState, number>> = {
  NEW: 0,
  IN_PROGRESS: 1,
  PLAYED: 2,
};

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pickDevice(a: SyncDevice, b: SyncDevice): SyncDevice {
  if (a.lastSeenAt !== b.lastSeenAt) {
    return a.lastSeenAt > b.lastSeenAt ? a : b;
  }
  const byName = compareLex(a.name, b.name);
  if (byName !== 0) return byName < 0 ? a : b;
  return compareLex(a.app, b.app) <= 0 ? a : b;
}

export function pickSubscription(a: SyncSubscription, b: SyncSubscription): SyncSubscription {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  // Identical HLC tie-break (§7.5):
  // 1. Prefer `deleted === false`
  // 2. Smaller `deviceId`
  // 3. Deterministic lexicographical tie-break for pure commutativity/associativity
  let winner: SyncSubscription;
  let loser: SyncSubscription;
  if (a.deleted !== b.deleted) {
    winner = !a.deleted ? a : b;
    loser = !a.deleted ? b : a;
  } else if (a.deviceId !== b.deviceId) {
    winner = a.deviceId < b.deviceId ? a : b;
    loser = a.deviceId < b.deviceId ? b : a;
  } else {
    const jsonA = JSON.stringify([a.url, a.movedTo ?? '', a.title ?? '', a.imageUrl ?? '', a.hasCredentials ?? false]);
    const jsonB = JSON.stringify([b.url, b.movedTo ?? '', b.title ?? '', b.imageUrl ?? '', b.hasCredentials ?? false]);
    winner = jsonA <= jsonB ? a : b;
    loser = jsonA <= jsonB ? b : a;
  }

  // Carry `movedTo` from either record if the winner lacks one (§7.5 line 639)
  if (!winner.movedTo && loser.movedTo) {
    return { ...winner, movedTo: loser.movedTo };
  }
  return winner;
}

export function pickQueueEntry(a: SyncQueueEntry, b: SyncQueueEntry): SyncQueueEntry {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  // Identical HLC tie-break (§7.5):
  // 1. Prefer `removed === false`
  // 2. Smaller `deviceId`
  // 3. Deterministic tie-break (`pos`, `addedAt`, `feedKey`)
  if (a.removed !== b.removed) {
    return !a.removed ? a : b;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? a : b;
  }
  if (a.pos !== b.pos) {
    return a.pos < b.pos ? a : b;
  }
  if (a.addedAt !== b.addedAt) {
    return a.addedAt < b.addedAt ? a : b;
  }
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

export function pickProgress(a: SyncProgress, b: SyncProgress): SyncProgress {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  // Identical HLC tie-break (§7.5):
  // 1. Higher `rank(state)` (`PLAYED > IN_PROGRESS > NEW`)
  // 2. Larger `positionMs`
  // 3. Smaller `deviceId`
  const rankA = PROGRESS_STATE_RANK[a.state];
  const rankB = PROGRESS_STATE_RANK[b.state];
  if (rankA !== rankB) {
    return rankA > rankB ? a : b;
  }
  if (a.positionMs !== b.positionMs) {
    return a.positionMs > b.positionMs ? a : b;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? a : b;
  }
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

function mergeMap<T extends { readonly updatedAt: number }>(
  mapA: SyncMap<T>,
  mapB: SyncMap<T>,
  pick: (x: T, y: T) => T,
): SyncMap<T> {
  const floor = Math.max(mapA.floor, mapB.floor);
  const allKeys = new Set<string>([...Object.keys(mapA.items), ...Object.keys(mapB.items)]);
  const sortedKeys = [...allKeys].sort();

  const items: Record<string, T> = {};
  for (const key of sortedKeys) {
    const x = mapA.items[key];
    const y = mapB.items[key];

    if (x === undefined && y === undefined) continue;
    // Floor rule (§7.5): an entry known to only one side and at/below the other side's floor
    // was tombstoned-and-GC'd (or evicted) there -> drop instead of resurrecting.
    if (x === undefined) {
      if (y!.updatedAt <= mapA.floor) continue;
      items[key] = y!;
      continue;
    }
    if (y === undefined) {
      if (x.updatedAt <= mapB.floor) continue;
      items[key] = x;
      continue;
    }
    items[key] = pick(x, y);
  }

  return { floor, items };
}

/**
 * Pure, deterministic, commutative, associative, and idempotent state-based CRDT merge
 * of two `SyncDocument`s (ARCHITECTURE.md §7.5).
 *
 * Never reads wall clock, never mutates entity timestamps, and never increments `rev`
 * (`SyncEngine` stamps `rev`/`writtenAt`/`writtenBy` only when uploading).
 */
export function mergeSyncDocuments(a: SyncDocument, b: SyncDocument): SyncDocument {
  const deviceIds = [...new Set<DeviceId>([...Object.keys(a.devices), ...Object.keys(b.devices)])].sort();
  const devices: Record<DeviceId, SyncDevice> = {};
  for (const id of deviceIds) {
    const da = a.devices[id];
    const db = b.devices[id];
    if (da && db) {
      devices[id] = pickDevice(da, db);
    } else if (da) {
      devices[id] = da;
    } else if (db) {
      devices[id] = db;
    }
  }

  const subscriptions = mergeMap(a.subscriptions, b.subscriptions, pickSubscription);
  const queue = mergeMap(a.queue, b.queue, pickQueueEntry);
  const progress = mergeMap(a.progress, b.progress, pickProgress);

  const entityHlcMax = computeEntityMapsHlcMax({ subscriptions, queue, progress });
  const hlcMax = Math.max(a.hlcMax, b.hlcMax, entityHlcMax);

  // Commutative, associative, idempotent envelope preservation (`merge(a, a) == a`)
  const rev = Math.max(a.rev, b.rev);
  let writtenAt: number;
  let writtenBy: DeviceId;
  if (a.writtenAt !== b.writtenAt) {
    if (a.writtenAt > b.writtenAt) {
      writtenAt = a.writtenAt;
      writtenBy = a.writtenBy;
    } else {
      writtenAt = b.writtenAt;
      writtenBy = b.writtenBy;
    }
  } else {
    writtenAt = a.writtenAt;
    writtenBy = a.writtenBy <= b.writtenBy ? a.writtenBy : b.writtenBy;
  }

  return {
    schema: SYNC_SCHEMA_ID,
    schemaVersion: Math.max(a.schemaVersion, b.schemaVersion, SYNC_SCHEMA_VERSION),
    rev,
    writtenAt,
    writtenBy,
    hlcMax,
    devices,
    subscriptions,
    queue,
    progress,
  };
}
