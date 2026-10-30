import { render } from '@testing-library/react';
import {
  App,
  createMockPlatformHost,
  createMockPlayerEngine,
  type MockHostOptions,
  type MockPlatformHost,
  type MockPlayerEngine,
} from '../index';

export function setViewportWidth(widthPx: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: widthPx,
  });

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const minMatch = /\(min-width:\s*(\d+)px\)/.exec(query);
      const matches = minMatch
        ? widthPx >= Number.parseInt(minMatch[1]!, 10)
        : query.includes('prefers-color-scheme: dark')
          ? false
          : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

export function renderMiniPod(options?: {
  readonly width?: number | undefined;
  readonly hostOptions?: MockHostOptions | undefined;
  readonly videoCapable?: boolean | undefined;
}): {
  readonly host: MockPlatformHost;
  readonly engine: MockPlayerEngine;
  readonly unmount: () => void;
} {
  setViewportWidth(options?.width ?? 1024);
  const host = createMockPlatformHost({
    ...options?.hostOptions,
    initialSettings: {
      uiLanguage: 'en',
      ...options?.hostOptions?.initialSettings,
    },
  });
  const engine = createMockPlayerEngine({
    capabilities: { video: options?.videoCapable ?? true },
  });
  const view = render(<App host={host} engine={engine} />);
  return { host, engine, unmount: view.unmount };
}
