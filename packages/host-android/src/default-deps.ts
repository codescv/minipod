/**
 * Default production dependencies for `@minipod/host-android`.
 *
 * Tests override `plugin`, `idbFactory`, `preferences`, `isVisible`, etc. so
 * Vitest runs in Node without touching Capacitor native bridges.
 */
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { PodcastIndexKeys, SyncSchedulerHost, Unsubscribe } from '@minipod/core';
import { createDefaultMiniPodPlugin, type DeepLinkPayload, type MiniPodPlugin } from './plugin-types';
import {
  createCapacitorPreferences,
  createMemoryPreferences,
  MINIPOD_IDB_NAME,
  type PreferencesLike,
} from './storage/idb';

/** Bumped automatically by `scripts/bump-version.mjs` when packaging APKs. */
export const version = '0.1.30';

export interface CapacitorHostDeps {
  readonly plugin: MiniPodPlugin;
  readonly idbFactory: IDBFactory;
  readonly dbName: string;
  readonly preferences: PreferencesLike;
  readonly appVersion: string;
  readonly osLabel: string;
  readonly defaultDeviceName: string;
  readonly podcastIndexKeys?: PodcastIndexKeys;
  readonly schedulerHost: SyncSchedulerHost;
  readonly onAppLifecycle?: (handlers: {
    readonly onForeground: () => void;
    readonly onBackground: () => void;
    readonly onDeepLink: (payload: DeepLinkPayload) => void;
  }) => Unsubscribe;
}

export function createBrowserSyncSchedulerHost(overrides?: {
  readonly isVisible?: () => boolean;
  readonly isOnline?: () => boolean;
  readonly isMetered?: () => boolean | undefined;
}): SyncSchedulerHost {
  const isVisible =
    overrides?.isVisible ??
    (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  const isOnline =
    overrides?.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const isMetered =
    overrides?.isMetered ??
    (() => {
      if (typeof navigator === 'undefined') return undefined;
      const conn = (
        navigator as Navigator & {
          connection?: { type?: string; saveData?: boolean };
        }
      ).connection;
      if (!conn) return undefined;
      if (conn.saveData) return true;
      if (conn.type === 'wifi' || conn.type === 'ethernet') return false;
      if (conn.type === 'cellular' || conn.type === 'bluetooth' || conn.type === 'wimax') {
        return true;
      }
      return undefined;
    });

  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    isVisible,
    isMetered,
    isOnline,
  };
}

export async function resolveCapacitorHostDeps(
  overrides?: Partial<CapacitorHostDeps>,
): Promise<CapacitorHostDeps> {
  const isNative = Capacitor.isNativePlatform();
  const plugin = overrides?.plugin ?? createDefaultMiniPodPlugin();
  const idbFactory = overrides?.idbFactory ?? globalThis.indexedDB;
  const dbName = overrides?.dbName ?? MINIPOD_IDB_NAME;
  const preferences =
    overrides?.preferences ?? (isNative ? createCapacitorPreferences() : createMemoryPreferences());

  let appVersion = overrides?.appVersion;
  if (!appVersion) {
    if (isNative) {
      try {
        appVersion = (await App.getInfo()).version || version;
      } catch {
        appVersion = version;
      }
    } else {
      appVersion = version;
    }
  }

  const osLabel =
    overrides?.osLabel ??
    (typeof navigator !== 'undefined' && navigator.userAgent
      ? /Android\s+([0-9.]+)/i.exec(navigator.userAgent)?.[0] ?? 'Android'
      : 'Android');

  const defaultDeviceName = overrides?.defaultDeviceName ?? 'Android';
  const schedulerHost = overrides?.schedulerHost ?? createBrowserSyncSchedulerHost();

  const onAppLifecycle: CapacitorHostDeps['onAppLifecycle'] =
    overrides?.onAppLifecycle ??
    ((handlers) => {
      const cleanups: Array<() => void> = [];

      if (typeof document !== 'undefined') {
        const onVis = () => {
          if (document.visibilityState === 'visible') {
            handlers.onForeground();
          } else {
            handlers.onBackground();
          }
        };
        document.addEventListener('visibilitychange', onVis);
        cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
      }

      if (isNative) {
        let disposed = false;
        void App.addListener('appStateChange', ({ isActive }) => {
          if (disposed) return;
          if (isActive) handlers.onForeground();
          else handlers.onBackground();
        }).then((h) => {
          if (disposed) void h.remove();
          else cleanups.push(() => void h.remove());
        });

        void App.addListener('appUrlOpen', ({ url }) => {
          if (disposed || !url) return;
          handlers.onDeepLink({ action: 'view', uri: url });
        }).then((h) => {
          if (disposed) void h.remove();
          else cleanups.push(() => void h.remove());
        });

        cleanups.push(() => {
          disposed = true;
        });
      }

      return () => {
        for (const fn of cleanups) {
          fn();
        }
      };
    });

  return {
    plugin,
    idbFactory,
    dbName,
    preferences,
    appVersion,
    osLabel,
    defaultDeviceName,
    schedulerHost,
    onAppLifecycle,
    ...(overrides?.podcastIndexKeys !== undefined
      ? { podcastIndexKeys: overrides.podcastIndexKeys }
      : {}),
  };
}
