/**
 * In-app auto-updater state store & cross-platform update actions (`codescv/minipod`).
 *
 * - Queries GitHub Releases (`api.github.com` -> `/releases?per_page=5` -> `releases.atom`)
 *   via `@minipod/core`'s platform-neutral `fetchLatestRelease`.
 * - On Android (Capacitor): streams the signed `.apk` into app cache with live progress
 *   and launches the Android package installer via `FileProvider`.
 * - On PC Web (`@minipod/host-node`): invokes `POST /api/update/apply` (`host.updater.apply()`)
 *   to self-update via `git pull --ff-only` or download the release bundle, falling back to
 *   opening the GitHub release page.
 */
import { create } from 'zustand';
import {
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASES_ATOM_URL,
  GITHUB_RELEASES_HTML_URL,
  GITHUB_RELEASES_LIST_URL,
  GITHUB_REPO,
  compareSemanticVersions,
  compareSemver,
  fetchLatestRelease,
  parseGithubReleaseJson,
  parseGithubReleasesAtom,
  parseSemanticVersion,
  parseSemver,
  type PlatformHost,
  type ReleaseFetchFn,
  type ReleaseFetchResponseLike,
  type ReleaseInfo,
} from '@minipod/core';
import { resolveLocale, translate, type MessageKey, type TranslateVars } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';

export {
  GITHUB_REPO,
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASES_LIST_URL,
  GITHUB_RELEASES_ATOM_URL,
  GITHUB_RELEASES_HTML_URL,
  parseSemver,
  parseSemanticVersion,
  compareSemver,
  compareSemanticVersions,
  parseGithubReleaseJson,
  parseGithubReleasesAtom,
  fetchLatestRelease,
  type ReleaseInfo,
  type ReleaseFetchFn,
  type ReleaseFetchResponseLike,
};

export const DISMISSED_UPDATE_TAG_KEY = 'minipod:update:dismissedTag';
export const STARTUP_UPDATE_THROTTLE_MS = 5 * 60_000;

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready-to-install'
  | 'applied'
  | 'error';

export interface ApkDownloadProgressEvent {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface NativeUpdaterPluginLike {
  downloadAndInstallApk?(opts: { readonly url: string; readonly version: string }): Promise<{
    readonly filePath: string;
    readonly installerLaunched: boolean;
    readonly needsPermission?: boolean;
  }>;
  installApkFile?(opts: { readonly filePath: string }): Promise<{
    readonly filePath?: string;
    readonly installerLaunched: boolean;
    readonly needsPermission?: boolean;
  }>;
  addListener?(
    eventName: 'apkDownloadProgress',
    cb: (ev: ApkDownloadProgressEvent) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

interface CapacitorGlobalLike {
  isNativePlatform?: () => boolean;
  Plugins?: {
    MiniPod?: NativeUpdaterPluginLike;
  };
}

export function getNativeUpdaterPlugin(): NativeUpdaterPluginLike | undefined {
  const cap = (globalThis as { Capacitor?: CapacitorGlobalLike }).Capacitor;
  if (!cap?.isNativePlatform?.()) return undefined;
  return cap.Plugins?.MiniPod;
}

function readDismissedTag(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(DISMISSED_UPDATE_TAG_KEY) ?? '') : '';
  } catch {
    return '';
  }
}

function writeDismissedTag(tag: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      if (tag) {
        localStorage.setItem(DISMISSED_UPDATE_TAG_KEY, tag);
      } else {
        localStorage.removeItem(DISMISSED_UPDATE_TAG_KEY);
      }
    }
  } catch {
    // ignore storage errors
  }
}

function tNow(key: MessageKey, vars?: TranslateVars): string {
  const locale = resolveLocale(useSettingsStore.getState().settings.uiLanguage);
  return translate(locale, key, vars);
}

export interface CheckForUpdateOptions {
  readonly silent?: boolean | undefined;
  readonly throttleMs?: number | undefined;
  readonly fetchImpl?: ReleaseFetchFn | undefined;
}

export interface UpdateStoreState {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly release: ReleaseInfo | undefined;
  readonly progressPercent: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly downloadedFilePath: string | undefined;
  readonly needsPermission: boolean;
  readonly appliedMessage: string | undefined;
  readonly error: string | undefined;
  readonly dismissedTag: string;
  readonly lastCheckedAt: number | undefined;
  checkForUpdate(host: PlatformHost, options?: CheckForUpdateOptions): Promise<ReleaseInfo | undefined>;
  downloadUpdate(host: PlatformHost): Promise<void>;
  installDownloadedApk(host: PlatformHost): Promise<void>;
  dismiss(tagName: string): void;
  reset(): void;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  status: 'idle',
  currentVersion: '0.1.25',
  release: undefined,
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  downloadedFilePath: undefined,
  needsPermission: false,
  appliedMessage: undefined,
  error: undefined,
  dismissedTag: readDismissedTag(),
  lastCheckedAt: undefined,

  async checkForUpdate(host, options) {
    const state = get();
    if (state.status === 'checking' || state.status === 'downloading') {
      return state.release;
    }
    const now = Date.now();
    if (
      options?.throttleMs !== undefined &&
      options.throttleMs > 0 &&
      state.lastCheckedAt !== undefined &&
      now - state.lastCheckedAt < options.throttleMs
    ) {
      return state.release;
    }

    const currentVersion = host.info.appVersion || '0.1.25';
    set({
      status: 'checking',
      currentVersion,
      error: undefined,
      dismissedTag: readDismissedTag(),
    });

    try {
      let release: ReleaseInfo | undefined;
      try {
        release = await fetchLatestRelease(options?.fetchImpl);
      } catch (primaryErr) {
        if (!options?.fetchImpl && host.updater) {
          const fallback = await host.updater.check({ currentVersion });
          release = fallback.release;
          if (!release) {
            throw primaryErr;
          }
        } else {
          throw primaryErr;
        }
      }

      const checkedAt = Date.now();
      const hasUpdate = compareSemver(release.version, currentVersion) > 0;
      if (hasUpdate) {
        set({
          status: 'available',
          currentVersion,
          release,
          lastCheckedAt: checkedAt,
          error: undefined,
        });
        if (!options?.silent) {
          showSnackbar(tNow('update.foundSnack', { version: release.version }));
        }
      } else {
        set({
          status: 'up-to-date',
          currentVersion,
          release,
          lastCheckedAt: checkedAt,
          error: undefined,
        });
        if (!options?.silent) {
          showSnackbar(tNow('update.upToDateSnack', { version: currentVersion }));
        }
      }
      return release;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({
        status: 'error',
        currentVersion,
        error: msg,
        lastCheckedAt: Date.now(),
      });
      if (!options?.silent) {
        showSnackbar(tNow('update.checkErrorSnack', { error: msg }), { tone: 'error' });
      }
      return undefined;
    }
  },

  async downloadUpdate(host) {
    const { release, status } = get();
    if (!release || status === 'downloading') return;

    const nativePlugin = getNativeUpdaterPlugin();
    if (nativePlugin?.downloadAndInstallApk && release.apkUrl) {
      set({
        status: 'downloading',
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: release.apkSizeBytes ?? 0,
        needsPermission: false,
        error: undefined,
      });

      let listenerHandle: { remove(): Promise<void> } | undefined;
      try {
        if (nativePlugin.addListener) {
          listenerHandle = await nativePlugin.addListener('apkDownloadProgress', (ev) => {
            set({
              downloadedBytes: ev.downloadedBytes,
              totalBytes: ev.totalBytes > 0 ? ev.totalBytes : (release.apkSizeBytes ?? 0),
              progressPercent: ev.percent,
            });
          });
        }

        const res = await nativePlugin.downloadAndInstallApk({
          url: release.apkUrl,
          version: release.version,
        });

        set({
          status: 'ready-to-install',
          progressPercent: 100,
          downloadedFilePath: res.filePath,
          needsPermission: Boolean(res.needsPermission),
        });

        if (res.needsPermission) {
          showSnackbar(tNow('update.permissionSnack'));
        } else {
          showSnackbar(tNow('update.installingSnack', { version: release.version }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ status: 'error', error: msg });
        showSnackbar(tNow('update.downloadErrorSnack', { error: msg }), { tone: 'error' });
      } finally {
        if (listenerHandle) {
          await listenerHandle.remove().catch(() => undefined);
        }
      }
      return;
    }

    if (host.info.platform === 'desktop' && host.updater) {
      set({
        status: 'downloading',
        progressPercent: -1,
        error: undefined,
      });
      try {
        const res = await host.updater.apply();
        if (res.method === 'external') {
          set({ status: 'available', progressPercent: 0 });
          await host.files.openExternal(release.htmlUrl);
          showSnackbar(tNow('update.openedReleaseSnack', { version: release.version }));
          return;
        }
        set({
          status: 'applied',
          progressPercent: 100,
          appliedMessage: res.message,
          error: undefined,
        });
        showSnackbar(res.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ status: 'error', error: msg });
        showSnackbar(tNow('update.downloadErrorSnack', { error: msg }), { tone: 'error' });
      }
      return;
    }

    const targetUrl =
      host.info.platform === 'android' && release.apkUrl ? release.apkUrl : release.htmlUrl;
    await host.files.openExternal(targetUrl);
    showSnackbar(tNow('update.openedReleaseSnack', { version: release.version }));
  },

  async installDownloadedApk(host) {
    const { downloadedFilePath, release } = get();
    const nativePlugin = getNativeUpdaterPlugin();
    if (downloadedFilePath && nativePlugin?.installApkFile) {
      try {
        const res = await nativePlugin.installApkFile({ filePath: downloadedFilePath });
        set({ needsPermission: Boolean(res.needsPermission) });
        if (res.needsPermission) {
          showSnackbar(tNow('update.permissionSnack'));
        } else if (release) {
          showSnackbar(tNow('update.installingSnack', { version: release.version }));
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ status: 'error', error: msg });
        showSnackbar(tNow('update.downloadErrorSnack', { error: msg }), { tone: 'error' });
        return;
      }
    }
    await get().downloadUpdate(host);
  },

  dismiss(tagName) {
    writeDismissedTag(tagName);
    set({ dismissedTag: tagName });
  },

  reset() {
    set({
      status: 'idle',
      currentVersion: '0.1.25',
      release: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedFilePath: undefined,
      needsPermission: false,
      appliedMessage: undefined,
      error: undefined,
      dismissedTag: readDismissedTag(),
      lastCheckedAt: undefined,
    });
  },
}));
