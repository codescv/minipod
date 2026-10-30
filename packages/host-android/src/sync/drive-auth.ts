/**
 * Android Google Drive OAuth token provider over `MiniPodPlugin.auth.googleSignIn`
 * (`ARCHITECTURE.md §3.2`, `§8.2`).
 */
import { MiniPodError, type EpochMs, type TokenProvider } from '@minipod/core';
import type { MiniPodPlugin } from '../plugin-types';

const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const EXPIRY_BUFFER_MS = 60_000;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: EpochMs;
  readonly accountEmail?: string;
}

export class AndroidDriveAuthManager {
  private readonly plugin: Pick<MiniPodPlugin, 'auth'>;
  private readonly tokenByScope = new Map<string, CachedToken>();

  constructor(plugin: Pick<MiniPodPlugin, 'auth'>) {
    this.plugin = plugin;
  }

  static scopeFor(mode: 'drive-appdata' | 'drive-file'): string {
    return mode === 'drive-appdata' ? DRIVE_APPDATA_SCOPE : DRIVE_FILE_SCOPE;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.plugin.auth.isGoogleSignInAvailable();
      return Boolean(res.available);
    } catch {
      return false;
    }
  }

  async authorizeInteractive(
    mode: 'drive-appdata' | 'drive-file',
    accountHint?: string,
  ): Promise<string | undefined> {
    const scope = AndroidDriveAuthManager.scopeFor(mode);
    const res = await this.plugin.auth.googleSignIn({
      scopes: [scope],
      ...(accountHint !== undefined ? { accountHint } : {}),
      forceRefresh: false,
    });
    if (!res.supported) {
      throw new MiniPodError(
        'unsupported',
        'Google Play Services Sign-In is not available on this device',
      );
    }
    if (!res.accessToken) {
      throw new MiniPodError('sync-auth', 'Google Drive authorization did not return an access token');
    }
    this.tokenByScope.set(scope, {
      accessToken: res.accessToken,
      expiresAt: res.expiresAt ?? Date.now() + 50 * 60_000,
      ...(res.accountEmail !== undefined ? { accountEmail: res.accountEmail } : {}),
    });
    return res.accountEmail;
  }

  createTokenProvider(
    mode: 'drive-appdata' | 'drive-file',
    accountHint?: string,
  ): TokenProvider {
    const scope = AndroidDriveAuthManager.scopeFor(mode);
    return async (opts): Promise<string> => {
      const cached = this.tokenByScope.get(scope);
      if (
        !opts?.forceRefresh &&
        cached &&
        cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()
      ) {
        return cached.accessToken;
      }

      try {
        const res = await this.plugin.auth.googleSignIn({
          scopes: [scope],
          ...(accountHint !== undefined ? { accountHint } : {}),
          forceRefresh: Boolean(opts?.forceRefresh),
        });
        if (!res.supported) {
          throw new MiniPodError(
            'unsupported',
            'Google Play Services Sign-In is not available on this device',
          );
        }
        if (!res.accessToken) {
          throw new MiniPodError('sync-auth', 'Google Drive authorization required');
        }
        this.tokenByScope.set(scope, {
          accessToken: res.accessToken,
          expiresAt: res.expiresAt ?? Date.now() + 50 * 60_000,
          ...(res.accountEmail !== undefined ? { accountEmail: res.accountEmail } : {}),
        });
        return res.accessToken;
      } catch (err) {
        if (err instanceof MiniPodError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new MiniPodError('sync-auth', msg || 'Google Drive token refresh failed', {
          cause: err,
        });
      }
    };
  }

  clearCache(): void {
    this.tokenByScope.clear();
  }
}
