/**
 * Material Design 3 dynamic tonal-spot colour tokens (`--md-sys-color-*`)
 * generated from a single seed colour via `@material/material-color-utilities`.
 */
import {
  argbFromHex,
  hexFromArgb,
  Hct,
  MaterialDynamicColors,
  SchemeTonalSpot,
  type DynamicColor,
} from '@material/material-color-utilities';

/** MiniPod's calm minimalist indigo-slate seed. */
export const DEFAULT_SEED_COLOR = '#4f6d7a';

const ROLES = {
  primary: MaterialDynamicColors.primary,
  'on-primary': MaterialDynamicColors.onPrimary,
  'primary-container': MaterialDynamicColors.primaryContainer,
  'on-primary-container': MaterialDynamicColors.onPrimaryContainer,
  'inverse-primary': MaterialDynamicColors.inversePrimary,
  secondary: MaterialDynamicColors.secondary,
  'on-secondary': MaterialDynamicColors.onSecondary,
  'secondary-container': MaterialDynamicColors.secondaryContainer,
  'on-secondary-container': MaterialDynamicColors.onSecondaryContainer,
  tertiary: MaterialDynamicColors.tertiary,
  'on-tertiary': MaterialDynamicColors.onTertiary,
  'tertiary-container': MaterialDynamicColors.tertiaryContainer,
  'on-tertiary-container': MaterialDynamicColors.onTertiaryContainer,
  error: MaterialDynamicColors.error,
  'on-error': MaterialDynamicColors.onError,
  'error-container': MaterialDynamicColors.errorContainer,
  'on-error-container': MaterialDynamicColors.onErrorContainer,
  background: MaterialDynamicColors.background,
  'on-background': MaterialDynamicColors.onBackground,
  surface: MaterialDynamicColors.surface,
  'surface-dim': MaterialDynamicColors.surfaceDim,
  'surface-bright': MaterialDynamicColors.surfaceBright,
  'surface-container-lowest': MaterialDynamicColors.surfaceContainerLowest,
  'surface-container-low': MaterialDynamicColors.surfaceContainerLow,
  'surface-container': MaterialDynamicColors.surfaceContainer,
  'surface-container-high': MaterialDynamicColors.surfaceContainerHigh,
  'surface-container-highest': MaterialDynamicColors.surfaceContainerHighest,
  'on-surface': MaterialDynamicColors.onSurface,
  'surface-variant': MaterialDynamicColors.surfaceVariant,
  'on-surface-variant': MaterialDynamicColors.onSurfaceVariant,
  'inverse-surface': MaterialDynamicColors.inverseSurface,
  'inverse-on-surface': MaterialDynamicColors.inverseOnSurface,
  outline: MaterialDynamicColors.outline,
  'outline-variant': MaterialDynamicColors.outlineVariant,
  shadow: MaterialDynamicColors.shadow,
  scrim: MaterialDynamicColors.scrim,
  'surface-tint': MaterialDynamicColors.surfaceTint,
} as const satisfies Record<string, DynamicColor>;

export type M3Role = keyof typeof ROLES;
export type M3Tokens = Readonly<Record<`--md-sys-color-${M3Role}`, string>>;

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normaliseSeed(seed: string | undefined): string {
  const m = HEX_RE.exec((seed ?? '').trim());
  if (!m?.[1]) return DEFAULT_SEED_COLOR;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${hex.toLowerCase()}`;
}

const cache = new Map<string, M3Tokens>();

export function buildM3Tokens(seed: string, dark: boolean, contrast = 0): M3Tokens {
  const normalized = normaliseSeed(seed);
  const key = `${normalized}|${dark ? 'd' : 'l'}|${contrast}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(normalized)), dark, contrast);
  const tokens: Record<string, string> = {};
  for (const [name, color] of Object.entries(ROLES)) {
    tokens[`--md-sys-color-${name}`] = hexFromArgb(color.getArgb(scheme));
  }
  if (dark) {
    // Raw SchemeTonalSpot dark surface/background is Tone 6 (near-black). Align
    // with standard Android / Google / Discord charcoal dark by promoting the
    // Tone 12 surface-container as the base surface and elevating the
    // container hierarchy one step.
    const rawSurface = tokens['--md-sys-color-surface']!;
    const rawContainer = tokens['--md-sys-color-surface-container']!;
    const rawContainerHigh = tokens['--md-sys-color-surface-container-high']!;
    const rawContainerHighest = tokens['--md-sys-color-surface-container-highest']!;
    const rawBright = tokens['--md-sys-color-surface-bright']!;
    tokens['--md-sys-color-background'] = rawContainer;
    tokens['--md-sys-color-surface'] = rawContainer;
    tokens['--md-sys-color-surface-container-lowest'] = rawSurface;
    tokens['--md-sys-color-surface-container-low'] = rawContainerHigh;
    tokens['--md-sys-color-surface-container'] = rawContainerHighest;
    tokens['--md-sys-color-surface-container-high'] = rawBright;
    // Keep the hierarchy strictly monotonic: the raw `highest` (Tone 22) now
    // equals the promoted `surface-container`, so lift it to neutral Tone 30.
    tokens['--md-sys-color-surface-container-highest'] = hexFromArgb(scheme.neutralPalette.tone(30));
  }
  const result = tokens as M3Tokens;
  cache.set(key, result);
  return result;
}

export function applyM3Tokens(el: HTMLElement, tokens: M3Tokens, dark: boolean): void {
  for (const [k, v] of Object.entries(tokens)) {
    el.style.setProperty(k, v);
  }
  el.dataset['theme'] = dark ? 'dark' : 'light';
  el.style.colorScheme = dark ? 'dark' : 'light';
}
