/**
 * Sleep timer controller for JS playback engines (`HtmlAudioEngine` & `MockPlayerEngine`).
 * Supports `15 / 30 / 45 / 60 min`, `endOfEpisode`, `endOfChapter`, and `off`,
 * with a linear 60-second volume fade-out in the final minute (DESIGN.md §4.6).
 */
import type { SleepTimer, SleepTimerState, Unsubscribe } from '@minipod/core';

export const SLEEP_FADE_WINDOW_MS = 60_000;

export interface SleepTimerCallbacks {
  onVolumeFactor(factor: number): void;
  onExpire(): void;
  onStateChange(state: SleepTimerState): void;
}

export class SleepTimerController {
  private timer: SleepTimer = { mode: 'off' };
  private deadlineMs: number | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private expiredRecently = false;
  private readonly now: () => number;

  constructor(
    private readonly callbacks: SleepTimerCallbacks,
    options?: { readonly now?: () => number },
  ) {
    this.now = options?.now ?? (() => Date.now());
  }

  getState(currentPositionMs = 0): SleepTimerState {
    if (this.timer.mode === 'off') {
      return { timer: this.timer };
    }
    if (this.timer.mode === 'minutes' && this.deadlineMs !== null) {
      return {
        timer: this.timer,
        remainingMs: Math.max(0, this.deadlineMs - this.now()),
      };
    }
    if (this.timer.mode === 'endOfChapter') {
      return {
        timer: this.timer,
        remainingMs: Math.max(0, this.timer.chapterEndMs - currentPositionMs),
      };
    }
    return { timer: this.timer };
  }

  set(next: SleepTimer, currentPositionMs = 0): void {
    this.clearIntervalTimer();
    this.expiredRecently = false;
    this.timer = next;
    this.deadlineMs = null;
    this.callbacks.onVolumeFactor(1);

    if (next.mode === 'minutes') {
      const durationMs = Math.max(1, next.minutes) * 60_000;
      this.deadlineMs = this.now() + durationMs;
      this.intervalId = setInterval(() => this.tickCountdown(), 500);
    }

    this.callbacks.onStateChange(this.getState(currentPositionMs));
  }

  /** Called manually in tests or every 500ms in real time for `'minutes'` mode. */
  tickCountdown(): void {
    if (this.timer.mode !== 'minutes' || this.deadlineMs === null) return;
    const remainingMs = this.deadlineMs - this.now();
    if (remainingMs <= 0) {
      this.expire();
      return;
    }
    const factor =
      remainingMs < SLEEP_FADE_WINDOW_MS ? Math.max(0.05, remainingMs / SLEEP_FADE_WINDOW_MS) : 1;
    this.callbacks.onVolumeFactor(factor);
    this.callbacks.onStateChange({ timer: this.timer, remainingMs });
  }

  /** Called on playback position updates to enforce `'endOfChapter'` and its fade-out. */
  onPosition(positionMs: number): void {
    if (this.timer.mode !== 'endOfChapter') return;
    const remainingMs = this.timer.chapterEndMs - positionMs;
    if (remainingMs <= 0) {
      this.expire();
      return;
    }
    const factor =
      remainingMs < SLEEP_FADE_WINDOW_MS ? Math.max(0.05, remainingMs / SLEEP_FADE_WINDOW_MS) : 1;
    this.callbacks.onVolumeFactor(factor);
    this.callbacks.onStateChange({ timer: this.timer, remainingMs });
  }

  /** Called when an episode finishes; returns `true` if `'endOfEpisode'` consumed it (suppressing auto-advance). */
  onEpisodeEnded(): boolean {
    if (this.timer.mode === 'endOfEpisode') {
      this.expire();
      return true;
    }
    return false;
  }

  consumeExpiredFlag(): boolean {
    const was = this.expiredRecently;
    this.expiredRecently = false;
    return was;
  }

  dispose(): void {
    this.clearIntervalTimer();
  }

  private expire(): void {
    this.clearIntervalTimer();
    this.deadlineMs = null;
    this.timer = { mode: 'off' };
    this.expiredRecently = true;
    this.callbacks.onVolumeFactor(1);
    this.callbacks.onExpire();
    this.callbacks.onStateChange({ timer: { mode: 'off' } });
  }

  private clearIntervalTimer(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export function subscribeSleepTimerHelper(
  controller: SleepTimerController,
  cb: () => void,
): Unsubscribe {
  void controller;
  return cb;
}
