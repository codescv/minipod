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
  type SyncState,
  type SyncStatus,
} from '@minipod/core';
import { resolve } from 'node:path';
import type { SqliteSyncStore } from '../db/SqliteSyncStore';
import type { SettingsStore } from '../settings/store';
import { DesktopDriveAuthManager } from './drive-oauth';
import { createLocalFolderFileProvider, type LocalFolderCloudProvider } from './LocalFolderFileProvider';

export function computeDesktopRemoteFingerprint(
  config: SyncProviderConfig,
  settingsStore: SettingsStore,
): string {
  switch (config.id) {
    case 'local-folder':
      return `local-folder:${resolve(config.folderPath)}`;
    case 'webdav':
      return `webdav:${config.fileUrl.trim()}`;
    case 'gist':
      return `gist:${config.gistId?.trim() ?? ''}`;
    case 'saf':
      return `saf:${config.documentUri}`;
    case 'drive-appdata':
    case 'drive-file': {
      const scope = settingsStore.getDriveTokens()?.scope ?? config.id;
      return `${config.id}:${scope}`;
    }
  }
}

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
      const built = this.buildProvider(initialSettings.sync.provider);
      this.activeLocalProvider = built.localProvider;
      this.engine.setProvider(built.provider);
    }

    this.scheduler.start();

    // Perform an initial foreground pull on desktop startup when a provider is configured (SYNC-P2-02)
    if (initialSettings.sync.provider) {
      this.scheduler.request('foreground');
    }
  }

  private handleDecisions(decisions: ApplyDecisions): void {
    const changed = decisions.changed;
    if (!changed || changed.subscriptions || decisions.feedsToRefresh.length > 0) {
      this.emit({ type: 'feeds-changed' });
    }
    if (!changed || changed.queue) {
      this.emit({ type: 'queue-changed' });
    }

    const hintKeys = new Set<EpisodeKey>();
    for (const hint of decisions.resumeHints) {
      hintKeys.add(hint.episodeKey);
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

    // Emit plain `progress-changed` ONLY for episodes NOT already covered by `resumeHints`
    // so paused active playback does not receive an unintended silent seek without Undo (SYNC-P1-07).
    if (changed?.progressEpisodeKeys) {
      for (const epKey of changed.progressEpisodeKeys) {
        if (!hintKeys.has(epKey)) {
          this.emit({ type: 'progress-changed', episodeKey: epKey });
        }
      }
    }

    if (decisions.feedsToRefresh.length > 0) {
      this.onRefreshFeeds(decisions.feedsToRefresh);
    }
  }

  private buildProvider(
    config: SyncProviderConfig,
    options?: {
      readonly secretOverride?: SyncProviderSecret | undefined;
      readonly ignoreStoredFileId?: boolean | undefined;
    },
  ): {
    readonly provider: CloudFileProvider | null;
    readonly localProvider: LocalFolderCloudProvider | null;
  } {
    switch (config.id) {
      case 'local-folder': {
        const p = createLocalFolderFileProvider(config.folderPath);
        return { provider: p, localProvider: p };
      }

      case 'drive-appdata':
      case 'drive-file': {
        const state = this.store.getSyncStateSync();
        const initialFileId = options?.ignoreStoredFileId ? null : state.remoteFileId;
        return {
          provider: new GoogleDriveProvider({
            mode: config.id === 'drive-appdata' ? 'appdata' : 'file',
            http: this.http,
            getToken: this.driveAuth.createTokenProvider(),
            initialFileId,
            userAgent: this.userAgent,
            ...(config.id === 'drive-file' && config.folderName ? { folderName: config.folderName } : {}),
          }),
          localProvider: null,
        };
      }

      case 'webdav': {
        const password =
          options?.secretOverride?.id === 'webdav'
            ? options.secretOverride.password
            : (this.settingsStore.getWebDavPassword() ?? '');
        return {
          provider: new WebDavProvider({
            fileUrl: config.fileUrl,
            username: config.username,
            password,
            http: this.http,
            userAgent: this.userAgent,
          }),
          localProvider: null,
        };
      }

      case 'gist': {
        const token =
          options?.secretOverride?.id === 'gist'
            ? options.secretOverride.token
            : (this.settingsStore.getGistToken() ?? '');
        const state = this.store.getSyncStateSync();
        const initialGistId =
          config.gistId ?? (options?.ignoreStoredFileId ? undefined : (state.remoteFileId ?? undefined));
        return {
          provider: new GitHubGistProvider({
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
          }),
          localProvider: null,
        };
      }

      case 'saf':
        throw new MiniPodError('unsupported', 'SAF sync provider is only supported on Android');
    }
  }

  async configure(settings: SyncSettings, secret?: SyncProviderSecret): Promise<SyncStatus> {
    // Disabling sync: stop active cycle first, preserve remote fingerprint for clean reconnect
    if (!settings.provider) {
      this.engine.setProvider(null);
      await this.engine.drainActiveCycle();
      this.activeLocalProvider = null;
      await this.store.setSyncState({ deviceName: settings.deviceName });
      const updated = this.settingsStore.update({ sync: settings });
      this.scheduler.setWifiOnly(updated.sync.wifiOnly);
      this.scheduler.rebindProviderWatcher();
      this.emit({ type: 'settings-changed', settings: updated });
      const status = await this.engine.getStatus();
      this.emit({ type: 'sync-status', status });
      return status;
    }

    // Determine whether this targets a new remote lineage BEFORE mutating secrets/state (SYNC-P0-05, SYNC-P1-10)
    const state = this.store.getSyncStateSync();
    const nextFingerprint = computeDesktopRemoteFingerprint(settings.provider, this.settingsStore);
    const isDrive =
      settings.provider.id === 'drive-appdata' || settings.provider.id === 'drive-file';
    const sameDriveWithoutReauth =
      isDrive &&
      !state.pendingLineageReset &&
      typeof state.lastRemoteFingerprint === 'string' &&
      state.lastRemoteFingerprint.startsWith(`${settings.provider.id}:`);
    const fingerprintChanged =
      state.lastRemoteFingerprint !== undefined &&
      state.lastRemoteFingerprint !== null &&
      state.lastRemoteFingerprint !== nextFingerprint &&
      !sameDriveWithoutReauth;
    const needLineageReset = fingerprintChanged || state.pendingLineageReset === true;

    // Phase 1: construct candidate using ephemeral secret and probe BEFORE mutating any persisted state (SYNC-P1-10)
    const candidate = this.buildProvider(settings.provider, {
      secretOverride: secret,
      ignoreStoredFileId: needLineageReset,
    });
    if (!candidate.provider) {
      throw new MiniPodError('invalid-argument', 'Unable to initialize sync provider');
    }

    const probe = await candidate.provider.probe();
    if (!probe.ok) {
      throw probe.error
        ? MiniPodError.fromShape(probe.error)
        : new MiniPodError('sync-auth', 'Sync provider probe failed');
    }

    // Phase 2: probe succeeded -> drain any in-flight cycle, then atomically commit secrets/state/provider
    this.engine.setProvider(null);
    await this.engine.drainActiveCycle();

    if (secret) {
      this.settingsStore.saveSyncSecret(secret);
    }

    // Never call `markAllDirty()` on configure; use explicit lineage-reset flag only when remote identity changed (SYNC-P0-05).
    const statePatch: Partial<SyncState> = needLineageReset
      ? ({
          deviceName: settings.deviceName,
          remoteEtag: null,
          remoteFileId: null,
          remoteRev: 0,
          floors: { subscriptions: 0, queue: 0, progress: 0 },
          lastPullAt: undefined,
          lastPushAt: undefined,
          remoteDevices: {},
          lastRemoteFingerprint: nextFingerprint,
          pendingLineageReset: true,
        } as unknown as Partial<SyncState>)
      : {
          deviceName: settings.deviceName,
          ...(state.lastRemoteFingerprint == null ? { lastRemoteFingerprint: nextFingerprint } : {}),
        };
    await this.store.setSyncState(statePatch);

    this.activeLocalProvider = candidate.localProvider;
    const updated = this.settingsStore.update({ sync: settings });
    this.scheduler.setWifiOnly(updated.sync.wifiOnly);
    this.engine.setProvider(candidate.provider);
    this.scheduler.rebindProviderWatcher();
    this.emit({ type: 'settings-changed', settings: updated });

    const res = await this.scheduler.requestAsync('configured');
    return res ? res.status : this.engine.getStatus();
  }

  async authorize(provider: 'drive-appdata' | 'drive-file'): Promise<void> {
    await this.driveAuth.authorizeInteractive(provider);
    // Re-authorization may target a different Google account -> flag lineage reset for next pull (SYNC-P0-05).
    await this.store.setSyncState({ pendingLineageReset: true });
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
    await this.engine.drainActiveCycle();
    this.activeLocalProvider = null;
    this.scheduler.rebindProviderWatcher();
    this.settingsStore.clearSyncSecrets();

    // Preserve `lastRemoteFingerprint`, `remoteRev`, `floors`, and `lastPullAt`/`lastPushAt` across disconnect
    // so reconnecting the SAME remote does not masquerade as a new lineage or resurrect deleted items (SYNC-P0-05).
    await this.store.setSyncState({
      remoteEtag: null,
      lastError: undefined,
      backoffUntil: 0,
    } as unknown as Partial<SyncState>);

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

  async dispose(flushTimeoutMs: number = 3_000): Promise<void> {
    if (this.engine.getProvider() && flushTimeoutMs > 0) {
      try {
        const dirty = await this.engine.getDirtyCount();
        if (dirty > 0) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([
            this.scheduler.requestAsync('hidden').catch(() => undefined),
            new Promise<void>((resolveTimer) => {
              timer = setTimeout(resolveTimer, flushTimeoutMs);
              timer.unref?.();
            }),
          ]);
          if (timer !== null) clearTimeout(timer);
        }
      } catch {
        // Best-effort shutdown flush
      }
    }
    this.scheduler.dispose();
    this.engine.setProvider(null);
    await this.engine.drainActiveCycle();
  }
}
