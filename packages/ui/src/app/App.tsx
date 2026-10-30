/**
 * Top-level `<App host={...} engine={...} />` wiring theme, settings, LIFO back handler,
 * host events, CLI/deep-link `open-add` triggers, `<Shell />`, and `<SnackbarHost />`.
 */
import { useEffect } from 'react';
import type { PlatformHost, PlayerEngine } from '@minipod/core';
import { installGlobalBackHandler } from './back';
import { useRouteStore } from './routes';
import { Shell } from './Shell';
import { SnackbarHost } from '../components/m3';
import { HostProvider, useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { PlayerProvider } from '../player/usePlayer';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
import { useTheme } from '../theme/useTheme';

function AppRuntime() {
  const host = useHost();
  useTheme();

  useEffect(() => {
    void useSettingsStore.getState().load(host).catch(() => undefined);
  }, [host]);

  useEffect(() => {
    return installGlobalBackHandler();
  }, []);

  useHostEvents((ev) => {
    if (ev.type === 'settings-changed') {
      useSettingsStore.getState().receive(ev.settings);
    } else if (ev.type === 'open-add') {
      useRouteStore.getState().openAdd(ev.input);
    } else if (ev.type === 'host-notice') {
      showSnackbar(ev.message);
    }
  });

  // Support desktop CLI `/?add=<url>` query param and `minipod:open-add` CustomEvent
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const addInput = params.get('add');
      if (addInput && addInput.trim()) {
        useRouteStore.getState().openAdd(addInput.trim());
      }
    } catch {
      // ignore
    }

    const onOpenAddEvent = (e: Event) => {
      const custom = e as CustomEvent<{ readonly input?: string }>;
      const input = custom.detail?.input?.trim();
      if (input) {
        useRouteStore.getState().openAdd(input);
      }
    };
    window.addEventListener('minipod:open-add', onOpenAddEvent);
    return () => window.removeEventListener('minipod:open-add', onOpenAddEvent);
  }, []);

  return (
    <>
      <Shell />
      <SnackbarHost />
    </>
  );
}

export interface AppProps {
  readonly host: PlatformHost;
  readonly engine: PlayerEngine;
}

export function App({ host, engine }: AppProps) {
  return (
    <HostProvider host={host}>
      <PlayerProvider engine={engine}>
        <AppRuntime />
      </PlayerProvider>
    </HostProvider>
  );
}
