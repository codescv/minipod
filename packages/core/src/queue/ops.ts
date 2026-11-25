import {
  QUEUE_MAX_ENTRIES,
  type DeviceId,
  type Episode,
  type EpisodeKey,
  type Feed,
  type FeedKey,
  type HlcMs,
  type QueueEntry,
  type QueueStub,
  type SyncQueueEntry,
} from '../types';
import {
  BASE62_DIGITS,
  compareQueueOrder,
  generateKeyBetween,
  generateNKeysBetween,
  needsKeyRebalance,
  validateOrderKey,
} from '../sync/fractional-index';
import type { HybridLogicalClock } from '../sync/hlc';

export interface QueueStampContext {
  readonly hlc: HybridLogicalClock;
  readonly deviceId: DeviceId;
}

export interface QueueItemInput {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly stub?: QueueStub;
}

export interface AutoAdvanceOptions {
  readonly sleepTimerExpired?: boolean;
}

/**
 * Builds a self-contained `QueueStub` from an `Episode` and `Feed` so devices that
 * have not yet refreshed the feed can still render and stream queued items (§7.1).
 */
export function buildQueueStub(
  episode: Pick<
    Episode,
    'identity' | 'title' | 'enclosureUrl' | 'enclosureMime' | 'durationMs' | 'imageUrl' | 'pubDate'
  >,
  feed: Pick<Feed, 'url' | 'title' | 'imageUrl'>,
): QueueStub {
  const imageUrl = episode.imageUrl?.trim() || feed.imageUrl?.trim() || undefined;
  return {
    identity: episode.identity,
    title: episode.title,
    feedUrl: feed.url,
    ...(feed.title ? { feedTitle: feed.title } : {}),
    ...(episode.enclosureUrl !== undefined ? { enclosureUrl: episode.enclosureUrl } : {}),
    ...(episode.enclosureMime !== undefined ? { enclosureMime: episode.enclosureMime } : {}),
    ...(episode.durationMs !== undefined ? { durationMs: episode.durationMs } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(episode.pubDate !== undefined ? { pubDate: episode.pubDate } : {}),
  };
}

export function toSyncQueueEntry(entry: QueueEntry): SyncQueueEntry {
  return {
    feedKey: entry.feedKey,
    pos: entry.pos,
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt,
    removed: entry.removed,
    deviceId: entry.deviceId,
    ...(!entry.removed && entry.stub !== undefined ? { stub: entry.stub } : {}),
  };
}

export function fromSyncQueueEntry(episodeKey: EpisodeKey, sync: SyncQueueEntry): QueueEntry {
  return {
    episodeKey,
    feedKey: sync.feedKey,
    pos: sync.pos,
    addedAt: sync.addedAt,
    updatedAt: sync.updatedAt,
    removed: sync.removed,
    deviceId: sync.deviceId,
    ...(!sync.removed && sync.stub !== undefined ? { stub: sync.stub } : {}),
  };
}

/**
 * Returns active (`!removed`) queue entries sorted deterministically by `(pos, addedAt, episodeKey)`.
 */
export function sortQueueEntries(entries: readonly QueueEntry[]): QueueEntry[] {
  return entries.filter((e) => !e.removed).sort(compareQueueOrder);
}

function findEntry(entries: readonly QueueEntry[], episodeKey: EpisodeKey): QueueEntry | undefined {
  return entries.find((e) => e.episodeKey === episodeKey);
}

function hasDuplicateOrOverlongPos(sortedActive: readonly QueueEntry[]): boolean {
  for (let i = 0; i < sortedActive.length; i++) {
    const cur = sortedActive[i]!;
    if (needsKeyRebalance(cur.pos)) return true;
    if (i > 0 && sortedActive[i - 1]!.pos >= cur.pos) return true;
  }
  return false;
}

/**
 * Re-spaces active queue entries evenly across short fractional-index keys whenever any
 * key exceeds 64 chars or two entries collided on the same `pos` from concurrent devices (§7.4).
 * Returns ONLY the entries whose `pos` changed, each stamped with `hlc.stamp(prev.updatedAt)`.
 */
export function rebalanceQueueIfNeeded(
  entries: readonly QueueEntry[],
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const active = sortQueueEntries(entries);
  if (active.length === 0 || !hasDuplicateOrOverlongPos(active)) {
    return [];
  }
  return forceRebalanceSorted(active, ctx);
}

function forceRebalanceSorted(
  orderedActive: readonly QueueEntry[],
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const freshKeys = generateNKeysBetween(null, null, orderedActive.length);
  const mutated: QueueEntry[] = [];
  for (let i = 0; i < orderedActive.length; i++) {
    const entry = orderedActive[i]!;
    const newPos = freshKeys[i]!;
    if (entry.pos !== newPos) {
      const updatedAt = ctx.hlc.stamp(entry.updatedAt);
      mutated.push({
        ...entry,
        pos: newPos,
        updatedAt,
        deviceId: ctx.deviceId,
      });
    }
  }
  return mutated;
}

function isValidOrderKey(pos: string): boolean {
  if (!pos) return false;
  try {
    validateOrderKey(pos);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives a deterministic 2-char Base-62 suffix whose trailing digit is never `'0'`
 * so appending it to any valid fractional-index key preserves `validateOrderKey`
 * and separates concurrent offline insertions from different devices (SYNC-P1-11).
 */
function deviceJitterSuffix(deviceId: DeviceId): string {
  // FNV-1a 32-bit hash + final avalanche mix
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const u = h >>> 0;
  const d1 = BASE62_DIGITS[u % 62]!;
  const d2 = BASE62_DIGITS[1 + (Math.floor(u / 62) % 61)]!;
  return `${d1}${d2}`;
}

/**
 * Generates a valid fractional-index key strictly between `a` and `b` with a
 * device-derived 2-char suffix so concurrent insertions at the head, tail, or
 * midpoint (`queuePlayNext`) from distinct devices do not collide on identical `pos`.
 */
function generateJitteredKeyBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  deviceId: DeviceId,
): string {
  const base = generateKeyBetween(a, b);
  const jitter = deviceJitterSuffix(deviceId);
  const candidate = base + jitter;
  if (b == null || candidate < b) {
    return candidate;
  }
  // `base` is a prefix of `b` (e.g. base = "a0", b = "a0V"); step strictly inside (base, b).
  const mid = generateKeyBetween(base, b);
  const midCandidate = mid + jitter;
  if (midCandidate < b) {
    return midCandidate;
  }
  const mid2 = generateKeyBetween(base, mid);
  const mid2Candidate = mid2 + jitter;
  if (mid2Candidate < b) {
    return mid2Candidate;
  }
  return mid;
}

function applyInsertionAtIndex(
  entries: readonly QueueEntry[],
  item: QueueItemInput,
  insertIndex: number,
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const existing = findEntry(entries, item.episodeKey);
  const othersActive = sortQueueEntries(
    entries.filter((e) => e.episodeKey !== item.episodeKey),
  );

  // Enforce hard active cap safety
  if (othersActive.length >= QUEUE_MAX_ENTRIES && (!existing || existing.removed)) {
    return [];
  }

  const clampedIdx = Math.max(0, Math.min(insertIndex, othersActive.length));
  const prevNeighbor = clampedIdx > 0 ? othersActive[clampedIdx - 1] : undefined;
  const nextNeighbor = clampedIdx < othersActive.length ? othersActive[clampedIdx] : undefined;

  const updatedAt: HlcMs = ctx.hlc.stamp(existing?.updatedAt);
  const addedAt: HlcMs =
    existing && !existing.removed ? existing.addedAt : updatedAt;
  const stub = item.stub ?? existing?.stub;

  const prevInvalid = prevNeighbor !== undefined && !isValidOrderKey(prevNeighbor.pos);
  const nextInvalid = nextNeighbor !== undefined && !isValidOrderKey(nextNeighbor.pos);
  const neighborsCollide =
    prevNeighbor !== undefined &&
    nextNeighbor !== undefined &&
    prevNeighbor.pos >= nextNeighbor.pos;

  // Localized repair for colliding neighbors or malformed neighbor keys (SYNC-P1-11, SYNC-P2-07).
  // Only re-keys the minimal contiguous colliding/invalid run `[runStart..runEnd]` so unrelated
  // queue items keep their original `pos` and `updatedAt` (no cross-device resurrection).
  if (prevInvalid || nextInvalid || neighborsCollide) {
    const placeholder: QueueEntry = {
      episodeKey: item.episodeKey,
      feedKey: item.feedKey,
      pos: prevNeighbor?.pos ?? nextNeighbor?.pos ?? 'a0',
      addedAt,
      updatedAt,
      removed: false,
      deviceId: ctx.deviceId,
      ...(stub !== undefined ? { stub } : {}),
    };

    let runStart = clampedIdx;
    let runEnd = clampedIdx - 1;
    if (prevInvalid || neighborsCollide) {
      runStart = Math.min(runStart, clampedIdx - 1);
      runEnd = Math.max(runEnd, clampedIdx - 1);
    }
    if (nextInvalid || neighborsCollide) {
      runStart = Math.min(runStart, clampedIdx);
      runEnd = Math.max(runEnd, clampedIdx);
    }

    const collidingPos = neighborsCollide ? prevNeighbor.pos : undefined;

    for (;;) {
      let expanded = false;
      while (runStart > 0) {
        const left = othersActive[runStart - 1]!;
        const firstInRun = runStart <= runEnd ? othersActive[runStart]! : undefined;
        const mustInclude =
          !isValidOrderKey(left.pos) ||
          (collidingPos !== undefined && left.pos === collidingPos) ||
          (firstInRun !== undefined && isValidOrderKey(firstInRun.pos) && left.pos >= firstInRun.pos);
        if (mustInclude) {
          runStart -= 1;
          expanded = true;
        } else {
          break;
        }
      }
      while (runEnd + 1 < othersActive.length) {
        const right = othersActive[runEnd + 1]!;
        const lastInRun = runStart <= runEnd ? othersActive[runEnd]! : undefined;
        const mustInclude =
          !isValidOrderKey(right.pos) ||
          (collidingPos !== undefined && right.pos === collidingPos) ||
          (lastInRun !== undefined && isValidOrderKey(lastInRun.pos) && lastInRun.pos >= right.pos);
        if (mustInclude) {
          runEnd += 1;
          expanded = true;
        } else {
          break;
        }
      }

      const leftBound = runStart > 0 ? othersActive[runStart - 1]!.pos : null;
      const rightBound =
        runEnd + 1 < othersActive.length ? othersActive[runEnd + 1]!.pos : null;
      if (leftBound !== null && rightBound !== null && leftBound >= rightBound) {
        if (runStart > 0) {
          runStart -= 1;
          expanded = true;
        } else if (runEnd + 1 < othersActive.length) {
          runEnd += 1;
          expanded = true;
        }
      }
      if (!expanded) break;
    }

    const leftBound = runStart > 0 ? othersActive[runStart - 1]!.pos : null;
    const rightBound =
      runEnd + 1 < othersActive.length ? othersActive[runEnd + 1]!.pos : null;

    const runEntries: QueueEntry[] = [
      ...othersActive.slice(runStart, clampedIdx),
      placeholder,
      ...othersActive.slice(clampedIdx, runEnd + 1),
    ];

    const freshKeys = generateNKeysBetween(leftBound, rightBound, runEntries.length);
    const anyOverlong = freshKeys.some((k) => needsKeyRebalance(k));
    if (!anyOverlong) {
      const out: QueueEntry[] = [];
      for (let i = 0; i < runEntries.length; i++) {
        const e = runEntries[i]!;
        const k = freshKeys[i]!;
        if (e.episodeKey === item.episodeKey) {
          out.push({ ...placeholder, pos: k });
        } else if (e.pos !== k) {
          out.push({
            ...e,
            pos: k,
            updatedAt: ctx.hlc.stamp(e.updatedAt),
            deviceId: ctx.deviceId,
          });
        }
      }
      return out;
    }

    // Fallback: keys inside the narrow colliding window exceeded max length -> full rebalance.
    const desiredOrder = [
      ...othersActive.slice(0, clampedIdx),
      placeholder,
      ...othersActive.slice(clampedIdx),
    ];
    const allKeys = generateNKeysBetween(null, null, desiredOrder.length);
    const out: QueueEntry[] = [];
    for (let i = 0; i < desiredOrder.length; i++) {
      const e = desiredOrder[i]!;
      const k = allKeys[i]!;
      if (e.episodeKey === item.episodeKey) {
        out.push({ ...placeholder, pos: k });
      } else if (e.pos !== k) {
        out.push({
          ...e,
          pos: k,
          updatedAt: ctx.hlc.stamp(e.updatedAt),
          deviceId: ctx.deviceId,
        });
      }
    }
    return out;
  }

  const pos = generateJitteredKeyBetween(
    prevNeighbor?.pos ?? null,
    nextNeighbor?.pos ?? null,
    ctx.deviceId,
  );
  const upserted: QueueEntry = {
    episodeKey: item.episodeKey,
    feedKey: item.feedKey,
    pos,
    addedAt,
    updatedAt,
    removed: false,
    deviceId: ctx.deviceId,
    ...(stub !== undefined ? { stub } : {}),
  };

  if (needsKeyRebalance(pos)) {
    const desiredOrder = [
      ...othersActive.slice(0, clampedIdx),
      upserted,
      ...othersActive.slice(clampedIdx),
    ];
    const freshKeys = generateNKeysBetween(null, null, desiredOrder.length);
    const out: QueueEntry[] = [];
    for (let i = 0; i < desiredOrder.length; i++) {
      const e = desiredOrder[i]!;
      const k = freshKeys[i]!;
      if (e.episodeKey === item.episodeKey) {
        out.push({ ...upserted, pos: k });
      } else if (e.pos !== k) {
        out.push({
          ...e,
          pos: k,
          updatedAt: ctx.hlc.stamp(e.updatedAt),
          deviceId: ctx.deviceId,
        });
      }
    }
    return out;
  }

  return [upserted];
}

/**
 * *Add to queue*: appends `item` at the tail (`pos = after(last)`).
 * Idempotent if `item.episodeKey` is already active in the queue.
 */
export function queueAdd(
  entries: readonly QueueEntry[],
  item: QueueItemInput,
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const existing = findEntry(entries, item.episodeKey);
  if (existing && !existing.removed) {
    return [];
  }
  const active = sortQueueEntries(entries);
  return applyInsertionAtIndex(entries, item, active.length, ctx);
}

/**
 * Playing an episode from anywhere puts it at the **head** of the queue if it is
 * not already queued (DESIGN.md §4.5).
 */
export function queueEnsureAtHead(
  entries: readonly QueueEntry[],
  item: QueueItemInput,
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const existing = findEntry(entries, item.episodeKey);
  if (existing && !existing.removed) {
    return [];
  }
  return applyInsertionAtIndex(entries, item, 0, ctx);
}

/**
 * *Play next*: inserts `item` right after the currently playing item (or right after
 * the current head at index 1; index 0 when the queue is empty), per ARCHITECTURE.md §4.5
 * (`pos = between(head, second)`).
 */
export function queuePlayNext(
  entries: readonly QueueEntry[],
  item: QueueItemInput,
  ctx: QueueStampContext,
  currentPlayingKey?: EpisodeKey,
): readonly QueueEntry[] {
  const othersActive = sortQueueEntries(
    entries.filter((e) => e.episodeKey !== item.episodeKey),
  );
  if (othersActive.length === 0) {
    return applyInsertionAtIndex(entries, item, 0, ctx);
  }
  if (currentPlayingKey !== undefined) {
    const playingIdx = othersActive.findIndex((e) => e.episodeKey === currentPlayingKey);
    if (playingIdx >= 0) {
      return applyInsertionAtIndex(entries, item, playingIdx + 1, ctx);
    }
  }
  return applyInsertionAtIndex(entries, item, 1, ctx);
}

/**
 * Reorders an existing active queue entry immediately before `beforeKey`
 * (`beforeKey === null` moves to the end of the queue).
 */
export function queueMove(
  entries: readonly QueueEntry[],
  episodeKey: EpisodeKey,
  beforeKey: EpisodeKey | null,
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  if (beforeKey === episodeKey) {
    return [];
  }
  const existing = findEntry(entries, episodeKey);
  if (!existing || existing.removed) {
    return [];
  }

  const othersActive = sortQueueEntries(
    entries.filter((e) => e.episodeKey !== episodeKey),
  );

  let targetIdx: number;
  if (beforeKey === null) {
    targetIdx = othersActive.length;
  } else {
    const foundIdx = othersActive.findIndex((e) => e.episodeKey === beforeKey);
    targetIdx = foundIdx >= 0 ? foundIdx : othersActive.length;
  }

  return applyInsertionAtIndex(
    entries,
    {
      episodeKey: existing.episodeKey,
      feedKey: existing.feedKey,
      ...(existing.stub !== undefined ? { stub: existing.stub } : {}),
    },
    targetIdx,
    ctx,
  );
}

/**
 * Soft-removes (`removed: true` tombstone, `stub` omitted per §7.1) an episode from the queue.
 */
export function queueRemove(
  entries: readonly QueueEntry[],
  episodeKey: EpisodeKey,
  ctx: QueueStampContext,
): QueueEntry | null {
  const existing = findEntry(entries, episodeKey);
  if (!existing || existing.removed) {
    return null;
  }
  const updatedAt = ctx.hlc.stamp(existing.updatedAt);
  return {
    episodeKey: existing.episodeKey,
    feedKey: existing.feedKey,
    pos: existing.pos,
    addedAt: existing.addedAt,
    updatedAt,
    removed: true,
    deviceId: ctx.deviceId,
  };
}

/**
 * Marks `finishedKey` removed when playback completes (`autoRemoveOnFinish`, §4.5).
 */
export function queueAutoRemoveOnFinish(
  entries: readonly QueueEntry[],
  finishedKey: EpisodeKey,
  ctx: QueueStampContext,
): QueueEntry | null {
  return queueRemove(entries, finishedKey, ctx);
}

/**
 * Tombstones every active entry in the queue (*Clear queue*).
 */
export function queueClear(
  entries: readonly QueueEntry[],
  ctx: QueueStampContext,
): readonly QueueEntry[] {
  const active = sortQueueEntries(entries);
  const tombstones: QueueEntry[] = [];
  for (const entry of active) {
    tombstones.push({
      episodeKey: entry.episodeKey,
      feedKey: entry.feedKey,
      pos: entry.pos,
      addedAt: entry.addedAt,
      updatedAt: ctx.hlc.stamp(entry.updatedAt),
      removed: true,
      deviceId: ctx.deviceId,
    });
  }
  return tombstones;
}

/**
 * Selects the next episode to auto-advance to when `finishedKey` completes (ARCHITECTURE.md §4.5).
 * Returns `null` when the queue has no remaining items or when a sleep timer expired.
 */
export function nextAutoAdvanceEpisode(
  entries: readonly Pick<QueueEntry, 'episodeKey' | 'pos' | 'addedAt' | 'removed'>[],
  finishedKey: EpisodeKey,
  options?: AutoAdvanceOptions,
): EpisodeKey | null {
  if (options?.sleepTimerExpired) {
    return null;
  }
  const remaining = entries
    .filter((e) => !e.removed && e.episodeKey !== finishedKey)
    .sort(compareQueueOrder);
  return remaining[0]?.episodeKey ?? null;
}

export const AutoAdvancePolicy = {
  next: nextAutoAdvanceEpisode,
} as const;
