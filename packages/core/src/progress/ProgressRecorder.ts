import {
  COMPLETION_TAIL_MS,
  LOCAL_PROGRESS_INTERVAL_MS,
  RESUME_REWIND_MS,
  type DeviceId,
  type EpochMs,
  type EpisodeKey,
  type FeedKey,
  type PlayerEngine,
  type PlayerEvent,
  type ProgressRecord,
  type ProgressSave,
  type SyncProgress,
  type Unsubscribe,
} from '../types';
import type { HybridLogicalClock } from '../sync/hlc';

export interface CompletionCheckInput {
  readonly positionMs: number;
  readonly durationMs?: number | undefined;
  readonly ended?: boolean | undefined;
}

/**
 * Determines whether playback has reached completion (ARCHITECTURE.md §4.5, DESIGN.md §5):
 * `ended === true` OR (`durationMs > 0` AND `positionMs >= durationMs - 1000`).
 */
export function isEpisodeCompleted(input: CompletionCheckInput): boolean {
  if (input.ended) {
    return true;
  }
  if (input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs > 0) {
    return input.positionMs >= input.durationMs - COMPLETION_TAIL_MS;
  }
  return false;
}

/**
 * Computes the playback start position for an episode (ARCHITECTURE.md §4.5, DESIGN.md §5):
 * - `IN_PROGRESS`: `positionMs - 3000` when `positionMs >= 3000`, else `positionMs` (no rewind < 3 s).
 * - `PLAYED` / `NEW` / absent: `0`.
 */
export function computeResumePositionMs(
  record: Pick<ProgressRecord, 'state' | 'positionMs'> | null | undefined,
): number {
  if (!record || record.state !== 'IN_PROGRESS') {
    return 0;
  }
  const pos = Math.max(0, Math.trunc(record.positionMs));
  if (pos < RESUME_REWIND_MS) {
    return pos;
  }
  return pos - RESUME_REWIND_MS;
}

export interface StampProgressSaveOptions {
  readonly feedKey: FeedKey;
  readonly hlc: HybridLogicalClock;
  readonly deviceId: DeviceId;
  readonly previous?: ProgressRecord | undefined;
  readonly ended?: boolean | undefined;
}

/**
 * Applies completion policy and HLC causal stamping (`max(hlc.now(), prev.updatedAt + 1)`)
 * to a `ProgressSave` input, producing a persisted `ProgressRecord`.
 */
export function stampProgressSave(
  save: ProgressSave,
  options: StampProgressSaveOptions,
): ProgressRecord {
  const durationMs = save.durationMs ?? options.previous?.durationMs;
  const completed =
    save.state === 'PLAYED' ||
    isEpisodeCompleted({
      positionMs: save.positionMs,
      durationMs,
      ended: options.ended,
    });

  const updatedAt = options.hlc.stamp(options.previous?.updatedAt);

  if (completed) {
    return {
      episodeKey: save.episodeKey,
      feedKey: options.feedKey,
      positionMs: 0,
      state: 'PLAYED',
      playedAt: updatedAt,
      updatedAt,
      deviceId: options.deviceId,
      ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
    };
  }

  if (save.state === 'NEW' && save.positionMs <= 0) {
    return {
      episodeKey: save.episodeKey,
      feedKey: options.feedKey,
      positionMs: 0,
      state: 'NEW',
      updatedAt,
      deviceId: options.deviceId,
      ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
    };
  }

  const clampedPos = Math.max(0, Math.trunc(save.positionMs));
  return {
    episodeKey: save.episodeKey,
    feedKey: options.feedKey,
    positionMs: clampedPos,
    state: clampedPos > 0 ? 'IN_PROGRESS' : save.state,
    updatedAt,
    deviceId: options.deviceId,
    ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
  };
}

export interface StampMarkPlayedOptions {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly played: boolean;
  readonly hlc: HybridLogicalClock;
  readonly deviceId: DeviceId;
  readonly previous?: ProgressRecord | undefined;
  readonly durationMs?: number | undefined;
}

export function stampMarkPlayed(options: StampMarkPlayedOptions): ProgressRecord {
  const updatedAt = options.hlc.stamp(options.previous?.updatedAt);
  const durationMs = options.durationMs ?? options.previous?.durationMs;
  if (options.played) {
    return {
      episodeKey: options.episodeKey,
      feedKey: options.feedKey,
      positionMs: 0,
      state: 'PLAYED',
      playedAt: updatedAt,
      updatedAt,
      deviceId: options.deviceId,
      ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
    };
  }
  return {
    episodeKey: options.episodeKey,
    feedKey: options.feedKey,
    positionMs: 0,
    state: 'NEW',
    updatedAt,
    deviceId: options.deviceId,
    ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
  };
}

export interface StampUndoResumeOptions {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly positionMs: number;
  readonly hlc: HybridLogicalClock;
  readonly deviceId: DeviceId;
  readonly previous?: ProgressRecord | undefined;
  readonly durationMs?: number | undefined;
}

/**
 * Stamps a local undo-resume `ProgressRecord` with `max(hlc.now(), previous.updatedAt + 1)`
 * so the reverted local position deterministically beats the remote resume position (§7.6).
 */
export function stampUndoResume(options: StampUndoResumeOptions): ProgressRecord {
  const updatedAt = options.hlc.stamp(options.previous?.updatedAt);
  const pos = Math.max(0, Math.trunc(options.positionMs));
  const durationMs = options.durationMs ?? options.previous?.durationMs;
  return {
    episodeKey: options.episodeKey,
    feedKey: options.feedKey,
    positionMs: pos,
    state: pos > 0 ? 'IN_PROGRESS' : 'NEW',
    updatedAt,
    deviceId: options.deviceId,
    ...(durationMs !== undefined ? { durationMs: Math.trunc(durationMs) } : {}),
  };
}

export function toSyncProgress(record: ProgressRecord, identity?: string): SyncProgress {
  return {
    feedKey: record.feedKey,
    positionMs: record.positionMs,
    state: record.state,
    updatedAt: record.updatedAt,
    deviceId: record.deviceId,
    ...(identity !== undefined ? { identity } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.playedAt !== undefined ? { playedAt: record.playedAt } : { playedAt: null }),
  };
}

export function fromSyncProgress(episodeKey: EpisodeKey, sync: SyncProgress): ProgressRecord {
  return {
    episodeKey,
    feedKey: sync.feedKey,
    positionMs: sync.positionMs,
    state: sync.state,
    updatedAt: sync.updatedAt,
    deviceId: sync.deviceId,
    ...(sync.durationMs !== undefined ? { durationMs: sync.durationMs } : {}),
    ...(typeof sync.playedAt === 'number' ? { playedAt: sync.playedAt } : {}),
  };
}

export type ProgressSaveTrigger = 'periodic' | 'pause' | 'seek' | 'completed' | 'flush';

export interface ProgressRecorderDeps {
  readonly onSave: (save: ProgressSave, trigger: ProgressSaveTrigger) => void | Promise<void>;
  readonly onCompleted?: (episodeKey: EpisodeKey) => void | Promise<void>;
  readonly now?: () => EpochMs;
  readonly isVisible?: () => boolean;
  readonly saveIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Pure playback progress policy driven by `PlayerEngine` events (ARCHITECTURE.md §4.5, DESIGN.md §5).
 *
 * - Persists locally every `5_000` ms while playing (`'periodic'`), and immediately on
 *   pause/stop (`'pause'`), seek (`'seek'`), ended/tail-threshold (`'completed'`), and `flush()`/`dispose()`.
 * - Applies completion rule (`ended` OR `durationMs > 0 && positionMs >= durationMs - 1000`)
 *   at pause/stop/ended, resetting `positionMs = 0` and transitioning `state = 'PLAYED'`.
 */
export class ProgressRecorder {
  private readonly onSave: (save: ProgressSave, trigger: ProgressSaveTrigger) => void | Promise<void>;
  private readonly onCompleted?: (episodeKey: EpisodeKey) => void | Promise<void>;
  private readonly now: () => EpochMs;
  private readonly isVisible: () => boolean;
  private readonly saveIntervalMs: number;
  private readonly onError?: (error: unknown) => void;

  private engineUnsub: Unsubscribe | null = null;
  private currentEpisodeKey: EpisodeKey | undefined;
  private currentPlaying = false;
  private currentPositionMs = 0;
  private currentDurationMs: number | undefined;

  private lastSavedEpisodeKey: EpisodeKey | undefined;
  private lastSavedPositionMs = -1;
  private lastSavedAt: EpochMs = 0;
  private completedForCurrentLoad = false;

  constructor(deps: ProgressRecorderDeps) {
    this.onSave = deps.onSave;
    this.now = deps.now ?? Date.now;
    this.isVisible = deps.isVisible ?? (() => true);
    this.saveIntervalMs = deps.saveIntervalMs ?? LOCAL_PROGRESS_INTERVAL_MS;
    if (deps.onCompleted !== undefined) {
      this.onCompleted = deps.onCompleted;
    }
    if (deps.onError !== undefined) {
      this.onError = deps.onError;
    }
  }

  /**
   * Subscribes to a `PlayerEngine` and returns an `Unsubscribe` function.
   */
  attach(engine: Pick<PlayerEngine, 'subscribe' | 'getSnapshot'>): Unsubscribe {
    this.detach();
    const initial = engine.getSnapshot();
    this.currentEpisodeKey = initial.episodeKey;
    this.currentPlaying = initial.playing;
    this.currentPositionMs = initial.positionMs;
    this.currentDurationMs = initial.durationMs;

    this.engineUnsub = engine.subscribe((event) => {
      this.handleEvent(event);
    });
    return () => {
      this.detach();
    };
  }

  detach(): void {
    if (this.engineUnsub) {
      this.engineUnsub();
      this.engineUnsub = null;
    }
  }

  handleEvent(event: PlayerEvent): void {
    switch (event.type) {
      case 'position': {
        if (event.episodeKey !== this.currentEpisodeKey) {
          this.currentEpisodeKey = event.episodeKey;
          this.completedForCurrentLoad = false;
        }
        const prevPos = this.currentPositionMs;
        this.currentPositionMs = Math.max(0, Math.trunc(event.positionMs));
        if (event.durationMs !== undefined && event.durationMs > 0) {
          this.currentDurationMs = Math.trunc(event.durationMs);
        }

        if (this.completedForCurrentLoad) {
          return;
        }

        const nowMs = this.now();
        // Detect nonlinear jump (> 3.5s delta in a 1s position tick) as a seek
        const elapsedSinceSave = nowMs - this.lastSavedAt;
        const jumped =
          this.lastSavedEpisodeKey === event.episodeKey &&
          Math.abs(this.currentPositionMs - prevPos) >= 3_500 &&
          elapsedSinceSave < this.saveIntervalMs;

        if (jumped) {
          this.emitProgressSave(event.episodeKey, this.currentPositionMs, this.currentDurationMs, 'seek', false);
          return;
        }

        if (
          this.currentPlaying &&
          (this.lastSavedEpisodeKey !== event.episodeKey || elapsedSinceSave >= this.saveIntervalMs) &&
          this.currentPositionMs !== this.lastSavedPositionMs
        ) {
          this.emitProgressSave(
            event.episodeKey,
            this.currentPositionMs,
            this.currentDurationMs,
            'periodic',
            false,
          );
        }
        break;
      }

      case 'state': {
        const snap = event.snapshot;
        const prevKey = this.currentEpisodeKey;
        const wasPlaying = this.currentPlaying;
        const prevPos = this.currentPositionMs;
        const prevDur = this.currentDurationMs;

        // If switching away from an active episode while playing/unsaved, flush previous episode first
        if (prevKey !== undefined && snap.episodeKey !== prevKey && !this.completedForCurrentLoad) {
          if (wasPlaying || prevPos !== this.lastSavedPositionMs) {
            this.finalizePauseOrStop(prevKey, prevPos, prevDur);
          }
        }

        if (snap.episodeKey !== prevKey) {
          this.currentEpisodeKey = snap.episodeKey;
          this.completedForCurrentLoad = false;
          this.lastSavedPositionMs = -1;
        }

        this.currentPlaying = snap.playing;
        this.currentPositionMs = Math.max(0, Math.trunc(snap.positionMs));
        if (snap.durationMs !== undefined && snap.durationMs > 0) {
          this.currentDurationMs = Math.trunc(snap.durationMs);
        }

        if (snap.episodeKey === undefined || this.completedForCurrentLoad) {
          break;
        }

        if (wasPlaying && !snap.playing && snap.episodeKey === prevKey) {
          this.finalizePauseOrStop(snap.episodeKey, this.currentPositionMs, this.currentDurationMs);
        } else if (
          !snap.playing &&
          snap.episodeKey === prevKey &&
          this.lastSavedEpisodeKey === snap.episodeKey &&
          Math.abs(this.currentPositionMs - this.lastSavedPositionMs) >= 500
        ) {
          // Seek while paused
          this.emitProgressSave(
            snap.episodeKey,
            this.currentPositionMs,
            this.currentDurationMs,
            'seek',
            false,
          );
        }
        break;
      }

      case 'ended': {
        this.currentPlaying = false;
        if (!this.completedForCurrentLoad || this.currentEpisodeKey !== event.episodeKey) {
          this.emitCompleted(
            event.episodeKey,
            event.episodeKey === this.currentEpisodeKey ? this.currentDurationMs : undefined,
          );
        }
        break;
      }

      case 'nativeAdvanced': {
        if (!this.completedForCurrentLoad || this.currentEpisodeKey !== event.from) {
          this.emitCompleted(
            event.from,
            event.from === this.currentEpisodeKey ? this.currentDurationMs : undefined,
          );
        }
        this.currentEpisodeKey = event.to;
        this.currentPositionMs = 0;
        this.currentDurationMs = undefined;
        this.completedForCurrentLoad = false;
        this.lastSavedPositionMs = -1;
        break;
      }

      case 'error':
      case 'sleepTimer':
        break;
    }
  }

  /**
   * Explicit seek notification hook for callers that want deterministic immediate seek saves
   * without waiting for the next `PlayerEvent`.
   */
  notifySeek(positionMs: number, durationMs?: number): void {
    if (!this.currentEpisodeKey) return;
    this.currentPositionMs = Math.max(0, Math.trunc(positionMs));
    if (durationMs !== undefined && durationMs > 0) {
      this.currentDurationMs = Math.trunc(durationMs);
    }
    this.completedForCurrentLoad = false;
    this.emitProgressSave(
      this.currentEpisodeKey,
      this.currentPositionMs,
      this.currentDurationMs,
      'seek',
      !this.isVisible(),
    );
  }

  /**
   * Immediately persists any unsaved progress (e.g. on `pagehide` or before shutdown).
   */
  flush(): void {
    const epKey = this.currentEpisodeKey;
    if (!epKey || this.completedForCurrentLoad) return;

    if (
      isEpisodeCompleted({
        positionMs: this.currentPositionMs,
        durationMs: this.currentDurationMs,
        ended: false,
      })
    ) {
      this.emitCompleted(epKey, this.currentDurationMs);
      return;
    }

    if (this.currentPositionMs > 0 && this.currentPositionMs !== this.lastSavedPositionMs) {
      this.emitProgressSave(
        epKey,
        this.currentPositionMs,
        this.currentDurationMs,
        'flush',
        true,
      );
    }
  }

  dispose(): void {
    this.flush();
    this.detach();
  }

  private finalizePauseOrStop(
    episodeKey: EpisodeKey,
    positionMs: number,
    durationMs: number | undefined,
  ): void {
    if (isEpisodeCompleted({ positionMs, durationMs, ended: false })) {
      this.emitCompleted(episodeKey, durationMs);
      return;
    }
    const flushNow = !this.isVisible();
    this.emitProgressSave(episodeKey, positionMs, durationMs, 'pause', flushNow);
  }

  private emitCompleted(episodeKey: EpisodeKey, durationMs: number | undefined): void {
    this.completedForCurrentLoad = true;
    this.lastSavedEpisodeKey = episodeKey;
    this.lastSavedPositionMs = 0;
    this.lastSavedAt = this.now();

    const flushNow = !this.isVisible();
    const save: ProgressSave = {
      episodeKey,
      positionMs: 0,
      state: 'PLAYED',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(flushNow ? { flush: true } : {}),
    };

    this.invokeCallback(() => this.onSave(save, 'completed'));
    if (this.onCompleted) {
      this.invokeCallback(() => this.onCompleted!(episodeKey));
    }
  }

  private emitProgressSave(
    episodeKey: EpisodeKey,
    positionMs: number,
    durationMs: number | undefined,
    trigger: ProgressSaveTrigger,
    flushNow: boolean,
  ): void {
    const clampedPos = Math.max(0, Math.trunc(positionMs));
    if (clampedPos === 0 && this.lastSavedEpisodeKey !== episodeKey) {
      // Avoid writing spurious `0ms` before playback actually advances
      return;
    }

    this.lastSavedEpisodeKey = episodeKey;
    this.lastSavedPositionMs = clampedPos;
    this.lastSavedAt = this.now();

    const save: ProgressSave = {
      episodeKey,
      positionMs: clampedPos,
      state: clampedPos > 0 ? 'IN_PROGRESS' : 'NEW',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(flushNow ? { flush: true } : {}),
    };

    this.invokeCallback(() => this.onSave(save, trigger));
  }

  private invokeCallback(fn: () => void | Promise<void>): void {
    try {
      const res = fn();
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((err) => {
          this.onError?.(err);
        });
      }
    } catch (err) {
      this.onError?.(err);
    }
  }
}
