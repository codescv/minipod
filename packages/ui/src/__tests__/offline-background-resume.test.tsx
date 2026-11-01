/**
 * Regression: v0.1.21 on Android 17 — "飞行模式下播放已下载音频，退到后台，暂停后再进入，
 * 点击播放按钮没反应，一直停在0秒" (Airplane Mode + downloaded audio -> background -> pause ->
 * return -> Play does nothing and the timer stays at 0:00).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createMockPlatformHost, createMockPlayerEngine } from '../index';
import { renderMiniPod, setViewportWidth } from './test-helpers';

function miniPlayerClock(): string {
  const el = screen.getByTestId('mini-player').querySelector('.m-mini-player__time');
  return el?.textContent ?? '';
}

async function playDownloadedEpisodeAndPauseInBackground(mobile: ReturnType<typeof renderMiniPod>) {
  const { host, engine } = mobile;
  await screen.findByText('Syntax & Signal');
  const feeds = await host.feeds.list();
  const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
  fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
  const rows = await screen.findAllByTestId(/^episode-row-/);
  const epKey = rows[0]!.getAttribute('data-testid')!.replace(/^episode-row-/, '');

  // Downloaded episode, played in Airplane Mode
  await host.episodes.download(epKey);
  fireEvent.click(rows[0]!);
  await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
  act(() => {
    engine.emitPosition(42_000);
  });
  await waitFor(() => expect(miniPlayerClock()).toMatch(/^0?0:42/));

  // App goes to background, user pauses (notification / headset) at 0:42
  fireEvent.click(screen.getByTestId('mini-player-play-btn'));
  await waitFor(() => expect(engine.getSnapshot().playing).toBe(false));
  expect(miniPlayerClock()).toMatch(/^0?0:42/);
  return { epKey };
}

describe('Airplane Mode downloaded playback: background pause -> foreground -> Play', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never shows 0:00 after the native service was reset, and Play reloads & resumes from the paused position', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey } = await playDownloadedEpisodeAndPauseInBackground(mobile);
    const { engine } = mobile;

    // Android stopped the paused PlaybackService: engine reports an empty idle 0 ms state
    act(() => {
      engine.emitRawState({ playing: false, buffering: false, positionMs: 0, speed: 1 });
    });
    expect(miniPlayerClock()).toMatch(/^0?0:42/);

    // Return to foreground and tap Play: must reload the episode at 0:42 and play immediately
    const loadSpy = vi.spyOn(engine, 'load');
    fireEvent.click(screen.getByTestId('mini-player-play-btn'));
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0]![0]).toMatchObject({ episodeKey: epKey, startMs: 42_000 });
    expect(engine.getSnapshot()).toMatchObject({ episodeKey: epKey, positionMs: 42_000, playing: true });
    expect(miniPlayerClock()).toMatch(/^0?0:42/);
  });

  it('keeps the paused position on a transient same-episode idle 0 state and Play resumes in place from ExpandedPlayer', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey } = await playDownloadedEpisodeAndPauseInBackground(mobile);
    const { engine } = mobile;
    const durationMs = engine.getSnapshot().durationMs;

    act(() => {
      engine.emitRawState({
        episodeKey: epKey,
        playing: false,
        buffering: false,
        positionMs: 0,
        speed: 1,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    });
    expect(miniPlayerClock()).toMatch(/^0?0:42/);

    fireEvent.click(screen.getByTestId('mini-player'));
    const expanded = await screen.findByTestId('expanded-player');
    expect(expanded).toHaveTextContent(/0?0:42/);

    const loadSpy = vi.spyOn(engine, 'load');
    fireEvent.click(screen.getByTestId('expanded-play-pause-btn'));
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
    expect(loadSpy).not.toHaveBeenCalled();
    expect(engine.getSnapshot().positionMs).toBe(42_000);
    expect(screen.getByTestId('expanded-player')).toHaveTextContent(/0?0:42/);
  });

  it('reflects the reconciled native journal checkpoint (progress-changed) on foreground instead of 0:00', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey } = await playDownloadedEpisodeAndPauseInBackground(mobile);
    const { host, engine } = mobile;

    // Native kept playing in the background until 1:35, then paused; WebView missed the ticks
    act(() => {
      engine.emitRawState({ playing: false, buffering: false, positionMs: 0, speed: 1 });
    });
    await act(async () => {
      await host.progress.save({ episodeKey: epKey, positionMs: 95_000, state: 'IN_PROGRESS' });
      host.emit({ type: 'progress-changed', episodeKey: epKey });
    });
    await waitFor(() => expect(miniPlayerClock()).toMatch(/^0?1:35/));

    fireEvent.click(screen.getByTestId('mini-player-play-btn'));
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
    expect(engine.getSnapshot()).toMatchObject({ episodeKey: epKey, positionMs: 95_000 });
  });

  it('hydrates MiniPlayer from an engine that already holds a paused episode (WebView reload) and resumes on Play', async () => {
    setViewportWidth(390);
    const host = createMockPlatformHost({ initialSettings: { uiLanguage: 'en' } });
    const engine = createMockPlayerEngine();
    const feeds = await host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const page = await host.episodes.list(syntax.feedKey, 'all');
    const ep = page.items[0]!.episode;
    await engine.load({
      episodeKey: ep.episodeKey,
      source: { kind: 'file', path: `/downloads/${ep.episodeKey}.mp3` },
      startMs: 42_000,
      speed: 1,
      mediaType: ep.mediaType,
      metadata: { title: ep.title, ...(ep.durationMs !== undefined ? { durationMs: ep.durationMs } : {}) },
    });

    render(<App host={host} engine={engine} />);
    const mini = await screen.findByTestId('mini-player');
    expect(mini).toHaveTextContent(ep.title);
    expect(miniPlayerClock()).toMatch(/^0?0:42/);

    fireEvent.click(screen.getByTestId('mini-player-play-btn'));
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
    expect(engine.getSnapshot()).toMatchObject({ episodeKey: ep.episodeKey, positionMs: 42_000 });
  });

  it('still allows an intentional seek to 0:00 while paused', async () => {
    const mobile = renderMiniPod({ width: 390 });
    await playDownloadedEpisodeAndPauseInBackground(mobile);
    fireEvent.click(screen.getByTestId('mini-player'));
    const slider = (await screen.findByTestId('expanded-seek-slider')) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '0' } });
    expect(mobile.engine.getSnapshot().positionMs).toBe(0);
    await waitFor(() => expect(slider.value).toBe('0'));
  });
});
