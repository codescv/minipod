/**
 * Desktop settings & secrets store (`ARCHITECTURE.md §6.1`, `§8.2`).
 *
 * - Non-secret `AppSettings` live as JSON in SQLite `settings(key = 'app')`.
 * - Secrets (feed Basic Auth credentials, WebDAV password, GitHub PAT, Google Drive
 *   OAuth tokens & client credentials) live in `${dataDir}/secrets.json` (`0o600`),
 *   never in SQLite or `minipod-sync-v1.json`.
 */
import {
  COUNTRY_CODE_UNSET,
  type AppSettings,
  type CountryCode,
  type FeedKey,
  type HttpBasicCredentials,
  type SyncProviderSecret,
  type SyncSettings,
} from '@minipod/core';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from '../db/sqlite';

export interface StoredDriveTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scope?: string;
}

export interface StoredDriveOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface SecretsFile {
  readonly feedCredentials: Record<FeedKey, HttpBasicCredentials>;
  readonly webdavPassword?: string;
  readonly gistToken?: string;
  readonly driveTokens?: StoredDriveTokens;
  readonly driveOAuthClient?: StoredDriveOAuthClient;
}

export function defaultAppSettings(deviceName: string, defaultCountry: CountryCode = COUNTRY_CODE_UNSET): AppSettings {
  return {
    schemaVersion: 1,
    deleteDownloadWhenPlayed: false,
    backgroundRefreshHours: 0,
    sync: {
      provider: null,
      wifiOnly: false,
      deviceName,
    },
    playbackSpeed: 1.0,
    topChartsCountry: defaultCountry,
    subscriptionsLayout: 'grid',
    uiLanguage: 'system',
  };
}

const VALID_REFRESH_HOURS = new Set([0, 1, 3, 6, 12, 24]);

function sanitizeSettings(raw: Partial<AppSettings> | undefined, fallbackDeviceName: string): AppSettings {
  const base = defaultAppSettings(fallbackDeviceName);
  if (!raw || typeof raw !== 'object') return base;

  const refreshHours = VALID_REFRESH_HOURS.has(raw.backgroundRefreshHours as number)
    ? (raw.backgroundRefreshHours as AppSettings['backgroundRefreshHours'])
    : base.backgroundRefreshHours;

  const speed =
    typeof raw.playbackSpeed === 'number' && Number.isFinite(raw.playbackSpeed)
      ? Math.min(3.0, Math.max(0.5, raw.playbackSpeed))
      : base.playbackSpeed;

  const syncRaw = raw.sync;
  const sync: SyncSettings = {
    provider: syncRaw && 'provider' in syncRaw ? (syncRaw.provider ?? null) : null,
    wifiOnly: Boolean(syncRaw?.wifiOnly),
    deviceName:
      typeof syncRaw?.deviceName === 'string' && syncRaw.deviceName.trim()
        ? syncRaw.deviceName.trim()
        : fallbackDeviceName,
  };

  return {
    schemaVersion: 1,
    deleteDownloadWhenPlayed: Boolean(raw.deleteDownloadWhenPlayed),
    backgroundRefreshHours: refreshHours,
    sync,
    playbackSpeed: speed,
    topChartsCountry:
      typeof raw.topChartsCountry === 'string' && raw.topChartsCountry.trim()
        ? raw.topChartsCountry.trim().toUpperCase()
        : base.topChartsCountry,
    subscriptionsLayout: raw.subscriptionsLayout === 'list' ? 'list' : 'grid',
    uiLanguage:
      raw.uiLanguage === 'en' || raw.uiLanguage === 'zh-CN' || raw.uiLanguage === 'ja'
        ? raw.uiLanguage
        : 'system',
  };
}

export class SettingsStore {
  private readonly secretsPath: string;
  private secretsCache: SecretsFile | null = null;

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    private readonly fallbackDeviceName: string,
  ) {
    this.secretsPath = join(dataDir, 'secrets.json');
  }

  get(): AppSettings {
    const row = this.db
      .prepare("SELECT json FROM settings WHERE key = 'app'")
      .get() as { json: string } | undefined;
    if (!row) {
      return defaultAppSettings(this.fallbackDeviceName);
    }
    try {
      const parsed = JSON.parse(row.json) as Partial<AppSettings>;
      return sanitizeSettings(parsed, this.fallbackDeviceName);
    } catch {
      return defaultAppSettings(this.fallbackDeviceName);
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const mergedSync: SyncSettings = patch.sync
      ? {
          provider: 'provider' in patch.sync ? (patch.sync.provider ?? null) : current.sync.provider,
          wifiOnly: patch.sync.wifiOnly ?? current.sync.wifiOnly,
          deviceName: patch.sync.deviceName ?? current.sync.deviceName,
        }
      : current.sync;

    const next = sanitizeSettings(
      {
        ...current,
        ...patch,
        sync: mergedSync,
      },
      this.fallbackDeviceName,
    );

    this.db
      .prepare(
        `INSERT INTO settings (key, json) VALUES ('app', ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      )
      .run(JSON.stringify(next));

    return next;
  }

  private readSecrets(): SecretsFile {
    if (this.secretsCache) return this.secretsCache;
    if (!existsSync(this.secretsPath)) {
      this.secretsCache = { feedCredentials: {} };
      return this.secretsCache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as Partial<SecretsFile>;
      this.secretsCache = {
        feedCredentials:
          parsed.feedCredentials && typeof parsed.feedCredentials === 'object'
            ? { ...parsed.feedCredentials }
            : {},
        ...(typeof parsed.webdavPassword === 'string' ? { webdavPassword: parsed.webdavPassword } : {}),
        ...(typeof parsed.gistToken === 'string' ? { gistToken: parsed.gistToken } : {}),
        ...(parsed.driveTokens ? { driveTokens: parsed.driveTokens } : {}),
        ...(parsed.driveOAuthClient ? { driveOAuthClient: parsed.driveOAuthClient } : {}),
      };
      return this.secretsCache;
    } catch {
      this.secretsCache = { feedCredentials: {} };
      return this.secretsCache;
    }
  }

  private writeSecrets(next: SecretsFile): void {
    this.secretsCache = next;
    if (this.dataDir === ':memory:') return;
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    const tmp = `${this.secretsPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows ignores POSIX mode bits
    }
    renameSync(tmp, this.secretsPath);
  }

  getFeedCredentials(feedKey: FeedKey): HttpBasicCredentials | undefined {
    return this.readSecrets().feedCredentials[feedKey];
  }

  setFeedCredentials(feedKey: FeedKey, credentials: HttpBasicCredentials | null): void {
    const cur = this.readSecrets();
    const nextMap = { ...cur.feedCredentials };
    if (credentials === null) {
      delete nextMap[feedKey];
    } else {
      nextMap[feedKey] = { username: credentials.username, password: credentials.password };
    }
    this.writeSecrets({
      ...cur,
      feedCredentials: nextMap,
    });
  }

  saveSyncSecret(secret: SyncProviderSecret): void {
    const cur = this.readSecrets();
    if (secret.id === 'webdav') {
      this.writeSecrets({ ...cur, webdavPassword: secret.password });
    } else if (secret.id === 'gist') {
      this.writeSecrets({ ...cur, gistToken: secret.token });
    }
  }

  getWebDavPassword(): string | undefined {
    return this.readSecrets().webdavPassword;
  }

  getGistToken(): string | undefined {
    return this.readSecrets().gistToken;
  }

  getDriveTokens(): StoredDriveTokens | undefined {
    return this.readSecrets().driveTokens;
  }

  setDriveTokens(tokens: StoredDriveTokens | null): void {
    const cur = this.readSecrets();
    const next: SecretsFile = {
      feedCredentials: cur.feedCredentials,
      ...(cur.webdavPassword !== undefined ? { webdavPassword: cur.webdavPassword } : {}),
      ...(cur.gistToken !== undefined ? { gistToken: cur.gistToken } : {}),
      ...(cur.driveOAuthClient !== undefined ? { driveOAuthClient: cur.driveOAuthClient } : {}),
      ...(tokens !== null ? { driveTokens: tokens } : {}),
    };
    this.writeSecrets(next);
  }

  getDriveOAuthClient(): StoredDriveOAuthClient | undefined {
    const envClientId = process.env['MINIPOD_GOOGLE_CLIENT_ID']?.trim();
    const envSecret = process.env['MINIPOD_GOOGLE_CLIENT_SECRET']?.trim();
    if (envClientId) {
      return {
        clientId: envClientId,
        ...(envSecret ? { clientSecret: envSecret } : {}),
      };
    }
    return this.readSecrets().driveOAuthClient;
  }

  setDriveOAuthClient(client: StoredDriveOAuthClient): void {
    const cur = this.readSecrets();
    this.writeSecrets({ ...cur, driveOAuthClient: client });
  }

  clearSyncSecrets(): void {
    const cur = this.readSecrets();
    const next: SecretsFile = {
      feedCredentials: cur.feedCredentials,
      ...(cur.driveOAuthClient !== undefined ? { driveOAuthClient: cur.driveOAuthClient } : {}),
    };
    this.writeSecrets(next);
  }
}
