/**
 * `NativeAudioEngine`: `PlayerEngine` implementation over `MiniPodPlugin.media`
 * driving Android's Media3 `PlaybackService` (`ARCHITECTURE.md §3.2`, `§3.3`, `§5.1`).
 *
 * - `capabilities = { video: false, background: true, nativeQueue: true }`.
 * - Maps native `media-state`, `media-ended`, `media-error`, `sleep-timer-state`
 *   events into `PlayerEvent`s (`state`, `position`, `ended`, `error`, `sleepTimer`, `nativeAdvanced`).
 * - Triggers `onHiddenFlushNeeded` immediately when playback pauses or ends while
 *   `document.visibilityState === 'hidden'` so `CapacitorPlatformHost` can push
 *   progress inside the service's 15 s `PARTIAL_WAKE_LOCK` window.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import {
  SPEED_MAX,
  SPEED_MIN,
  type EpisodeKey,
  type PlayerEngine,
  type PlayerEngineCapabilities,
  type PlayerEvent,
  type PlayerLoadItem,
  type PlayerSnapshot,
  type QueueItemSource,
  type SleepTimer,
  type SleepTimerState,
  type Unsubscribe,
} from '@minipod/core';
import type {
  MiniPodPlugin,
  NativeMediaEndedPayload,
  NativeMediaErrorPayload,
  NativeMediaStatePayload,
  NativeSleepTimerPayload,
} from '../plugin-types';

export interface NativeAudioEngineOptions {
  readonly plugin: Pick<MiniPodPlugin, 'media' | 'addListener'>;
  readonly isVisible?: () => boolean;
  /** Invoked on native `media-state` / `media-ended` so the host can reconcile journal entries. */
  readonly onNativeActivity?: () => void;
  /** Invoked when pause/ended arrives while `!isVisible()` inside the 15s native wake lock. */
  readonly onHiddenFlushNeeded?: (reason: 'paused' | 'ended') => void;
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(speed * 100) / 100));
}

function mapSleepTimerPayload(payload: NativeSleepTimerPayload): SleepTimerState {
  let timer: SleepTimer;
  switch (payload.mode) {
    case 'minutes':
      timer = { mode: 'minutes', minutes: payload.minutes ?? 15 };
      break;
    case 'endOfEpisode':
      timer = { mode: 'endOfEpisode' };
      break;
    case 'endOfChapter':
      timer = { mode: 'endOfChapter', chapterEndMs: payload.chapterEndMs ?? 0 };
      break;
    case 'off':
    default:
      timer = { mode: 'off' };
      break;
  }
  return {
    timer,
    ...(payload.remainingMs !== undefined ? { remainingMs: payload.remainingMs } : {}),
  };
}

export class NativeAudioEngine implements PlayerEngine {
  readonly capabilities: PlayerEngineCapabilities = {
    video: false,
    background: true,
    nativeQueue: true,
  };

  private readonly plugin: Pick<MiniPodPlugin, 'media' | 'addListener'>;
  private readonly isVisible: () => boolean;
  private readonly onNativeActivity?: () => void;
  private readonly onHiddenFlushNeeded?: (reason: 'paused' | 'ended') => void;
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly handles: PluginListenerHandle[] = [];

  private snapshot: PlayerSnapshot = {
    playing: false,
    buffering: false,
    positionMs: 0,
    speed: 1.0,
  };

  private requestedEpisodeKey: EpisodeKey | undefined;
  private pendingSeek: {
    readonly episodeKey: EpisodeKey | undefined;
    readonly targetMs: number;
    readonly expiresAt: number;
  } | null = null;
  private disposed = false;

  constructor(options: NativeAudioEngineOptions) {
    this.plugin = options.plugin;
    this.isVisible =
      options.isVisible ??
      (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
    if (options.onNativeActivity !== undefined) {
      this.onNativeActivity = options.onNativeActivity;
    }
    if (options.onHiddenFlushNeeded !== undefined) {
      this.onHiddenFlushNeeded = options.onHiddenFlushNeeded;
    }

    void this.attachListeners();
  }

  private async attachListeners(): Promise<void> {
    const hState = await this.plugin.addListener('media-state', (p) => this.handleNativeState(p));
    const hEnded = await this.plugin.addListener('media-ended', (p) => this.handleNativeEnded(p));
    const hError = await this.plugin.addListener('media-error', (p) => this.handleNativeError(p));
    const hSleep = await this.plugin.addListener('sleep-timer-state', (p) =>
      this.handleNativeSleepTimer(p),
    );

    if (this.disposed) {
      await Promise.all([hState.remove(), hEnded.remove(), hError.remove(), hSleep.remove()]);
      return;
    }
    this.handles.push(hState, hEnded, hError, hSleep);

    try {
      const initial = await this.plugin.media.getState();
      if (!this.disposed && initial.episodeKey) {
        this.requestedEpisodeKey = initial.episodeKey;
        this.applySnapshotFromPayload(initial, false);
      }
    } catch {
      // Service may not be running yet; ignore.
    }
  }

  private emit(event: PlayerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  private applySnapshotFromPayload(payload: NativeMediaStatePayload, emitEvents: boolean): void {
    const prev = this.snapshot;
    const rawPosMs = Math.max(0, Math.trunc(payload.positionMs));
    let resolvedPosMs = rawPosMs;
    if (this.pendingSeek !== null) {
      if (
        Date.now() >= this.pendingSeek.expiresAt ||
        (payload.episodeKey !== undefined && payload.episodeKey !== this.pendingSeek.episodeKey)
      ) {
        this.pendingSeek = null;
      } else if (Math.abs(rawPosMs - this.pendingSeek.targetMs) <= 2500) {
        this.pendingSeek = null;
        resolvedPosMs = rawPosMs;
      } else {
        resolvedPosMs = this.pendingSeek.targetMs;
      }
    }

    const next: PlayerSnapshot = {
      playing: payload.playing,
      buffering: payload.buffering,
      positionMs: resolvedPosMs,
      speed: clampSpeed(payload.speed),
      ...(payload.episodeKey !== undefined ? { episodeKey: payload.episodeKey } : {}),
      ...(payload.durationMs !== undefined && payload.durationMs > 0
        ? { durationMs: Math.trunc(payload.durationMs) }
        : {}),
    };

    const autonomousAdvance =
      prev.episodeKey !== undefined &&
      next.episodeKey !== undefined &&
      prev.episodeKey !== next.episodeKey &&
      this.requestedEpisodeKey !== next.episodeKey;

    if (autonomousAdvance) {
      this.requestedEpisodeKey = next.episodeKey;
    }

    this.snapshot = next;

    if (!emitEvents) return;

    if (autonomousAdvance && prev.episodeKey && next.episodeKey) {
      this.emit({
        type: 'nativeAdvanced',
        from: prev.episodeKey,
        to: next.episodeKey,
      });
    }

    const stateChanged =
      prev.episodeKey !== next.episodeKey ||
      prev.playing !== next.playing ||
      prev.buffering !== next.buffering ||
      prev.speed !== next.speed ||
      prev.durationMs !== next.durationMs ||
      (!next.playing && prev.positionMs !== next.positionMs);

    if (stateChanged) {
      this.emit({ type: 'state', snapshot: next });
    }

    if (next.episodeKey && (next.playing || prev.positionMs !== next.positionMs)) {
      this.emit({
        type: 'position',
        episodeKey: next.episodeKey,
        positionMs: next.positionMs,
        ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
      });
    }

    // Immediate hidden flush when playback pauses with the screen off (`ARCHITECTURE.md §3.3`)
    if (prev.playing && !next.playing && !this.isVisible()) {
      this.onHiddenFlushNeeded?.('paused');
    }
  }

  private handleNativeState(payload: NativeMediaStatePayload): void {
    if (this.disposed) return;
    this.onNativeActivity?.();
    this.applySnapshotFromPayload(payload, true);
  }

  private handleNativeEnded(payload: NativeMediaEndedPayload): void {
    if (this.disposed) return;
    this.pendingSeek = null;
    this.onNativeActivity?.();

    if (payload.autoAdvancedTo) {
      this.requestedEpisodeKey = payload.autoAdvancedTo;
      this.emit({
        type: 'nativeAdvanced',
        from: payload.episodeKey,
        to: payload.autoAdvancedTo,
      });
    } else {
      if (this.snapshot.episodeKey === payload.episodeKey) {
        this.snapshot = {
          ...this.snapshot,
          playing: false,
          buffering: false,
        };
      }
      this.emit({ type: 'ended', episodeKey: payload.episodeKey });
    }

    if (!this.isVisible()) {
      this.onHiddenFlushNeeded?.('ended');
    }
  }

  private handleNativeError(payload: NativeMediaErrorPayload): void {
    if (this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      playing: false,
      buffering: false,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
    this.emit({
      type: 'error',
      error: payload.error,
      ...(payload.episodeKey !== undefined ? { episodeKey: payload.episodeKey } : {}),
    });
  }

  private handleNativeSleepTimer(payload: NativeSleepTimerPayload): void {
    if (this.disposed) return;
    this.emit({
      type: 'sleepTimer',
      state: mapSleepTimerPayload(payload),
    });
  }

  async load(item: PlayerLoadItem): Promise<void> {
    const speed = clampSpeed(item.speed);
    const startMs = Math.max(0, Math.trunc(item.startMs));
    this.pendingSeek = null;
    this.requestedEpisodeKey = item.episodeKey;
    this.snapshot = {
      episodeKey: item.episodeKey,
      playing: false,
      buffering: true,
      positionMs: startMs,
      speed,
      ...(item.metadata.durationMs !== undefined && item.metadata.durationMs > 0
        ? { durationMs: item.metadata.durationMs }
        : {}),
    };
    this.emit({ type: 'state', snapshot: this.snapshot });

    const state = await this.plugin.media.load({
      episodeKey: item.episodeKey,
      source: item.source,
      startMs,
      speed,
      metadata: item.metadata,
      playWhenReady: false,
    });
    this.applySnapshotFromPayload(state, true);
  }

  async play(): Promise<void> {
    await this.plugin.media.play();
    this.snapshot = {
      ...this.snapshot,
      playing: true,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  pause(): void {
    this.snapshot = {
      ...this.snapshot,
      playing: false,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
    void this.plugin.media.pause().catch(() => undefined);
  }

  stop(): void {
    this.pendingSeek = null;
    this.requestedEpisodeKey = undefined;
    this.snapshot = {
      playing: false,
      buffering: false,
      positionMs: 0,
      speed: this.snapshot.speed,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
    void this.plugin.media.stop().catch(() => undefined);
  }

  seekTo(ms: number): void {
    const clamped = Math.max(
      0,
      this.snapshot.durationMs !== undefined && this.snapshot.durationMs > 0
        ? Math.min(Math.floor(ms), this.snapshot.durationMs)
        : Math.floor(ms),
    );
    this.pendingSeek = {
      episodeKey: this.snapshot.episodeKey,
      targetMs: clamped,
      expiresAt: Date.now() + 1500,
    };
    this.snapshot = {
      ...this.snapshot,
      positionMs: clamped,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
    if (this.snapshot.episodeKey) {
      this.emit({
        type: 'position',
        episodeKey: this.snapshot.episodeKey,
        positionMs: clamped,
        ...(this.snapshot.durationMs !== undefined ? { durationMs: this.snapshot.durationMs } : {}),
      });
    }
    void this.plugin.media.seekTo({ positionMs: clamped }).catch(() => undefined);
  }

  skip(deltaMs: number): void {
    this.seekTo(this.snapshot.positionMs + deltaMs);
  }

  setSpeed(speed: number): void {
    const clamped = clampSpeed(speed);
    this.snapshot = {
      ...this.snapshot,
      speed: clamped,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
    void this.plugin.media.setSpeed({ speed: clamped }).catch(() => undefined);
  }

  setSleepTimer(timer: SleepTimer): void {
    void this.plugin.media.setSleepTimer(timer).catch(() => undefined);
    this.emit({
      type: 'sleepTimer',
      state: {
        timer,
        ...(timer.mode === 'minutes' ? { remainingMs: timer.minutes * 60_000 } : {}),
      },
    });
  }

  setQueue(items: readonly QueueItemSource[]): void {
    void this.plugin.media
      .setQueue({
        items: items.map((item) => ({
          episodeKey: item.episodeKey,
          source: item.source,
          startMs: Math.max(0, Math.trunc(item.startMs)),
          metadata: item.metadata,
        })),
      })
      .catch(() => undefined);
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    const toRemove = this.handles.splice(0, this.handles.length);
    for (const h of toRemove) {
      void h.remove().catch(() => undefined);
    }
  }
}
