import { describe, expect, it } from 'vitest';
import { HybridLogicalClock } from '../sync/hlc';
import type { QueueEntry } from '../types';
import {
  AutoAdvancePolicy,
  buildQueueStub,
  fromSyncQueueEntry,
  queueAdd,
  queueAutoRemoveOnFinish,
  queueClear,
  queueEnsureAtHead,
  queueMove,
  queuePlayNext,
  queueRemove,
  rebalanceQueueIfNeeded,
  sortQueueEntries,
  toSyncQueueEntry,
} from './index';

function applyChanges(current: readonly QueueEntry[], changed: readonly QueueEntry[]): QueueEntry[] {
  const byKey = new Map(current.map((e) => [e.episodeKey, e]));
  for (const c of changed) {
    byKey.set(c.episodeKey, c);
  }
  return [...byKey.values()];
}

describe('queue/ops & AutoAdvancePolicy', () => {
  it('supports add, ensureAtHead, playNext, move, remove, clear, and stub stripping on tombstone', () => {
    let wall = 1_000_000;
    const hlc = new HybridLogicalClock(0, () => wall);
    const ctx = { hlc, deviceId: 'd_dev1' };

    const stubA = buildQueueStub(
      { identity: 'id-a', title: 'Ep A', enclosureUrl: 'https://x/a.mp3', durationMs: 60_000 },
      { url: 'https://x/rss', title: 'Podcast X', imageUrl: 'https://x/cover.jpg' },
    );
    expect(stubA.imageUrl).toBe('https://x/cover.jpg');

    let state: QueueEntry[] = [];
    state = applyChanges(state, queueAdd(state, { episodeKey: 'e_a', feedKey: 'f_1', stub: stubA }, ctx));
    state = applyChanges(state, queueAdd(state, { episodeKey: 'e_b', feedKey: 'f_1' }, ctx));
    // Duplicate add is idempotent
    expect(queueAdd(state, { episodeKey: 'e_a', feedKey: 'f_1' }, ctx)).toEqual([]);

    expect(sortQueueEntries(state).map((e) => e.episodeKey)).toEqual(['e_a', 'e_b']);

    // Play next inserts right after head (`e_a`, `e_c`, `e_b`)
    state = applyChanges(state, queuePlayNext(state, { episodeKey: 'e_c', feedKey: 'f_1' }, ctx));
    expect(sortQueueEntries(state).map((e) => e.episodeKey)).toEqual(['e_a', 'e_c', 'e_b']);

    // Playing an unqueued episode puts it at head (`e_head`, `e_a`, `e_c`, `e_b`)
    state = applyChanges(state, queueEnsureAtHead(state, { episodeKey: 'e_head', feedKey: 'f_1' }, ctx));
    expect(sortQueueEntries(state).map((e) => e.episodeKey)).toEqual(['e_head', 'e_a', 'e_c', 'e_b']);

    // Move `e_b` before `e_a` -> (`e_head`, `e_b`, `e_a`, `e_c`)
    state = applyChanges(state, queueMove(state, 'e_b', 'e_a', ctx));
    expect(sortQueueEntries(state).map((e) => e.episodeKey)).toEqual(['e_head', 'e_b', 'e_a', 'e_c']);

    // Move `e_head` to end (`beforeKey = null`) -> (`e_b`, `e_a`, `e_c`, `e_head`)
    state = applyChanges(state, queueMove(state, 'e_head', null, ctx));
    expect(sortQueueEntries(state).map((e) => e.episodeKey)).toEqual(['e_b', 'e_a', 'e_c', 'e_head']);

    // Remove `e_a` creates tombstone without `stub`
    const removedA = queueRemove(state, 'e_a', ctx)!;
    expect(removedA.removed).toBe(true);
    expect(removedA.stub).toBeUndefined();
    expect(toSyncQueueEntry(removedA).stub).toBeUndefined();
    expect(fromSyncQueueEntry('e_a', toSyncQueueEntry(removedA))).toEqual(removedA);
    state = applyChanges(state, [removedA]);

    // Auto-advance when `e_b` finishes -> `e_c` (or `null` when sleep timer expired)
    expect(AutoAdvancePolicy.next(state, 'e_b')).toBe('e_c');
    expect(AutoAdvancePolicy.next(state, 'e_b', { sleepTimerExpired: true })).toBeNull();
    const finishTombstone = queueAutoRemoveOnFinish(state, 'e_b', ctx)!;
    state = applyChanges(state, [finishTombstone]);
    expect(AutoAdvancePolicy.next(state, 'e_b')).toBe('e_c');

    // Clear tombstones all remaining active items
    const cleared = queueClear(state, ctx);
    expect(cleared).toHaveLength(2);
    state = applyChanges(state, cleared);
    expect(sortQueueEntries(state)).toEqual([]);
  });

  it('gracefully rebalances duplicate fractional-index keys from concurrent multi-device inserts', () => {
    const hlc = new HybridLogicalClock(100, () => 200);
    const ctx = { hlc, deviceId: 'd_dev1' };
    // Simulate two entries that collided on `pos: 'a0'` from two offline devices
    const collided: QueueEntry[] = [
      { episodeKey: 'e_1', feedKey: 'f_1', pos: 'a0', addedAt: 10, updatedAt: 10, removed: false, deviceId: 'd_a' },
      { episodeKey: 'e_2', feedKey: 'f_1', pos: 'a0', addedAt: 20, updatedAt: 20, removed: false, deviceId: 'd_b' },
    ];

    // Inserting between `e_1` and `e_2` via `queuePlayNext` must NOT throw `a >= b`!
    const changed = queuePlayNext(collided, { episodeKey: 'e_mid', feedKey: 'f_1' }, ctx);
    const nextState = applyChanges(collided, changed);
    const ordered = sortQueueEntries(nextState);
    expect(ordered.map((e) => e.episodeKey)).toEqual(['e_1', 'e_mid', 'e_2']);
    expect(ordered[0]!.pos < ordered[1]!.pos && ordered[1]!.pos < ordered[2]!.pos).toBe(true);
    expect(rebalanceQueueIfNeeded(nextState, ctx)).toEqual([]);
  });
});
