import type { MountMiniPodApp } from '@minipod/ui';
import { createCapacitorPlatformHost } from '../src/capacitor-host';

interface UiModuleRuntime {
  readonly mountMiniPodApp?: MountMiniPodApp;
}

declare global {
  interface Window {
    __minipodHandleBack?: () => boolean;
  }
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Missing #root container');
  }

  // Reconciles native journal (`minipod_playback.xml`) before mounting UI / running first sync
  const { host, engine } = await createCapacitorPlatformHost();
  const ui = (await import('@minipod/ui')) as unknown as UiModuleRuntime;

  if (!ui.mountMiniPodApp) {
    container.textContent = 'MiniPod UI module not initialized.';
    return;
  }

  const mounted = ui.mountMiniPodApp(container, host, engine);
  void mounted;
}

void bootstrap();
