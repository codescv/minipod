/**
 * Regression (bc737679, v0.1.29 Android 17): "放到后台很快就消失了，再按耳机播放钮不会继续播放".
 * After the native `PlaybackService` resumed playback headless (headset / Bluetooth Play while the
 * WebView was gone), re-opening the app must adopt the live native state without disturbing it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createMockPlatformHost, createMockPlayerEngine } from '../index';
import { useSettingsStore } from '../stores/settings';
import { setViewportWidth } from './test-helpers';

async function liveHeadlessEpisode(speed: number) {
  setViewportWidth(390);
  const host = createMockPlatformHost({ initialSettings: { uiLanguage: 'en', playbackSpeed: speed } });
  const engine = createMockPlayerEngine();
  const feeds = await host.feeds.list();
  const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
  const page = await host.episodes.list(syntax.feedKey, 'all');
  const ep = page.items[0]!.episode;
  await engine.load({
    episodeKey: ep.episodeKey,
    source: { kind: 'url', url: 'https://example.com/ep.mp3' },
    startMs: 754_000,
    speed,
    mediaType: ep.mediaType,
    metadata: { title: ep.title, ...(ep.durationMs !== undefined ? { durationMs: ep.durationMs } : {}) },
  });
  // Native playback resumed by the headset, at the user's speed.
  engine.emitRawState({ ...engine.getSnapshot(), playing: true, buffering: false, speed });
  return { host, engine, ep };
}

describe('WebView reconnect after headless headset resume (bc737679)', () => {
  beforeEach(() => {
    useSettingsStore.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never resets live native speed to the store default before persisted settings load', async () => {
    const { host, engine, ep } = await liveHeadlessEpisode(1.5);
    const setSpeed = vi.spyOn(engine, 'setSpeed');

    render(<App host={host} engine={engine} />);
    const mini = await screen.findByTestId('mini-player');
    expect(mini).toHaveTextContent(ep.title);
    await waitFor(() => expect(useSettingsStore.getState().loaded).toBe(true));

    expect(setSpeed).not.toHaveBeenCalled();
    expect(engine.getSnapshot()).toMatchObject({ playing: true, speed: 1.5, positionMs: 754_000 });
  });

  it('still applies a different persisted speed once settings are loaded', async () => {
    const { host, engine } = await liveHeadlessEpisode(1.0);
    await host.settings.update({ playbackSpeed: 0.8 });
    const setSpeed = vi.spyOn(engine, 'setSpeed');

    render(<App host={host} engine={engine} />);
    await screen.findByTestId('mini-player');
    await waitFor(() => expect(useSettingsStore.getState().loaded).toBe(true));
    await waitFor(() => expect(setSpeed).toHaveBeenCalledWith(0.8));
    expect(setSpeed).toHaveBeenCalledTimes(1);
  });

  it('adopts an engine snapshot that changed between first render and subscription (playing, no event)', async () => {
    const { host, engine, ep } = await liveHeadlessEpisode(1.0);
    const live = engine.getSnapshot();
    // First read (PlayerProvider's initial state) still sees the pre-`getState()` empty snapshot;
    // the engine then adopts the live native state without emitting an event.
    const spy = vi.spyOn(engine, 'getSnapshot');
    spy.mockReturnValueOnce({ playing: false, buffering: false, positionMs: 0, speed: 1 });

    render(<App host={host} engine={engine} />);

    const mini = await screen.findByTestId('mini-player');
    expect(mini).toHaveTextContent(ep.title);
    expect(engine.getSnapshot()).toBe(live);
    // Shown as playing (Pause control), not stuck on Play while audio plays.
    await waitFor(() =>
      expect(screen.getByTestId('mini-player-play-btn').getAttribute('aria-label') ?? '').toMatch(/pause/i),
    );
  });
});
