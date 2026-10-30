/**
 * Desktop server-side `SyncEngine` + `SyncScheduler` host (`ARCHITECTURE.md §8`, `§9`).
 *
 * Wires `SqliteSyncStore` to all 5 desktop providers:
 *   - `local-folder` (`LocalFolderFileProvider`)
 *   - `drive-appdata` (`GoogleDriveProvider` mode `'appdata'`)
 *   - `drive-file` (`GoogleDriveProvider` mode `'file'`)
 *   - `webdav` (`WebDavProvider`)
 *   - `gist` (`GitHubGistProvider`)
 */
import {
  GitHubGistProvider,
  GoogleDriveProvider,
  HybridLogicalClock,
  MiniPodError,
  SyncEngine,
  SyncScheduler,
  WebDavProvider,
  type ApplyDecisions,
  type CloudFileProvider,
  type EpisodeKey,
  type FeedKey,
  type HostEvent,
  type HttpClient,
  type SyncProviderConfig,
  type SyncProviderSecret,
  type SyncReason,
  type SyncSchedulerHost,
  type SyncSettings,
  type SyncStatus,
} from '@minipod/core';
import type { SqliteSyncStore } from '../db/SqliteSyncStore';
import type { SettingsStore } from '../settings/store';
import { DesktopDriveAuthManager } from './drive-oauth';
import { createLocalFolderFileProvider, type LocalFolderCloudProvider } from './LocalFolderFileProvider';

export function createNodeSyncSchedulerHost(): SyncSchedulerHost {
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    },
    setInterval(fn, ms) {
      const i = setInterval(fn, ms);
      i.unref?.();
      return () => clearInterval(i);
    },
    isVisible: () => true,
    isMetered: () => false,
    isOnline: () => true,
  };
}

export interface NodeSyncServiceDeps {
  readonly store: SqliteSyncStore;
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly hlc: HybridLogicalClock;
  readonly userAgent: string;
  readonly openExternal: (url: string) => Promise<void>;
  readonly getCurrentEpisodeKey: () => EpisodeKey | undefined;
  readonly emit: (event: HostEvent) => void;
  readonly onRefreshFeeds: (feedKeys: readonly FeedKey[]) => void;
  readonly schedulerHost?: SyncSchedulerHost;
}

export class NodeSyncService {
  readonly engine: SyncEngine;
  readonly scheduler: SyncScheduler;
  readonly driveAuth: DesktopDriveAuthManager;

  private readonly store: SqliteSyncStore;
  private readonly settingsStore: SettingsStore;
  private readonly http: HttpClient;
  private readonly userAgent: string;
  private readonly emit: (event: HostEvent) => void;
  private readonly onRefreshFeeds: (feedKeys: readonly FeedKey[]) => void;
  private activeLocalProvider: LocalFolderCloudProvider | null = null;

  constructor(deps: NodeSyncServiceDeps) {
    this.store = deps.store;
    this.settingsStore = deps.settingsStore;
    this.http = deps.http;
    this.userAgent = deps.userAgent;
    this.emit = deps.emit;
    this.onRefreshFeeds = deps.onRefreshFeeds;

    this.driveAuth = new DesktopDriveAuthManager({
      settingsStore: deps.settingsStore,
      http: deps.http,
      openExternal: deps.openExternal,
    });

    this.engine = new SyncEngine({
      store: deps.store,
      provider: null,
      hlc: deps.hlc,
      backgroundSync: true,
      getCurrentEpisodeKey: deps.getCurrentEpisodeKey,
      onStatusChanged: (status) => {
        this.emit({ type: 'sync-status', status });
      },
      onDecisions: (decisions) => this.handleDecisions(decisions),
      onCorruptRemote: (bytes) => {
        if (this.activeLocalProvider) {
          const archived = this.activeLocalProvider.archiveCorrupt(bytes);
          this.emit({
            type: 'host-notice',
            level: 'warning',
            message: `Corrupt sync file backed up to ${archived}`,
          });
        }
      },
    });

    const initialSettings = deps.settingsStore.get();
    this.scheduler = new SyncScheduler({
      engine: this.engine,
      host: deps.schedulerHost ?? createNodeSyncSchedulerHost(),
      wifiOnly: initialSettings.sync.wifiOnly,
    });

    // Instantiate configured provider if present on startup
    if (initialSettings.sync.provider) {
      const provider = this.instantiateProvider(initialSettings.sync.provider);
      this.engine.setProvider(provider);
    }

    this.scheduler.start();
  }

  private handleDecisions(decisions: ApplyDecisions): void {
    this.emit({ type: 'feeds-changed' });
    this.emit({ type: 'queue-changed' });

    for (const hint of decisions.resumeHints) {
      this.emit({
        type: 'progress-changed',
        episodeKey: hint.episodeKey,
        fromSync: {
          deviceName: hint.deviceName,
          positionMs: hint.positionMs,
          state: hint.state,
        },
      });
    }

    if (decisions.feedsToRefresh.length > 0) {
      this.onRefreshFeeds(decisions.feedsToRefresh);
    }
  }

  private instantiateProvider(config: SyncProviderConfig): CloudFileProvider | null {
    this.activeLocalProvider = null;

    switch (config.id) {
      case 'local-folder': {
        const p = createLocalFolderFileProvider(config.folderPath);
        this.activeLocalProvider = p;
        return p;
      }

      case 'drive-appdata':
      case 'drive-file': {
        const state = this.store.getSyncStateSync();
        return new GoogleDriveProvider({
          mode: config.id === 'drive-appdata' ? 'appdata' : 'file',
          http: this.http,
          getToken: this.driveAuth.createTokenProvider(),
          initialFileId: state.remoteFileId,
          userAgent: this.userAgent,
          ...(config.id === 'drive-file' && config.folderName ? { folderName: config.folderName } : {}),
        });
      }

      case 'webdav': {
        const password = this.settingsStore.getWebDavPassword() ?? '';
        return new WebDavProvider({
          fileUrl: config.fileUrl,
          username: config.username,
          password,
          http: this.http,
          userAgent: this.userAgent,
        });
      }

      case 'gist': {
        const token = this.settingsStore.getGistToken() ?? '';
        const state = this.store.getSyncStateSync();
        const initialGistId = config.gistId ?? state.remoteFileId ?? undefined;
        return new GitHubGistProvider({
          token,
          http: this.http,
          userAgent: this.userAgent,
          ...(initialGistId ? { gistId: initialGistId } : {}),
          onGistCreated: (newGistId) => {
            const cur = this.settingsStore.get();
            if (cur.sync.provider?.id === 'gist') {
              const updated = this.settingsStore.update({
                sync: {
                  ...cur.sync,
                  provider: { id: 'gist', gistId: newGistId },
                },
              });
              this.emit({ type: 'settings-changed', settings: updated });
            }
          },
        });
      }

      case 'saf':
        throw new MiniPodError('unsupported', 'SAF sync provider is only supported on Android');
    }
  }

  async configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus> {
    if (secret) {
      this.settingsStore.saveSyncSecret(secret);
    }

    const prevSettings = this.settingsStore.get();
    const providerChanged =
      JSON.stringify(prevSettings.sync.provider) !== JSON.stringify(settings.provider);

    await this.store.setSyncState({
      deviceName: settings.deviceName,
      ...(providerChanged
        ? {
            remoteEtag: null,
            remoteFileId: null,
            remoteRev: 0,
          }
        : {}),
    });

    if (!settings.provider) {
      this.engine.setProvider(null);
      const updated = this.settingsStore.update({ sync: settings });
      this.scheduler.setWifiOnly(updated.sync.wifiOnly);
      this.scheduler.rebindProviderWatcher();
      this.emit({ type: 'settings-changed', settings: updated });
      const status = await this.engine.getStatus();
      this.emit({ type: 'sync-status', status });
      return status;
    }

    const candidateProvider = this.instantiateProvider(settings.provider);
    if (!candidateProvider) {
      throw new MiniPodError('invalid-argument', 'Unable to initialize sync provider');
    }

    // Probe target before committing active sync cycle (`ARCHITECTURE.md §8.1`)
    const probe = await candidateProvider.probe();
    if (!probe.ok) {
      throw probe.error
        ? MiniPodError.fromShape(probe.error)
        : new MiniPodError('sync-auth', 'Sync provider probe failed');
    }

    const updated = this.settingsStore.update({ sync: settings });
    this.scheduler.setWifiOnly(updated.sync.wifiOnly);
    this.engine.setProvider(candidateProvider);
    this.scheduler.rebindProviderWatcher();
    this.emit({ type: 'settings-changed', settings: updated });

    const res = await this.scheduler.requestAsync('configured');
    return res ? res.status : this.engine.getStatus();
  }

  async authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void> {
    await this.driveAuth.authorizeInteractive(provider);
  }

  async syncNow(): Promise<SyncStatus> {
    if (!this.engine.getProvider()) {
      return this.engine.getStatus();
    }
    const res = await this.scheduler.requestAsync('manual');
    return res ? res.status : this.engine.getStatus();
  }

  async disconnect(): Promise<void> {
    const cur = this.settingsStore.get();
    this.engine.setProvider(null);
    this.activeLocalProvider = null;
    this.scheduler.rebindProviderWatcher();
    this.settingsStore.clearSyncSecrets();

    await this.store.setSyncState({
      remoteEtag: null,
      remoteFileId: null,
      remoteRev: 0,
      lastError: undefined,
      backoffUntil: 0,
    } as unknown as Partial<import('@minipod/core').SyncState>);

    const updated = this.settingsStore.update({
      sync: {
        ...cur.sync,
        provider: null,
      },
    });
    this.emit({ type: 'settings-changed', settings: updated });
    const status = await this.engine.getStatus();
    this.emit({ type: 'sync-status', status });
  }

  async resetRemote(): Promise<void> {
    await this.engine.resetRemote();
  }

  request(reason: SyncReason): void {
    this.scheduler.request(reason);
  }

  async requestImmediatePush(): Promise<void> {
    await this.scheduler.requestAsync('hidden');
  }

  dispose(): void {
    this.scheduler.dispose();
  }
}
