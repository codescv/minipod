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
  /**
   * Last item handed to `load()` (kept in sync with the latest known position) so `play()` can
   * transparently reload it when Android stopped/reset `PlaybackService` while paused in the
   * background (e.g. Airplane Mode + downloaded audio).
   */
  private lastLoadedItem: PlayerLoadItem | null = null;
  /** Last native queue so autonomous advances keep `lastLoadedItem` accurate. */
  private lastQueueItems: readonly QueueItemSource[] = [];
  private pendingSeek: {
    readonly episodeKey: EpisodeKey | undefined;
    readonly targetMs: number;
    readonly expiresAt: number;
  } | null = null;
  private disposed = false;
  /**
   * Episode that just finished natively (`media-ended` without auto-advance). Trailing paused
   * `media-state`s for it are pinned to `positionMs: 0` so they never look like a mid-track pause
   * (which would overwrite PLAYED with IN_PROGRESS). Cleared on load/play/seek/stop or when the
   * native player reports playing / a different episode.
   */
  private completedEpisodeKey: EpisodeKey | null = null;

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
        // Publish the adopted native state (bc737679): subscribers (usePlayer) mounted before this
        // async read resolved. Without it a paused episode never hydrates the MiniPlayer, and live
        // playback resumed headless (headset / Bluetooth) stays shown as paused, because every
        // later 1 s tick is then "unchanged" and only emits `position`. State only: no `position`
        // event, so nothing is re-saved at boot.
        this.emit({ type: 'state', snapshot: this.snapshot });
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

  /**
   * Applies a native state payload. Returns `true` when it is a real state change (episode,
   * play/pause, buffering, speed, duration, seek, autonomous advance) rather than a plain
   * position tick while playing.
   */
  private applySnapshotFromPayload(payload: NativeMediaStatePayload, emitEvents: boolean): boolean {
    const prev = this.snapshot;
    const rawPosMs = Math.max(0, Math.trunc(Number.isFinite(payload.positionMs) ? payload.positionMs : 0));
    const seeked = payload.seeked === true && payload.episodeKey !== undefined;
    let resolvedPosMs = rawPosMs;
    // Note: a native `seeked` echo of an *older* in-app seek (rapid ±skip taps) must not override
    // the newer pending target either, so `seeked` payloads go through the same guard.
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

    // Transient native idle state (service stopped/restarted while paused in the background, or
    // an empty player): never wipe the known paused episode/position back to 0:00.
    const transientIdle =
      payload.episodeKey === undefined &&
      !payload.playing &&
      rawPosMs === 0 &&
      prev.episodeKey !== undefined;
    const episodeKey: EpisodeKey | undefined = transientIdle
      ? prev.episodeKey
      : payload.episodeKey;
    const durationMs =
      payload.durationMs !== undefined && payload.durationMs > 0
        ? Math.trunc(payload.durationMs)
        : transientIdle
          ? prev.durationMs
          : undefined;

    const next: PlayerSnapshot = {
      playing: payload.playing,
      buffering: payload.buffering,
      positionMs: transientIdle ? prev.positionMs : resolvedPosMs,
      speed: transientIdle ? prev.speed : clampSpeed(payload.speed),
      ...(episodeKey !== undefined ? { episodeKey } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };

    const autonomousAdvance =
      prev.episodeKey !== undefined &&
      next.episodeKey !== undefined &&
      prev.episodeKey !== next.episodeKey &&
      this.requestedEpisodeKey !== next.episodeKey;

    if (autonomousAdvance) {
      this.requestedEpisodeKey = next.episodeKey;
      this.adoptQueuedItem(next.episodeKey);
    }

    this.snapshot = next;
    this.rememberPosition(next, seeked);

    const stateChanged =
      autonomousAdvance ||
      seeked ||
      prev.episodeKey !== next.episodeKey ||
      prev.playing !== next.playing ||
      prev.buffering !== next.buffering ||
      prev.speed !== next.speed ||
      prev.durationMs !== next.durationMs ||
      (!next.playing && prev.positionMs !== next.positionMs);

    if (!emitEvents) return stateChanged;

    if (autonomousAdvance && prev.episodeKey && next.episodeKey) {
      this.emit({
        type: 'nativeAdvanced',
        from: prev.episodeKey,
        to: next.episodeKey,
      });
    }

    if (stateChanged) {
      this.emit(seeked ? { type: 'state', snapshot: next, seeked: true } : { type: 'state', snapshot: next });
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
    return stateChanged;
  }

  /**
   * Keeps `lastLoadedItem.startMs` at the latest known position of that episode. A `0` is only
   * adopted for an explicit seek (e.g. lock-screen Rewind -10 s from 0:06), never for a transient
   * idle/reset state.
   */
  private rememberPosition(snap: PlayerSnapshot, seeked = false): void {
    const item = this.lastLoadedItem;
    if (item === null || snap.episodeKey !== item.episodeKey) return;
    if ((snap.positionMs > 0 || seeked) && snap.positionMs !== item.startMs) {
      this.lastLoadedItem = { ...item, startMs: snap.positionMs };
    }
  }

  private adoptQueuedItem(episodeKey: EpisodeKey | undefined): void {
    if (episodeKey === undefined) return;
    if (this.lastLoadedItem?.episodeKey === episodeKey) return;
    const queued = this.lastQueueItems.find((q) => q.episodeKey === episodeKey);
    if (!queued) return;
    this.lastLoadedItem = {
      episodeKey: queued.episodeKey,
      source: queued.source,
      startMs: queued.startMs,
      speed: this.snapshot.speed,
      metadata: queued.metadata,
      mediaType: this.lastLoadedItem?.mediaType ?? 'AUDIO',
    };
  }

  private handleNativeState(payload: NativeMediaStatePayload): void {
    if (this.disposed) return;
    let effective = payload;
    const completed = this.completedEpisodeKey;
    if (completed !== null) {
      if (
        payload.playing ||
        (payload.episodeKey !== undefined && payload.episodeKey !== completed) ||
        // Explicit seek on the finished episode (e.g. lock-screen Rewind -10 s re-opens its tail).
        (payload.seeked === true && payload.episodeKey === completed)
      ) {
        this.completedEpisodeKey = null;
      } else if (payload.positionMs !== 0) {
        // Trailing paused state of the finished episode: keep it at 0 (no spurious pause/position).
        effective = { ...payload, positionMs: 0 };
      }
    }
    const stateChanged = this.applySnapshotFromPayload(effective, true);
    // Reconcile the native journal (a `readJournal()` bridge round-trip) only on real state
    // changes — never on the plain 1 s position ticks of foreground playback.
    if (stateChanged || !effective.playing || effective.seeked === true) {
      this.onNativeActivity?.();
    }
  }

  private handleNativeEnded(payload: NativeMediaEndedPayload): void {
    if (this.disposed) return;
    this.pendingSeek = null;
    this.onNativeActivity?.();

    if (payload.autoAdvancedTo) {
      this.requestedEpisodeKey = payload.autoAdvancedTo;
      this.adoptQueuedItem(payload.autoAdvancedTo);
      this.emit({
        type: 'nativeAdvanced',
        from: payload.episodeKey,
        to: payload.autoAdvancedTo,
        completed: true,
      });
    } else {
      this.completedEpisodeKey = payload.episodeKey;
      if (this.lastLoadedItem?.episodeKey === payload.episodeKey) {
        this.lastLoadedItem = { ...this.lastLoadedItem, startMs: 0 };
      }
      if (this.snapshot.episodeKey === payload.episodeKey) {
        this.snapshot = {
          ...this.snapshot,
          playing: false,
          buffering: false,
          positionMs: 0,
        };
        // Publish the stopped snapshot BEFORE `ended` so listeners (usePlayer) already see
        // `playing: false` and never treat the trailing native `media-state` as a pause.
        this.emit({ type: 'state', snapshot: this.snapshot });
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
    this.completedEpisodeKey = null;
    this.requestedEpisodeKey = item.episodeKey;
    this.lastLoadedItem = { ...item, startMs, speed };
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
    this.completedEpisodeKey = null;
    const item = this.lastLoadedItem;
    if (item !== null && !this.snapshot.episodeKey) {
      await this.reloadAndPlay(item);
      return;
    }

    const result = await this.plugin.media.play();
    if (item === null) {
      // Episode adopted from native state (WebView reconnect / cold boot), not `load()`ed here:
      // trust the native result instead of assuming playback started, so the caller can reload
      // from storage when the service could not restore the track (bc737679).
      if (result) {
        this.applySnapshotFromPayload(result, true);
        return;
      }
    } else {
      let native: NativeMediaStatePayload | null = result ? result : null;
      if (native === null) {
        try {
          native = await this.plugin.media.getState();
        } catch {
          native = null;
        }
      }
      // `PlaybackService` was stopped/reset while paused in the background (nothing loaded, or
      // stuck idle): reload the last item at the paused position instead of staying at 0:00.
      if (
        native &&
        (native.episodeKey === undefined || (!native.playing && !native.buffering))
      ) {
        await this.reloadAndPlay(item);
        return;
      }
    }
    this.snapshot = {
      ...this.snapshot,
      playing: true,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  private async reloadAndPlay(item: PlayerLoadItem): Promise<void> {
    const sameEpisode = this.snapshot.episodeKey === item.episodeKey || !this.snapshot.episodeKey;
    const startMs =
      sameEpisode && this.snapshot.positionMs > 0 ? this.snapshot.positionMs : item.startMs;
    const speed = clampSpeed(this.snapshot.speed);
    this.pendingSeek = null;
    this.requestedEpisodeKey = item.episodeKey;
    this.lastLoadedItem = { ...item, startMs, speed };
    const state = await this.plugin.media.load({
      episodeKey: item.episodeKey,
      source: item.source,
      startMs,
      speed,
      metadata: item.metadata,
      playWhenReady: true,
    });
    if (state) {
      this.applySnapshotFromPayload(state, true);
    }
    await this.plugin.media.play();
    this.snapshot = {
      ...this.snapshot,
      episodeKey: item.episodeKey,
      playing: true,
      positionMs: this.snapshot.positionMs > 0 ? this.snapshot.positionMs : startMs,
    };
    this.emit({ type: 'state', snapshot: this.snapshot });
  }

  /**
   * Re-reads native `PlaybackService` state (e.g. on app foreground) without ever clobbering a
   * known paused position to 0 when the service reports no loaded episode.
   */
  async syncStateFromNative(): Promise<PlayerSnapshot> {
    try {
      const state = await this.plugin.media.getState();
      if (!this.disposed && state) {
        if (state.episodeKey !== undefined && this.requestedEpisodeKey === undefined) {
          this.requestedEpisodeKey = state.episodeKey;
        }
        this.applySnapshotFromPayload(state, true);
      }
    } catch {
      // Service not reachable; keep current snapshot.
    }
    return this.snapshot;
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
    this.completedEpisodeKey = null;
    this.requestedEpisodeKey = undefined;
    this.lastLoadedItem = null;
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
    this.completedEpisodeKey = null;
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
    this.lastQueueItems = items;
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
