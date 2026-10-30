/**
 * PlayerEngine contract re-exports & pure playback rules (speed presets,
 * 3-second resume rewind, 1-second completion tail, active chapter lookup).
 */
import {
  COMPLETION_TAIL_MS,
  RESUME_REWIND_MS,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  type Chapter,
  type MediaMetadataLite,
  type MediaSource,
  type PlayerEngine,
  type PlayerEngineCapabilities,
  type PlayerEvent,
  type PlayerLoadItem,
  type PlayerSnapshot,
  type ProgressRecord,
  type QueueItemSource,
  type SleepTimer,
  type SleepTimerState,
} from '@minipod/core';

export type {
  MediaMetadataLite,
  MediaSource,
  PlayerEngine,
  PlayerEngineCapabilities,
  PlayerEvent,
  PlayerLoadItem,
  PlayerSnapshot,
  QueueItemSource,
  SleepTimer,
  SleepTimerState,
};

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  return Math.round(clamped * 100) / 100;
}

/** Cycles `1.0 -> 1.25 -> 1.5 -> 1.75 -> 2.0 -> 1.0` (DESIGN.md §4.6). */
export function nextSpeedPreset(current: number): number {
  const rounded = Math.round(current * 100) / 100;
  for (let i = 0; i < SPEED_PRESETS.length; i++) {
    const preset = SPEED_PRESETS[i]!;
    if (Math.abs(preset - rounded) < 0.02) {
      return SPEED_PRESETS[(i + 1) % SPEED_PRESETS.length]!;
    }
  }
  const higher = SPEED_PRESETS.find((p) => p > rounded + 0.02);
  return higher ?? SPEED_PRESETS[0]!;
}

/**
 * Resume rule (DESIGN.md §5):
 * `IN_PROGRESS` resumes at `positionMs - 3000` (not applied when `< 3000 ms`).
 * `PLAYED` or `NEW` starts at `0`.
 */
export function computeResumePositionMs(progress: ProgressRecord | undefined): number {
  if (!progress || progress.state !== 'IN_PROGRESS') return 0;
  const pos = Math.max(0, Math.floor(progress.positionMs));
  return pos >= RESUME_REWIND_MS ? pos - RESUME_REWIND_MS : pos;
}

export function isEpisodeNearEnd(positionMs: number, durationMs: number | undefined): boolean {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return false;
  return positionMs >= Math.max(0, durationMs - COMPLETION_TAIL_MS);
}

/** Returns the index of the active chapter for `positionMs`, or `-1` when none. */
export function findActiveChapterIndex(chapters: readonly Chapter[], positionMs: number): number {
  if (chapters.length === 0) return -1;
  let active = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (positionMs >= chapters[i]!.startMs) {
      active = i;
    } else {
      break;
    }
  }
  return active >= 0 ? active : 0;
}
