import { describe, expect, it } from 'vitest';
import { HybridLogicalClock } from '../sync/hlc';
import type { ProgressSave } from '../types';
import {
  ProgressRecorder,
  computeResumePositionMs,
  fromSyncProgress,
  isEpisodeCompleted,
  stampMarkPlayed,
  stampProgressSave,
  stampUndoResume,
  toSyncProgress,
  type ProgressSaveTrigger,
} from './index';

describe('progress/ProgressRecorder & resume/completion rules', () => {
  it('enforces the 3-second resume rewind rule (not rewinding when < 3000ms, restarting PLAYED at 0)', () => {
    expect(computeResumePositionMs(undefined)).toBe(0);
    expect(computeResumePositionMs({ state: 'NEW', positionMs: 0 })).toBe(0);
    expect(computeResumePositionMs({ state: 'PLAYED', positionMs: 0 })).toBe(0);
    expect(computeResumePositionMs({ state: 'IN_PROGRESS', positionMs: 1_800 })).toBe(1_800);
    expect(computeResumePositionMs({ state: 'IN_PROGRESS', positionMs: 2_999 })).toBe(2_999);
    expect(computeResumePositionMs({ state: 'IN_PROGRESS', positionMs: 3_000 })).toBe(0);
    expect(computeResumePositionMs({ state: 'IN_PROGRESS', positionMs: 15_400 })).toBe(12_400);
  });

  it('enforces completion rule: ended OR (durationMs > 0 && positionMs >= durationMs - 1000)', () => {
    expect(isEpisodeCompleted({ positionMs: 59_000, durationMs: 60_000 })).toBe(true);
    expect(isEpisodeCompleted({ positionMs: 58_999, durationMs: 60_000 })).toBe(false);
    // Unknown / zero duration MUST NOT auto-complete on position alone
    expect(isEpisodeCompleted({ positionMs: 100_000, durationMs: 0 })).toBe(false);
    expect(isEpisodeCompleted({ positionMs: 100_000 })).toBe(false);
    expect(isEpisodeCompleted({ positionMs: 10_000, ended: true })).toBe(true);
  });

  it('stamps causal HLC updates for save, markPlayed, and undoResume', () => {
    const hlc = new HybridLogicalClock(1_000, () => 1_000);
    const first = stampProgressSave(
      { episodeKey: 'e_1', positionMs: 12_000, durationMs: 60_000, state: 'IN_PROGRESS' },
      { feedKey: 'f_1', hlc, deviceId: 'd_local' },
    );
    expect(first.state).toBe('IN_PROGRESS');
    expect(first.positionMs).toBe(12_000);

    // Simulate remote winning with skewed future timestamp 50_000
    const remoteSync = toSyncProgress({
      ...first,
      positionMs: 40_000,
      updatedAt: 50_000,
      deviceId: 'd_remote',
    }, 'guid-1');
    const remoteRec = fromSyncProgress('e_1', remoteSync);

    // Undo resume MUST stamp strictly > 50_000 so local revert wins
    const undone = stampUndoResume({
      episodeKey: 'e_1',
      feedKey: 'f_1',
      positionMs: 12_000,
      previous: remoteRec,
      hlc,
      deviceId: 'd_local',
    });
    expect(undone.updatedAt).toBe(50_001);
    expect(undone.positionMs).toBe(12_000);
    expect(undone.state).toBe('IN_PROGRESS');

    const markedPlayed = stampMarkPlayed({
      episodeKey: 'e_1',
      feedKey: 'f_1',
      played: true,
      previous: undone,
      hlc,
      deviceId: 'd_local',
    });
    expect(markedPlayed.state).toBe('PLAYED');
    expect(markedPlayed.positionMs).toBe(0);
    expect(markedPlayed.playedAt).toBe(50_002);
  });

  it('throttles playing ticks to 5s, saves immediately on pause/seek/flush, and completes within 1s of tail', () => {
    let now = 10_000;
    let visible = true;
    const saves: Array<{ save: ProgressSave; trigger: ProgressSaveTrigger }> = [];
    const completions: string[] = [];

    const recorder = new ProgressRecorder({
      now: () => now,
      isVisible: () => visible,
      onSave: (save, trigger) => {
        saves.push({ save, trigger });
      },
      onCompleted: (ep) => {
        completions.push(ep);
      },
    });

    recorder.handleEvent({
      type: 'state',
      snapshot: { episodeKey: 'e_1', playing: true, buffering: false, positionMs: 0, durationMs: 60_000, speed: 1 },
    });

    // First non-zero tick saves immediately
    now = 11_000;
    recorder.handleEvent({ type: 'position', episodeKey: 'e_1', positionMs: 1_000, durationMs: 60_000 });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.trigger).toBe('periodic');

    // Ticks at +1s..+4s are throttled; tick at +5s saves
    for (let step = 1; step <= 4; step++) {
      now = 11_000 + step * 1_000;
      recorder.handleEvent({
        type: 'position',
        episodeKey: 'e_1',
        positionMs: 1_000 + step * 1_000,
        durationMs: 60_000,
      });
    }
    expect(saves).toHaveLength(1);

    now = 16_000;
    recorder.handleEvent({ type: 'position', episodeKey: 'e_1', positionMs: 6_000, durationMs: 60_000 });
    expect(saves).toHaveLength(2);
    expect(saves[1]?.save.positionMs).toBe(6_000);

    // Explicit seek saves immediately
    now = 16_500;
    recorder.notifySeek(30_000, 60_000);
    expect(saves).toHaveLength(3);
    expect(saves[2]?.trigger).toBe('seek');
    expect(saves[2]?.save.positionMs).toBe(30_000);

    // Pause while hidden within 1s of tail (59_200 >= 60_000 - 1_000) -> completes with `flush: true`!
    visible = false;
    now = 17_000;
    recorder.handleEvent({
      type: 'state',
      snapshot: {
        episodeKey: 'e_1',
        playing: false,
        buffering: false,
        positionMs: 59_200,
        durationMs: 60_000,
        speed: 1,
      },
    });

    expect(saves).toHaveLength(4);
    expect(saves[3]).toEqual({
      trigger: 'completed',
      save: {
        episodeKey: 'e_1',
        positionMs: 0,
        durationMs: 60_000,
        state: 'PLAYED',
        flush: true,
      },
    });
    expect(completions).toEqual(['e_1']);

    // Subsequent `ended` event for the same load does NOT double-emit completion
    recorder.handleEvent({ type: 'ended', episodeKey: 'e_1' });
    expect(completions).toEqual(['e_1']);
  });
});
