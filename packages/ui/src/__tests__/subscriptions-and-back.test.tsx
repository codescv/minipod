import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Subscriptions & LIFO Back Navigation', () => {
  it('renders 3 subscribed podcasts in cover grid without unread badges, toggles list view, refreshes, and unsubscribes', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    expect(screen.getByText('内核茶话会')).toBeInTheDocument();
    expect(screen.getByText('Minimalist Design Radio')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();

    // Strictly zero unread badges
    expect(screen.queryByText(/unplayed/i)).not.toBeInTheDocument();

    // Toggle to list view via overflow menu
    fireEvent.click(screen.getByTestId('subs-overflow-btn'));
    fireEvent.click(screen.getByTestId('subs-toggle-layout'));
    expect(await screen.findByTestId('subs-list')).toBeInTheDocument();

    // Manual refresh button works
    fireEvent.click(screen.getByTestId('subs-refresh-btn'));

    // Unsubscribe Minimalist Design Radio via its per-feed menu
    const feeds = await host.feeds.list();
    const mdr = feeds.find((f) => f.title === 'Minimalist Design Radio')!;
    fireEvent.click(screen.getByTestId(`feed-menu-${mdr.feedKey}`));
    fireEvent.click(screen.getByTestId(`feed-unsubscribe-${mdr.feedKey}`));

    await waitFor(() => {
      expect(screen.queryByText('Minimalist Design Radio')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('snackbar')).toHaveTextContent(/Minimalist Design Radio/);
  });

  it('shows calm empty state with Find podcasts CTA when there are no subscriptions', async () => {
    renderMiniPod({ width: 390, hostOptions: { empty: true } });

    expect(await screen.findByTestId('subs-empty')).toBeInTheDocument();
    expect(screen.getByText('No subscriptions yet')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('subs-find-podcasts-btn'));
    expect(await screen.findByTestId('add-search-screen')).toBeInTheDocument();
  });

  it('unwinds LIFO back stack via window.__minipodHandleBack (dialog -> sheet -> expanded player -> detail -> root -> false)', async () => {
    renderMiniPod({ width: 390 });

    const syntaxTile = await screen.findByText('Syntax & Signal');
    fireEvent.click(syntaxTile);

    // Now on PodcastDetail
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();

    // Play first episode so MiniPlayer appears on mobile
    const playBtns = screen.getAllByTestId(/^ep-play-/);
    fireEvent.click(playBtns[0]!);

    const miniPlayer = await screen.findByTestId('mini-player');
    fireEvent.click(miniPlayer);

    // Expanded player open
    expect(await screen.findByTestId('expanded-player')).toBeInTheDocument();

    // Open Sleep Timer sheet on top of ExpandedPlayer
    fireEvent.click(screen.getByTestId('expanded-sleep-btn'));
    expect(await screen.findByTestId('sleep-timer-sheet')).toBeInTheDocument();

    // 1st back: closes SleepTimerSheet (via BottomSheet back interceptor)
    let consumed = false;
    act(() => {
      consumed = Boolean(window.__minipodHandleBack?.());
    });
    expect(consumed).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId('sleep-timer-sheet')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('expanded-player')).toBeInTheDocument();

    // 2nd back: collapses ExpandedPlayer -> back to PodcastDetail
    act(() => {
      consumed = Boolean(window.__minipodHandleBack?.());
    });
    expect(consumed).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId('expanded-player')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('podcast-detail-screen')).toBeInTheDocument();

    // 3rd back: pops PodcastDetail -> back to Subscriptions root
    act(() => {
      consumed = Boolean(window.__minipodHandleBack?.());
    });
    expect(consumed).toBe(true);
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();

    // 4th back at root: returns false so Android exits cleanly
    act(() => {
      consumed = Boolean(window.__minipodHandleBack?.());
    });
    expect(consumed).toBe(false);
  });
});
