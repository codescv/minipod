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
    const ep39 = page.items[3]!.episode;

    // Playing IN_PROGRESS ep 42 (saved at 480_000 ms) resumes at 477_000 ms (3s rewind)
    fireEvent.click(screen.getByTestId(`ep-play-${ep42.episodeKey}`));
    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(engine.loadedItem?.startMs).toBe(477_000);

    // Download ep 39 manually (`NONE` -> `DONE`)
    fireEvent.click(screen.getByTestId(`ep-download-${ep39.episodeKey}`));
    await waitFor(async () => {
      const updated = await host.episodes.get(ep39.episodeKey);
      expect(updated.episode.downloadState).toBe('DONE');
    });

    // Overflow menu on ep 39: Add to queue + Undo snackbar, then Mark played
    fireEvent.click(screen.getByTestId(`ep-menu-${ep39.episodeKey}`));
    fireEvent.click(screen.getByTestId(`ep-queue-toggle-${ep39.episodeKey}`));
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Added to queue');

    fireEvent.click(screen.getByTestId(`ep-menu-${ep39.episodeKey}`));
    fireEvent.click(screen.getByTestId(`ep-mark-played-${ep39.episodeKey}`));
    expect(await screen.findByTestId(`ep-played-badge-${ep39.episodeKey}`)).toBeInTheDocument();

    // RFC 5005 `Load older episodes` appends archived episodes 38 & 37 and removes footer button
    const loadOlderBtn = screen.getByTestId('detail-load-older-btn');
    fireEvent.click(loadOlderBtn);

    expect(await screen.findByText(/38: Archive — Designing Calm Interfaces/)).toBeInTheDocument();
    expect(screen.getByText(/37: Archive — Media3/)).toBeInTheDocument();
    expect(screen.queryByTestId('detail-load-older-btn')).not.toBeInTheDocument();
  });
});
