/**
 * `@minipod/ui` — shared React 19 + Material Design 3 UI package.
 *
 * Mounted identically by `@minipod/host-node` (desktop web) and `@minipod/host-android`
 * (Capacitor WebView) via `mountMiniPodApp(container, host, engine)`.
 */
import './theme/styles.css';
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlatformHost, PlayerEngine } from '@minipod/core';
import { App, type AppProps } from './app/App';
import { useRouteStore } from './app/routes';
import { useSettingsStore } from './stores/settings';
import { useSnackbarStore } from './stores/snackbar';

export interface MountedApp {
  unmount(): void;
}

export type MountMiniPodApp = (
  container: HTMLElement,
  host: PlatformHost,
  engine: PlayerEngine,
) => MountedApp;

export const mountMiniPodApp: MountMiniPodApp = (container, host, engine) => {
  useRouteStore.getState().reset();
  useSnackbarStore.getState().clear();
  const root = createRoot(container);
  root.render(createElement(StrictMode, null, createElement(App, { host, engine })));
  return {
    unmount() {
      root.unmount();
      useRouteStore.getState().reset();
      useSettingsStore.getState().reset();
      useSnackbarStore.getState().clear();
    },
  };
};

export { App, type AppProps };
export { HostProvider, useHost } from './host/HostContext';
export { useHostEvents } from './host/useHostEvents';
export {
  MockPlatformHost,
  createMockPlatformHost,
  MockPlayerEngine,
  createMockPlayerEngine,
  type MockHostOptions,
} from './host/mock-host';
export {
  HtmlAudioEngine,
  createHtmlAudioEngine,
  type HtmlAudioEngineOptions,
  PlayerProvider,
  usePlayer,
  type PlayerContextValue,
  type PlayEpisodeOptions,
  SleepTimerController,
  SLEEP_FADE_WINDOW_MS,
  clampSpeed,
  nextSpeedPreset,
  computeResumePositionMs,
  isEpisodeNearEnd,
  findActiveChapterIndex,
} from './player';
export {
  registerBackInterceptor,
  useBackInterceptor,
  dispatchBackNavigation,
} from './app/back';
export { useRouteStore, type RootTab, type ScreenRoute, type SidePanelTab } from './app/routes';
export { useSettingsStore, DEFAULT_APP_SETTINGS } from './stores/settings';
export { useSnackbarStore, showSnackbar } from './stores/snackbar';
export { buildM3Tokens, applyM3Tokens, normaliseSeed, DEFAULT_SEED_COLOR } from './theme/m3-theme';
export { resolveLocale, translate, useLocale, useT } from './i18n';
