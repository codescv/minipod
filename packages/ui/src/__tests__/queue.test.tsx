import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Unified Queue Gesture Rows, Working Pointer Drag Reorder, Swipe-Left Remove + Undo & Clear', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has zero inline buttons, plays on click, opens context menu on long-press/right-click, reorders via pointer drag on compact handle, and removes on swipe-left with Undo', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));

    // Queue list and rows render synchronously on the very first render pass (frame 0) without waitFor or flashing queue-empty
    expect(screen.getByTestId('queue-screen')).toBeInTheDocument();
    expect(screen.getByTestId('queue-list')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-header-title')).toHaveTextContent(/Queue · 3 episodes ·/);

    // Switching Queue -> Subscriptions -> Queue also preserves both lists synchronously on frame 0
    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();
    expect(screen.getByTestId('subs-timeline-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(screen.getByTestId('queue-list')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();
    // Top-right queue overflow menu is present in v0.1.14 (`Download all` + `Manage downloads` when non-empty)
    expect(screen.getByTestId('queue-overflow-btn')).toBeInTheDocument();

    const initialQueue = await host.queue.list();
    expect(initialQueue).toHaveLength(3);
    const firstKey = initialQueue[0]!.episode.episodeKey;
    const secondKey = initialQueue[1]!.episode.episodeKey;
    const thirdKey = initialQueue[2]!.episode.episodeKey;

    // Per-row cache status indicator right of remaining time:
    // - firstKey (`ep42`) is `DONE` -> check icon (`data-cache-state="done"`)
    // - secondKey (`kt-18`) and thirdKey (`mdr-09`) are `NONE` -> no status indicator
    expect(screen.getByTestId(`queue-cache-status-${firstKey}`)).toHaveAttribute(
      'data-cache-state',
      'done',
    );
    expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`queue-cache-status-${thirdKey}`)).not.toBeInTheDocument();

    // Live downloading progress indicator (`RUNNING` -> dashed+solid circle SVG)
    act(() => {
      host.emit({
        type: 'download-updated',
        episodeKey: secondKey,
        state: 'RUNNING',
        progress: 0.45,
      });
    });
    const cachingBadge = screen.getByTestId(`queue-cache-status-${secondKey}`);
    expect(cachingBadge).toHaveAttribute('data-cache-state', 'downloading');
    expect(cachingBadge).toHaveAttribute('data-cache-progress', '45');
    expect(cachingBadge.querySelectorAll('circle')).toHaveLength(2);

    act(() => {
      host.emit({
        type: 'download-updated',
        episodeKey: secondKey,
        state: 'NONE',
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
    });

    // Top-right queue menu: shows `Download all` and `Manage downloads (2)` when downloads > 0
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('queue-overflow-btn'));
      expect(screen.getByTestId('queue-manage-downloads')).toHaveTextContent(
        'Manage downloads (2)',
      );
    });
    expect(screen.getByTestId('queue-download-all')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('queue-download-all'));

    // `Download all` downloads all un-downloaded queue episodes so all 3 rows show `done` checkmarks
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${firstKey}`)).toHaveAttribute(
        'data-cache-state',
        'done',
      );
      expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute(
        'data-cache-state',
        'done',
      );
      expect(screen.getByTestId(`queue-cache-status-${thirdKey}`)).toHaveAttribute(
        'data-cache-state',
        'done',
      );
    });

    // Zero inline Play or `⋮` buttons on queue rows
    const row0Initial = screen.getByTestId('queue-row-0');
    expect(row0Initial.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByTestId(`queue-play-${firstKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`queue-menu-${firstKey}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`queue-handle-${firstKey}`)).toBeInTheDocument();

    // Tapping a queue row directly starts playback
    fireEvent.click(row0Initial);
    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(engine.getSnapshot().episodeKey).toBe(firstKey);

    // Long-press (~450ms) on 3rd item opens `queue-context-menu` and moves 3rd item to top
    const row2Initial = screen.getByTestId('queue-row-2');
    vi.useFakeTimers();
    fireEvent(
      row2Initial,
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 250,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(460);
    });
    fireEvent(
      row2Initial,
      new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 250,
      }),
    );
    fireEvent.click(row2Initial);
    vi.useRealTimers();

    const queueCtxMenu = screen.getByTestId('queue-context-menu');
    expect(queueCtxMenu).toBeInTheDocument();
    // Strictly 3 items in `queue-context-menu`: Move to top, Download / Delete download, Remove
    expect(queueCtxMenu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(screen.getByTestId(`queue-move-top-${thirdKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(`queue-download-${thirdKey}`)).toHaveTextContent('Delete download');
    expect(screen.getByTestId(`queue-remove-${thirdKey}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`queue-move-up-${thirdKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`queue-move-down-${thirdKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`queue-mark-played-${thirdKey}`)).not.toBeInTheDocument();

    // Delete download from `queue-context-menu`, then re-download from `queue-context-menu`
    fireEvent.click(screen.getByTestId(`queue-download-${thirdKey}`));
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${thirdKey}`)).not.toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('queue-row-2'), { clientX: 180, clientY: 250 });
    expect(screen.getByTestId(`queue-download-${thirdKey}`)).toHaveTextContent('Download episode');
    fireEvent.click(screen.getByTestId(`queue-download-${thirdKey}`));
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${thirdKey}`)).toHaveAttribute(
        'data-cache-state',
        'done',
      );
    });

    // Move 3rd item to top via `queue-move-top-*`
    fireEvent.contextMenu(screen.getByTestId('queue-row-2'), { clientX: 180, clientY: 250 });
    fireEvent.click(screen.getByTestId(`queue-move-top-${thirdKey}`));

    await waitFor(async () => {
      const reordered = await host.queue.list();
      expect(reordered[0]?.episode.episodeKey).toBe(thirdKey);
    });

    // Pointer Events Drag-and-Drop on compact handle (`queue-handle-*`): drag index 0 (`thirdKey`) down onto index 2!
    const origGetBCR = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset?.queueIdx !== undefined) {
        const idx = Number.parseInt(this.dataset.queueIdx, 10);
        const top = 100 + idx * 60;
        return {
          x: 0,
          y: top,
          left: 0,
          top,
          width: 600,
          height: 60,
          right: 600,
          bottom: top + 60,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBCR.call(this);
    });

    const handle0 = screen.getByTestId(`queue-handle-${thirdKey}`);
    fireEvent(
      handle0,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 16, clientY: 130 }),
    );
    fireEvent(
      handle0,
      new MouseEvent('pointermove', { bubbles: true, cancelable: true, button: 0, clientX: 16, clientY: 250 }),
    );

    // Live item-following drag: dragged row follows pointer (+120px) while rows 1 & 2 shift UP (-60px)
    // and outer `.m-swipe-container`s have `overflow: visible` + elevated z-index so rows never disappear/clip!
    const draggedRowEl = screen.getByTestId('queue-row-0');
    const shiftedRow1El = screen.getByTestId('queue-row-1');
    const shiftedRow2El = screen.getByTestId('queue-row-2');
    expect(draggedRowEl.getAttribute('data-drag-offset-y')).toBe('120');
    expect(draggedRowEl.style.transform).toContain('translate3d(0, 120px, 0)');
    expect(draggedRowEl.style.opacity).toBe('1');
    expect(draggedRowEl.parentElement).toHaveClass('m-swipe-container', 'is-dragging-container');
    expect(draggedRowEl.parentElement?.style.overflow).toBe('visible');
    expect(draggedRowEl.parentElement?.style.zIndex).toBe('30');
    expect(shiftedRow1El.getAttribute('data-shift-y')).toBe('-60');
    expect(shiftedRow1El.parentElement).toHaveClass('m-swipe-container', 'is-drag-active');
    expect(shiftedRow1El.parentElement?.style.overflow).toBe('visible');
    expect(shiftedRow2El.getAttribute('data-shift-y')).toBe('-60');

    fireEvent(
      handle0,
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 16, clientY: 250 }),
    );

    await waitFor(async () => {
      const reordered = await host.queue.list();
      expect(reordered[0]?.episode.episodeKey).toBe(firstKey);
      expect(reordered[1]?.episode.episodeKey).toBe(secondKey);
      expect(reordered[2]?.episode.episodeKey).toBe(thirdKey);
    });
    expect(screen.getByTestId('queue-row-0').getAttribute('data-drag-offset-y')).toBe('0');
    expect(screen.getByTestId('queue-row-1').getAttribute('data-shift-y')).toBe('0');

    // Swipe Right (`deltaX > +64px`) on queue row does NOT remove from queue
    const midRow = screen.getByTestId('queue-row-1');
    fireEvent.touchStart(midRow, { touches: [{ clientX: 80, clientY: 190 }] });
    fireEvent.touchEnd(midRow, { changedTouches: [{ clientX: 200, clientY: 190 }] });
    expect(await host.queue.list()).toHaveLength(3);

    // Swipe Left (`deltaX < -64px`) on middle item (index 1) reveals armed edge hint + removes from queue + Undo restores original slot!
    fireEvent.touchStart(midRow, { touches: [{ clientX: 260, clientY: 190 }] });
    fireEvent.touchMove(midRow, { touches: [{ clientX: 225, clientY: 191 }] });
    const removeHintUnarmed = screen.getByTestId(`swipe-hint-left-${secondKey}`);
    expect(removeHintUnarmed).toHaveTextContent('Remove');
    expect(removeHintUnarmed.getAttribute('data-swipe-armed')).toBe('false');

    fireEvent.touchMove(midRow, { touches: [{ clientX: 150, clientY: 192 }] });
    const removeHintArmed = screen.getByTestId(`swipe-hint-left-${secondKey}`);
    expect(removeHintArmed.getAttribute('data-swipe-armed')).toBe('true');

    fireEvent.touchEnd(midRow, { changedTouches: [{ clientX: 140, clientY: 192 }] });

    await waitFor(async () => {
      expect(await host.queue.list()).toHaveLength(2);
    });
    expect(screen.queryByTestId('snackbar')).toBeNull();
    const inlineUndoEl = await screen.findByTestId(`inline-undo-${secondKey}`);
    expect(inlineUndoEl).toHaveTextContent(/Removed/);
    expect(inlineUndoEl.getAttribute('data-queue-undo-idx')).toBe('1');

    fireEvent.click(screen.getByTestId(`inline-undo-btn-${secondKey}`));
    await waitFor(async () => {
      const restored = await host.queue.list();
      expect(restored).toHaveLength(3);
      expect(restored[1]?.episode.episodeKey).toBe(secondKey);
    });
    expect(screen.queryByTestId(`inline-undo-${secondKey}`)).not.toBeInTheDocument();
  });

  it('localizes strictly 3 queue context menu items in zh-CN (置顶 / 下载 / 移除) and handles top-row & downloading disabled states', async () => {
    const { host } = renderMiniPod({
      width: 390,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-bar-queue'));
    const q = await host.queue.list();
    const firstKey = q[0]!.episode.episodeKey;
    const secondKey = q[1]!.episode.episodeKey;

    // Row 0 (`firstKey` is DONE): `置顶` is disabled at idx 0, `删除已下载文件` enabled, `从队列移除` enabled
    fireEvent.contextMenu(screen.getByTestId('queue-row-0'), { clientX: 120, clientY: 160 });
    const menu0 = screen.getByTestId('queue-context-menu');
    expect(menu0.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(screen.getByTestId(`queue-move-top-${firstKey}`)).toHaveTextContent('置顶');
    expect(screen.getByTestId(`queue-move-top-${firstKey}`)).toBeDisabled();
    expect(screen.getByTestId(`queue-download-${firstKey}`)).toHaveTextContent('删除已下载文件');
    expect(screen.getByTestId(`queue-remove-${firstKey}`)).toHaveTextContent('从队列移除');
    fireEvent.keyDown(window, { key: 'Escape' });

    // Row 1 (`secondKey` set to RUNNING): `停止下载` is enabled, `置顶` is enabled
    act(() => {
      host.emit({
        type: 'download-updated',
        episodeKey: secondKey,
        state: 'RUNNING',
        progress: 0.3,
      });
    });
    // Top-right `停止全部` appears while any queue episode is downloading
    expect(screen.getByTestId('queue-stop-all-btn')).toHaveTextContent('停止全部');
    expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute(
      'aria-label',
      '停止下载',
    );
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    expect(screen.getByTestId('queue-context-menu').querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(screen.getByTestId(`queue-move-top-${secondKey}`)).not.toBeDisabled();
    expect(screen.getByTestId(`queue-download-${secondKey}`)).toHaveTextContent('停止下载');
    expect(screen.getByTestId(`queue-download-${secondKey}`)).not.toBeDisabled();

    // Remove row 1 via `queue-remove-*`
    fireEvent.click(screen.getByTestId(`queue-remove-${secondKey}`));
    await waitFor(async () => {
      expect(await host.queue.list()).toHaveLength(2);
    });
  });
  it('stops a single RUNNING/QUEUED episode download via context menu `Stop download` or by tapping the progress ring (without playing)', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const q = await host.queue.list();
    const secondKey = q[1]!.episode.episodeKey;
    const thirdKey = q[2]!.episode.episodeKey;
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload');

    // No downloads in flight -> no top-right `Stop all`
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();

    act(() => {
      host.emit({ type: 'download-updated', episodeKey: secondKey, state: 'RUNNING', progress: 0.4 });
      host.emit({ type: 'download-updated', episodeKey: thirdKey, state: 'QUEUED', progress: 0 });
    });

    // Context menu on RUNNING row: `Stop download` enabled
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    const stopItem = screen.getByTestId(`queue-download-${secondKey}`);
    expect(stopItem).toHaveTextContent('Stop download');
    expect(stopItem).not.toBeDisabled();
    fireEvent.click(stopItem);
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
    });
    expect(deleteSpy).toHaveBeenCalledWith(secondKey);
    expect((await host.queue.list()).find((r) => r.episode.episodeKey === secondKey)?.episode.downloadState).toBe('NONE');

    // Tapping the QUEUED row's progress ring (with a stop square) stops it without starting playback
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: thirdKey, state: 'QUEUED', progress: 0 });
    });
    const ring = screen.getByTestId(`queue-cache-status-${thirdKey}`);
    expect(ring).toHaveAttribute('role', 'button');
    expect(ring).toHaveAttribute('aria-label', 'Stop download');
    expect(ring.querySelectorAll('circle')).toHaveLength(2);
    expect(ring.querySelectorAll('rect')).toHaveLength(1);
    expect(screen.getByTestId('queue-row-2').querySelectorAll('button')).toHaveLength(0);
    fireEvent.pointerDown(ring);
    fireEvent.click(ring);
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${thirdKey}`)).not.toBeInTheDocument();
    });
    expect(deleteSpy).toHaveBeenCalledWith(thirdKey);
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.getSnapshot().episodeKey).not.toBe(thirdKey);
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
  });

  it('shows top-right `Stop all` (button + overflow menu item) while downloads are in flight and stops all of them', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const q = await host.queue.list();
    const secondKey = q[1]!.episode.episodeKey;
    const thirdKey = q[2]!.episode.episodeKey;
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload');

    // Overflow menu has no `Stop all` without active downloads
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    expect(screen.getByTestId('queue-download-all')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-stop-all')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    const startBoth = () => {
      act(() => {
        host.emit({ type: 'download-updated', episodeKey: secondKey, state: 'RUNNING', progress: 0.2 });
        host.emit({ type: 'download-updated', episodeKey: thirdKey, state: 'QUEUED', progress: 0 });
      });
    };

    // 1) Top-right header button
    startBoth();
    const stopAllBtn = screen.getByTestId('queue-stop-all-btn');
    expect(stopAllBtn).toHaveTextContent('Stop all');
    fireEvent.click(stopAllBtn);
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`queue-cache-status-${thirdKey}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    });
    expect(deleteSpy).toHaveBeenCalledWith(secondKey);
    expect(deleteSpy).toHaveBeenCalledWith(thirdKey);

    // 2) Overflow menu item `queue-stop-all`
    deleteSpy.mockClear();
    startBoth();
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    const stopAllItem = screen.getByTestId('queue-stop-all');
    expect(stopAllItem).toHaveTextContent('Stop all');
    fireEvent.click(stopAllItem);
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`queue-cache-status-${thirdKey}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    });
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect((await host.queue.list()).find((r) => r.episode.episodeKey === secondKey)?.episode.downloadState).toBe('NONE');
    expect((await host.queue.list()).find((r) => r.episode.episodeKey === thirdKey)?.episode.downloadState).toBe('NONE');
  });
});
