/**
 * Scroll-smoothness regressions (iOS WKWebView + Android WebView):
 * - list screens / rows never re-render on playback `position` ticks,
 * - `download-updated` RUNNING progress samples never re-query IndexedDB lists (only the
 *   downloading row updates its `%` badge),
 * - the playing episode's 5 s `progress-changed` checkpoints are deferred until pause,
 * - `useRowGestures` keeps 0 window listeners while idle and locks out vertical scrolls,
 * - `PodcastDetail` renders episodes progressively (60 at a time).
 */
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import type { EpisodeRow as EpisodeRowModel, EpisodeKey } from '@minipod/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import { formatClock } from '../lib/format';
import { renderMiniPod } from './test-helpers';

/** Every row component (`EpisodeRow`, `QueueRowItem`, `PreviewEpisodeRow`) calls `useRowGestures` once per render. */
const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../hooks/useRowGestures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useRowGestures')>();
  return {
    ...actual,
    useRowGestures: (opts: Parameters<typeof actual.useRowGestures>[0]) => {
      rowRenders.count += 1;
      return actual.useRowGestures(opts);
    },
  };
});

// Imported after the mock declaration (hoisted anyway) for the direct hook tests.
const { useRowGestures, ROW_LONG_PRESS_DELAY_MS } = await vi.importActual<
  typeof import('../hooks/useRowGestures')
>('../hooks/useRowGestures');

async function openSyntaxDetail(mini: ReturnType<typeof renderMiniPod>) {
  await screen.findByText('Syntax & Signal');
  const feeds = await mini.host.feeds.list();
  const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
  fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
  const rows = await screen.findAllByTestId(/^episode-row-/);
  return { syntax, rows };
}

const keyOfRow = (el: HTMLElement) => el.getAttribute('data-testid')!.replace(/^episode-row-/, '') as EpisodeKey;

describe('scroll performance', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not re-render episode rows (or re-bind Shell keyboard shortcuts) on playback position ticks', async () => {
    const mini = renderMiniPod({ width: 390 });
    const { rows } = await openSyntaxDetail(mini);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(mini.engine.getSnapshot().playing).toBe(true));
    await screen.findByTestId('mini-player');
    // Let the play-start revalidations (progress save -> list reload) settle first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const addSpy = vi.spyOn(window, 'addEventListener');
    const before = rowRenders.count;
    const TICKS = 6;
    // Advance 1 s at a time from the resume position (same chapter: a chapter change is a
    // legitimate low-frequency update).
    const startMs = mini.engine.getSnapshot().positionMs;
    for (let i = 1; i <= TICKS; i++) {
      act(() => {
        mini.engine.emitPosition(startMs + i * 1_000);
      });
    }
    // Only the current episode's row follows the live position (<= 1 render per tick);
    // the other rows (and list screens) stay untouched.
    expect(rowRenders.count - before).toBeLessThanOrEqual(TICKS);
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    // Player chrome still follows the live position.
    expect(
      screen.getByTestId('mini-player').querySelector('.m-mini-player__time')!.textContent,
    ).toContain(formatClock(startMs + TICKS * 1_000));
  });

  it('ignores download-updated RUNNING progress samples at list level: no list re-query, only the downloading row updates', async () => {
    const mini = renderMiniPod({ width: 1024 });
    const { host } = mini;
    await screen.findByText('Syntax & Signal');
    const feeds = await host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const page = await host.episodes.list(syntax.feedKey, 'all');
    const candidates = page.items.filter((r) => r.episode.downloadState === 'NONE');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const [gridKey, detailKey] = [candidates[0]!.episode.episodeKey, candidates[1]!.episode.episodeKey];

    // 1) SubscriptionsGrid mounted.
    const gridControl = host.holdNextDownload(gridKey);
    let gridDone: Promise<void> | undefined;
    act(() => {
      gridDone = host.episodes.download(gridKey).catch(() => undefined);
    });
    act(() => gridControl.progress(0.1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const gridListSpy = vi.spyOn(host.episodes, 'list');
    act(() => gridControl.progress(0.3));
    act(() => gridControl.progress(0.5));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(gridListSpy).not.toHaveBeenCalled();
    act(() => gridControl.finish());
    await act(async () => {
      await gridDone;
    });
    // DONE is a real transition: the grid re-queries.
    await waitFor(() => expect(gridListSpy).toHaveBeenCalled());
    gridListSpy.mockRestore();

    // 2) PodcastDetail mounted.
    fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
    await screen.findByTestId(`episode-row-${detailKey}`);
    const control = host.holdNextDownload(detailKey);
    let done: Promise<void> | undefined;
    act(() => {
      done = host.episodes.download(detailKey).catch(() => undefined);
    });
    act(() => control.progress(0.1));
    await waitFor(() =>
      expect(screen.getByTestId(`ep-download-progress-${detailKey}`)).toHaveAttribute(
        'data-cache-progress',
        '10',
      ),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const listSpy = vi.spyOn(host.episodes, 'list');
    const before = rowRenders.count;
    act(() => control.progress(0.3));
    act(() => control.progress(0.55));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(listSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId(`ep-download-progress-${detailKey}`)).toHaveAttribute(
      'data-cache-progress',
      '55',
    );
    // Only the downloading row re-rendered (<= 1 render per progress sample).
    expect(rowRenders.count - before).toBeLessThanOrEqual(2);

    act(() => control.finish());
    await act(async () => {
      await done;
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
  });

  it("defers the playing episode's 5 s progress-changed checkpoints until playback pauses", async () => {
    const mini = renderMiniPod({ width: 1024 });
    const { rows } = await openSyntaxDetail(mini);
    const playingKey = keyOfRow(rows[0]!);
    const otherKey = keyOfRow(rows[1]!);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(mini.engine.getSnapshot().playing).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const listSpy = vi.spyOn(mini.host.episodes, 'list');
    act(() => {
      mini.host.emit({ type: 'progress-changed', episodeKey: playingKey });
      mini.host.emit({ type: 'progress-changed', episodeKey: playingKey });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(listSpy).not.toHaveBeenCalled();

    // Another episode (e.g. Mark played) reloads immediately.
    act(() => {
      mini.host.emit({ type: 'progress-changed', episodeKey: otherKey });
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    // Pausing flushes the skipped checkpoint once.
    listSpy.mockClear();
    act(() => {
      mini.engine.pause();
    });
    await waitFor(() => expect(mini.engine.getSnapshot().playing).toBe(false));
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
  });

  it('renders PodcastDetail progressively: 60 episodes on frame 0, more when the sentinel intersects', async () => {
    const observers: Array<{ cb: IntersectionObserverCallback; el: Element | null }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly rec: { cb: IntersectionObserverCallback; el: Element | null };
        constructor(cb: IntersectionObserverCallback) {
          this.rec = { cb, el: null };
          observers.push(this.rec);
        }
        observe(el: Element) {
          this.rec.el = el;
        }
        unobserve() {}
        disconnect() {
          this.rec.el = null;
        }
        takeRecords() {
          return [];
        }
      },
    );

    const mini = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    const feeds = await mini.host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const original = mini.host.episodes.list.bind(mini.host.episodes);
    const template = (await original(syntax.feedKey, 'all')).items[0]!;
    const { progress: _ignored, ...templateWithoutProgress } = template;
    void _ignored;
    const bigRows: EpisodeRowModel[] = Array.from({ length: 150 }, (_, i) => ({
      ...templateWithoutProgress,
      episode: {
        ...template.episode,
        episodeKey: `e_bulk_${i}` as EpisodeKey,
        title: `Bulk episode ${i}`,
        downloadState: 'NONE',
      },
    }));
    vi.spyOn(mini.host.episodes, 'list').mockImplementation(async (feedKey, filter) =>
      feedKey === syntax.feedKey ? { items: bigRows } : original(feedKey, filter),
    );

    fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
    await waitFor(() => expect(screen.getByText('Bulk episode 0')).toBeInTheDocument());
    const countRows = () =>
      screen.getByTestId('detail-episode-list').querySelectorAll('[data-testid^="episode-row-"]')
        .length;
    expect(countRows()).toBe(60);
    const sentinel = screen.getByTestId('detail-list-sentinel');
    expect(screen.getByTestId('detail-load-more')).toBeInTheDocument();

    const active = observers.find((o) => o.el === sentinel)!;
    expect(active).toBeDefined();
    act(() => {
      active.cb(
        [{ isIntersecting: true, target: sentinel } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(countRows()).toBe(120);

    fireEvent.click(screen.getByTestId('detail-load-more'));
    expect(countRows()).toBe(150);
    expect(screen.queryByTestId('detail-list-sentinel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-load-more')).not.toBeInTheDocument();
  });
});

describe('useRowGestures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const target = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 60 }),
  };
  const pointer = (x: number, y: number) =>
    ({ button: 0, clientX: x, clientY: y, currentTarget: target }) as unknown as ReactPointerEvent<HTMLElement>;
  const touch = (x: number, y: number, end = false) =>
    ({
      touches: end ? [] : [{ clientX: x, clientY: y }],
      changedTouches: [{ clientX: x, clientY: y }],
      cancelable: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    }) as unknown as ReactTouchEvent<HTMLElement>;

  const windowPointerListenerDelta = (spy: { mock: { calls: readonly unknown[][] } }) =>
    spy.mock.calls.filter(([type]) => type === 'pointerup' || type === 'pointercancel').length;

  it('attaches 0 window pointer listeners while idle, attaches them lazily per pointer session and cleans them up', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const opts = { onTap: vi.fn(), onContext: vi.fn(), onSwipeLeft: vi.fn(), onSwipeRight: vi.fn() };
    const { result, unmount } = renderHook(() => useRowGestures(opts));
    expect(windowPointerListenerDelta(addSpy)).toBe(0);

    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    expect(windowPointerListenerDelta(addSpy)).toBe(2);
    act(() => result.current.handlers.onPointerUp(pointer(100, 100)));
    expect(windowPointerListenerDelta(removeSpy)).toBe(2);

    // pointercancel also detaches
    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    expect(windowPointerListenerDelta(addSpy)).toBe(4);
    act(() => result.current.handlers.onPointerCancel());
    expect(windowPointerListenerDelta(removeSpy)).toBe(4);

    // unmount mid-session detaches
    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    unmount();
    expect(windowPointerListenerDelta(removeSpy)).toBe(6);
  });

  it('locks out swipe + long-press once the gesture becomes a vertical scroll', () => {
    vi.useFakeTimers();
    const opts = { onTap: vi.fn(), onContext: vi.fn(), onSwipeLeft: vi.fn(), onSwipeRight: vi.fn() };
    const { result } = renderHook(() => useRowGestures(opts));

    act(() => result.current.handlers.onPointerDown(pointer(100, 100)));
    act(() => result.current.handlers.onPointerMove(pointer(102, 130))); // vertical scroll
    act(() => result.current.handlers.onPointerMove(pointer(220, 132))); // later horizontal drift
    expect(result.current.swipeOffsetX).toBe(0);
    act(() => {
      vi.advanceTimersByTime(ROW_LONG_PRESS_DELAY_MS + 50);
    });
    expect(opts.onContext).not.toHaveBeenCalled();
    act(() => result.current.handlers.onPointerUp(pointer(220, 132)));
    expect(opts.onSwipeRight).not.toHaveBeenCalled();
    expect(opts.onSwipeLeft).not.toHaveBeenCalled();

    // Touch-only stream: same lockout.
    act(() => result.current.handlers.onTouchStart(touch(100, 100)));
    act(() => result.current.handlers.onTouchMove(touch(101, 140)));
    act(() => result.current.handlers.onTouchMove(touch(240, 141)));
    expect(result.current.swipeOffsetX).toBe(0);
    act(() => result.current.handlers.onTouchEnd(touch(240, 141, true)));
    expect(opts.onSwipeRight).not.toHaveBeenCalled();
  });

  it('runs gesture math once when Pointer + Touch streams both fire, and still supports touch-only swipes', () => {
    const opts = { onTap: vi.fn(), onContext: vi.fn(), onSwipeLeft: vi.fn(), onSwipeRight: vi.fn() };
    const { result } = renderHook(() => useRowGestures(opts));

    // WebView order: pointerdown, touchstart, pointermove, touchmove, pointerup, touchend
    act(() => result.current.handlers.onPointerDown(pointer(260, 120)));
    act(() => result.current.handlers.onTouchStart(touch(260, 120)));
    act(() => result.current.handlers.onPointerMove(pointer(150, 121)));
    act(() => result.current.handlers.onTouchMove(touch(150, 121)));
    expect(result.current.swipeOffsetX).toBeLessThan(0);
    act(() => result.current.handlers.onPointerUp(pointer(140, 121)));
    act(() => result.current.handlers.onTouchEnd(touch(140, 121, true)));
    expect(opts.onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(result.current.swipeOffsetX).toBe(0);

    // Touch-only (no pointer events): swipe right still works.
    act(() => result.current.handlers.onTouchStart(touch(80, 160)));
    act(() => result.current.handlers.onTouchMove(touch(190, 161)));
    act(() => result.current.handlers.onTouchEnd(touch(200, 161, true)));
    expect(opts.onSwipeRight).toHaveBeenCalledTimes(1);
  });
});
