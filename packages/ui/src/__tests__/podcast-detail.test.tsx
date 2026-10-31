import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Podcast Detail, Episode Actions & RFC 5005 Pagination', () => {
  it('filters All / Unplayed / Downloaded, resumes with 3s rewind, toggles downloads, marks played, and loads older archive pages', async () => {
    // Test with audio-only engine (`videoCapable: false`) to also verify `Audio only` badge on VIDEO episodes
    const { host, engine } = renderMiniPod({ width: 1024, videoCapable: false });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();

    // All 4 initial episodes visible
    expect(await screen.findByText(/42: Zero-Backend Sync/)).toBeInTheDocument();
    expect(screen.getByText(/41: Parsing 15 Years/)).toBeInTheDocument();
    expect(screen.getByText(/40: Live Studio Walkthrough/)).toBeInTheDocument();
    expect(screen.getByText(/39: SQLite WAL Mode/)).toBeInTheDocument();

    // Video episode displays `Audio only` badge when `!engine.capabilities.video`
    expect(screen.getByText('Audio only')).toBeInTheDocument();

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

    // Playing IN_PROGRESS ep 42 (saved at 480_000 ms) resumes at 477_000 ms (3s rewind)
    fireEvent.click(screen.getByTestId(`ep-play-${ep42.episodeKey}`));
    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(engine.loadedItem?.startMs).toBe(477_000);

    // Inline row actions on ep 39: Play + Add-to-Queue + Overflow Menu (download is inside menu, not inline)
    expect(screen.getByTestId(`ep-play-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-menu-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`ep-download-${ep39.episodeKey}`)).not.toBeInTheDocument();

    // Inline Add-to-Queue toggles queue membership and shows snackbar
    fireEvent.click(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`));
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Added to queue');
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q.some((r) => r.episode.episodeKey === ep39.episodeKey)).toBe(true);
    });

    // Clicking inline queue button again removes from queue
    fireEvent.click(screen.getByTestId(`ep-queue-btn-${ep39.episodeKey}`));
    await waitFor(async () => {
      const q = await host.queue.list();
      expect(q.some((r) => r.episode.episodeKey === ep39.episodeKey)).toBe(false);
    });

    // Overflow menu on ep 39: contains ONLY Download + Mark played (NO Play next, NO Share link)
    fireEvent.click(screen.getByTestId(`ep-menu-${ep39.episodeKey}`));
    expect(screen.getByTestId(`ep-download-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-mark-played-${ep39.episodeKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`ep-play-next-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-share-${ep39.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByText(/play next/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/share/i)).not.toBeInTheDocument();

    // Download ep 39 from inside overflow menu (`NONE` -> `DONE`) and verify downloaded badge
    fireEvent.click(screen.getByTestId(`ep-download-${ep39.episodeKey}`));
    await waitFor(async () => {
      const updated = await host.episodes.get(ep39.episodeKey);
      expect(updated.episode.downloadState).toBe('DONE');
    });
    expect(await screen.findByTestId(`ep-downloaded-badge-${ep39.episodeKey}`)).toBeInTheDocument();

    // Mark ep 39 played via overflow menu
    fireEvent.click(screen.getByTestId(`ep-menu-${ep39.episodeKey}`));
    fireEvent.click(screen.getByTestId(`ep-mark-played-${ep39.episodeKey}`));
    expect(await screen.findByTestId(`ep-played-badge-${ep39.episodeKey}`)).toBeInTheDocument();

    // Audio-only VIDEO episode overflow menu includes `ep-open-video-*` and still NO Play next / Share
    fireEvent.click(screen.getByTestId(`ep-menu-${ep40Video.episodeKey}`));
    expect(screen.getByTestId(`ep-open-video-${ep40Video.episodeKey}`)).toBeInTheDocument();
    expect(screen.queryByText(/play next/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/share/i)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    // RFC 5005 `Load older episodes` appends archived episodes 38 & 37 and removes footer button
    const loadOlderBtn = screen.getByTestId('detail-load-older-btn');
    fireEvent.click(loadOlderBtn);

    expect(await screen.findByText(/38: Archive — Designing Calm Interfaces/)).toBeInTheDocument();
    expect(screen.getByText(/37: Archive — Media3/)).toBeInTheDocument();
    expect(screen.queryByTestId('detail-load-older-btn')).not.toBeInTheDocument();
  });
});
