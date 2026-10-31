import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Podcast Detail, Gesture-Driven EpisodeRow & RFC 5005 Pagination', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders minimalist 4-element EpisodeRow (icon, 2-line title, date, remaining time) with zero inline buttons, tap-to-play, long-press/context menu, swipe-left Play Next, and swipe-right Mark Played & Remove', async () => {
    const { host, engine } = renderMiniPod({ width: 1024, videoCapable: false });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();

    // All 4 initial episodes visible
    expect(await screen.findByText(/42: Zero-Backend Sync/)).toBeInTheDocument();
    expect(screen.getByText(/41: Parsing 15 Years/)).toBeInTheDocument();
    expect(screen.getByText(/40: Live Studio Walkthrough/)).toBeInTheDocument();
    expect(screen.getByText(/39: SQLite WAL Mode/)).toBeInTheDocument();

    // Filter `Unplayed` hides played episode 41
    fireEvent.click(screen.getByTestId('filter-chip-unplayed'));
    await waitFor(() => {
      expect(screen.queryByText(/41: Parsing 15 Years/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/42: Zero-Backend Sync/)).toBeInTheDocument();

    // Filter `Downloaded` shows only episode 42 (`DONE`)
    fireEvent.click(screen.getByTestId('filter-chip-downloaded'));
    await waitFor(() => {
      expect(screen.queryByText(/39: SQLite WAL Mode/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/42: Zero-Backend Sync/)).toBeInTheDocument();

    // Switch back to `All`
    fireEvent.click(screen.getByTestId('filter-chip-all'));
    expect(await screen.findByText(/39: SQLite WAL Mode/)).toBeInTheDocument();

    const feeds = await host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const page = await host.episodes.list(syntax.feedKey, 'all');
    const ep42 = page.items[0]!.episode;
    const ep40Video = page.items[2]!.episode;
    const ep39 = page.items[3]!.episode;

    // Strictly 4 visual elements & ZERO inline buttons or cluttered badges on EpisodeRow
    const row42 = screen.getByTestId(`episode-row-${ep42.episodeKey}`);
    const row39 = screen.getByTestId(`episode-row-${ep39.episodeKey}`);
    expect(row42.querySelectorAll('button')).toHaveLength(0);
    expect(row39.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByTestId(`ep-thumb-${ep42.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-thumb-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(row42.querySelector('.m-episode-row__title')).not.toBeNull();
    expect(row42.querySelector('.m-episode-row__meta')).toHaveTextContent(/32 min left/);
    expect(row39.querySelector('.m-episode-row__meta')).toHaveTextContent(/35 min/);
    expect(screen.queryByTestId(`ep-play-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-menu-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-played-badge-${ep42.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-downloaded-badge-${ep42.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-audio-only-${ep40Video.episodeKey}`)).not.toBeInTheDocument();

    // Clicking IN_PROGRESS ep 42 row directly resumes at 477_000 ms (3s rewind)
    fireEvent.click(row42);
    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(engine.loadedItem?.startMs).toBe(477_000);

    // Long-press (~450ms) on ep 39 opens clamped `ep-context-menu` and suppresses synthetic click
    vi.useFakeTimers();
    fireEvent(
      row39,
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 220,
        clientY: 280,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(460);
    });
    fireEvent(
      row39,
      new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 220,
        clientY: 280,
      }),
    );
    fireEvent.click(row39);
    vi.useRealTimers();

    // Playback did NOT switch to ep 39 on long-press, and context menu opened
    expect(engine.getSnapshot().episodeKey).toBe(ep42.episodeKey);
    expect(screen.getByTestId('ep-context-menu')).toBeInTheDocument();
    expect(screen.getByTestId(`ep-play-next-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-download-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-mark-played-${ep39.episodeKey}`)).toBeInTheDocument();

    // Add to queue from context menu and verify Undo / toggle
    fireEvent.click(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`));
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Added to queue');
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q.some((r) => r.episode.episodeKey === ep39.episodeKey)).toBe(true);
    });

    // Remove from queue via right-click context menu
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${ep39.episodeKey}`), {
      clientX: 200,
      clientY: 260,
    });
    fireEvent.click(await screen.findByTestId(`ep-queue-btn-${ep39.episodeKey}`));
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q.some((r) => r.episode.episodeKey === ep39.episodeKey)).toBe(false);
    });

    // Download ep 39 from context menu (`NONE` -> `DONE`)
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${ep39.episodeKey}`), {
      clientX: 200,
      clientY: 260,
    });
    fireEvent.click(await screen.findByTestId(`ep-download-${ep39.episodeKey}`));
    await waitFor(async () => {
      const updated = await host.episodes.get(ep39.episodeKey);
      expect(updated.episode.downloadState).toBe('DONE');
    });

    // Swipe Left (`deltaX < -64px`, right-to-left) on ep 39 -> inserts as Play Next (index 1)
    const row39Fresh = screen.getByTestId(`episode-row-${ep39.episodeKey}`);
    fireEvent.touchStart(row39Fresh, { touches: [{ clientX: 280, clientY: 120 }] });
    fireEvent.touchMove(row39Fresh, { touches: [{ clientX: 170, clientY: 122 }] });
    fireEvent.touchEnd(row39Fresh, { changedTouches: [{ clientX: 160, clientY: 122 }] });

    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Playing next');
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q[1]?.episode.episodeKey).toBe(ep39.episodeKey);
    });

    // Swipe Right (`deltaX > +64px`, left-to-right) via pointer drag on ep 39 -> marks PLAYED & removes immediately even in `All` filter!
    const row39BeforeDismiss = screen.getByTestId(`episode-row-${ep39.episodeKey}`);
    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 150 }),
    );
    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 195, clientY: 152 }),
    );
    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 210, clientY: 152 }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId(`episode-row-${ep39.episodeKey}`)).not.toBeInTheDocument();
    });
    await waitFor(async () => {
      const updated = await host.episodes.get(ep39.episodeKey);
      expect(updated.progress?.state).toBe('PLAYED');
      expect(updated.inQueue).toBe(false);
    });
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Marked played and removed');

    // Undo restores ep 39 to unplayed AND puts it back in the visible list & queue!
    fireEvent.click(screen.getByTestId('snackbar-action'));
    expect(await screen.findByTestId(`episode-row-${ep39.episodeKey}`)).toBeInTheDocument();
    await waitFor(async () => {
      const restored = await host.episodes.get(ep39.episodeKey);
      expect(restored.progress?.state).toBe('NEW');
      expect(restored.inQueue).toBe(true);
    });

    // Audio-only VIDEO episode context menu includes `ep-open-video-*`
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${ep40Video.episodeKey}`), {
      clientX: 200,
      clientY: 200,
    });
    expect(await screen.findByTestId(`ep-open-video-${ep40Video.episodeKey}`)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    // RFC 5005 `Load older episodes` appends archived episodes 38 & 37 and removes footer button
    const loadOlderBtn = screen.getByTestId('detail-load-older-btn');
    fireEvent.click(loadOlderBtn);

    expect(await screen.findByText(/38: Archive — Designing Calm Interfaces/)).toBeInTheDocument();
    expect(screen.getByText(/37: Archive — Media3/)).toBeInTheDocument();
    expect(screen.queryByTestId('detail-load-older-btn')).not.toBeInTheDocument();
  });
});
