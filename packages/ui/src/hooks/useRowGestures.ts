/**
 * Unified minimalist row gesture controller:
 * - Tap / Click (`Enter` / `Space`) -> primary action (e.g. play episode)
 * - Long-Press (~450ms, 10px slop), Right-Click (`contextmenu`), `ContextMenu` / `Shift+F10` -> context menu
 * - Horizontal Swipe (`|deltaX| > 64px` and `|deltaX| > |deltaY| * 1.5`) via both Touch and Pointer drag
 *   with live horizontal translation feedback and deduplication across touch/pointer event streams.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { clearTextSelection } from '../lib/text-selection';

export const ROW_LONG_PRESS_DELAY_MS = 450;
export const ROW_LONG_PRESS_SLOP_PX = 10;
export const ROW_SWIPE_THRESHOLD_PX = 64;
const ROW_SWIPE_MAX_VISUAL_PX = 116;

export type SwipeDirection = 'left' | 'right' | null;

export interface UseRowGesturesOptions {
  readonly onTap: () => void;
  readonly onContext: (x: number, y: number) => void;
  readonly onSwipeLeft?: (() => void) | undefined;
  readonly onSwipeRight?: (() => void) | undefined;
}

export interface RowGestureHandlers {
  readonly onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void;
  readonly onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void;
  readonly onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => void;
  readonly onTouchCancel: () => void;
  readonly onClick: (e: ReactMouseEvent<HTMLElement>) => void;
  readonly onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

export function useRowGestures({
  onTap,
  onContext,
  onSwipeLeft,
  onSwipeRight,
}: UseRowGesturesOptions): {
  readonly swipeOffsetX: number;
  readonly swipeDirection: SwipeDirection;
  readonly swipeArmed: boolean;
  readonly handlers: RowGestureHandlers;
} {
  const [swipeOffsetX, setSwipeOffsetX] = useState(0);
  const [swipeArmed, setSwipeArmed] = useState(false);

  const callbacksRef = useRef({ onTap, onContext, onSwipeLeft, onSwipeRight });
  callbacksRef.current = { onTap, onContext, onSwipeLeft, onSwipeRight };

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const touchStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const touchActiveRef = useRef(false);
  const recentTouchEndRef = useRef(false);
  const longPressedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const didSwipeRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetSwipeVisual = useCallback(() => {
    setSwipeOffsetX(0);
    setSwipeArmed(false);
  }, []);

  const updateVisualOffset = useCallback((dx: number, dy: number) => {
    const { onSwipeLeft: canLeft, onSwipeRight: canRight } = callbacksRef.current;
    const minX = canLeft ? -ROW_SWIPE_MAX_VISUAL_PX : 0;
    const maxX = canRight ? ROW_SWIPE_MAX_VISUAL_PX : 0;
    const clamped = Math.max(minX, Math.min(maxX, Math.round(dx * 0.75)));
    setSwipeOffsetX(clamped);
    const armed =
      clamped !== 0 &&
      Math.abs(dx) > ROW_SWIPE_THRESHOLD_PX &&
      Math.abs(dx) > Math.abs(dy) * 1.5 &&
      ((dx < 0 && Boolean(canLeft)) || (dx > 0 && Boolean(canRight)));
    setSwipeArmed(armed);
  }, []);

  const finishPointerAt = useCallback(
    (clientX: number | undefined, clientY: number | undefined, cancelled: boolean) => {
      clearTimer();
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      resetSwipeVisual();

      if (cancelled || !start || touchActiveRef.current || recentTouchEndRef.current) {
        return;
      }
      if (longPressedRef.current) {
        return;
      }

      const endX = clientX !== undefined && Number.isFinite(clientX) ? clientX : start.x;
      const endY = clientY !== undefined && Number.isFinite(clientY) ? clientY : start.y;
      const dx = endX - start.x;
      const dy = endY - start.y;

      if (Math.abs(dx) > ROW_SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < -ROW_SWIPE_THRESHOLD_PX && callbacksRef.current.onSwipeLeft) {
          suppressClickRef.current = true;
          callbacksRef.current.onSwipeLeft();
          return;
        }
        if (dx > ROW_SWIPE_THRESHOLD_PX && callbacksRef.current.onSwipeRight) {
          suppressClickRef.current = true;
          callbacksRef.current.onSwipeRight();
          return;
        }
      }

      if (didSwipeRef.current) {
        suppressClickRef.current = true;
      }
    },
    [clearTimer, resetSwipeVisual],
  );

  useEffect(() => {
    const onWinPointerUp = (ev: PointerEvent) => {
      if (!pointerStartRef.current) return;
      finishPointerAt(ev.clientX, ev.clientY, false);
    };
    const onWinPointerCancel = () => {
      if (!pointerStartRef.current) return;
      finishPointerAt(undefined, undefined, true);
    };
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerCancel);
    return () => {
      clearTimer();
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerCancel);
    };
  }, [clearTimer, finishPointerAt]);

  const startLongPressTimer = useCallback(
    (x: number, y: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        longPressedRef.current = true;
        pointerStartRef.current = null;
        touchStartRef.current = null;
        resetSwipeVisual();
        // v0.1.25: drop any Android WebView long-press selection before the menu portals in.
        clearTextSelection();
        callbacksRef.current.onContext(x, y);
      }, ROW_LONG_PRESS_DELAY_MS);
    },
    [clearTimer, resetSwipeVisual],
  );

  const handlers: RowGestureHandlers = {
    onPointerDown: (e) => {
      if (typeof e.button === 'number' && e.button > 0) return;
      longPressedRef.current = false;
      suppressClickRef.current = false;
      didSwipeRef.current = false;

      const hasCoords = Number.isFinite(e.clientX) && Number.isFinite(e.clientY);
      const rect = hasCoords ? null : e.currentTarget.getBoundingClientRect();
      const x = hasCoords ? e.clientX : rect ? rect.left + rect.width / 2 : 0;
      const y = hasCoords ? e.clientY : rect ? rect.top + rect.height / 2 : 0;

      pointerStartRef.current = { x, y };
      startLongPressTimer(x, y);
    },

    onPointerMove: (e) => {
      const start = pointerStartRef.current;
      if (!start) return;
      const curX = Number.isFinite(e.clientX) ? e.clientX : start.x;
      const curY = Number.isFinite(e.clientY) ? e.clientY : start.y;
      const dx = curX - start.x;
      const dy = curY - start.y;

      if (Math.hypot(dx, dy) > ROW_LONG_PRESS_SLOP_PX) {
        clearTimer();
      }
      if (!touchActiveRef.current && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        didSwipeRef.current = true;
        updateVisualOffset(dx, dy);
      }
    },

    onPointerUp: (e) => {
      finishPointerAt(e.clientX, e.clientY, false);
    },

    onPointerCancel: () => {
      longPressedRef.current = false;
      finishPointerAt(undefined, undefined, true);
    },

    onTouchStart: (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      touchActiveRef.current = true;
      longPressedRef.current = false;
      suppressClickRef.current = false;
      didSwipeRef.current = false;

      const x = Number.isFinite(touch.clientX) ? touch.clientX : 0;
      const y = Number.isFinite(touch.clientY) ? touch.clientY : 0;
      touchStartRef.current = { x, y };
      if (timerRef.current === null) {
        startLongPressTimer(x, y);
      }
    },

    onTouchMove: (e) => {
      const touch = e.touches[0];
      const start = touchStartRef.current;
      if (!touch || !start) return;
      const curX = Number.isFinite(touch.clientX) ? touch.clientX : start.x;
      const curY = Number.isFinite(touch.clientY) ? touch.clientY : start.y;
      const dx = curX - start.x;
      const dy = curY - start.y;

      if (Math.hypot(dx, dy) > ROW_LONG_PRESS_SLOP_PX) {
        clearTimer();
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        didSwipeRef.current = true;
        updateVisualOffset(dx, dy);
      }
    },

    onTouchEnd: (e) => {
      clearTimer();
      const start = touchStartRef.current;
      touchStartRef.current = null;
      pointerStartRef.current = null;
      touchActiveRef.current = false;
      recentTouchEndRef.current = true;
      queueMicrotask(() => {
        recentTouchEndRef.current = false;
      });
      resetSwipeVisual();

      if (longPressedRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }
        e.stopPropagation();
        clearTextSelection();
        return;
      }

      const touch = e.changedTouches[0];
      if (start && touch) {
        const endX = Number.isFinite(touch.clientX) ? touch.clientX : start.x;
        const endY = Number.isFinite(touch.clientY) ? touch.clientY : start.y;
        const dx = endX - start.x;
        const dy = endY - start.y;

        if (Math.abs(dx) > ROW_SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < -ROW_SWIPE_THRESHOLD_PX && callbacksRef.current.onSwipeLeft) {
            suppressClickRef.current = true;
            callbacksRef.current.onSwipeLeft();
            return;
          }
          if (dx > ROW_SWIPE_THRESHOLD_PX && callbacksRef.current.onSwipeRight) {
            suppressClickRef.current = true;
            callbacksRef.current.onSwipeRight();
            return;
          }
        }
      }

      if (didSwipeRef.current) {
        suppressClickRef.current = true;
      }
    },

    onTouchCancel: () => {
      clearTimer();
      touchStartRef.current = null;
      pointerStartRef.current = null;
      touchActiveRef.current = false;
      longPressedRef.current = false;
      resetSwipeVisual();
    },

    onClick: (e) => {
      if (longPressedRef.current || suppressClickRef.current) {
        longPressedRef.current = false;
        suppressClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      callbacksRef.current.onTap();
    },

    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimer();
      touchStartRef.current = null;
      pointerStartRef.current = null;
      resetSwipeVisual();
      clearTextSelection();
      callbacksRef.current.onContext(e.clientX, e.clientY);
    },

    onKeyDown: (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        callbacksRef.current.onContext(rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        callbacksRef.current.onTap();
      }
    },
  };

  const swipeDirection: SwipeDirection =
    swipeOffsetX < 0 ? 'left' : swipeOffsetX > 0 ? 'right' : null;

  return { swipeOffsetX, swipeDirection, swipeArmed, handlers };
}
