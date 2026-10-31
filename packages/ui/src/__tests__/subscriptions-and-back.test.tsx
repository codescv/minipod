import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Subscriptions & LIFO Back Navigation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders 3 subscribed podcasts in cover grid without unread badges or top-right ⋮ buttons, toggles list view, refreshes, and unsubscribes via context menu', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    expect(screen.getByText('内核茶话会')).toBeInTheDocument();
    expect(screen.getByText('Minimalist Design Radio')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();

    // Strictly zero unread badges and NO top-right `⋮` button on podcast tiles
    expect(screen.queryByText(/unplayed/i)).not.toBeInTheDocument();
    const feeds = await host.feeds.list();
    const mdr = feeds.find((f) => f.title === 'Minimalist Design Radio')!;
    expect(screen.queryByTestId(`feed-menu-${mdr.feedKey}`)).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`feed-tile-${mdr.feedKey}`).querySelector('.m-podcast-tile__menu'),
    ).toBeNull();

    // Toggle to list view via overflow menu
    fireEvent.click(screen.getByTestId('subs-overflow-btn'));
    fireEvent.click(screen.getByTestId('subs-toggle-layout'));
    expect(await screen.findByTestId('subs-list')).toBeInTheDocument();
    expect(screen.queryByTestId(`feed-menu-${mdr.feedKey}`)).not.toBeInTheDocument();

    // Manual refresh button works
    fireEvent.click(screen.getByTestId('subs-refresh-btn'));

    // Unsubscribe Minimalist Design Radio via right-click context menu
    fireEvent.contextMenu(screen.getByTestId(`feed-list-item-${mdr.feedKey}`), {
      clientX: 240,
      clientY: 180,
    });
    expect(await screen.findByTestId('subs-context-menu')).toBeInTheDocument();
    expect(screen.getByTestId(`subs-copy-url-${mdr.feedKey}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`subs-unsubscribe-${mdr.feedKey}`));

    await waitFor(() => {
      expect(screen.queryByText('Minimalist Design Radio')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('snackbar')).toHaveTextContent(/Minimalist Design Radio/);
  });

  it('renders Latest Episodes timeline below Subscriptions sorted by pubDate DESC, navigates to podcast on thumb/title click, and paginates >30 episodes', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    const timeline = await screen.findByTestId('subs-timeline-section');
    expect(timeline).toHaveTextContent('Latest episodes');

    // Collect all episodes across subscribed feeds and verify strict pubDate DESC order
    const subscribedFeeds = await host.feeds.list();
    const allPages = await Promise.all(
      subscribedFeeds.map((f) => host.episodes.list(f.feedKey, 'all')),
    );
    const expectedOrder = allPages
      .flatMap((p) => p.items.map((i) => i.episode))
      .sort((a, b) => {
        const diff = (b.pubDate ?? 0) - (a.pubDate ?? 0);
        return diff !== 0 ? diff : a.episodeKey.localeCompare(b.episodeKey);
      });

    expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent(
      String(expectedOrder.length),
    );

    const renderedRows = within(screen.getByTestId('subs-timeline-list')).getAllByTestId(
      /^episode-row-/,
    );
    expect(renderedRows.map((el) => el.getAttribute('data-testid'))).toEqual(
      expectedOrder.map((ep) => `episode-row-${ep.episodeKey}`),
    );

    // Clicking a timeline episode's podcast title link opens PodcastDetail for that feed
    const firstEp = expectedOrder[0]!;
    fireEvent.click(screen.getByTestId(`ep-podcast-link-${firstEp.episodeKey}`));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();

    // Navigate back to Subscriptions and add enough feeds so total timeline episodes > 30
    fireEvent.click(screen.getByTestId('detail-back-btn'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();

    const extraUrls = Array.from(
      { length: 14 },
      (_, idx) => `https://feeds.example.org/extra-show-${idx + 1}.xml`,
    );
    await act(async () => {
      await host.feeds.subscribeMany(extraUrls);
    });

    // Each extra preview feed adds 2 episodes -> 8 + 28 = 36 > 30
    await waitFor(() => {
      expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('36');
    });
    expect(
      within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
    ).toBe(30);

    const loadMoreBtn = screen.getByTestId('subs-timeline-load-more');
    fireEvent.click(loadMoreBtn);
    await waitFor(() => {
      expect(
        within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
      ).toBe(36);
    });
    expect(screen.queryByTestId('subs-timeline-load-more')).not.toBeInTheDocument();
  });

  it('collapses >6 subscriptions in grid mode (and >4 in list mode) with Show all (N) / Show less toggle', async () => {
    const { host } = renderMiniPod({ width: 1024 });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();

    // With 3 feeds, no expand toggle is shown
    expect(screen.queryByTestId('subs-expand-toggle')).not.toBeInTheDocument();

    // Subscribe to 5 more feeds -> total 8 feeds (> 6 grid threshold)
    await act(async () => {
      await host.feeds.subscribeMany([
        'https://feeds.example.org/alpha-cast.xml',
        'https://feeds.example.org/beta-cast.xml',
        'https://feeds.example.org/gamma-cast.xml',
        'https://feeds.example.org/delta-cast.xml',
        'https://feeds.example.org/epsilon-cast.xml',
      ]);
    });

    const expandToggle = await screen.findByTestId('subs-expand-toggle');
    expect(expandToggle).toHaveTextContent('Show all (8)');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(6);

    // Expand all 8
    fireEvent.click(expandToggle);
    expect(expandToggle).toHaveTextContent('Show less');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(8);

    // Collapse back to 6
    fireEvent.click(expandToggle);
    expect(expandToggle).toHaveTextContent('Show all (8)');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(6);

    // Switch to list mode -> collapses to 4 items
    fireEvent.click(screen.getByTestId('subs-overflow-btn'));
    fireEvent.click(screen.getByTestId('subs-toggle-layout'));
    expect(await screen.findByTestId('subs-list')).toBeInTheDocument();
    expect(within(screen.getByTestId('subs-list')).getAllByTestId(/^feed-list-item-/).length).toBe(4);
  });

  it('localizes timeline and expandable subscriptions labels in zh-CN', async () => {
    const { host } = renderMiniPod({
      width: 390,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    expect(await screen.findByText('最新单集')).toBeInTheDocument();
    await act(async () => {
      await host.feeds.subscribeMany([
        'https://feeds.example.org/zh-1.xml',
        'https://feeds.example.org/zh-2.xml',
        'https://feeds.example.org/zh-3.xml',
        'https://feeds.example.org/zh-4.xml',
        'https://feeds.example.org/zh-5.xml',
      ]);
    });
    const zhToggle = await screen.findByTestId('subs-expand-toggle');
    expect(zhToggle).toHaveTextContent('展开全部 (8)');
    fireEvent.click(zhToggle);
    expect(zhToggle).toHaveTextContent('收起');
  });

  it('opens viewport-clamped context menu on ~450ms long-press (suppressing click & cancelling on pointer move) and clamps Menu near screen edges', async () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 844,
    });
    const { host } = renderMiniPod({ width: 390 });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();

    const feeds = await host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const tile = screen.getByTestId(`feed-tile-${syntax.feedKey}`);

    // Mock `.m-menu` dimensions (200x112) and overflow anchor near bottom-right corner (350..386, 804..840)
    const origGetBCR = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList?.contains('m-menu')) {
        const left = Number.parseFloat(this.style.left || '0') || 0;
        const top = Number.parseFloat(this.style.top || '0') || 0;
        return {
          x: left,
          y: top,
          left,
          top,
          width: 200,
          height: 112,
          right: left + 200,
          bottom: top + 112,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.classList?.contains('m-menu-anchor')) {
        return {
          x: 350,
          y: 804,
          left: 350,
          top: 804,
          width: 36,
          height: 36,
          right: 386,
          bottom: 840,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBCR.call(this);
    });

    vi.useFakeTimers();

    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      fireEvent(
        tile,
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX,
          clientY,
        }),
      );
    };

    // 1. Pointer move > 10px before 450ms cancels long-press
    dispatchPointer('pointerdown', 100, 120);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    dispatchPointer('pointermove', 130, 120);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    dispatchPointer('pointerup', 130, 120);
    expect(screen.queryByTestId('subs-context-menu')).not.toBeInTheDocument();

    // 2. Holding for 450ms near bottom-right corner (385, 840) on 390x844 opens clamped ContextMenu
    dispatchPointer('pointerdown', 385, 840);
    act(() => {
      vi.advanceTimersByTime(460);
    });
    dispatchPointer('pointerup', 385, 840);
    // Subsequent synthetic click after long-press MUST NOT navigate into PodcastDetail!
    fireEvent.click(tile);

    vi.useRealTimers();

    expect(screen.queryByTestId('podcast-detail-screen')).not.toBeInTheDocument();
    const ctxMenu = screen.getByTestId('subs-context-menu');
    const ctxLeft = Number.parseFloat(ctxMenu.style.left);
    const ctxTop = Number.parseFloat(ctxMenu.style.top);
    // Clamped to 390 - 200 - 8 = 182 and 844 - 112 - 8 = 724 -> 100% inside 390x844 viewport!
    expect(ctxLeft).toBe(182);
    expect(ctxTop).toBe(724);
    expect(ctxLeft).toBeGreaterThanOrEqual(8);
    expect(ctxTop).toBeGreaterThanOrEqual(8);
    expect(ctxLeft + 200).toBeLessThanOrEqual(390 - 8);
    expect(ctxTop + 112).toBeLessThanOrEqual(844 - 8);

    // Dismiss ContextMenu via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('subs-context-menu')).not.toBeInTheDocument();

    // 3. Regular Menu near bottom-right flips above anchor & clamps inside viewport
    fireEvent.click(screen.getByTestId('subs-overflow-btn'));
    const overflowPopup = document.body.querySelector('.m-menu') as HTMLElement | null;
    expect(overflowPopup).not.toBeNull();
    const menuLeft = Number.parseFloat(overflowPopup!.style.left);
    const menuTop = Number.parseFloat(overflowPopup!.style.top);
    expect(menuLeft).toBeGreaterThanOrEqual(8);
    expect(menuLeft + 200).toBeLessThanOrEqual(390 - 8);
    expect(menuTop).toBeGreaterThanOrEqual(8);
    expect(menuTop + 112).toBeLessThanOrEqual(844 - 8);
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
