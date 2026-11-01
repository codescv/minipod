import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { useRouteStore } from './app/routes';
import { AGENT_FEEDBACK_EMAIL_KEY } from './features/settings/agent-feedback';
import { DISMISSED_UPDATE_TAG_KEY, useUpdateStore } from './features/updater/updater';
import { useSettingsStore } from './stores/settings';
import { useSnackbarStore } from './stores/snackbar';

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem(DISMISSED_UPDATE_TAG_KEY);
    localStorage.removeItem(AGENT_FEEDBACK_EMAIL_KEY);
  } catch {
    // ignore
  }
  useRouteStore.getState().reset();
  useSettingsStore.getState().reset();
  useSnackbarStore.getState().clear();
  useUpdateStore.getState().reset();
});

// jsdom has no media playback pipeline; make play()/pause()/load() inert
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: () => {},
});
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: () => Promise.resolve(),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  writable: true,
  value: () => {},
});

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
