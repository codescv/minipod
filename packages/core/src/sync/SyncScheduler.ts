import {
  SYNC_DEBOUNCE_QUEUE_MS,
  SYNC_DEBOUNCE_SHORT_MS,
  SYNC_PERIODIC_MS,
  SYNC_PLAYING_CHECKPOINT_MS,
  SYNC_PULL_THROTTLE_MS,
  type EpochMs,
  type EpisodeKey,
  type SyncReason,
  type SyncSchedulerHost,
  type Unsubscribe,
} from '../types';
import type { SyncEngine, SyncRunResult } from './SyncEngine';

export interface SyncSchedulerDeps {
  readonly engine: SyncEngine;
  readonly host: SyncSchedulerHost;
  readonly wifiOnly?: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface PlaybackCheckpointInput {
  readonly playing: boolean;
  readonly episodeKey?: EpisodeKey;
  readonly positionMs: number;
}

function isLocalFileProviderId(id: string | undefined): boolean {
  return id === 'local-folder' || id === 'saf';
}

function debounceDelayForReason(reason: SyncReason, visible: boolean): number | null {
  switch (reason) {
    case 'subscriptions-changed':
    case 'progress-paused':
    case 'progress-completed':
    case 'progress-marked':
      return visible ? SYNC_DEBOUNCE_SHORT_MS : 0;
    case 'queue-changed':
      return visible ? SYNC_DEBOUNCE_QUEUE_MS : 0;
    default:
      return null;
  }
}

/**
 * Event-driven, debounced cloud sync scheduler (ARCHITECTURE.md §9.2).
 *
 * - Keeps one pending timer per reason class (`2s` short / `5s` queue; `0` immediate when hidden)
 *   and coalesces all pending debounce timers when an engine cycle starts so a pause followed by
 *   a queue edit produces a single upload.
 * - Runs a `180s` playing-checkpoint timer ONLY while actively playing, firing only if `positionMs`
 *   changed and no push already occurred during that window.
 * - Throttles `'foreground'` pulls to `>= 20s` since the last pull.
 * - Gates automatic network syncs on `host.isOnline()` and `wifiOnly` (`!host.isMetered()`).
 */
export class SyncScheduler {
  private readonly engine: SyncEngine;
  private readonly host: SyncSchedulerHost;
  private readonly onError?: (error: unknown) => void;
  private wifiOnly: boolean;

  private started = false;
  private disposed = false;
  private periodicUnsub: Unsubscribe | null = null;
  private watchUnsub: Unsubscribe | null = null;
  private playingIntervalUnsub: Unsubscribe | null = null;

  private readonly pendingTimers = new Map<SyncReason, Unsubscribe>();

  // Playback checkpoint state
  private isPlaying = false;
  private playingEpisodeKey: EpisodeKey | undefined;
  private playingPositionMs = 0;
  private checkpointBaselineKey: EpisodeKey | undefined;
  private checkpointBaselinePosMs = 0;
  private lastPushObservedAt: EpochMs = 0;
  private lastWindowOpenedAt: EpochMs = 0;

  constructor(deps: SyncSchedulerDeps) {
    this.engine = deps.engine;
    this.host = deps.host;
    this.wifiOnly = deps.wifiOnly ?? false;
    if (deps.onError !== undefined) {
      this.onError = deps.onError;
    }
  }

  setWifiOnly(wifiOnly: boolean): void {
    this.wifiOnly = wifiOnly;
  }

  getWifiOnly(): boolean {
    return this.wifiOnly;
  }

  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;

    this.periodicUnsub = this.host.setInterval(() => {
      this.request('periodic');
    }, SYNC_PERIODIC_MS);

    this.rebindProviderWatcher();
  }

  /**
   * Re-attaches `provider.watch()` after `engine.setProvider(...)` changes the active provider.
   */
  rebindProviderWatcher(): void {
    if (this.watchUnsub) {
      this.watchUnsub();
      this.watchUnsub = null;
    }
    if (this.disposed || !this.started) return;
    const provider = this.engine.getProvider();
    if (provider?.watch) {
      this.watchUnsub = provider.watch(() => {
        this.request('remote-changed');
      });
    }
  }

  /**
   * Feeds live playback state from the `PlayerEngine` so the 180s playing checkpoint
   * runs while playing and stops when paused/stopped (§9.2).
   */
  updatePlayback(input: PlaybackCheckpointInput): void {
    if (this.disposed) return;

    this.playingEpisodeKey = input.episodeKey;
    this.playingPositionMs = input.positionMs;

    if (input.playing && !this.isPlaying) {
      this.isPlaying = true;
      this.checkpointBaselineKey = input.episodeKey;
      this.checkpointBaselinePosMs = input.positionMs;
      this.lastWindowOpenedAt = this.host.now();

      this.playingIntervalUnsub?.();
      this.playingIntervalUnsub = this.host.setInterval(() => {
        this.onPlayingCheckpointTick();
      }, SYNC_PLAYING_CHECKPOINT_MS);
    } else if (!input.playing && this.isPlaying) {
      this.isPlaying = false;
      if (this.playingIntervalUnsub) {
        this.playingIntervalUnsub();
        this.playingIntervalUnsub = null;
      }
    }
  }

  private onPlayingCheckpointTick(): void {
    if (this.disposed || !this.isPlaying) return;

    const posChanged =
      this.playingEpisodeKey !== this.checkpointBaselineKey ||
      this.playingPositionMs !== this.checkpointBaselinePosMs;
    const pushHappenedInWindow = this.lastPushObservedAt > this.lastWindowOpenedAt;

    this.checkpointBaselineKey = this.playingEpisodeKey;
    this.checkpointBaselinePosMs = this.playingPositionMs;
    this.lastWindowOpenedAt = this.host.now();

    if (posChanged && !pushHappenedInWindow) {
      this.request('playing-checkpoint');
    }
  }

  /**
   * Schedules or immediately runs a sync cycle for `reason` according to §9.2 policy.
   */
  request(reason: SyncReason): void {
    void this.requestAsync(reason).catch((err) => {
      this.onError?.(err);
    });
  }

  async requestAsync(reason: SyncReason): Promise<SyncRunResult | undefined> {
    if (this.disposed) return undefined;
    if (!this.engine.getProvider()) return undefined;

    // Immediate manual / configuration sync: cancel pending timers and bypass gates
    if (reason === 'manual' || reason === 'configured') {
      this.clearDebounceTimers();
      return await this.executeEngineRun(reason);
    }

    if (!this.canRunOnCurrentNetwork()) {
      return undefined;
    }

    if (reason === 'foreground') {
      const status = await this.engine.getStatus();
      const nowMs = this.host.now();
      const lastFreshAt =
        status.lastPullAt !== undefined || status.lastPushAt !== undefined
          ? Math.max(status.lastPullAt ?? 0, status.lastPushAt ?? 0)
          : undefined;
      if (lastFreshAt !== undefined && nowMs - lastFreshAt < SYNC_PULL_THROTTLE_MS) {
        return undefined;
      }
      return await this.executeEngineRun('foreground');
    }

    if (reason === 'hidden') {
      const hadPendingTimers = this.pendingTimers.size > 0;
      this.clearDebounceTimers();
      const dirtyCount = await this.engine.getDirtyCount();
      if (dirtyCount === 0 && !hadPendingTimers) {
        return undefined;
      }
      return await this.executeEngineRun('hidden');
    }

    if (reason === 'periodic' || reason === 'playing-checkpoint' || reason === 'remote-changed') {
      return await this.executeEngineRun(reason);
    }

    // Debounced push reasons
    const delayMs = debounceDelayForReason(reason, this.host.isVisible());
    if (delayMs === null || delayMs <= 0) {
      this.clearDebounceTimers();
      return await this.executeEngineRun(reason);
    }

    return await new Promise<SyncRunResult | undefined>((resolve) => {
      const prevCancel = this.pendingTimers.get(reason);
      if (prevCancel) {
        prevCancel();
        this.pendingTimers.delete(reason);
      }

      const unsub = this.host.setTimeout(() => {
        this.pendingTimers.delete(reason);
        if (this.disposed || !this.canRunOnCurrentNetwork()) {
          resolve(undefined);
          return;
        }
        void this.executeEngineRun(reason).then(resolve, (err) => {
          this.onError?.(err);
          resolve(undefined);
        });
      }, delayMs);

      this.pendingTimers.set(reason, () => {
        unsub();
        resolve(undefined);
      });
    });
  }

  private canRunOnCurrentNetwork(): boolean {
    const provider = this.engine.getProvider();
    if (!provider) return false;
    if (isLocalFileProviderId(provider.id)) {
      return true;
    }
    if (!this.host.isOnline()) {
      return false;
    }
    if (this.wifiOnly && this.host.isMetered() === true) {
      return false;
    }
    return true;
  }

  private clearDebounceTimers(): void {
    const cancels = [...this.pendingTimers.values()];
    this.pendingTimers.clear();
    for (const cancel of cancels) {
      cancel();
    }
  }

  private async executeEngineRun(reason: SyncReason): Promise<SyncRunResult> {
    const result = await this.engine.run(reason, {
      onCycleStart: () => {
        this.clearDebounceTimers();
      },
    });
    if (result.uploaded) {
      const pushTime = result.status.lastPushAt ?? this.host.now();
      if (pushTime > this.lastPushObservedAt) {
        this.lastPushObservedAt = pushTime;
      }
    }
    return result;
  }

  stop(): void {
    this.started = false;
    this.clearDebounceTimers();
    if (this.periodicUnsub) {
      this.periodicUnsub();
      this.periodicUnsub = null;
    }
    if (this.watchUnsub) {
      this.watchUnsub();
      this.watchUnsub = null;
    }
    if (this.playingIntervalUnsub) {
      this.playingIntervalUnsub();
      this.playingIntervalUnsub = null;
    }
    this.isPlaying = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }
}
