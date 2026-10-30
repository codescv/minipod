/**
 * Responsive media-query hooks (`>= 840px` desktop layout vs `< 840px` mobile shell,
 * SSR/jsdom-safe with `window.innerWidth` fallback when `matchMedia` is absent).
 */
import { useSyncExternalStore } from 'react';
import { LAYOUT_EXPANDED_MIN_WIDTH_PX } from '@minipod/core';

export function useMediaQuery(query: string, fallback?: () => boolean): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined') return () => {};
      if (typeof window.matchMedia === 'function') {
        const mql = window.matchMedia(query);
        mql.addEventListener('change', notify);
        window.addEventListener('resize', notify);
        return () => {
          mql.removeEventListener('change', notify);
          window.removeEventListener('resize', notify);
        };
      }
      window.addEventListener('resize', notify);
      return () => window.removeEventListener('resize', notify);
    },
    () => {
      if (typeof window === 'undefined') return false;
      if (typeof window.matchMedia === 'function') {
        return window.matchMedia(query).matches;
      }
      return fallback ? fallback() : false;
    },
    () => false,
  );
}

export const DESKTOP_QUERY = `(min-width: ${LAYOUT_EXPANDED_MIN_WIDTH_PX}px)`;

export function useIsDesktop(): boolean {
  return useMediaQuery(
    DESKTOP_QUERY,
    () => typeof window !== 'undefined' && window.innerWidth >= LAYOUT_EXPANDED_MIN_WIDTH_PX,
  );
}

export function usePrefersDark(): boolean {
  return useMediaQuery('(prefers-color-scheme: dark)');
}
