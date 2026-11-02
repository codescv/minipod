import { describe, expect, it, vi } from 'vitest';
import type { PlayerEvent } from '@minipod/core';
import { NativeAudioEngine } from './NativeAudioEngine';
import type { MiniPodEventMap, MiniPodPlugin } from '../plugin-types';

function createMockMediaHarness() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitNative = <K extends keyof MiniPodEventMap>(event: K, payload: MiniPodEventMap[K]) => {
    for (const cb of listeners.get(event) ?? []) {
      cb(payload);
    }
  };

  const media: MiniPodPlugin['media'] = {
    load: vi.fn(async (p) => ({
      episodeKey: p.episodeKey,
      playing: false,
      buffering: false,
      positionMs: p.startMs,
      durationMs: p.metadata.durationMs ?? 60_000,
      speed: p.speed,
    })),
    setQueue: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seekTo: vi.fn(async () => undefined),
    setSpeed: vi.fn(async () => undefined),
    setSleepTimer: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({
      playing: false,
      buffering: false,
      positionMs: 0,
      speed: 1,
    })),
    readJournal: vi.fn(async () => ({ completed: [] })),
    clearJournal: vi.fn(async () => undefined),
    ackFlush: vi.fn(async () => undefined),
  };

  const addListener: MiniPodPlugin['addListener'] = vi.fn(async (eventName, cb) => {
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    const fn = cb as (payload: unknown) => void;
    set.add(fn);
    return {
      remove: async () => {
        set?.delete(fn);
      },
    };
  });

  return { plugin: { media, addListener }, emitNative, media };
}

describe('NativeAudioEngine', () => {
  it('maps native playback state, emits nativeAdvanced on autonomous track transition, and triggers hidden flush', async () => {
    const { plugin, emitNative, media } = createMockMediaHarness();
    let visible = true;
    const hiddenFlushes: Array<'paused' | 'ended'> = [];

    const engine = new NativeAudioEngine({
      plugin,
      isVisible: () => visible,
      onHiddenFlushNeeded: (reason) => hiddenFlushes.push(reason),
    });

    // Wait for async listener registration
    await new Promise((r) => setTimeout(r, 0));

    const events: PlayerEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.load({
      episodeKey: 'e_track1',
      source: { kind: 'url', url: 'https://example.com/1.mp3' },
      startMs: 5_000,
      speed: 1.25,
      metadata: { title: 'Track 1', durationMs: 120_000 },
      mediaType: 'AUDIO',
    });
    expect(media.load).toHaveBeenCalledOnce();

    await engine.play();
    emitNative('media-state', {
      episodeKey: 'e_track1',
      playing: true,
      buffering: false,
      positionMs: 6_000,
      durationMs: 120_000,
      speed: 1.25,
    });

    // Autonomous native transition from `e_track1` -> `e_track2` while screen is off
    visible = false;
    emitNative('media-state', {
      episodeKey: 'e_track2',
      playing: true,
      buffering: false,
      positionMs: 0,
      durationMs: 90_000,
      speed: 1.25,
    });

    expect(events).toContainEqual({
      type: 'nativeAdvanced',
      from: 'e_track1',
      to: 'e_track2',
    });

    // Earbud pause while hidden -> triggers immediate hidden flush!
    emitNative('media-state', {
      episodeKey: 'e_track2',
      playing: false,
      buffering: false,
      positionMs: 14_000,
      durationMs: 90_000,
      speed: 1.25,
    });

    expect(hiddenFlushes).toEqual(['paused']);

    // Sleep timer state event mapping
    emitNative('sleep-timer-state', {
      mode: 'minutes',
      minutes: 15,
      remainingMs: 42_000,
    });
    expect(events).toContainEqual({
      type: 'sleepTimer',
      state: {
        timer: { mode: 'minutes', minutes: 15 },
        remainingMs: 42_000,
      },
    });

    engine.dispose();
  });

  it('guards pending seekTo position against in-flight pre-seek media-state ticks until native player settles', async () => {
    const { plugin, emitNative, media } = createMockMediaHarness();
    const engine = new NativeAudioEngine({ plugin });
    await new Promise((r) => setTimeout(r, 0));

    const events: PlayerEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.load({
      episodeKey: 'e_seek_ep',
      source: { kind: 'url', url: 'https://example.com/ep.mp3' },
      startMs: 10_000,
      speed: 1.0,
      metadata: { title: 'Seek Episode', durationMs: 300_000 },
      mediaType: 'AUDIO',
    });
    await engine.play();
    emitNative('media-state', {
      episodeKey: 'e_seek_ep',
      playing: true,
      buffering: false,
      positionMs: 10_000,
      durationMs: 300_000,
      speed: 1.0,
    });
    expect(engine.getSnapshot().positionMs).toBe(10_000);

    // User seeks to 120_000ms (2:00)
    engine.seekTo(120_000);
    expect(media.seekTo).toHaveBeenCalledWith({ positionMs: 120_000 });
    expect(engine.getSnapshot().positionMs).toBe(120_000);

    // An in-flight pre-seek `media-state` tick arrives right before native `seekToMs` executes
    emitNative('media-state', {
      episodeKey: 'e_seek_ep',
      playing: true,
      buffering: true,
      positionMs: 10_000,
      durationMs: 300_000,
      speed: 1.0,
    });
    // `positionMs` MUST remain pinned at `120_000` instead of snapping backward to `10_000`!
    expect(engine.getSnapshot().positionMs).toBe(120_000);

    // Post-seek `media-state` arrives once ExoPlayer reaches the target position
    emitNative('media-state', {
      episodeKey: 'e_seek_ep',
      playing: true,
      buffering: false,
      positionMs: 120_200,
      durationMs: 300_000,
      speed: 1.0,
    });
    expect(engine.getSnapshot().positionMs).toBe(120_200);

    // Subsequent 1s playback ticks continue updating `positionMs` normally
    emitNative('media-state', {
      episodeKey: 'e_seek_ep',
      playing: true,
      buffering: false,
      positionMs: 121_200,
      durationMs: 300_000,
      speed: 1.0,
    });
    expect(engine.getSnapshot().positionMs).toBe(121_200);

    engine.dispose();
  });
  it('publishes a stopped state (pos 0) BEFORE `ended` and pins trailing paused media-state of the finished episode to 0 (b1d6d66b)', async () => {
    const { plugin, emitNative } = createMockMediaHarness();
    const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
    await new Promise((r) => setTimeout(r, 0));
    const events: PlayerEvent[] = [];
    engine.subscribe((ev) => events.push(ev));

    await engine.load({
      episodeKey: 'e_done',
      source: { kind: 'url', url: 'https://example.com/done.mp3' },
      startMs: 0,
      speed: 1.0,
      metadata: { title: 'Done', durationMs: 1_800_000 },
      mediaType: 'AUDIO',
    });
    await engine.play();
    emitNative('media-state', {
      episodeKey: 'e_done',
      playing: true,
      buffering: false,
      positionMs: 1_700_000,
      durationMs: 1_800_000,
      speed: 1.0,
    });
    events.length = 0;

    emitNative('media-ended', { episodeKey: 'e_done' });
    expect(events.map((e) => e.type)).toEqual(['state', 'ended']);
    expect(events[0]).toMatchObject({
      type: 'state',
      snapshot: { episodeKey: 'e_done', playing: false, buffering: false, positionMs: 0 },
    });

    // Trailing `emitCurrentState()` from PlaybackService (old builds report the end position,
    // ~100 s before the RSS-declared duration): no pause-looking state/position events.
    events.length = 0;
    emitNative('media-state', {
      episodeKey: 'e_done',
      playing: false,
      buffering: false,
      positionMs: 1_700_500,
      durationMs: 1_800_000,
      speed: 1.0,
    });
    expect(events).toEqual([]);
    expect(engine.getSnapshot()).toMatchObject({ episodeKey: 'e_done', playing: false, positionMs: 0 });

    // A deliberate seek on the finished episode is honored again.
    engine.seekTo(60_000);
    emitNative('media-state', {
      episodeKey: 'e_done',
      playing: false,
      buffering: false,
      positionMs: 60_000,
      durationMs: 1_800_000,
      speed: 1.0,
    });
    expect(engine.getSnapshot().positionMs).toBe(60_000);

    engine.dispose();
  });

  it('flags media-ended auto-advance as a completed nativeAdvanced', async () => {
    const { plugin, emitNative } = createMockMediaHarness();
    const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
    await new Promise((r) => setTimeout(r, 0));
    const events: PlayerEvent[] = [];
    engine.subscribe((ev) => events.push(ev));
    emitNative('media-ended', { episodeKey: 'e_a', autoAdvancedTo: 'e_b' });
    expect(events).toContainEqual({ type: 'nativeAdvanced', from: 'e_a', to: 'e_b', completed: true });
    engine.dispose();
  });
});
