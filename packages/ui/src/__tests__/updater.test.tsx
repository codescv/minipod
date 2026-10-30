import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISMISSED_UPDATE_TAG_KEY,
  GITHUB_RELEASE_API_URL,
  type ApkDownloadProgressEvent,
  useUpdateStore,
} from '../features/updater/updater';
import { renderMiniPod } from './test-helpers';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.restoreAllMocks();
});

function mockGithubLatestRelease(tag = 'v0.1.2', body = '### Added\n- Cross-platform auto-updater') {
  const version = tag.replace(/^v/, '');
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === GITHUB_RELEASE_API_URL) {
      return new Response(
        JSON.stringify({
          tag_name: tag,
          name: `MiniPod ${tag}`,
          body,
          published_at: '2026-10-30T15:00:00Z',
          html_url: `https://github.com/codescv/minipod/releases/tag/${tag}`,
          assets: [
            {
              name: `minipod-${tag}.apk`,
              browser_download_url: `https://github.com/codescv/minipod/releases/download/${tag}/minipod-${tag}.apk`,
              size: 4 * 1024 * 1024,
            },
            {
              name: `minipod-${tag}-pc.tar.gz`,
              browser_download_url: `https://github.com/codescv/minipod/releases/download/${tag}/minipod-${tag}-pc.tar.gz`,
              size: 900 * 1024,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

describe('In-App Auto-Updater UI (Banner, Android Native APK, PC Self-Update & 9-Row Settings)', () => {
  it('runs startup auto-check, shows UpdateBanner, and supports per-version dismiss', async () => {
    mockGithubLatestRelease('v0.1.2', '### Highlights\nFast cross-platform auto-updater');

    renderMiniPod({
      width: 1024,
      hostOptions: { appVersion: '0.1.0' },
      autoCheckUpdates: true,
    });

    const banner = await screen.findByTestId('update-banner');
    expect(banner).toHaveTextContent('MiniPod v0.1.2 available');

    // Dismiss v0.1.2 and verify localStorage persistence
    fireEvent.click(screen.getByTestId('update-banner-dismiss-btn'));
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_UPDATE_TAG_KEY)).toBe('v0.1.2');

    // A newer release (v0.1.3) still surfaces the banner
    mockGithubLatestRelease('v0.1.3');
    await act(async () => {
      useUpdateStore.setState({ lastCheckedAt: undefined });
      await useUpdateStore.getState().checkForUpdate({
        info: {
          platform: 'desktop',
          os: 'Linux',
          appVersion: '0.1.0',
          deviceId: 'd_test',
          deviceName: 'Test',
          capabilities: {
            nativeAudio: false,
            downloads: true,
            localFolderFeeds: true,
            syncProviders: [],
            filePicker: false,
            folderPicker: false,
            backgroundSync: true,
            openExternal: true,
          },
        },
      } as never);
    });
    expect(await screen.findByTestId('update-banner')).toHaveTextContent('MiniPod v0.1.3 available');
  });

  it('streams Android APK download progress and handles unknown-sources permission + install retry', async () => {
    mockGithubLatestRelease('v0.1.2');

    let progressListener: ((ev: ApkDownloadProgressEvent) => void) | undefined;
    let resolveDownload!: (res: {
      filePath: string;
      installerLaunched: boolean;
      needsPermission?: boolean;
    }) => void;

    const downloadAndInstallApk = vi.fn(
      () =>
        new Promise<{
          filePath: string;
          installerLaunched: boolean;
          needsPermission?: boolean;
        }>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const installApkFile = vi.fn(async () => ({
      filePath: '/data/user/0/dev.minipod.app/cache/updates/minipod-0.1.2.apk',
      installerLaunched: true,
      needsPermission: false,
    }));

    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        MiniPod: {
          downloadAndInstallApk,
          installApkFile,
          addListener: vi.fn(async (_event: string, cb: (ev: ApkDownloadProgressEvent) => void) => {
            progressListener = cb;
            return { remove: async () => undefined };
          }),
        },
      },
    };

    renderMiniPod({
      width: 390,
      hostOptions: { platform: 'android', appVersion: '0.1.0' },
      autoCheckUpdates: true,
    });

    const banner = await screen.findByTestId('update-banner');
    expect(banner).toHaveTextContent('4.0 MB');

    fireEvent.click(screen.getByTestId('update-banner-action-btn'));
    await waitFor(() => {
      expect(downloadAndInstallApk).toHaveBeenCalledWith({
        url: 'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
        version: '0.1.2',
      });
    });

    act(() => {
      progressListener?.({
        downloadedBytes: 2 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        percent: 50,
      });
    });

    expect(await screen.findByTestId('update-banner-progress')).toHaveTextContent('50%');

    await act(async () => {
      resolveDownload({
        filePath: '/data/user/0/dev.minipod.app/cache/updates/minipod-0.1.2.apk',
        installerLaunched: false,
        needsPermission: true,
      });
    });

    const installBtn = await screen.findByTestId('update-banner-install-btn');
    expect(installBtn).toHaveTextContent('Grant & install');

    fireEvent.click(installBtn);
    await waitFor(() => {
      expect(installApkFile).toHaveBeenCalledWith({
        filePath: '/data/user/0/dev.minipod.app/cache/updates/minipod-0.1.2.apk',
      });
    });
  });

  it('applies PC self-update via host.updater.apply() and preserves the strict 9-row Settings invariant', async () => {
    mockGithubLatestRelease('v0.1.2');

    const applyMock = vi.fn(async () => ({
      ok: true,
      method: 'git-pull' as const,
      previousVersion: '0.1.0',
      targetVersion: '0.1.2',
      restartRequired: true,
      message: 'Updated to v0.1.2 via git pull. Restart MiniPod to load the new build.',
    }));

    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: {
        platform: 'desktop',
        appVersion: '0.1.0',
        updater: {
          check: vi.fn(async () => ({
            currentVersion: '0.1.0',
            updateAvailable: true,
            checkedAt: Date.now(),
          })),
          apply: applyMock,
        },
      },
    });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-settings'));

    const settingsScreen = await screen.findByTestId('settings-screen');
    expect(settingsScreen.querySelectorAll('[data-settings-row]')).toHaveLength(9);
    expect(screen.getByTestId('settings-version-badge')).toHaveTextContent('v0.1.0');

    // Click inline "Check for updates" button inside Row 9 without opening About dialog
    const updateBtn = screen.getByTestId('settings-update-btn');
    expect(updateBtn).toHaveTextContent('Check for updates');
    fireEvent.click(updateBtn);
    expect(screen.queryByTestId('settings-about-dialog')).not.toBeInTheDocument();

    expect(await screen.findByTestId('settings-update-status')).toHaveTextContent(
      'Update available: v0.1.2',
    );
    expect(screen.getByTestId('settings-update-btn')).toHaveTextContent('Update to v0.1.2');
    // Still strictly 9 rows!
    expect(settingsScreen.querySelectorAll('[data-settings-row]')).toHaveLength(9);

    // Trigger 1-click PC self-update
    fireEvent.click(screen.getByTestId('settings-update-btn'));
    await waitFor(() => {
      expect(applyMock).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('settings-update-status')).toHaveTextContent(
      'Updated to v0.1.2 via git pull.',
    );

    // Clicking Row 9 itself opens the About dialog and points Source code to codescv/minipod
    fireEvent.click(screen.getByTestId('settings-row-about'));
    expect(await screen.findByTestId('settings-about-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Source code'));
    await waitFor(() => {
      expect(host.openedExternalUrls).toContain('https://github.com/codescv/minipod');
    });
  });
});
