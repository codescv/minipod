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
import { useUpdateStore } from './features/updater/updater';
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
  useUpdateStore.getState().reset();
  const root = createRoot(container);
  root.render(createElement(StrictMode, null, createElement(App, { host, engine })));
  return {
    unmount() {
      root.unmount();
      useRouteStore.getState().reset();
      useSettingsStore.getState().reset();
      useSnackbarStore.getState().clear();
      useUpdateStore.getState().reset();
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
export {
  clearArtworkCacheForTests,
  getPinnedArtworkCount,
  getRememberedCandidateIndex,
  isArtworkLoaded,
  pinLoadedArtwork,
  preloadArtworkUrls,
  rememberResolvedCandidate,
} from './lib/artwork-cache';
export { resolveLocale, translate, useLocale, useT } from './i18n';
export { UpdateBanner } from './features/updater/UpdateBanner';
export {
  useUpdateStore,
  GITHUB_REPO,
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASES_LIST_URL,
  GITHUB_RELEASES_ATOM_URL,
  GITHUB_RELEASES_HTML_URL,
  DISMISSED_UPDATE_TAG_KEY,
  STARTUP_UPDATE_THROTTLE_MS,
  parseSemver,
  parseSemanticVersion,
  compareSemver,
  compareSemanticVersions,
  parseGithubReleaseJson,
  parseGithubReleasesAtom,
  fetchLatestRelease,
  type UpdateStatus,
  type UpdateStoreState,
  type CheckForUpdateOptions,
} from './features/updater/updater';
