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

  describe('lock-screen Rewind -10 s / Fast-forward +30 s (media-state `seeked`)', () => {
    async function pausedAt6s() {
      const harness = createMockMediaHarness();
      const engine = new NativeAudioEngine({ plugin: harness.plugin, isVisible: () => true });
      await new Promise((r) => setTimeout(r, 0));
      await engine.load({
        episodeKey: 'e_lock',
        source: { kind: 'file', path: '/downloads/e_lock.mp3' },
        startMs: 6_000,
        speed: 1.0,
        metadata: { title: 'Lock', durationMs: 600_000 },
        mediaType: 'AUDIO',
      });
      const events: PlayerEvent[] = [];
      engine.subscribe((ev) => events.push(ev));
      return { ...harness, engine, events };
    }

    it('emits a `seeked` state for a paused lock-screen rewind to 0:00 and adopts 0 as resume point', async () => {
      const { engine, events, emitNative, media } = await pausedAt6s();

      emitNative('media-state', {
        episodeKey: 'e_lock',
        playing: false,
        buffering: false,
        positionMs: 0,
        durationMs: 600_000,
        speed: 1.0,
        seeked: true,
      });

      expect(events[0]).toEqual({
        type: 'state',
        seeked: true,
        snapshot: expect.objectContaining({ episodeKey: 'e_lock', playing: false, positionMs: 0 }),
      });
      expect(events).toContainEqual(expect.objectContaining({ type: 'position', episodeKey: 'e_lock', positionMs: 0 }));
      expect(engine.getSnapshot().positionMs).toBe(0);

      // Android later stops the paused service; Play reloads from the rewound 0:00, not 0:06.
      emitNative('media-state', { playing: false, buffering: false, positionMs: 0, speed: 1.0 });
      vi.mocked(media.load).mockClear();
      vi.mocked(media.play).mockResolvedValueOnce(undefined);
      vi.mocked(media.getState).mockResolvedValueOnce({ playing: false, buffering: false, positionMs: 0, speed: 1 });
      await engine.play();
      expect(media.load).toHaveBeenCalledWith(expect.objectContaining({ episodeKey: 'e_lock', startMs: 0 }));
      engine.dispose();
    });

    it('keeps the transient idle-0 protection for payloads without `seeked`', async () => {
      const { engine, events, emitNative } = await pausedAt6s();

      emitNative('media-state', { playing: false, buffering: false, positionMs: 0, speed: 1.0 });

      expect(engine.getSnapshot()).toMatchObject({ episodeKey: 'e_lock', positionMs: 6_000 });
      expect(events.some((e) => e.type === 'state' && e.seeked === true)).toBe(false);
      engine.dispose();
    });

    it('emits a `seeked` state for a lock-screen +30 s while playing (position-only change)', async () => {
      const { engine, events, emitNative } = await pausedAt6s();
      await engine.play();
      emitNative('media-state', {
        episodeKey: 'e_lock', playing: true, buffering: false, positionMs: 7_000, durationMs: 600_000, speed: 1.0,
      });
      events.length = 0;

      emitNative('media-state', {
        episodeKey: 'e_lock', playing: true, buffering: false, positionMs: 37_000, durationMs: 600_000, speed: 1.0, seeked: true,
      });

      expect(events.map((e) => e.type)).toEqual(['state', 'position']);
      expect(events[0]).toMatchObject({ type: 'state', seeked: true, snapshot: { positionMs: 37_000, playing: true } });
      // A regular tick with the same values does not re-emit `state`.
      events.length = 0;
      emitNative('media-state', {
        episodeKey: 'e_lock', playing: true, buffering: false, positionMs: 38_000, durationMs: 600_000, speed: 1.0,
      });
      expect(events.map((e) => e.type)).toEqual(['position']);
      expect(engine.getSnapshot().positionMs).toBe(38_000);
      engine.dispose();
    });

    it('a stale native `seeked` echo of an older in-app skip does not override the newer pending target', async () => {
      const { engine, emitNative } = await pausedAt6s();
      engine.skip(30_000); // 0:36
      engine.skip(30_000); // 1:06 (pending)

      emitNative('media-state', {
        episodeKey: 'e_lock', playing: false, buffering: false, positionMs: 36_000, durationMs: 600_000, speed: 1.0, seeked: true,
      });
      expect(engine.getSnapshot().positionMs).toBe(66_000);

      emitNative('media-state', {
        episodeKey: 'e_lock', playing: false, buffering: false, positionMs: 66_000, durationMs: 600_000, speed: 1.0, seeked: true,
      });
      expect(engine.getSnapshot().positionMs).toBe(66_000);
      engine.dispose();
    });

    it('foreground syncStateFromNative() honors a `seeked` 0:00 reported by mediaGetState', async () => {
      const { engine, events, media } = await pausedAt6s();
      vi.mocked(media.getState).mockResolvedValueOnce({
        episodeKey: 'e_lock',
        playing: false,
        buffering: false,
        positionMs: 0,
        durationMs: 600_000,
        speed: 1,
        seeked: true,
      });

      const snap = await engine.syncStateFromNative();

      expect(snap).toMatchObject({ episodeKey: 'e_lock', positionMs: 0 });
      expect(events).toContainEqual(expect.objectContaining({ type: 'state', seeked: true }));
      engine.dispose();
    });

    it('an explicit lock-screen rewind re-opens a finished episode instead of pinning it to 0', async () => {
      const { engine, emitNative } = await pausedAt6s();
      emitNative('media-ended', { episodeKey: 'e_lock' });
      expect(engine.getSnapshot().positionMs).toBe(0);

      emitNative('media-state', {
        episodeKey: 'e_lock', playing: false, buffering: false, positionMs: 590_000, durationMs: 600_000, speed: 1.0, seeked: true,
      });
      expect(engine.getSnapshot().positionMs).toBe(590_000);
      engine.dispose();
    });
  });

  describe('cold WebView reconnect after headless headset resume (bc737679)', () => {
    it('publishes the adopted live playing state so subscribers do not stay on "paused"', async () => {
      const { plugin, emitNative, media } = createMockMediaHarness();
      vi.mocked(media.getState).mockResolvedValue({
        episodeKey: 'e_live',
        playing: true,
        buffering: false,
        positionMs: 754_000,
        durationMs: 1_800_000,
        speed: 1.5,
      });
      const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
      // usePlayer subscribes right away, before the async `getState()` resolved.
      const events: PlayerEvent[] = [];
      engine.subscribe((e) => events.push(e));
      await new Promise((r) => setTimeout(r, 0));

      const states = events.filter((e) => e.type === 'state');
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({
        type: 'state',
        snapshot: { episodeKey: 'e_live', playing: true, positionMs: 754_000, speed: 1.5 },
      });
      // No progress `position` re-save at boot; no stop / reload / speed change of live audio.
      expect(events.some((e) => e.type === 'position')).toBe(false);
      expect(media.load).not.toHaveBeenCalled();
      expect(media.stop).not.toHaveBeenCalled();
      expect(media.setSpeed).not.toHaveBeenCalled();
      expect(media.play).not.toHaveBeenCalled();

      // The next native tick only advances the position.
      emitNative('media-state', {
        episodeKey: 'e_live',
        playing: true,
        buffering: false,
        positionMs: 755_000,
        durationMs: 1_800_000,
        speed: 1.5,
      });
      expect(engine.getSnapshot()).toMatchObject({ playing: true, positionMs: 755_000 });
      engine.dispose();
    });

    it('publishes an adopted paused episode (saved idle state) so the MiniPlayer hydrates', async () => {
      const { plugin, media } = createMockMediaHarness();
      vi.mocked(media.getState).mockResolvedValue({
        episodeKey: 'e_paused',
        playing: false,
        buffering: false,
        positionMs: 42_000,
        speed: 1,
      });
      const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
      const events: PlayerEvent[] = [];
      engine.subscribe((e) => events.push(e));
      await new Promise((r) => setTimeout(r, 0));

      expect(events).toEqual([
        { type: 'state', snapshot: expect.objectContaining({ episodeKey: 'e_paused', playing: false, positionMs: 42_000 }) },
      ]);
      engine.dispose();
    });

    it('emits nothing when native has no episode', async () => {
      const { plugin } = createMockMediaHarness();
      const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
      const events: PlayerEvent[] = [];
      engine.subscribe((e) => events.push(e));
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual([]);
      engine.dispose();
    });

    it('play() on an adopted (not load()ed) episode trusts the native result instead of forcing playing', async () => {
      const { plugin, media } = createMockMediaHarness();
      vi.mocked(media.getState).mockResolvedValue({
        episodeKey: 'e_paused',
        playing: false,
        buffering: false,
        positionMs: 42_000,
        speed: 1,
      });
      const engine = new NativeAudioEngine({ plugin, isVisible: () => true });
      await new Promise((r) => setTimeout(r, 0));

      // Service could not restore the track (e.g. downloaded file gone): nothing playing.
      vi.mocked(media.play).mockResolvedValueOnce({ playing: false, buffering: false, positionMs: 0, speed: 1 });
      await engine.play();
      expect(engine.getSnapshot()).toMatchObject({ episodeKey: 'e_paused', playing: false, buffering: false, positionMs: 42_000 });

      // Restored and buffering: reflected as such (usePlayer will not reload).
      vi.mocked(media.play).mockResolvedValueOnce({
        episodeKey: 'e_paused',
        playing: false,
        buffering: true,
        positionMs: 42_000,
        speed: 1,
      });
      await engine.play();
      expect(engine.getSnapshot()).toMatchObject({ episodeKey: 'e_paused', buffering: true });
      expect(media.load).not.toHaveBeenCalled();
      engine.dispose();
    });
  });

  it('only reports native activity (journal reconcile) on real state changes, never on 1 s playing position ticks', async () => {
    const { plugin, emitNative } = createMockMediaHarness();
    const onNativeActivity = vi.fn();
    const engine = new NativeAudioEngine({ plugin, isVisible: () => true, onNativeActivity });
    await new Promise((r) => setTimeout(r, 0));

    await engine.load({
      episodeKey: 'e_tick',
      source: { kind: 'url', url: 'https://example.com/tick.mp3' },
      startMs: 0,
      speed: 1,
      metadata: { title: 'Tick', durationMs: 600_000 },
      mediaType: 'AUDIO',
    });
    const base = { episodeKey: 'e_tick', buffering: false, durationMs: 600_000, speed: 1 } as const;

    // play transition -> one activity
    emitNative('media-state', { ...base, playing: true, positionMs: 1_000 });
    expect(onNativeActivity).toHaveBeenCalledTimes(1);

    // 5 plain 1 s foreground ticks -> no extra readJournal round-trips
    for (let i = 2; i <= 6; i++) {
      emitNative('media-state', { ...base, playing: true, positionMs: i * 1_000 });
    }
    expect(onNativeActivity).toHaveBeenCalledTimes(1);

    // explicit seek -> activity
    emitNative('media-state', { ...base, playing: true, positionMs: 60_000, seeked: true });
    expect(onNativeActivity).toHaveBeenCalledTimes(2);

    // buffering change -> activity
    emitNative('media-state', { ...base, playing: true, buffering: true, positionMs: 61_000 });
    expect(onNativeActivity).toHaveBeenCalledTimes(3);

    // pause -> activity
    emitNative('media-state', { ...base, playing: false, positionMs: 62_000 });
    expect(onNativeActivity).toHaveBeenCalledTimes(4);

    // ended -> activity
    emitNative('media-ended', { episodeKey: 'e_tick' });
    expect(onNativeActivity).toHaveBeenCalledTimes(5);
    engine.dispose();
  });
});
