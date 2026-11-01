import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldUseImageProxy } from '../components/m3';
import {
  AUTO_REFRESH_MIN_INTERVAL_MS,
  computeSubscriptionsGridCols,
  MAX_SUBS_COLLAPSED_ROWS,
} from '../features/subscriptions/SubscriptionsGrid';
import { App, createMockPlatformHost, createMockPlayerEngine } from '../index';
import {
  clearArtworkCacheForTests,
  getRememberedCandidateIndex,
  isArtworkLoaded,
  pinLoadedArtwork,
  rememberResolvedCandidate,
} from '../lib/artwork-cache';
import { renderMiniPod, setViewportWidth } from './test-helpers';

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

  it('renders Latest Episodes timeline excluding played, in-progress/playing & queued episodes, removes immediately on tap-to-play or swipe-left Play Next (with Undo), removes on right-swipe, and paginates >30 episodes', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    const timeline = await screen.findByTestId('subs-timeline-section');
    expect(timeline).toHaveTextContent('Latest episodes');

    // Collect unplayed, unstarted & unqueued episodes across subscribed feeds and verify strict pubDate DESC order
    const subscribedFeeds = await host.feeds.list();
    const allPages = await Promise.all(
      subscribedFeeds.map((f) => host.episodes.list(f.feedKey, 'all')),
    );
    const expectedOrder = allPages
      .flatMap((p) =>
        p.items
          .filter(
            (i) =>
              i.progress?.state !== 'PLAYED' &&
              i.progress?.state !== 'IN_PROGRESS' &&
              (i.progress?.positionMs ?? 0) <= 0 &&
              !i.inQueue,
          )
          .map((i) => i.episode),
      )
      .sort((a, b) => {
        const diff = (b.pubDate ?? 0) - (a.pubDate ?? 0);
        return diff !== 0 ? diff : a.episodeKey.localeCompare(b.episodeKey);
      });

    // Played ep 41, in-progress/queued ep 42, and queued kt-18 & mdr-09 are excluded -> 4 episodes remain
    expect(expectedOrder).toHaveLength(4);
    const timelineList = screen.getByTestId('subs-timeline-list');
    expect(within(timelineList).queryByText(/41: Parsing 15 Years/)).not.toBeInTheDocument();
    expect(within(timelineList).queryByText(/42: Zero-Backend Sync/)).not.toBeInTheDocument();
    expect(within(timelineList).queryByText(/Vol\.18/)).not.toBeInTheDocument();
    expect(within(timelineList).queryByText(/09: Dynamic Color/)).not.toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('4');

    const renderedRows = within(timelineList).getAllByTestId(/^episode-row-/);
    expect(renderedRows.map((el) => el.getAttribute('data-testid'))).toEqual(
      expectedOrder.map((ep) => `episode-row-${ep.episodeKey}`),
    );

    // Every timeline row has 0 inline buttons
    expect(renderedRows[0]!.querySelectorAll('button')).toHaveLength(0);

    // Swipe left (Play Next) on first timeline row replaces it in-place with inline Undo (`Playing next`), and Undo removes from queue & restores it in timeline
    const firstEp = expectedOrder[0]!;
    const firstRowForPlayNext = screen.getByTestId(`episode-row-${firstEp.episodeKey}`);
    fireEvent.touchStart(firstRowForPlayNext, { touches: [{ clientX: 260, clientY: 160 }] });
    fireEvent.touchMove(firstRowForPlayNext, { touches: [{ clientX: 150, clientY: 161 }] });
    fireEvent.touchEnd(firstRowForPlayNext, { changedTouches: [{ clientX: 140, clientY: 161 }] });

    expect(await screen.findByTestId(`inline-undo-${firstEp.episodeKey}`)).toHaveTextContent(
      'Playing next',
    );
    expect(screen.queryByTestId(`episode-row-${firstEp.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('snackbar')).toBeNull();

    fireEvent.click(screen.getByTestId(`inline-undo-btn-${firstEp.episodeKey}`));
    expect(await screen.findByTestId(`episode-row-${firstEp.episodeKey}`)).toBeInTheDocument();

    // Swipe right on first timeline row replaces it in-place with inline Undo (no bottom snackbar), and Undo restores it
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

    // Tapping the last timeline episode starts playback and immediately removes it from Latest episodes on frame 0 (`4 -> 3`)
    const tappedEp = expectedOrder[3]!;
    fireEvent.click(screen.getByTestId(`episode-row-${tappedEp.episodeKey}`));
    expect(screen.queryByTestId(`episode-row-${tappedEp.episodeKey}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('3');
    await waitFor(() => {
      expect(engine.getSnapshot().episodeKey).toBe(tappedEp.episodeKey);
    });

    // Opening podcast from timeline episode's 2-item context menu (`View details` -> `Go to podcast`) navigates to PodcastDetail
    fireEvent.contextMenu(screen.getByTestId(`episode-row-${firstEp.episodeKey}`), {
      clientX: 200,
      clientY: 240,
    });
    const epMenu = await screen.findByTestId('ep-context-menu');
    expect(within(epMenu).getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByTestId(`ep-queue-btn-${firstEp.episodeKey}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`ep-view-details-${firstEp.episodeKey}`));

    const detailSheet = await screen.findByTestId('episode-detail-sheet');
    expect(detailSheet).toHaveTextContent(firstEp.title);
    expect(screen.getByTestId(`ep-detail-play-${firstEp.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-detail-queue-${firstEp.episodeKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-detail-shownotes-${firstEp.episodeKey}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`ep-open-podcast-${firstEp.episodeKey}`));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();

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

    // Each extra preview feed adds 2 unplayed & unqueued episodes -> 3 + 28 = 31 > 30
    await waitFor(() => {
      expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('31');
    });
    expect(
      within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
    ).toBe(30);

    const loadMoreBtn = screen.getByTestId('subs-timeline-load-more');
    fireEvent.click(loadMoreBtn);
    await waitFor(() => {
      expect(
        within(screen.getByTestId('subs-timeline-list')).getAllByTestId(/^episode-row-/).length,
      ).toBe(31);
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

    // Queueing an episode via the 2-item episode context menu (`加入队列`, `查看详情`) and downloading it from Queue makes `管理下载 (1)` reappear immediately!
    const firstTimelineRow = within(screen.getByTestId('subs-timeline-list')).getAllByTestId(
      /^episode-row-/,
    )[0]!;
    const epKey = firstTimelineRow.getAttribute('data-testid')!.replace('episode-row-', '');
    fireEvent.contextMenu(firstTimelineRow, { clientX: 180, clientY: 220 });
    const zhEpMenu = await screen.findByTestId('ep-context-menu');
    expect(within(zhEpMenu).getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByTestId(`ep-queue-btn-${epKey}`)).toHaveTextContent('加入队列');
    expect(screen.getByTestId(`ep-view-details-${epKey}`)).toHaveTextContent('查看详情');
    fireEvent.click(screen.getByTestId(`ep-queue-btn-${epKey}`));

    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(await screen.findByTestId('queue-screen')).toBeInTheDocument();
    const queuedRow = await screen.findByTestId('queue-row-3');
    fireEvent.contextMenu(queuedRow, { clientX: 180, clientY: 220 });
    fireEvent.click(await screen.findByTestId(`queue-download-${epKey}`));

    await waitFor(async () => {
      expect((await host.episodes.get(epKey)).episode.downloadState).toBe('DONE');
    });
    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    const reappearedBtn = await screen.findByTestId('subs-manage-downloads');
    expect(reappearedBtn.getAttribute('aria-label')).toBe('管理下载 (1)');
  });

  it('shows strictly `Delete download` + `View details` (no queue toggle) in the DownloadsPage long-press `ep-context-menu` and deletes the download', async () => {
    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('subs-manage-downloads'));
    expect(await screen.findByTestId('downloads-screen')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('downloads-count')).toHaveTextContent('2');
    });

    const dlRows = within(screen.getByTestId('downloads-list')).getAllByTestId(/^episode-row-/);
    const firstDlKey = dlRows[0]!.getAttribute('data-testid')!.replace('episode-row-', '');
    const secondDlKey = dlRows[1]!.getAttribute('data-testid')!.replace('episode-row-', '');

    // Right-click: `删除已下载文件` + `查看详情` only, no `ep-queue-btn-*`
    fireEvent.contextMenu(dlRows[0]!, { clientX: 180, clientY: 160 });
    const dlMenu = await screen.findByTestId('ep-context-menu');
    expect(within(dlMenu).getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByTestId(`ep-delete-download-${firstDlKey}`)).toHaveTextContent('删除已下载文件');
    expect(screen.getByTestId(`ep-view-details-${firstDlKey}`)).toHaveTextContent('查看详情');
    expect(screen.queryByTestId(`ep-queue-btn-${firstDlKey}`)).not.toBeInTheDocument();

    // `查看详情` opens `episode-detail-sheet`
    fireEvent.click(screen.getByTestId(`ep-view-details-${firstDlKey}`));
    expect(await screen.findByTestId('episode-detail-sheet')).toBeInTheDocument();
    expect(screen.getByTestId(`ep-detail-shownotes-${firstDlKey}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`ep-detail-close-${firstDlKey}`));
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // `删除已下载文件` deletes the file and reloads DownloadsPage (`2 -> 1`)
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload');
    fireEvent.contextMenu(dlRows[0]!, { clientX: 180, clientY: 160 });
    fireEvent.click(await screen.findByTestId(`ep-delete-download-${firstDlKey}`));
    await waitFor(() => {
      expect(screen.getByTestId('downloads-count')).toHaveTextContent('1');
    });
    expect(deleteSpy).toHaveBeenCalledWith(firstDlKey);
    expect((await host.episodes.get(firstDlKey)).episode.downloadState).not.toBe('DONE');
    expect(screen.queryByTestId(`episode-row-${firstDlKey}`)).not.toBeInTheDocument();

    // Long-press (~450ms) on the remaining row opens the same 2-item downloads menu
    const remainingRow = screen.getByTestId(`episode-row-${secondDlKey}`);
    vi.useFakeTimers();
    fireEvent(
      remainingRow,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 160 }),
    );
    act(() => {
      vi.advanceTimersByTime(460);
    });
    fireEvent(
      remainingRow,
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 160 }),
    );
    vi.useRealTimers();
    const lpMenu = screen.getByTestId('ep-context-menu');
    expect(within(lpMenu).getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByTestId(`ep-delete-download-${secondDlKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ep-view-details-${secondDlKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`ep-queue-btn-${secondDlKey}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`ep-delete-download-${secondDlKey}`));
    expect(await screen.findByTestId('downloads-empty')).toBeInTheDocument();
  });

  it('computes flexible multi-column cover grid and collapses after 2 rows (12 on 6-col desktop, 8 on 4-col phone like OnePlus 13T) with Show all (N) / Show less toggle', async () => {
    expect(MAX_SUBS_COLLAPSED_ROWS).toBe(2);
    // Compact phones (360px, 390px OnePlus 13T, 412px) -> 4 columns per row (8 max before collapse)
    expect(computeSubscriptionsGridCols(320)).toBe(3);
    expect(computeSubscriptionsGridCols(360)).toBe(4);
    expect(computeSubscriptionsGridCols(390)).toBe(4);
    expect(computeSubscriptionsGridCols(412)).toBe(4);
    expect(computeSubscriptionsGridCols(480)).toBe(5);
    expect(computeSubscriptionsGridCols(600)).toBe(6);
    // Desktop viewports -> 5..8 columns per row
    expect(computeSubscriptionsGridCols(840)).toBe(5);
    expect(computeSubscriptionsGridCols(1024)).toBe(6);
    expect(computeSubscriptionsGridCols(1160)).toBe(7);
    expect(computeSubscriptionsGridCols(1280)).toBe(8);

    const { host } = renderMiniPod({ width: 1024 });
    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid').getAttribute('data-grid-cols')).toBe('6');

    // With 3 feeds, no expand toggle is shown
    expect(screen.queryByTestId('subs-expand-toggle')).not.toBeInTheDocument();

    // Subscribe to 11 more feeds -> total 14 feeds (> 12 threshold for 2 rows × 6 cols on 1024px desktop)
    await act(async () => {
      await host.feeds.subscribeMany(
        Array.from({ length: 11 }, (_, i) => `https://feeds.example.org/desk-cast-${i + 1}.xml`),
      );
    });

    const expandToggle = await screen.findByTestId('subs-expand-toggle');
    expect(expandToggle).toHaveTextContent('Show all (14)');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(12);

    // Expand all 14
    fireEvent.click(expandToggle);
    expect(expandToggle).toHaveTextContent('Show less');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(14);

    // Collapse back to 12 (2 rows × 6 cols)
    fireEvent.click(expandToggle);
    expect(expandToggle).toHaveTextContent('Show all (14)');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(12);

    // Re-expand all 14 and verify switching tabs (Subscriptions -> Queue -> Settings -> Subscriptions) preserves expanded state & renders synchronously on frame 0
    fireEvent.click(expandToggle);
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(14);

    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(screen.getByTestId('queue-screen')).toBeInTheDocument();
    expect(screen.getByTestId('queue-list')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-rail-settings'));
    expect(screen.getByTestId('settings-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    expect(screen.getByTestId('subscriptions-screen')).toBeInTheDocument();
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(14);
    expect(screen.getByTestId('subs-timeline-list')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-empty')).not.toBeInTheDocument();
  });

  it('shows 4 covers per row (max 2 rows = 8 covers before collapsing) on compact phone screens (390px) and localizes labels in zh-CN', async () => {
    const { host } = renderMiniPod({
      width: 390,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    expect(await screen.findByText('最新单集')).toBeInTheDocument();
    expect(screen.getByTestId('subs-grid').getAttribute('data-grid-cols')).toBe('4');

    // Subscribe to 5 more feeds -> total 8 feeds (exact 2 rows × 4 cols = 8 -> NOT collapsed yet!)
    await act(async () => {
      await host.feeds.subscribeMany([
        'https://feeds.example.org/zh-1.xml',
        'https://feeds.example.org/zh-2.xml',
        'https://feeds.example.org/zh-3.xml',
        'https://feeds.example.org/zh-4.xml',
        'https://feeds.example.org/zh-5.xml',
      ]);
    });
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(8);
    expect(screen.queryByTestId('subs-expand-toggle')).not.toBeInTheDocument();

    // Subscribe to 2 more feeds -> total 10 feeds (> 8 threshold for 2 rows × 4 cols)
    await act(async () => {
      await host.feeds.subscribeMany([
        'https://feeds.example.org/zh-6.xml',
        'https://feeds.example.org/zh-7.xml',
      ]);
    });
    const zhToggle = await screen.findByTestId('subs-expand-toggle');
    expect(zhToggle).toHaveTextContent('展开全部 (10)');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(8);
    fireEvent.click(zhToggle);
    expect(zhToggle).toHaveTextContent('收起');
    expect(within(screen.getByTestId('subs-grid')).getAllByTestId(/^feed-tile-/).length).toBe(10);
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

  it('marks all Latest Episodes as played via subs-mark-all-played-btn on the right of 最新单集, clears the list, and only admits newer unplayed episodes afterwards', async () => {
    let mockNow = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);

    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: {
        now: () => mockNow,
        initialSettings: { uiLanguage: 'zh-CN' },
      },
    });

    expect(await screen.findByText('最新单集')).toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('4');

    const markAllBtn = screen.getByTestId('subs-mark-all-played-btn');
    expect(markAllBtn).not.toBeDisabled();
    expect(markAllBtn.getAttribute('aria-label')).toBe('全部标为已播');
    expect(markAllBtn.style.marginLeft).toBe('auto');
    expect(markAllBtn.closest('.m-timeline-header')).not.toBeNull();

    const initialTimelineKeys = within(screen.getByTestId('subs-timeline-list'))
      .getAllByTestId(/^episode-row-/)
      .map((el) => el.getAttribute('data-testid')!.replace('episode-row-', ''));
    expect(initialTimelineKeys).toHaveLength(4);

    fireEvent.click(markAllBtn);

    // Immediately clears timeline list on frame 0 and disables button
    expect(screen.queryByTestId('subs-timeline-list')).not.toBeInTheDocument();
    expect(await screen.findByTestId('subs-timeline-empty')).toBeInTheDocument();
    expect(screen.getByTestId('subs-mark-all-played-btn')).toBeDisabled();

    // Every episode previously in `最新单集` is marked PLAYED
    await waitFor(async () => {
      for (const epKey of initialTimelineKeys) {
        const row = await host.episodes.get(epKey);
        expect(row.progress?.state).toBe('PLAYED');
      }
    });

    // Removing an older unstarted episode from Queue (`pubDate <= timelineClearedCutoffMs`) does NOT admit it back into `最新单集`
    const queueBefore = await host.queue.list();
    const unstartedQueued = queueBefore.find(
      (q) =>
        q.progress?.state !== 'PLAYED' &&
        q.progress?.state !== 'IN_PROGRESS' &&
        (q.progress?.positionMs ?? 0) <= 0,
    );
    expect(unstartedQueued).toBeDefined();
    await act(async () => {
      await host.queue.remove(unstartedQueued!.episode.episodeKey);
    });
    expect(screen.getByTestId('subs-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-timeline-list')).not.toBeInTheDocument();

    // Subscribing to a feed whose episodes all have `pubDate <= timelineClearedCutoffMs` ALSO stays excluded
    await act(async () => {
      await host.feeds.subscribe('https://feeds.example.org/archive-only-show.xml');
    });
    expect(screen.getByTestId('subs-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-timeline-list')).not.toBeInTheDocument();

    // Advancing clock by +2 days so a newly published episode has `pubDate > timelineClearedCutoffMs` (while its older sibling is `-6d <= cutoff`)
    mockNow += 2 * 86_400_000;
    await act(async () => {
      await host.feeds.subscribe('https://feeds.example.org/fresh-updates-show.xml');
    });

    // Strictly ONLY the 1 newly updated episode (`pubDate > cutoff`) enters `最新单集`!
    await waitFor(() => {
      expect(screen.getByTestId('subs-timeline-count')).toHaveTextContent('1');
    });
    const freshRows = within(screen.getByTestId('subs-timeline-list')).getAllByTestId(
      /^episode-row-/,
    );
    expect(freshRows).toHaveLength(1);
    expect(screen.getByTestId('subs-mark-all-played-btn')).not.toBeDisabled();
  });

  it('disables downward pull-to-refresh on Subscriptions and enforces the 30-minute AUTO_REFRESH_MIN_INTERVAL_MS cooldown on entry while manual refresh always runs', async () => {
    expect(AUTO_REFRESH_MIN_INTERVAL_MS).toBe(30 * 60_000);

    let mockNow = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);

    setViewportWidth(390);
    const host = createMockPlatformHost({
      now: () => mockNow,
      initialSettings: { uiLanguage: 'en' },
    });
    const refreshSpy = vi.spyOn(host.feeds, 'refresh');
    const engine = createMockPlayerEngine({ capabilities: { video: true } });

    render(<App host={host} engine={engine} />);

    expect(await screen.findByText('Syntax & Signal')).toBeInTheDocument();
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    // Touch pull-down (`touchstart` -> `touchend` downward) on `subscriptions-screen` MUST NOT trigger refresh
    const subsScreen = screen.getByTestId('subscriptions-screen');
    fireEvent.touchStart(subsScreen, { touches: [{ clientX: 180, clientY: 20 }] });
    fireEvent.touchMove(subsScreen, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchEnd(subsScreen, { changedTouches: [{ clientX: 180, clientY: 240 }] });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Re-entering Subscriptions within 30 minutes (e.g. +10 min) skips auto-refresh
    mockNow += 10 * 60_000;
    fireEvent.click(screen.getByTestId('nav-bar-queue'));
    expect(screen.getByTestId('queue-screen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nav-bar-subscriptions'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Re-entering Subscriptions after >= 30 minutes triggers auto-refresh once
    mockNow += AUTO_REFRESH_MIN_INTERVAL_MS;
    fireEvent.click(screen.getByTestId('nav-bar-queue'));
    expect(screen.getByTestId('queue-screen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nav-bar-subscriptions'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });

    // Manual `subs-refresh-btn` ALWAYS runs immediately even with 0ms elapsed
    fireEvent.click(screen.getByTestId('subs-refresh-btn'));
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(3);
    });
  });
});
