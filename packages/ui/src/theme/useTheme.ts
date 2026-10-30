/**
 * React hook keeping `document.documentElement` synchronized with M3 dynamic
 * colour tokens and OS `prefers-color-scheme: dark`.
 */
import { useLayoutEffect, useMemo } from 'react';
import { usePrefersDark } from '../hooks/useMediaQuery';
import { applyM3Tokens, buildM3Tokens, DEFAULT_SEED_COLOR, type M3Tokens } from './m3-theme';

export interface ThemeState {
  readonly dark: boolean;
  readonly seed: string;
  readonly tokens: M3Tokens;
}

export function useTheme(options?: { readonly seed?: string; readonly forceDark?: boolean; readonly target?: HTMLElement | null }): ThemeState {
  const prefersDark = usePrefersDark();
  const dark = options?.forceDark ?? prefersDark;
  const seed = options?.seed ?? DEFAULT_SEED_COLOR;
  const tokens = useMemo(() => buildM3Tokens(seed, dark), [seed, dark]);

  useLayoutEffect(() => {
    const el = options?.target ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el) return;
    applyM3Tokens(el, tokens, dark);
    if (el.dataset['themeReady'] === undefined && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        el.dataset['themeReady'] = '';
      });
    }
  }, [options?.target, tokens, dark]);

  return { dark, seed, tokens };
}
