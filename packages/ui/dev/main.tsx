/**
 * Standalone Vite dev harness (`pnpm dev:ui`) mounting MiniPod against
 * `MockPlatformHost` + `MockPlayerEngine` (`autoTick: true`).
 */
import { createMockPlatformHost, createMockPlayerEngine, mountMiniPodApp } from '../src';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root container in dev/index.html');
}

const host = createMockPlatformHost({
  initialSettings: { uiLanguage: 'en' },
});
const engine = createMockPlayerEngine({ autoTick: true });

// Expose on `window` in dev harness so developers can test `host.simulateRemoteProgress(...)` in console
Object.assign(window, { __minipodDevHost: host, __minipodDevEngine: engine });

mountMiniPodApp(root, host, engine);
