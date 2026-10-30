/**
 * @minipod/ui — mountMiniPodApp(container, host, engine) is implemented by coder-ui (ARCHITECTURE.md §5).
 * This scaffold only fixes the public signature.
 */
import type { PlatformHost, PlayerEngine } from '@minipod/core';

export interface MountedApp {
  unmount(): void;
}

export type MountMiniPodApp = (container: HTMLElement, host: PlatformHost, engine: PlayerEngine) => MountedApp;
