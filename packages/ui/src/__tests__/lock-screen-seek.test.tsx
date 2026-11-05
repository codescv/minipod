/**
 * v0.1.27 feature request "把锁屏界面增加快进快退按钮" (lock-screen Rewind -10 s / Fast-forward +30 s).
 *
 * Seeks made outside the app (Android lock screen / notification / System UI, Bluetooth keys, or
 * the browser's `navigator.mediaSession`) reach the UI as a `state` event with `seeked: true`.
 * A paused rewind to 0:00 must be shown and persisted, while the transient native idle-0
 * protection (8536c0e3 / 49ee9ff) stays intact for every other paused `positionMs: 0`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlAudioEngine, normalizeSeekOffsetMs } from '../player/HtmlAudioEngine';
import { renderMiniPod } from './test-helpers';

function miniPlayerClock(): string {
  const el = screen.getByTestId('mini-player').querySelector('.m-mini-player__time');
  return el?.textContent ?? '';
}

async function playAndPauseAt(mobile: ReturnType<typeof renderMiniPod>, positionMs: number) {
  const { host, engine } = mobile;
  await screen.findByText('Syntax & Signal');
  const feeds = await host.feeds.list();
  const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
  fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
  const rows = await screen.findAllByTestId(/^episode-row-/);
  const epKey = rows[0]!.getAttribute('data-testid')!.replace(/^episode-row-/, '');
  fireEvent.click(rows[0]!);
  await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
  act(() => {
    engine.emitPosition(positionMs);
  });
  fireEvent.click(screen.getByTestId('mini-player-play-btn'));
  await waitFor(() => expect(engine.getSnapshot().playing).toBe(false));
  const durationMs = engine.getSnapshot().durationMs;
  return { epKey, durationMs };
}

describe('lock-screen Rewind -10 s / Fast-forward +30 s sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows and persists a paused lock-screen rewind from 0:06 to 0:00', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey, durationMs } = await playAndPauseAt(mobile, 6_000);
    expect(miniPlayerClock()).toMatch(/^0?0:06/);
    const saveSpy = vi.spyOn(mobile.host.progress, 'save');

    // Native `PlaybackService.onPositionDiscontinuity` after the lock-screen -10 s tap.
    act(() => {
      mobile.engine.emitRawState(
        {
          episodeKey: epKey,
          playing: false,
          buffering: false,
          positionMs: 0,
          speed: 1,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
        { seeked: true },
      );
    });

    expect(miniPlayerClock()).toMatch(/^0?0:00/);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ episodeKey: epKey, positionMs: 0, state: 'IN_PROGRESS' }),
    );
    await waitFor(async () => {
      const prog = await mobile.host.progress.get(epKey);
      expect(prog).toMatchObject({ positionMs: 0, state: 'IN_PROGRESS' });
    });

    // The following `position` event for 0 is accepted too (no snap back to 0:06).
    act(() => {
      mobile.engine.emitPosition(0);
    });
    expect(miniPlayerClock()).toMatch(/^0?0:00/);

    // Expanded player agrees.
    fireEvent.click(screen.getByTestId('mini-player'));
    const slider = (await screen.findByTestId('expanded-seek-slider')) as HTMLInputElement;
    expect(slider.value).toBe('0');
  });

  it('still ignores a transient paused idle 0 without `seeked` (background service restart)', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey, durationMs } = await playAndPauseAt(mobile, 6_000);
    const saveSpy = vi.spyOn(mobile.host.progress, 'save');

    act(() => {
      mobile.engine.emitRawState({
        episodeKey: epKey,
        playing: false,
        buffering: false,
        positionMs: 0,
        speed: 1,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    });

    expect(miniPlayerClock()).toMatch(/^0?0:06/);
    expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ positionMs: 0 }));
  });

  it('shows and persists a paused lock-screen fast-forward from 0:06 to 0:36', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey, durationMs } = await playAndPauseAt(mobile, 6_000);

    act(() => {
      mobile.engine.emitRawState(
        {
          episodeKey: epKey,
          playing: false,
          buffering: false,
          positionMs: 36_000,
          speed: 1,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
        { seeked: true },
      );
    });

    expect(miniPlayerClock()).toMatch(/^0?0:36/);
    await waitFor(async () => {
      const prog = await mobile.host.progress.get(epKey);
      expect(prog).toMatchObject({ positionMs: 36_000, state: 'IN_PROGRESS' });
    });
  });

  it('reflects a reconciled IN_PROGRESS 0:00 checkpoint (rewind while the WebView was frozen) on foreground', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey, durationMs } = await playAndPauseAt(mobile, 8_000);
    expect(miniPlayerClock()).toMatch(/^0?0:08/);

    // Foreground `syncStateFromNative()` without the flag: still treated as a transient idle 0.
    act(() => {
      mobile.engine.emitRawState({
        episodeKey: epKey,
        playing: false,
        buffering: false,
        positionMs: 0,
        speed: 1,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    });
    expect(miniPlayerClock()).toMatch(/^0?0:08/);

    // Host reconciles the native `seeked: true` 0 checkpoint -> IN_PROGRESS@0 + progress-changed.
    await act(async () => {
      await mobile.host.progress.save({ episodeKey: epKey, positionMs: 0, state: 'IN_PROGRESS' });
      mobile.host.emit({ type: 'progress-changed', episodeKey: epKey });
    });
    await waitFor(() => expect(miniPlayerClock()).toMatch(/^0?0:00/));

    // And it sticks (the trailing transient 0 / position events do not snap back to 0:08).
    act(() => {
      mobile.engine.emitPosition(0);
    });
    expect(miniPlayerClock()).toMatch(/^0?0:00/);
  });

  it('does not save IN_PROGRESS for a seek that lands in the completion tail (native `ended` marks PLAYED)', async () => {
    const mobile = renderMiniPod({ width: 390 });
    const { epKey, durationMs } = await playAndPauseAt(mobile, 6_000);
    expect(durationMs).toBeGreaterThan(0);
    const saveSpy = vi.spyOn(mobile.host.progress, 'save');

    act(() => {
      mobile.engine.emitRawState(
        { episodeKey: epKey, playing: true, buffering: false, positionMs: durationMs!, speed: 1, durationMs: durationMs! },
        { seeked: true },
      );
    });

    expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'IN_PROGRESS', positionMs: durationMs }));
  });
});

describe('web navigator.mediaSession seekbackward / seekforward parity', () => {
  type Handler = (details: MediaSessionActionDetails) => void;
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');

  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, 'mediaSession', original);
    } else {
      delete (navigator as { mediaSession?: unknown }).mediaSession;
    }
  });

  function installFakeMediaSession(): Map<string, Handler | null> {
    const handlers = new Map<string, Handler | null>();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: (action: string, handler: Handler | null) => {
          handlers.set(action, handler);
        },
        setPositionState: () => undefined,
      },
    });
    return handlers;
  }

  it('normalizes OS-provided seek offsets safely', () => {
    expect(normalizeSeekOffsetMs(undefined, 10_000)).toBe(10_000);
    expect(normalizeSeekOffsetMs(null, 30_000)).toBe(30_000);
    expect(normalizeSeekOffsetMs(0, 30_000)).toBe(30_000);
    expect(normalizeSeekOffsetMs(-5, 10_000)).toBe(10_000);
    expect(normalizeSeekOffsetMs(Number.NaN, 10_000)).toBe(10_000);
    expect(normalizeSeekOffsetMs(Number.POSITIVE_INFINITY, 30_000)).toBe(30_000);
    expect(normalizeSeekOffsetMs(15, 30_000)).toBe(15_000);
    expect(normalizeSeekOffsetMs(99_999, 30_000)).toBe(600_000);
  });

  it('registers seekbackward (-10 s) / seekforward (+30 s) / seekto and emits `seeked` states', async () => {
    const handlers = installFakeMediaSession();
    const engine = new HtmlAudioEngine();
    const states: Array<{ positionMs: number; seeked: boolean }> = [];
    engine.subscribe((ev) => {
      if (ev.type === 'state') states.push({ positionMs: ev.snapshot.positionMs, seeked: ev.seeked === true });
    });

    await engine.load({
      episodeKey: 'e_web',
      source: { kind: 'url', url: 'https://cdn.example.org/web.mp3', mime: 'audio/mpeg' },
      startMs: 6_000,
      speed: 1,
      mediaType: 'AUDIO',
      metadata: { title: 'Web', durationMs: 600_000 },
    });

    for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
      expect(typeof handlers.get(action)).toBe('function');
    }

    // Paused at 0:06: OS -10 s clamps to 0:00 and is flagged as a seek.
    handlers.get('seekbackward')!({ action: 'seekbackward' });
    expect(engine.getSnapshot().positionMs).toBe(0);
    expect(states.at(-1)).toEqual({ positionMs: 0, seeked: true });

    handlers.get('seekforward')!({ action: 'seekforward' });
    expect(engine.getSnapshot().positionMs).toBe(30_000);

    // Browser-provided offset is honored; malformed offsets fall back to the defaults.
    handlers.get('seekforward')!({ action: 'seekforward', seekOffset: 15 });
    expect(engine.getSnapshot().positionMs).toBe(45_000);
    handlers.get('seekbackward')!({ action: 'seekbackward', seekOffset: -20 });
    expect(engine.getSnapshot().positionMs).toBe(35_000);

    // seekto: finite non-negative only; clamped to the duration.
    handlers.get('seekto')!({ action: 'seekto', seekTime: Number.NaN });
    expect(engine.getSnapshot().positionMs).toBe(35_000);
    handlers.get('seekto')!({ action: 'seekto', seekTime: 9_999 });
    expect(engine.getSnapshot().positionMs).toBe(600_000);

    engine.dispose();
  });
});
