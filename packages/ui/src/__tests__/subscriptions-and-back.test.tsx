import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldUseImageProxy } from '../components/m3';
import {
  clearArtworkCacheForTests,
  getRememberedCandidateIndex,
  isArtworkLoaded,
  pinLoadedArtwork,
  rememberResolvedCandidate,
} from '../lib/artwork-cache';
import { renderMiniPod } from './test-helpers';

describe('Subscriptions, Unplayed Timeline, Conditional Manage Downloads & LIFO Back Navigation', () => {
  afterEach(() => {
    clearArtworkCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders 3 subscribed podcasts in grid-only view with direct top-right Settings button (no overflow menu or list toggle), refreshes, and unsubscribes via context menu', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    expect(screen.getByText('内核茶话会')).toBeInTheDocument();
    expect(screen.getByText('Minimalist Design Radio')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subs-overflow-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subs-toggle-layout')).not.toBeInTheDocument();
    expect(screen.getByTestId('subs-settings-btn')).toBeInTheDocument();

    // Strictly zero unread badges and NO top-right `⋮` button on podcast tiles
    expect(screen.queryByText(/unplayed/i)).not.toBeInTheDocument();
    const feeds = await host.feeds.list();
    const mdr = feeds.find((f) => f.title === 'Minimalist Design Radio')!;
    expect(screen.queryByTestId(`feed-menu-${mdr.feedKey}`)).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`feed-tile-${mdr.feedKey}`).querySelector('.m-podcast-tile__menu'),
    ).toBeNull();

    // Direct top-right Settings button navigates to Settings and back to Subscriptions synchronously on frame 0 without clearing list
    fireEvent.click(screen.getByTestId('subs-settings-btn'));
    expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    expect(screen.getByTestId('subscriptions-screen')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();
    expect(screen.getByText('Syntax & Signal')).toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-list')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-empty')).not.toBeInTheDocument();

    // Manual refresh button works
    fireEvent.click(screen.getByTestId('subs-refresh-btn'));

    // Unsubscribe Minimalist Design Radio via right-click context menu on grid tile
    fireEvent.contextMenu(screen.getByTestId(`feed-tile-${mdr.feedKey}`), {
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

  it('renders Latest Episodes timeline filtered to unplayed sorted by pubDate DESC, removes on right-swipe, navigates to podcast from context menu, and paginates >30 episodes', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    const timeline = await screen.findByTestId('subs-timeline-section');
    expect(timeline).toHaveTextContent('Latest episodes');

    // Collect unplayed episodes across subscribed feeds and verify strict pubDate DESC order
    const subscribedFeeds = await host.feeds.list();
    const unplayedPages = await Promise.all(
      subscribedFeeds.map((f) => host.episodes.list(f.feedKey, 'unplayed')),
    );
    const expectedOrder = unplayedPages
      .flatMap((p) => p.items.map((i) => i.episode))
      .sort((a, b) => {
        const diff = (b.pubDate ?? 0) - (a.pubDate ?? 0);
        return diff !== 0 ? diff : a.episodeKey.localeCompare(b.episodeKey);
      });

    // Played episode 41 (`41: Parsing 15 Years`) is excluded from Timeline (`7` unplayed instead of `8` total)
    expect(expectedOrder).toHaveLength(7);
    expect(screen.queryByText(/41: Parsing 15 Years/)).not.toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent(
      String(expectedOrder.length),
    );

    const renderedRows = within(screen.getByTestId('subs-timeline-list')).getAllByTestId(
      /^episode-row-/,
    );
    expect(renderedRows.map((el) => el.getAttribute('data-testid'))).toEqual(
      expectedOrder.map((ep) => `episode-row-${ep.episodeKey}`),
    );

    // Every timeline row has 0 inline buttons
    expect(renderedRows[0]!.querySelectorAll('button')).toHaveLength(0);

    // Swipe right on first timeline row replaces it in-place with inline Undo (no bottom snackbar), and Undo restores it
    const firstEp = expectedOrder[0]!;
    const firstTimelineRowEl = screen.getByTestId(`episode-row-${firstEp.episodeKey}`);
    fireEvent.touchStart(firstTimelineRowEl, { touches: [{ clientX: 80, clientY: 160 }] });
    fireEvent.touchMove(firstTimelineRowEl, { touches: [{ clientX: 190, clientY: 161 }] });
    fireEvent.touchEnd(firstTimelineRowEl, { changedTouches: [{ clientX: 200, clientY: 161 }] });

    expect(await screen.findByTestId(`inline-undo-${firstEp.episodeKey}`)).toHaveTextContent(
      'Marked played and removed',
    );
    expect(screen.queryByTestId(`episode-row-${firstEp.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('snackbar')).toBeNull();

    fireEvent.click(screen.getByTestId(`inline-undo-btn-${firstEp.episodeKey}`));
    expect(await screen.findByTestId(`episode-row-${firstEp.episodeKey}`)).toBeInTheDocument();

    // Opening podcast from timeline episode's context menu (`Go to podcast`) navigates to PodcastDetail
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${firstEp.episodeKey}`), {
      clientX: 200,
      clientY: 240,
    });
    fireEvent.click(await screen.findByTestId(`ep-open-podcast-${firstEp.episodeKey}`));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();

    // Navigate back to Subscriptions and add enough feeds so total unplayed timeline episodes > 30
    fireEvent.click(screen.getByTestId('detail-back-btn'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();

    const extraUrls = Array.from(
      { length: 14 },
      (_, idx) => `https://feeds.example.org/extra-show-${idx + 1}.xml`,
    );
    await act(async () => {
      await host.feeds.subscribeMany(extraUrls);
    });

    // Each extra preview feed adds 2 unplayed episodes -> 7 + 28 = 35 > 30
    await waitFor(() => {
      expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('35');
    });
    expect(
      within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
    ).toBe(30);

    const loadMoreBtn = screen.getByTestId('subs-timeline-load-more');
    fireEvent.click(loadMoreBtn);
    await waitFor(() => {
      expect(
        within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
      ).toBe(35);
    });
    expect(screen.queryByTestId('subs-timeline-load-more')).not.toBeInTheDocument();
  });

  it('conditionally displays Manage Downloads button in top-right appbar ONLY when >= 1 downloaded episode exists and opens DownloadsPage to delete downloads with swipe hint', async () => {
    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();

    // Initially 2 episodes (`ep42` and `kt-17`) have `downloadState === 'DONE'` -> `管理下载 (2)` icon button appears!
    const manageBtn = await screen.findByTestId('subs-manage-downloads');
    expect(manageBtn.getAttribute('aria-label')).toBe('管理下载 (2)');

    // Open DownloadsPage
    fireEvent.click(manageBtn);
    expect(await screen.findByTestId('downloads-screen')).toBeInTheDocument();
    expect(screen.getByTestId('downloads-header-title')).toHaveTextContent('管理下载');
    expect(screen.getByTestId('downloads-count')).toHaveTextContent('2');
    expect(within(screen.getByTestId('downloads-list')).getAllByTestId(/^episode-row-/)).toHaveLength(
      2,
    );

    // Swipe-left on the first downloaded row reveals `删除下载` danger edge hint and deletes that single download (`2 -> 1`)
    const firstDlRow = within(screen.getByTestId('downloads-list')).getAllByTestId(
      /^episode-row-/,
    )[0]!;
    const firstDlKey = firstDlRow.getAttribute('data-testid')!.replace('episode-row-', '');
    fireEvent.touchStart(firstDlRow, { touches: [{ clientX: 260, clientY: 120 }] });
    fireEvent.touchMove(firstDlRow, { touches: [{ clientX: 140, clientY: 121 }] });
    const dlSwipeHint = screen.getByTestId(`swipe-hint-left-${firstDlKey}`);
    expect(dlSwipeHint).toHaveTextContent('删除已下载文件');
    expect(dlSwipeHint.getAttribute('data-swipe-armed')).toBe('true');

    fireEvent.touchEnd(firstDlRow, { changedTouches: [{ clientX: 120, clientY: 120 }] });
    await waitFor(() => {
      expect(screen.getByTestId('downloads-count')).toHaveTextContent('1');
    });
    expect(screen.queryByTestId('snackbar')).toBeNull();

    // Click `全部删除` (`downloads-delete-all-btn`) -> deletes remaining download and shows empty state
    fireEvent.click(screen.getByTestId('downloads-delete-all-btn'));
    expect(await screen.findByTestId('downloads-empty')).toHaveTextContent('暂无已下载的单集');

    // Navigate back to Subscriptions -> `subs-manage-downloads` MUST BE HIDDEN when 0 downloads exist!
    fireEvent.click(screen.getByTestId('downloads-back-btn'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-manage-downloads')).not.toBeInTheDocument();

    // Triggering a download via episode context menu makes `管理下载 (1)` reappear immediately!
    const firstTimelineRow = within(screen.getByTestId('subs-timeline-list')).getAllByTestId(
      /^episode-row-/,
    )[0]!;
    const epKey = firstTimelineRow.getAttribute('data-testid')!.replace('episode-row-', '');
    fireEvent.contextMenu(firstTimelineRow, { clientX: 180, clientY: 220 });
    fireEvent.click(await screen.findByTestId(`ep-download-${epKey}`));

    await waitFor(async () => {
      expect((await host.episodes.get(epKey)).episode.downloadState).toBe('DONE');
    });
    const reappearedBtn = await screen.findByTestId('subs-manage-downloads');
    expect(reappearedBtn.getAttribute('aria-label')).toBe('管理下载 (1)');
  });

  it('collapses >6 subscriptions in grid mode with Show all (N) / Show less toggle', async () => {
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

    // Re-expand all 8 and verify switching tabs (Subscriptions -> Queue -> Settings -> Subscriptions) preserves expanded state & renders synchronously on frame 0
    fireEvent.click(expandToggle);
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(8);

    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(screen.getByTestId('queue-screen')).toBeInTheDocument();
    expect(screen.getByTestId('queue-list')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-rail-settings'));
    expect(screen.getByTestId('settings-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    expect(screen.getByTestId('subscriptions-screen')).toBeInTheDocument();
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(8);
    expect(screen.getByTestId('subs-timeline-list')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-empty')).not.toBeInTheDocument();
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
    fireEvent.click(tile);
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('detail-overflow-btn'));
    const overflowPopup = document.body.querySelector('.m-menu') as HTMLElement | null;
    expect(overflowPopup).not.toBeNull();
    const menuLeft = Number.parseFloat(overflowPopup!.style.left);
    const menuTop = Number.parseFloat(overflowPopup!.style.top);
    expect(menuLeft).toBeGreaterThanOrEqual(8);
    expect(menuLeft + 200).toBeLessThanOrEqual(390 - 8);
    expect(menuTop).toBeGreaterThanOrEqual(8);
    expect(menuTop + 112).toBeLessThanOrEqual(844 - 8);
  });

  it('pins decoded artwork bitmaps in memory, remembers resolved candidate index, and enables image proxy on Android & desktop', async () => {
    expect(shouldUseImageProxy('desktop')).toBe(true);
    expect(shouldUseImageProxy('node')).toBe(true);
    expect(shouldUseImageProxy('android')).toBe(true);

    const testUrl = 'https://cdn.example.org/cover-1.jpg';
    expect(isArtworkLoaded(testUrl)).toBe(false);
    pinLoadedArtwork(testUrl);
    expect(isArtworkLoaded(testUrl)).toBe(true);

    const candidatesKey = `${testUrl}\n/api/image-proxy?url=${encodeURIComponent(testUrl)}`;
    expect(getRememberedCandidateIndex(candidatesKey)).toBeUndefined();
    rememberResolvedCandidate(candidatesKey, 1);
    expect(getRememberedCandidateIndex(candidatesKey)).toBe(1);

    const { host } = renderMiniPod({ width: 1024 });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    const feeds = await host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const tileImg = screen.getByTestId(`feed-tile-${syntax.feedKey}`).querySelector('img')!;

    // Triggering load on tile image pins the URL in artwork-cache and switches loading="eager" / decoding="sync"
    fireEvent.load(tileImg);
    expect(isArtworkLoaded(tileImg.getAttribute('src'))).toBe(true);
    expect(tileImg.getAttribute('loading')).toBe('eager');
    expect(tileImg.getAttribute('decoding')).toBe('sync');
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

    // Tap first episode row directly so MiniPlayer appears on mobile
    const epRows = screen.getAllByTestId(/^episode-row-/);
    fireEvent.click(epRows[0]!);

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
