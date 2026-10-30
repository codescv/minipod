import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { useRouteStore } from './app/routes';
import { useSettingsStore } from './stores/settings';
import { useSnackbarStore } from './stores/snackbar';

afterEach(() => {
  cleanup();
  useRouteStore.getState().reset();
  useSettingsStore.getState().reset();
  useSnackbarStore.getState().clear();
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
