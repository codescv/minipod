/**
 * AppSettings zustand store synchronized with `host.settings`.
 */
import { create } from 'zustand';
import { COUNTRY_CODE_UNSET, type AppSettings, type PlatformHost } from '@minipod/core';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 1,
  deleteDownloadWhenPlayed: false,
  backgroundRefreshHours: 3,
  sync: {
    provider: null,
    wifiOnly: false,
    deviceName: 'MiniPod',
  },
  playbackSpeed: 1.0,
  topChartsCountry: COUNTRY_CODE_UNSET,
  subscriptionsLayout: 'grid',
  uiLanguage: 'system',
};

export interface SettingsStoreState {
  readonly settings: AppSettings;
  readonly loaded: boolean;
  load(host: PlatformHost): Promise<AppSettings>;
  update(host: PlatformHost, patch: Partial<AppSettings>): Promise<AppSettings>;
  receive(settings: AppSettings): void;
  reset(): void;
}

export const useSettingsStore = create<SettingsStoreState>()((set) => ({
  settings: DEFAULT_APP_SETTINGS,
  loaded: false,
  load: async (host) => {
    const fetched = await host.settings.get();
    set({ settings: fetched, loaded: true });
    return fetched;
  },
  update: async (host, patch) => {
    set((s) => ({
      settings: {
        ...s.settings,
        ...patch,
        sync: patch.sync ? { ...s.settings.sync, ...patch.sync } : s.settings.sync,
      },
    }));
    const saved = await host.settings.update(patch);
    set({ settings: saved, loaded: true });
    return saved;
  },
  receive: (settings) => set({ settings, loaded: true }),
  reset: () => set({ settings: DEFAULT_APP_SETTINGS, loaded: false }),
}));
