import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioEngine } from '../player/HtmlAudioEngine';
import { renderMiniPod } from './test-helpers';

describe('Player Controls, Chapters, Sleep Timer, Cross-Device Resume Undo & HtmlAudioEngine', () => {
  it('supports desktop transport, speed presets + slider, keyboard shortcuts, active chapter highlight + seek, and sanitized shownotes', async () => {
    const { host, engine } = renderMiniPod({ width: 1200 });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const playBtns = await screen.findAllByTestId(/^ep-play-/);
    fireEvent.click(playBtns[0]!);

    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(screen.getByTestId('desktop-now-playing-title')).toHaveTextContent(
      /42: Zero-Backend Sync/,
    );

    // Skip forward (+30s) and back (-10s) via buttons
    const posBefore = engine.getSnapshot().positionMs;
    fireEvent.click(screen.getByTestId('desktop-skip-forward-btn'));
    expect(engine.getSnapshot().positionMs).toBe(posBefore + 30_000);

    fireEvent.click(screen.getByTestId('desktop-skip-back-btn'));
    expect(engine.getSnapshot().positionMs).toBe(posBefore + 20_000);

    // Cycle speed presets: 1x -> 1.25x -> 1.5x -> 1.75x -> 2x -> 1x
    const speedBtn = screen.getByTestId('desktop-speed-btn');
    expect(speedBtn).toHaveTextContent('1×');
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.25×');
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.5×');

    // Fine-grain speed slider (0.5x..3.0x)
    fireEvent.click(screen.getByTestId('desktop-speed-slider-btn'));
    const slider = await screen.findByTestId('desktop-speed-slider');
    fireEvent.change(slider, { target: { value: '2.35' } });
    expect(engine.getSnapshot().speed).toBeCloseTo(2.35, 2);

    // Keyboard shortcuts: Space pauses/plays, J/L skip, [/] adjust speed, Q opens Queue
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(engine.getSnapshot().playing).toBe(false);
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(engine.getSnapshot().playing).toBe(true);

    const beforeKeySkip = engine.getSnapshot().positionMs;
    fireEvent.keyDown(window, { key: 'l' });
    expect(engine.getSnapshot().positionMs).toBe(beforeKeySkip + 30_000);
    fireEvent.keyDown(window, { key: 'j' });
    expect(engine.getSnapshot().positionMs).toBe(beforeKeySkip + 20_000);

    fireEvent.keyDown(window, { key: ']' });
    expect(engine.getSnapshot().speed).toBeCloseTo(2.45, 2);

    fireEvent.keyDown(window, { key: 'q' });
    expect(await screen.findByTestId('queue-screen')).toBeInTheDocument();

    // Open Chapters SideSheet, verify active chapter highlight & tap-to-seek
    fireEvent.click(screen.getByTestId('desktop-chapters-btn'));
    expect(await screen.findByTestId('desktop-side-sheet')).toBeInTheDocument();
    expect(await screen.findByTestId('chapters-list')).toBeInTheDocument();

    // At ~527s (8m47s), chapter index 1 (starts at 360_000ms) is active
    expect(screen.getByTestId('chapter-item-1')).toHaveAttribute('aria-current', 'true');

    // Click chapter 2 (starts at 1_080_000ms = 18:00) -> seeks immediately
    fireEvent.click(screen.getByTestId('chapter-item-2'));
    expect(engine.getSnapshot().positionMs).toBe(1_080_000);
    expect(screen.getByTestId('chapter-item-2')).toHaveAttribute('aria-current', 'true');

    // Switch SideSheet to Shownotes and click external link -> intercepted by `host.files.openExternal`
    fireEvent.click(screen.getByTestId('sidesheet-tab-shownotes'));
    const shownotes = await screen.findByTestId('shownotes-content');
    const link = shownotes.querySelector('a')!;
    fireEvent.click(link);
    expect(host.openedExternalUrls).toContain('https://antennapod.org');
  });

  it('handles Sleep Timer countdown + 60s fade-out, End-of-episode auto-advance suppression, and Cross-Device Resume Undo snackbar', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const playBtns = await screen.findAllByTestId(/^ep-play-/);
    fireEvent.click(playBtns[0]!);
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));

    const loadedKey = engine.getSnapshot().episodeKey!;
    const localPos = engine.getSnapshot().positionMs;

    // 1. Cross-device resume hint ("Resumed from Pixel 9 at 15:00 — Undo")
    act(() => {
      host.simulateRemoteProgress(loadedKey, 900_000, 'Pixel 9');
    });

    expect(engine.getSnapshot().positionMs).toBe(900_000);
    const snackbar = await screen.findByTestId('snackbar');
    expect(snackbar).toHaveTextContent('Resumed from Pixel 9 at 15:00');

    // Clicking Undo seeks back to localPos and invokes `host.sync.undoResume`
    fireEvent.click(screen.getByTestId('snackbar-action'));
    expect(engine.getSnapshot().positionMs).toBe(localPos);
    await waitFor(() => {
      expect(
        host.progressSaves.some(
          (s) => s.episodeKey === loadedKey && s.positionMs === localPos && s.flush === true,
        ),
      ).toBe(true);
    });

    // 2. Sleep timer 15 min: fades volume in final 60s and pauses at 0s
    fireEvent.click(screen.getByTestId('desktop-sleep-btn'));
    fireEvent.click(await screen.findByTestId('sleep-opt-15'));

    act(() => {
      engine.advanceSleepClock(14 * 60_000 + 30_000); // 30s remaining -> 0.5 fade factor
    });
    expect(engine.volumeFactor).toBeCloseTo(0.5, 1);
    expect(engine.getSnapshot().playing).toBe(true);

    act(() => {
      engine.advanceSleepClock(31_000); // expired -> pauses & restores volumeFactor = 1
    });
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.volumeFactor).toBe(1);

    // 3. Sleep timer `End of episode`: suppresses auto-advance when current episode finishes
    await act(async () => {
      await engine.play();
    });
    fireEvent.click(screen.getByTestId('desktop-sleep-btn'));
    fireEvent.click(await screen.findByTestId('sleep-opt-episode'));

    act(() => {
      engine.emitEnded();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.getSnapshot().episodeKey).toBe(loadedKey);
  });

  it('HtmlAudioEngine flushes progress with fetch keepalive on pagehide', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const htmlEngine = new HtmlAudioEngine({
      flushUrl: '/api/progress/save',
      fetchImpl: fetchSpy,
    });

    await htmlEngine.load({
      episodeKey: 'e_test123',
      source: { kind: 'url', url: 'https://cdn.example.org/ep.mp3', mime: 'audio/mpeg' },
      startMs: 125_000,
      speed: 1.25,
      mediaType: 'AUDIO',
      metadata: { title: 'Test Ep', durationMs: 600_000 },
    });

    window.dispatchEvent(new Event('pagehide'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/progress/save');
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      episodeKey: 'e_test123',
      positionMs: 125_000,
      durationMs: 600_000,
      state: 'IN_PROGRESS',
      flush: true,
    });

    htmlEngine.dispose();
  });
});
