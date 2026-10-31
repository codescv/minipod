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
    // Top-right queue overflow menu is removed in v0.1.6
    expect(screen.queryByTestId('queue-overflow-btn')).not.toBeInTheDocument();

    const initialQueue = await host.queue.list();
    expect(initialQueue).toHaveLength(3);
    const firstKey = initialQueue[0]!.episode.episodeKey;
    const secondKey = initialQueue[1]!.episode.episodeKey;
    const thirdKey = initialQueue[2]!.episode.episodeKey;

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

    expect(screen.getByTestId('queue-context-menu')).toBeInTheDocument();
    expect(screen.getByTestId(`queue-mark-played-${thirdKey}`)).toBeInTheDocument();
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
    expect(screen.getByTestId('queue-row-0').getAttribute('data-drag-offset-y')).toBe('120');
    expect(screen.getByTestId('queue-row-0').style.transform).toContain('translate3d(0, 120px, 0)');
    expect(screen.getByTestId('queue-row-1').getAttribute('data-shift-y')).toBe('-60');
    expect(screen.getByTestId('queue-row-2').getAttribute('data-shift-y')).toBe('-60');

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
});
