import type { PlayerEngine } from '@minipod/core';
import type { MountMiniPodApp } from '@minipod/ui';
import { connectRestPlatformHost } from '../src/client';

interface UiModuleRuntime {
  readonly mountMiniPodApp?: MountMiniPodApp;
  readonly HtmlAudioEngine?: new () => PlayerEngine;
  readonly createHtmlAudioEngine?: () => PlayerEngine;
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Missing #root container');
  }

  const host = await connectRestPlatformHost();
  const ui = (await import('@minipod/ui')) as unknown as UiModuleRuntime;

  const engine: PlayerEngine | undefined = ui.createHtmlAudioEngine
    ? ui.createHtmlAudioEngine()
    : ui.HtmlAudioEngine
      ? new ui.HtmlAudioEngine()
      : undefined;

  if (!ui.mountMiniPodApp || !engine) {
    container.textContent = 'MiniPod UI module not initialized.';
    return;
  }

  const mounted = ui.mountMiniPodApp(container, host, engine);

  // Flush unsaved progress with keepalive: true when closing/reloading tab (`ARCHITECTURE.md §3.2`)
  window.addEventListener('pagehide', () => {
    const snap = engine.getSnapshot();
    if (snap.episodeKey && snap.positionMs > 0) {
      void host.progress
        .save({
          episodeKey: snap.episodeKey,
          positionMs: snap.positionMs,
          state: 'IN_PROGRESS',
          flush: true,
          ...(snap.durationMs !== undefined ? { durationMs: snap.durationMs } : {}),
        })
        .catch(() => undefined);
    }
  });

  // Deep-link CLI launch (`/?add=<encoded>`) -> emit `open-add` once UI has subscribed
  const params = new URLSearchParams(window.location.search);
  const addParam = params.get('add');
  if (addParam) {
    params.delete('add');
    const qs = params.toString();
    const cleanUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', cleanUrl);
    queueMicrotask(() => {
      // Triggered via server SSE or local URL dispatch
      window.dispatchEvent(new CustomEvent('minipod:open-add', { detail: { input: addParam } }));
    });
  }

  void mounted;
}

void bootstrap();
