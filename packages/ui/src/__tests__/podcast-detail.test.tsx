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
    // Opening a subscribed podcast from SubscriptionsGrid renders hero and episodes synchronously on frame 0 without flashing detail-empty
    expect(screen.getByTestId('podcast-detail-screen')).toBeInTheDocument();
    expect(screen.getByTestId('detail-episode-list')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-empty')).not.toBeInTheDocument();

    // All 4 initial episodes visible synchronously on frame 0
    expect(screen.getByText(/42: Zero-Backend Sync/)).toBeInTheDocument();
    expect(screen.getByText(/41: Parsing 15 Years/)).toBeInTheDocument();
    expect(screen.getByText(/40: Live Studio Walkthrough/)).toBeInTheDocument();
    expect(screen.getByText(/39: SQLite WAL Mode/)).toBeInTheDocument();

    // Filter `Unplayed` hides played episode 41 synchronously on the very first render pass
    fireEvent.click(screen.getByTestId('filter-chip-unplayed'));
    expect(screen.queryByText(/41: Parsing 15 Years/)).not.toBeInTheDocument();
    expect(screen.getByText(/42: Zero-Backend Sync/)).toBeInTheDocument();
    expect(screen.getByTestId('detail-episode-list')).toBeInTheDocument();

    // Filter `Downloaded` shows only episode 42 (`DONE`) synchronously on the very first render pass
    fireEvent.click(screen.getByTestId('filter-chip-downloaded'));
    expect(screen.queryByText(/39: SQLite WAL Mode/)).not.toBeInTheDocument();
    expect(screen.getByText(/42: Zero-Backend Sync/)).toBeInTheDocument();
    expect(screen.getByTestId('detail-episode-list')).toBeInTheDocument();

    // Switch back to `All` synchronously on the very first render pass
    fireEvent.click(screen.getByTestId('filter-chip-all'));
    expect(screen.getByText(/39: SQLite WAL Mode/)).toBeInTheDocument();
    expect(screen.getByText(/41: Parsing 15 Years/)).toBeInTheDocument();

    // Sort order button right of `Downloaded` chip toggles between newest-first (`desc`) and oldest-first (`asc`) and persists in view cache
    const sortBtn = screen.getByTestId('detail-sort-order-btn');
    expect(sortBtn).toHaveAttribute('data-sort-order', 'desc');
    const getRenderedTitles = () =>
      Array.from(
        screen.getByTestId('detail-episode-list').querySelectorAll('.m-episode-row__title'),
      ).map((el) => el.textContent ?? '');
    expect(getRenderedTitles()[0]).toMatch(/^42:/);
    expect(getRenderedTitles()[3]).toMatch(/^39:/);

    fireEvent.click(sortBtn);
    expect(screen.getByTestId('detail-sort-order-btn')).toHaveAttribute('data-sort-order', 'asc');
    expect(getRenderedTitles()[0]).toMatch(/^39:/);
    expect(getRenderedTitles()[3]).toMatch(/^42:/);

    // Navigating back to Subscriptions and reopening PodcastDetail preserves sortOrder (`asc`) on frame 0
    fireEvent.click(screen.getByTestId('detail-back-btn'));
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Syntax & Signal'));
    expect(screen.getByTestId('detail-sort-order-btn')).toHaveAttribute('data-sort-order', 'asc');
    expect(getRenderedTitles()[0]).toMatch(/^39:/);

    // Toggle back to `desc` for the rest of the test
    fireEvent.click(screen.getByTestId('detail-sort-order-btn'));
    expect(screen.getByTestId('detail-sort-order-btn')).toHaveAttribute('data-sort-order', 'desc');
    expect(getRenderedTitles()[0]).toMatch(/^42:/);

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

    // Playback did NOT switch to ep 39 on long-press, and context menu opened with strictly 2 items (`Add to queue`, `View details`)
    expect(engine.getSnapshot().episodeKey).toBe(ep42.episodeKey);
    const epCtxMenu = screen.getByTestId('ep-context-menu');
    expect(epCtxMenu).toBeInTheDocument();
    expect(epCtxMenu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-view-details-${ep39.episodeKey}`)).toHaveTextContent(
      'View details',
    );
    expect(screen.queryByTestId(`ep-play-next-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-download-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-mark-played-${ep39.episodeKey}`)).not.toBeInTheDocument();

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
    expect(screen.getByTestId('ep-context-menu').querySelectorAll('[role="menuitem"]')).toHaveLength(
      2,
    );
    fireEvent.click(await screen.findByTestId(`ep-queue-btn-${ep39.episodeKey}`));
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q.some((r) => r.episode.episodeKey === ep39.episodeKey)).toBe(false);
    });

    // Clicking `ep-view-details-*` opens `episode-detail-sheet` with Shownotes, Play/Pause, and Queue toggle
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${ep42.episodeKey}`), {
      clientX: 200,
      clientY: 180,
    });
    fireEvent.click(await screen.findByTestId(`ep-view-details-${ep42.episodeKey}`));
    const detailSheet42 = await screen.findByTestId('episode-detail-sheet');
    expect(detailSheet42).toHaveTextContent(ep42.title);
    expect(detailSheet42).toHaveTextContent('Syntax & Signal');
    expect(screen.getByTestId(`ep-detail-play-${ep42.episodeKey}`)).toHaveTextContent('Pause');
    expect(screen.getByTestId(`ep-detail-queue-${ep42.episodeKey}`)).toHaveTextContent(
      'Remove from queue',
    );
    expect(screen.queryByTestId(`ep-open-podcast-${ep42.episodeKey}`)).not.toBeInTheDocument();
    const shownotes42 = screen.getByTestId(`ep-detail-shownotes-${ep42.episodeKey}`);
    expect(shownotes42).toHaveTextContent('Fractional indexing');
    const externalLink = shownotes42.querySelector('a')!;
    fireEvent.click(externalLink);
    expect(host.openedExternalUrls).toContain('https://antennapod.org');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // Pre-download ep 39 via host so swipe-right mark-played also verifies auto-delete download when played
    await act(async () => {
      await host.episodes.download(ep39.episodeKey);
    });

    // Swipe Left (`deltaX < -64px`, right-to-left) on ep 39 -> reveals Play Next edge hint & inserts as Play Next (index 1)
    const row39Fresh = screen.getByTestId(`episode-row-${ep39.episodeKey}`);
    fireEvent.touchStart(row39Fresh, { touches: [{ clientX: 280, clientY: 120 }] });
    fireEvent.touchMove(row39Fresh, { touches: [{ clientX: 240, clientY: 121 }] });
    const leftHintUnarmed = screen.getByTestId(`swipe-hint-left-${ep39.episodeKey}`);
    expect(leftHintUnarmed).toHaveTextContent('Play next');
    expect(leftHintUnarmed.getAttribute('data-swipe-armed')).toBe('false');

    fireEvent.touchMove(row39Fresh, { touches: [{ clientX: 170, clientY: 122 }] });
    const leftHintArmed = screen.getByTestId(`swipe-hint-left-${ep39.episodeKey}`);
    expect(leftHintArmed.getAttribute('data-swipe-armed')).toBe('true');

    fireEvent.touchEnd(row39Fresh, { changedTouches: [{ clientX: 160, clientY: 122 }] });

    expect(await screen.findByTestId(`inline-undo-${ep39.episodeKey}`)).toHaveTextContent(
      'Playing next',
    );
    expect(screen.getByTestId(`inline-undo-btn-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId('snackbar')).toBeNull();
    // Episode row itself still has 0 inline buttons
    expect(screen.getByTestId(`episode-row-${ep39.episodeKey}`).querySelectorAll('button')).toHaveLength(
      0,
    );
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q[1]?.episode.episodeKey).toBe(ep39.episodeKey);
    });

    // Swipe Right (`deltaX > +64px`, left-to-right) via pointer drag on ep 39 -> reveals Mark Played edge hint, marks PLAYED & replaces row in-place with inline Undo (no bottom snackbar)!
    const row39BeforeDismiss = screen.getByTestId(`episode-row-${ep39.episodeKey}`);
    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 150 }),
    );
    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 195, clientY: 152 }),
    );
    const rightHintArmed = screen.getByTestId(`swipe-hint-right-${ep39.episodeKey}`);
    expect(rightHintArmed).toHaveTextContent('Mark played');
    expect(rightHintArmed.getAttribute('data-swipe-armed')).toBe('true');

    fireEvent(
      row39BeforeDismiss,
      new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 210, clientY: 152 }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId(`episode-row-${ep39.episodeKey}`)).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('snackbar')).toBeNull();
    expect(await screen.findByTestId(`inline-undo-${ep39.episodeKey}`)).toHaveTextContent(
      'Marked played and removed',
    );
    await waitFor(async () => {
      const updated = await host.episodes.get(ep39.episodeKey);
      expect(updated.progress?.state).toBe('PLAYED');
      expect(updated.inQueue).toBe(false);
      // Because deleteDownloadWhenPlayed is true by default, marking played auto-deletes the download
      expect(updated.episode.downloadState).toBe('NONE');
    });

    // Inline Undo restores ep 39 to unplayed AND puts it back in the visible list & queue!
    fireEvent.click(screen.getByTestId(`inline-undo-btn-${ep39.episodeKey}`));
    expect(await screen.findByTestId(`episode-row-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`inline-undo-${ep39.episodeKey}`)).not.toBeInTheDocument();
    await waitFor(async () => {
      const restored = await host.episodes.get(ep39.episodeKey);
      expect(restored.progress?.state).toBe('NEW');
      expect(restored.inQueue).toBe(true);
    });

    // Audio-only VIDEO episode context menu still has strictly 2 items, and its `episode-detail-sheet` includes `ep-open-video-*`
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${ep40Video.episodeKey}`), {
      clientX: 200,
      clientY: 200,
    });
    expect(screen.getByTestId('ep-context-menu').querySelectorAll('[role="menuitem"]')).toHaveLength(
      2,
    );
    fireEvent.click(await screen.findByTestId(`ep-view-details-${ep40Video.episodeKey}`));
    expect(await screen.findByTestId('episode-detail-sheet')).toBeInTheDocument();
    const openVideoBtn = await screen.findByTestId(`ep-open-video-${ep40Video.episodeKey}`);
    fireEvent.click(openVideoBtn);
    expect(host.openedExternalUrls).toContain('https://cdn.example.org/ss/40.mp4');
    fireEvent.keyDown(window, { key: 'Escape' });

    // RFC 5005 `Load older episodes` appends archived episodes 38 & 37 and removes footer button
    const loadOlderBtn = screen.getByTestId('detail-load-older-btn');
    fireEvent.click(loadOlderBtn);

    expect(await screen.findByText(/38: Archive — Designing Calm Interfaces/)).toBeInTheDocument();
    expect(screen.getByText(/37: Archive — Media3/)).toBeInTheDocument();
    expect(screen.queryByTestId('detail-load-older-btn')).not.toBeInTheDocument();
  });
});
