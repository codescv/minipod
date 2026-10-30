/**
 * Desktop Google Drive OAuth 2.0 loopback PKCE helper (`ARCHITECTURE.md §8.2`).
 *
 * Uses installed-app OAuth 2.0 with PKCE (`S256`) and an ephemeral loopback redirect
 * server on `http://127.0.0.1:0/oauth/callback`. Refreshes access tokens silently
 * 60s before expiry and supports `forceRefresh` on HTTP 401.
 */
import { MiniPodError, type HttpClient, type TokenProvider } from '@minipod/core';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SettingsStore, StoredDriveOAuthClient, StoredDriveTokens } from '../settings/store';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const AUTH_TIMEOUT_MS = 3 * 60_000;

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export interface DesktopDriveAuthDeps {
  readonly settingsStore: SettingsStore;
  readonly http: HttpClient;
  readonly openExternal: (url: string) => Promise<void>;
  readonly authEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly timeoutMs?: number;
}

export class DesktopDriveAuthManager {
  private readonly settingsStore: SettingsStore;
  private readonly http: HttpClient;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly authEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly timeoutMs: number;
  private inflightRefresh: Promise<string> | null = null;

  constructor(deps: DesktopDriveAuthDeps) {
    this.settingsStore = deps.settingsStore;
    this.http = deps.http;
    this.openExternal = deps.openExternal;
    this.authEndpoint = deps.authEndpoint ?? GOOGLE_AUTH_ENDPOINT;
    this.tokenEndpoint = deps.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.timeoutMs = deps.timeoutMs ?? AUTH_TIMEOUT_MS;
  }

  private requireOAuthClient(): StoredDriveOAuthClient {
    const client = this.settingsStore.getDriveOAuthClient();
    if (!client || !client.clientId.trim()) {
      throw new MiniPodError(
        'sync-auth',
        'Google Drive desktop OAuth requires MINIPOD_GOOGLE_CLIENT_ID (or configured OAuth clientId in secrets.json). Tip: on desktop you can also sync via Google Drive for Desktop using Local Folder!',
      );
    }
    return client;
  }

  /**
   * Starts interactive loopback PKCE sign-in for `'drive-appdata'` or `'drive-file'`.
   */
  async authorizeInteractive(provider: 'drive-appdata' | 'drive-file'): Promise<StoredDriveTokens> {
    const client = this.requireOAuthClient();
    const scope = provider === 'drive-appdata' ? DRIVE_APPDATA_SCOPE : DRIVE_FILE_SCOPE;
    const { verifier, challenge } = generatePkcePair();
    const expectedState = base64UrlEncode(randomBytes(16));

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;

    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new MiniPodError('sync-auth', 'Google sign-in timed out'));
      }, this.timeoutMs);
      timer.unref?.();

      server.on('request', (req, res) => {
        try {
          const u = new URL(req.url ?? '/', redirectUri);
          if (u.pathname !== '/oauth/callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }
          const errParam = u.searchParams.get('error');
          if (errParam) {
            clearTimeout(timer);
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>MiniPod Sign-in Cancelled</h1><p>You may close this tab.</p>');
            server.close();
            reject(new MiniPodError('sync-auth', `Google OAuth error: ${errParam}`));
            return;
          }
          const state = u.searchParams.get('state');
          const code = u.searchParams.get('code');
          if (!code || state !== expectedState) {
            clearTimeout(timer);
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Invalid OAuth callback state.');
            server.close();
            reject(new MiniPodError('sync-auth', 'Invalid OAuth state or missing code'));
            return;
          }

          clearTimeout(timer);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>MiniPod connected to Google Drive</h2><p>You can close this browser tab and return to MiniPod.</p></body></html>',
          );
          server.close();
          resolve(code);
        } catch (err) {
          clearTimeout(timer);
          server.close();
          reject(err);
        }
      });
    });

    const authUrl = new URL(this.authEndpoint);
    authUrl.searchParams.set('client_id', client.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', expectedState);

    try {
      await this.openExternal(authUrl.toString());
    } catch {
      server.close();
      throw new MiniPodError('sync-auth', 'Failed to open browser for Google sign-in');
    }

    const code = await codePromise;
    return this.exchangeCode(client, code, verifier, redirectUri, scope);
  }

  private async exchangeCode(
    client: StoredDriveOAuthClient,
    code: string,
    verifier: string,
    redirectUri: string,
    requestedScope: string,
  ): Promise<StoredDriveTokens> {
    const form = new URLSearchParams({
      client_id: client.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (client.clientSecret) {
      form.set('client_secret', client.clientSecret);
    }

    const resp = await this.http({
      url: this.tokenEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const parsed = JSON.parse(await resp.text()) as GoogleTokenResponse;
    if (resp.status < 200 || resp.status >= 300 || !parsed.access_token) {
      throw new MiniPodError(
        'sync-auth',
        parsed.error_description || parsed.error || `Token exchange failed (HTTP ${resp.status})`,
      );
    }

    const existing = this.settingsStore.getDriveTokens();
    const expiresInSec = parsed.expires_in ?? 3600;
    const refreshToken = parsed.refresh_token ?? existing?.refreshToken;
    const stored: StoredDriveTokens = {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
      scope: parsed.scope ?? requestedScope,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
    this.settingsStore.setDriveTokens(stored);
    return stored;
  }

  createTokenProvider(): TokenProvider {
    return async (options?: { readonly forceRefresh?: boolean }): Promise<string> => {
      const tokens = this.settingsStore.getDriveTokens();
      if (!tokens) {
        throw new MiniPodError('sync-auth', 'Not signed in to Google Drive');
      }

      const expired = Date.now() + TOKEN_REFRESH_SKEW_MS >= tokens.expiresAt;
      if (!options?.forceRefresh && !expired && tokens.accessToken) {
        return tokens.accessToken;
      }

      if (!tokens.refreshToken) {
        throw new MiniPodError('sync-auth', 'Google Drive access token expired; please sign in again');
      }

      if (this.inflightRefresh) {
        return this.inflightRefresh;
      }

      this.inflightRefresh = this.refreshAccessToken(tokens).finally(() => {
        this.inflightRefresh = null;
      });
      return this.inflightRefresh;
    };
  }

  private async refreshAccessToken(current: StoredDriveTokens): Promise<string> {
    const client = this.requireOAuthClient();
    const form = new URLSearchParams({
      client_id: client.clientId,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken!,
    });
    if (client.clientSecret) {
      form.set('client_secret', client.clientSecret);
    }

    const resp = await this.http({
      url: this.tokenEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const parsed = JSON.parse(await resp.text()) as GoogleTokenResponse;
    if (resp.status === 400 || resp.status === 401 || !parsed.access_token) {
      throw new MiniPodError(
        'sync-auth',
        parsed.error_description || parsed.error || `Token refresh rejected (HTTP ${resp.status})`,
      );
    }

    const expiresInSec = parsed.expires_in ?? 3600;
    const refreshToken = parsed.refresh_token ?? current.refreshToken;
    const next: StoredDriveTokens = {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
      ...(parsed.scope ?? current.scope ? { scope: (parsed.scope ?? current.scope)! } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
    this.settingsStore.setDriveTokens(next);
    return next.accessToken;
  }
}
