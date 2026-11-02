/**
 * v0.1.25 long-press text-selection guards.
 *
 * On Android WebView a long press (~500 ms) starts native text selection. Our own long-press
 * gestures fire at ~450 ms and portal a `.m-menu` right under the still-pressed finger, so the
 * WebView would immediately select the menu item text (teal selection handles). CSS
 * (`user-select: none` / `-webkit-touch-callout: none` in `theme/styles.css`) prevents most of
 * it; these helpers clear any selection that already started and block the native context menu.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';

/** Removes any active browser text selection (no-op where unsupported). */
export function clearTextSelection(): void {
  try {
    if (typeof window === 'undefined') return;
    window.getSelection?.()?.removeAllRanges?.();
  } catch {
    // Selection API unavailable (SSR / exotic WebViews): nothing to clear.
  }
}

/**
 * Wraps an optional `onContextMenu` handler so the native context menu (and the Android
 * WebView long-press text selection that comes with it) is always suppressed. The wrapped
 * handler still runs, and the event still bubbles to row-level long-press handlers.
 */
export function suppressNativeContextMenu<T extends Element>(
  handler?: ((e: ReactMouseEvent<T>) => void) | undefined,
): (e: ReactMouseEvent<T>) => void {
  return (e) => {
    handler?.(e);
    if (!e.defaultPrevented) e.preventDefault();
    clearTextSelection();
  };
}
