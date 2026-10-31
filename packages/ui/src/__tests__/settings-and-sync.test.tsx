import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildM3Tokens } from '../theme/m3-theme';
import { renderMiniPod } from './test-helpers';

describe('Minimalist Settings (9 Rows), Cloud Sync Capability Gating & i18n/Theme', () => {
  it('renders strictly 9 settings rows, updates settings, exports OPML, and configures WebDAV & Drive sync on desktop', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-settings'));

    const settingsScreen = await screen.findByTestId('settings-screen');
    const rows = settingsScreen.querySelectorAll('[data-settings-row]');
    expect(rows).toHaveLength(9);

    // Toggle Delete download when played
    fireEvent.click(screen.getByTestId('settings-switch-delete-played'));
    await waitFor(async () => {
      expect((await host.settings.get()).deleteDownloadWhenPlayed).toBe(true);
    });

    // Export OPML
    fireEvent.click(screen.getByTestId('settings-row-export-opml'));
    await waitFor(() => {
      expect(host.savedFiles).toHaveLength(1);
      expect(host.savedFiles[0]?.name).toBe('minipod-subscriptions.opml');
      expect(host.savedFiles[0]?.text).toContain('Syntax & Signal');
    });

    // Edit device name
    fireEvent.click(screen.getByTestId('settings-row-device-name'));
    const devInput = await screen.findByTestId('settings-device-input');
    fireEvent.change(devInput, { target: { value: 'Workstation Arch' } });
    fireEvent.click(screen.getByTestId('settings-device-save-btn'));
    expect(await screen.findByText('Workstation Arch')).toBeInTheDocument();

    // Open Cloud Sync setup (Desktop capabilities)
    fireEvent.click(screen.getByTestId('settings-row-provider'));
    expect(await screen.findByTestId('cloud-sync-screen')).toBeInTheDocument();
    expect(screen.getByTestId('sync-bg-hint')).toHaveTextContent(
      'Syncs while Podcasts is running, even with this window closed.',
    );
    expect(screen.getByTestId('sync-card-drive')).toBeInTheDocument();

    // Configure WebDAV with separate password secret
    fireEvent.click(screen.getByTestId('sync-radio-webdav'));
    fireEvent.change(screen.getByTestId('sync-webdav-url'), {
      target: { value: 'https://cloud.example.org/remote.php/dav/files/u/minipod-sync-v1.json' },
    });
    fireEvent.change(screen.getByTestId('sync-webdav-username'), {
      target: { value: 'chii' },
    });
    fireEvent.change(screen.getByTestId('sync-webdav-password'), {
      target: { value: 'app-pass-123' },
    });
    fireEvent.click(screen.getByTestId('sync-webdav-save-btn'));

    await waitFor(async () => {
      const st = await host.sync.status();
      expect(st.enabled).toBe(true);
      expect(st.provider).toBe('webdav');
    });
    expect(host.getStoredSecret()).toEqual({ id: 'webdav', password: 'app-pass-123' });
  });

  it('hides Google Drive when unsupported on Android F-Droid builds, uses SAF picker, and shows truthful foreground sync copy', async () => {
    const { host } = renderMiniPod({
      width: 390,
      hostOptions: {
        platform: 'android',
        capabilities: {
          syncProviders: ['saf', 'webdav', 'gist'],
          backgroundSync: false,
        },
      },
    });

    await screen.findByText('Syntax & Signal');

    // On mobile (< 840px), Settings is accessed from Subscriptions overflow menu
    fireEvent.click(screen.getByTestId('subs-overflow-btn'));
    fireEvent.click(screen.getByTestId('subs-mobile-settings'));
    expect(await screen.findByTestId('settings-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-row-provider'));
    expect(await screen.findByTestId('cloud-sync-screen')).toBeInTheDocument();

    // Truthful Android foreground copy + Google Drive card hidden
    expect(screen.getByTestId('sync-bg-hint')).toHaveTextContent(
      'Syncs while Podcasts is open or playing.',
    );
    expect(screen.queryByTestId('sync-card-drive')).not.toBeInTheDocument();

    // Select SAF cloud folder & create new sync file
    fireEvent.click(screen.getByTestId('sync-radio-cloud-folder'));
    fireEvent.click(await screen.findByTestId('sync-saf-create-btn'));

    await waitFor(async () => {
      const st = await host.sync.status();
      expect(st.enabled).toBe(true);
      expect(st.provider).toBe('saf');
    });
  });

  it('supports Simplified Chinese (zh-CN) UI localization and M3 light/dark token generation', async () => {
    renderMiniPod({
      width: 1024,
      hostOptions: {
        initialSettings: { uiLanguage: 'zh-CN' },
      },
    });

    expect(await screen.findByTestId('nav-rail-subscriptions')).toHaveTextContent('订阅');
    expect(screen.getByTestId('nav-rail-queue')).toHaveTextContent('队列');
    expect(screen.getByTestId('nav-rail-settings')).toHaveTextContent('设置');

    const light = buildM3Tokens('#4f6d7a', false);
    const dark = buildM3Tokens('#4f6d7a', true);
    expect(light['--md-sys-color-primary']).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark['--md-sys-color-primary']).toMatch(/^#[0-9a-f]{6}$/);
    expect(light['--md-sys-color-surface']).not.toBe(dark['--md-sys-color-surface']);
  });
});
