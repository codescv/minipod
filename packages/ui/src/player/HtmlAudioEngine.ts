/**
 * HTML5 `<audio>` / `<video>` implementation of `PlayerEngine` for PC Web (`@minipod/host-node`),
 * with pitch preservation, `navigator.mediaSession` OS media keys, sleep-timer 60s fade-out,
 * and `pagehide` `keepalive: true` progress flush (ARCHITECTURE.md §3.1, §5.1).
 */
import {
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  type EpisodeKey,
  type MediaMetadataLite,
  type PlayerEngine,
  type PlayerEngineCapabilities,
  type PlayerEvent,
  type PlayerLoadItem,
  type PlayerSnapshot,
  type SleepTimer,
  type Unsubscribe,
} from '@minipod/core';
import { clampSpeed } from './PlayerEngine';
import { SleepTimerController } from './SleepTimer';

export interface HtmlAudioEngineOptions {
  /** Custom `pagehide` flush endpoint (defaults to `/api/progress/save`). */
  readonly flushUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly onNextTrack?: (() => void) | undefined;
  readonly onPrevTrack?: (() => void) | undefined;
}

export class HtmlAudioEngine implements PlayerEngine {
  readonly capabilities: PlayerEngineCapabilities = {
    video: true,
    background: true,
    nativeQueue: false,
  };

  private audioEl: HTMLAudioElement | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private activeEl: HTMLMediaElement | null = null;
  private videoContainer: HTMLElement | null = null;
  private hiddenMediaPark: HTMLDivElement | null = null;
  private reparenting = false;

  private episodeKey: EpisodeKey | undefined;
  private durationHintMs: number | undefined;
  private speed = 1.0;
  private muted = false;
  private volumeFactor = 1.0;
  private buffering = false;
  private playing = false;
  private positionMs = 0;

  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly sleepController: SleepTimerController;
  private readonly flushUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private onNextTrack: (() => void) | undefined;
  private onPrevTrack: (() => void) | undefined;
  private readonly boundPageHide: () => void;

  constructor(options?: HtmlAudioEngineOptions) {
    this.flushUrl = options?.flushUrl ?? '/api/progress/save';
    this.fetchImpl = options?.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    this.onNextTrack = options?.onNextTrack;
    this.onPrevTrack = options?.onPrevTrack;

    this.sleepController = new SleepTimerController({
      onVolumeFactor: (factor) => {
        this.volumeFactor = factor;
        this.applyVolume();
      },
      onExpire: () => {
        this.pause();
      },
      onStateChange: (state) => {
        this.emit({ type: 'sleepTimer', state });
      },
    });

    this.boundPageHide = () => this.flushOnPageHide();
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.boundPageHide);
    }
  }

  setTrackHandlers(handlers: { readonly onNext?: () => void; readonly onPrev?: () => void }): void {
    this.onNextTrack = handlers.onNext;
    this.onPrevTrack = handlers.onPrev;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
    this.emitState();
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  consumeSleepExpired(): boolean {
    return this.sleepController.consumeExpiredFlag();
  }

  async load(item: PlayerLoadItem): Promise<void> {
    if (typeof document === 'undefined') return;

    const isVideo =
      item.mediaType === 'VIDEO' || Boolean(item.source.mime?.toLowerCase().startsWith('video/'));

    if (this.activeEl) {
      this.activeEl.pause();
    }

    const el = isVideo ? this.ensureVideoElement() : this.ensureAudioElement();
    this.activeEl = el;
    this.episodeKey = item.episodeKey;
    this.durationHintMs = item.metadata.durationMs;
    this.speed = clampSpeed(item.speed);
    this.positionMs = Math.max(0, Math.floor(item.startMs));
    this.buffering = true;
    this.playing = false;

    const srcUrl = item.source.kind === 'url' ? item.source.url : item.source.path;
    if (el.getAttribute('src') !== srcUrl) {
      el.src = srcUrl;
    }
    this.applyPitchAndSpeed(el);
    this.applyVolume();

    const targetSec = this.positionMs / 1000;
    try {
      el.currentTime = targetSec;
    } catch {
      const onLoadedMeta = () => {
        try {
          el.currentTime = targetSec;
        } catch {
          // ignore
        }
        el.removeEventListener('loadedmetadata', onLoadedMeta);
      };
      el.addEventListener('loadedmetadata', onLoadedMeta);
    }

    this.installMediaSession(item.metadata);
    this.emitState();
  }

  async play(): Promise<void> {
    if (!this.activeEl) return;
    this.applyPitchAndSpeed(this.activeEl);
    this.applyVolume();
    try {
      await this.activeEl.play();
      this.playing = true;
      this.buffering = false;
      this.updateMediaSessionPlaybackState('playing');
      this.emitState();
    } catch (err) {
      this.playing = false;
      this.buffering = false;
      this.emit({
        type: 'error',
        ...(this.episodeKey !== undefined ? { episodeKey: this.episodeKey } : {}),
        error: {
          code: 'network',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      this.emitState();
    }
  }

  pause(): void {
    if (!this.activeEl) return;
    this.activeEl.pause();
    this.playing = false;
    this.buffering = false;
    this.updateMediaSessionPlaybackState('paused');
    this.emitState();
  }

  stop(): void {
    if (this.activeEl) {
      this.activeEl.pause();
      this.activeEl.removeAttribute('src');
      this.activeEl.load();
    }
    this.playing = false;
    this.buffering = false;
    this.episodeKey = undefined;
    this.positionMs = 0;
    this.durationHintMs = undefined;
    this.updateMediaSessionPlaybackState('none');
    this.emitState();
  }

  seekTo(ms: number): void {
    const dur = this.resolveDurationMs();
    const clamped = dur !== undefined ? Math.min(dur, Math.max(0, ms)) : Math.max(0, ms);
    this.positionMs = Math.floor(clamped);
    if (this.activeEl) {
      try {
        this.activeEl.currentTime = this.positionMs / 1000;
      } catch {
        // ignore if media not ready
      }
    }
    this.updateMediaSessionPosition();
    this.emitState();
    if (this.episodeKey) {
      this.emit({
        type: 'position',
        episodeKey: this.episodeKey,
        positionMs: this.positionMs,
        ...(dur !== undefined ? { durationMs: dur } : {}),
      });
    }
  }

  skip(deltaMs: number): void {
    this.seekTo(this.positionMs + deltaMs);
  }

  setSpeed(speed: number): void {
    this.speed = clampSpeed(speed);
    if (this.activeEl) {
      this.applyPitchAndSpeed(this.activeEl);
    }
    this.updateMediaSessionPosition();
    this.emitState();
  }

  setSleepTimer(timer: SleepTimer): void {
    this.sleepController.set(timer, this.positionMs);
  }

  attachVideoSurface(element: HTMLElement | null): void {
    this.videoContainer = element;
    if (!this.videoEl) return;

    if (element) {
      if (this.videoEl.parentElement !== element) {
        const shouldStayPlaying = this.playing;
        this.reparentMediaElement(this.videoEl, element, shouldStayPlaying);
      }
    } else {
      const park = this.ensureHiddenMediaPark();
      if (park && this.videoEl.parentElement !== park) {
        this.reparentMediaElement(this.videoEl, park, this.playing);
      }
    }
  }

  private reparentMediaElement(
    el: HTMLMediaElement,
    container: HTMLElement,
    keepPlaying: boolean,
  ): void {
    this.reparenting = true;
    try {
      if (container === this.hiddenMediaPark) {
        container.appendChild(el);
      } else {
        container.replaceChildren(el);
      }
      if (keepPlaying && el.paused && !el.ended) {
        void el.play().catch(() => undefined);
      }
    } finally {
      this.reparenting = false;
    }
  }

  private ensureHiddenMediaPark(): HTMLDivElement | null {
    if (typeof document === 'undefined' || !document.body) return null;
    if (!this.hiddenMediaPark || !this.hiddenMediaPark.isConnected) {
      const div = document.createElement('div');
      div.setAttribute('data-minipod-media-park', 'true');
      div.setAttribute('aria-hidden', 'true');
      div.style.display = 'none';
      document.body.appendChild(div);
      this.hiddenMediaPark = div;
    }
    return this.hiddenMediaPark;
  }

  getSnapshot(): PlayerSnapshot {
    const durationMs = this.resolveDurationMs();
    return {
      ...(this.episodeKey !== undefined ? { episodeKey: this.episodeKey } : {}),
      playing: this.playing,
      buffering: this.buffering,
      positionMs: this.positionMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
      speed: this.speed,
    };
  }

  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.sleepController.dispose();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.boundPageHide);
    }
    this.stop();
    if (this.hiddenMediaPark) {
      this.hiddenMediaPark.remove();
      this.hiddenMediaPark = null;
    }
    this.listeners.clear();
  }

  private ensureAudioElement(): HTMLAudioElement {
    const park = this.ensureHiddenMediaPark();
    if (!this.audioEl) {
      const el = document.createElement('audio');
      el.preload = 'metadata';
      this.bindMediaElementEvents(el);
      this.audioEl = el;
    }
    if (park && !this.audioEl.isConnected) {
      park.appendChild(this.audioEl);
    }
    return this.audioEl;
  }

  private ensureVideoElement(): HTMLVideoElement {
    if (!this.videoEl) {
      const el = document.createElement('video');
      el.preload = 'metadata';
      el.playsInline = true;
      el.controls = false;
      this.bindMediaElementEvents(el);
      this.videoEl = el;
    }
    if (this.videoContainer && this.videoContainer.isConnected) {
      if (this.videoEl.parentElement !== this.videoContainer) {
        this.reparentMediaElement(this.videoEl, this.videoContainer, this.playing);
      }
    } else {
      const park = this.ensureHiddenMediaPark();
      if (park && this.videoEl.parentElement !== park) {
        this.reparentMediaElement(this.videoEl, park, this.playing);
      }
    }
    return this.videoEl;
  }

  private bindMediaElementEvents(el: HTMLMediaElement): void {
    el.addEventListener('playing', () => {
      if (el !== this.activeEl) return;
      this.playing = true;
      this.buffering = false;
      this.updateMediaSessionPlaybackState('playing');
      this.emitState();
    });

    el.addEventListener('pause', () => {
      if (el !== this.activeEl || el.ended || this.reparenting) return;
      // If a detached container briefly caused a browser auto-pause before park reparenting,
      // re-attach to hidden park and keep playing seamlessly.
      if (!el.isConnected && this.playing) {
        const park = this.ensureHiddenMediaPark();
        if (park) {
          this.reparentMediaElement(el, park, true);
          return;
        }
      }
      this.playing = false;
      this.buffering = false;
      this.updateMediaSessionPlaybackState('paused');
      this.emitState();
    });

    el.addEventListener('waiting', () => {
      if (el !== this.activeEl) return;
      this.buffering = true;
      this.emitState();
    });

    el.addEventListener('canplay', () => {
      if (el !== this.activeEl) return;
      this.buffering = false;
      this.emitState();
    });

    el.addEventListener('loadedmetadata', () => {
      if (el !== this.activeEl) return;
      this.updateMediaSessionPosition();
      this.emitState();
    });

    el.addEventListener('timeupdate', () => {
      if (el !== this.activeEl || !this.episodeKey) return;
      this.positionMs = Math.max(0, Math.floor(el.currentTime * 1000));
      const durationMs = this.resolveDurationMs();
      this.sleepController.onPosition(this.positionMs);
      this.updateMediaSessionPosition();
      this.emit({
        type: 'position',
        episodeKey: this.episodeKey,
        positionMs: this.positionMs,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    });

    el.addEventListener('ended', () => {
      if (el !== this.activeEl || !this.episodeKey) return;
      const finishedKey = this.episodeKey;
      this.playing = false;
      this.buffering = false;
      this.sleepController.onEpisodeEnded();
      this.emitState();
      this.emit({ type: 'ended', episodeKey: finishedKey });
    });

    el.addEventListener('error', () => {
      if (el !== this.activeEl) return;
      this.playing = false;
      this.buffering = false;
      this.emit({
        type: 'error',
        ...(this.episodeKey !== undefined ? { episodeKey: this.episodeKey } : {}),
        error: {
          code: 'network',
          message: el.error?.message || 'Media playback failed',
        },
      });
      this.emitState();
    });
  }

  private applyPitchAndSpeed(el: HTMLMediaElement): void {
    el.playbackRate = this.speed;
    const withPitch = el as HTMLMediaElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    if ('preservesPitch' in withPitch) withPitch.preservesPitch = true;
    if ('mozPreservesPitch' in withPitch) withPitch.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in withPitch) withPitch.webkitPreservesPitch = true;
  }

  private applyVolume(): void {
    if (!this.activeEl) return;
    this.activeEl.muted = this.muted;
    this.activeEl.volume = Math.min(1, Math.max(0, this.volumeFactor));
  }

  private resolveDurationMs(): number | undefined {
    const raw = this.activeEl?.duration;
    if (raw !== undefined && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw * 1000);
    }
    return this.durationHintMs;
  }

  private installMediaSession(meta: MediaMetadataLite): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
      return;
    }
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: meta.title,
          artist: meta.artist ?? '',
          album: meta.album ?? '',
          artwork: meta.artworkUrl ? [{ src: meta.artworkUrl }] : [],
        });
      }
    } catch {
      // ignore unsupported MediaMetadata constructor
    }

    const safeHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // unsupported action in current browser
      }
    };

    safeHandler('play', () => {
      void this.play();
    });
    safeHandler('pause', () => {
      this.pause();
    });
    safeHandler('seekbackward', (details) => {
      const offsetMs = details.seekOffset ? details.seekOffset * 1000 : SKIP_BACK_MS;
      this.skip(-offsetMs);
    });
    safeHandler('seekforward', (details) => {
      const offsetMs = details.seekOffset ? details.seekOffset * 1000 : SKIP_FORWARD_MS;
      this.skip(offsetMs);
    });
    safeHandler('seekto', (details) => {
      if (details.seekTime !== undefined) {
        this.seekTo(details.seekTime * 1000);
      }
    });
    safeHandler('nexttrack', () => {
      this.onNextTrack?.();
    });
    safeHandler('previoustrack', () => {
      this.onPrevTrack?.();
    });
  }

  private updateMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // ignore
    }
  }

  private updateMediaSessionPosition(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
      return;
    }
    const dur = this.resolveDurationMs();
    if (!dur || dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState?.({
        duration: dur / 1000,
        playbackRate: this.speed,
        position: Math.min(dur, Math.max(0, this.positionMs)) / 1000,
      });
    } catch {
      // ignore out-of-range timing glitches
    }
  }

  private flushOnPageHide(): void {
    if (!this.episodeKey || this.positionMs <= 0 || !this.fetchImpl) return;
    const durationMs = this.resolveDurationMs();
    const payload = {
      episodeKey: this.episodeKey,
      positionMs: this.positionMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
      state: 'IN_PROGRESS',
      flush: true,
    };
    try {
      void this.fetchImpl(this.flushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // ignore unload errors
    }
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.getSnapshot() });
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
}

export function createHtmlAudioEngine(options?: HtmlAudioEngineOptions): HtmlAudioEngine {
  return new HtmlAudioEngine(options);
}
