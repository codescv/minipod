import { MiniPodError } from '../../errors';
import { DEFAULT_USER_AGENT } from '../../http/userAgent';
import {
  GIST_GZIP_THRESHOLD_BYTES,
  SYNC_FILE_NAME,
  type CloudFileProvider,
  type HttpClient,
  type HttpResponse,
  type ProbeResult,
  type ReadResult,
  type WriteResult,
} from '../../types';
import { decodeBase64, encodeBase64 } from '../../util/base64';
import { gzipCompress, gzipDecompress, isGzipBase64 } from '../../util/gzip';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubGistProviderDeps {
  readonly token: string;
  readonly gistId?: string;
  readonly fileName?: string;
  readonly http: HttpClient;
  readonly onGistCreated?: (gistId: string) => void;
  readonly gzipThresholdBytes?: number;
  readonly apiBaseUrl?: string;
  readonly userAgent?: string;
}

interface GistFileJson {
  readonly filename?: string;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly raw_url?: string;
}

interface GistResponseJson {
  readonly id?: string;
  readonly updated_at?: string;
  readonly files?: Readonly<Record<string, GistFileJson | null | undefined>>;
}

/**
 * GitHub Secret Gist `CloudFileProvider` (ARCHITECTURE.md §8.2):
 * - Uses `If-None-Match` / `ETag` (304 responses do not count against GitHub's rate limit).
 * - Fetches `raw_url` **with the same `Authorization` header** whenever `truncated === true`.
 * - Stores raw UTF-8 JSON up to `GIST_GZIP_THRESHOLD_BYTES` (800 KB), and seamlessly switches
 *   to `CompressionStream('gzip')` + Base64 (`H4sI...`) above 800 KB.
 * - Performs pre-write `head()` conflict detection before uploading.
 */
export class GitHubGistProvider implements CloudFileProvider {
  readonly id = 'gist' as const;
  readonly supportsNativeConditionalWrite = false;
  readonly supportsCheapHead = false;

  private gistId: string | undefined;
  private readonly token: string;
  private readonly fileName: string;
  private readonly http: HttpClient;
  private readonly onGistCreated?: (gistId: string) => void;
  private readonly gzipThresholdBytes: number;
  private readonly apiBase: string;
  private readonly userAgent: string;

  constructor(deps: GitHubGistProviderDeps) {
    this.token = deps.token.trim();
    this.gistId = deps.gistId?.trim() || undefined;
    this.fileName = deps.fileName?.trim() || SYNC_FILE_NAME;
    this.http = deps.http;
    this.gzipThresholdBytes = deps.gzipThresholdBytes ?? GIST_GZIP_THRESHOLD_BYTES;
    this.apiBase = (deps.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
    if (deps.onGistCreated !== undefined) {
      this.onGistCreated = deps.onGistCreated;
    }
  }

  getGistId(): string | undefined {
    return this.gistId;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
      ...extra,
    };
  }

  private async decodePayload(rawContent: string): Promise<Uint8Array> {
    const trimmed = rawContent.trimStart();
    if (trimmed.startsWith('{')) {
      return utf8Encoder.encode(rawContent);
    }
    if (isGzipBase64(trimmed)) {
      const compressed = decodeBase64(trimmed);
      return gzipDecompress(compressed);
    }
    throw new MiniPodError('sync-schema', 'Unrecognized Gist sync file payload encoding');
  }

  private async encodePayload(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength <= this.gzipThresholdBytes) {
      return utf8Decoder.decode(bytes);
    }
    const compressed = await gzipCompress(bytes);
    return encodeBase64(compressed);
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    if (!this.token) {
      return {
        ok: false,
        exists: false,
        etag: null,
        error: new MiniPodError('sync-auth', 'GitHub personal access token is empty').toShape(),
      };
    }

    if (!this.gistId) {
      // Validate token with lightweight `/gists?per_page=1`
      try {
        const resp = await this.http({
          url: `${this.apiBase}/gists?per_page=1`,
          method: 'GET',
          headers: this.authHeaders(),
          ...(signal ? { signal } : {}),
        });
        if (resp.status === 401 || resp.status === 403) {
          return {
            ok: false,
            exists: false,
            etag: null,
            error: new MiniPodError('sync-auth', `GitHub token rejected (HTTP ${resp.status})`).toShape(),
          };
        }
        if (resp.status >= 200 && resp.status < 300) {
          return { ok: true, exists: false, etag: null };
        }
        return {
          ok: false,
          exists: false,
          etag: null,
          error: new MiniPodError('network', `GitHub probe failed (HTTP ${resp.status})`).toShape(),
        };
      } catch (err) {
        return {
          ok: false,
          exists: false,
          etag: null,
          error: MiniPodError.wrap(err, 'network').toShape(),
        };
      }
    }

    try {
      const etag = await this.head(signal);
      return { ok: true, exists: etag !== null, etag };
    } catch (err) {
      return {
        ok: false,
        exists: false,
        etag: null,
        error: MiniPodError.wrap(err, 'network').toShape(),
      };
    }
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    if (!this.gistId) return null;
    const resp = await this.http({
      url: `${this.apiBase}/gists/${encodeURIComponent(this.gistId)}`,
      method: 'GET',
      headers: this.authHeaders(),
      ...(signal ? { signal } : {}),
    });

    if (resp.status === 404) return null;
    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('sync-auth', `GitHub Gist unauthorized (HTTP ${resp.status})`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `GitHub Gist check failed (HTTP ${resp.status})`);
    }

    const parsed = JSON.parse(await resp.text()) as GistResponseJson;
    const fileEntry = parsed.files?.[this.fileName];
    if (!fileEntry) return null;

    return resp.headers['etag'] ?? parsed.updated_at ?? null;
  }

  async read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult> {
    if (!this.gistId) {
      return { kind: 'missing' };
    }

    const extra: Record<string, string> = {};
    if (ifNoneMatch !== null) {
      extra['If-None-Match'] = ifNoneMatch;
    }

    const resp: HttpResponse = await this.http({
      url: `${this.apiBase}/gists/${encodeURIComponent(this.gistId)}`,
      method: 'GET',
      headers: this.authHeaders(extra),
      ...(signal ? { signal } : {}),
    });

    if (resp.status === 304) {
      return { kind: 'not-modified' };
    }
    if (resp.status === 404) {
      return { kind: 'missing' };
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('sync-auth', `GitHub Gist unauthorized (HTTP ${resp.status})`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `GitHub Gist read failed (HTTP ${resp.status})`);
    }

    const parsed = JSON.parse(await resp.text()) as GistResponseJson;
    const fileEntry = parsed.files?.[this.fileName];
    if (!fileEntry) {
      return { kind: 'missing' };
    }

    let rawContent = fileEntry.content ?? '';
    if (fileEntry.truncated === true && fileEntry.raw_url) {
      const rawResp = await this.http({
        url: fileEntry.raw_url,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': this.userAgent,
        },
        ...(signal ? { signal } : {}),
      });
      if (rawResp.status === 401 || rawResp.status === 403) {
        throw new MiniPodError('sync-auth', `GitHub Gist raw_url unauthorized (HTTP ${rawResp.status})`);
      }
      if (rawResp.status < 200 || rawResp.status >= 300) {
        throw new MiniPodError('network', `GitHub Gist raw_url failed (HTTP ${rawResp.status})`);
      }
      rawContent = await rawResp.text();
    }

    const bytes = await this.decodePayload(rawContent);
    const updatedMs = parsed.updated_at ? Date.parse(parsed.updated_at) : Number.NaN;
    const etag = resp.headers['etag'] ?? parsed.updated_at ?? null;

    return {
      kind: 'blob',
      bytes,
      etag,
      ...(Number.isFinite(updatedMs) ? { lastModified: updatedMs } : {}),
    };
  }

  async write(bytes: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<WriteResult> {
    try {
      if (this.gistId) {
        const currentEtag = await this.head(signal);
        if (ifMatch === null) {
          if (currentEtag !== null) {
            return { kind: 'conflict' };
          }
        } else if (currentEtag !== ifMatch) {
          return { kind: 'conflict' };
        }
      } else if (ifMatch !== null) {
        return { kind: 'conflict' };
      }

      const content = await this.encodePayload(bytes);

      if (!this.gistId) {
        const createResp = await this.http({
          url: `${this.apiBase}/gists`,
          method: 'POST',
          headers: this.authHeaders({ 'Content-Type': 'application/json; charset=UTF-8' }),
          body: JSON.stringify({
            description: 'MiniPod Cloud Sync',
            public: false,
            files: {
              [this.fileName]: { content },
            },
          }),
          ...(signal ? { signal } : {}),
        });

        if (createResp.status === 401 || createResp.status === 403) {
          return {
            kind: 'failed',
            cause: new MiniPodError('sync-auth', `GitHub Gist create unauthorized (HTTP ${createResp.status})`),
            retryable: false,
          };
        }
        if (createResp.status < 200 || createResp.status >= 300) {
          return {
            kind: 'failed',
            cause: new MiniPodError('network', `GitHub Gist create failed (HTTP ${createResp.status})`),
            retryable: createResp.status >= 500 || createResp.status === 429,
          };
        }

        const created = JSON.parse(await createResp.text()) as GistResponseJson;
        if (created.id) {
          this.gistId = created.id;
          this.onGistCreated?.(created.id);
        }
        return {
          kind: 'ok',
          newEtag: createResp.headers['etag'] ?? created.updated_at ?? null,
        };
      }

      const patchResp = await this.http({
        url: `${this.apiBase}/gists/${encodeURIComponent(this.gistId)}`,
        method: 'PATCH',
        headers: this.authHeaders({ 'Content-Type': 'application/json; charset=UTF-8' }),
        body: JSON.stringify({
          files: {
            [this.fileName]: { content },
          },
        }),
        ...(signal ? { signal } : {}),
      });

      if (patchResp.status === 404) {
        return { kind: 'conflict' };
      }
      if (patchResp.status === 401 || patchResp.status === 403) {
        return {
          kind: 'failed',
          cause: new MiniPodError('sync-auth', `GitHub Gist update unauthorized (HTTP ${patchResp.status})`),
          retryable: false,
        };
      }
      if (patchResp.status < 200 || patchResp.status >= 300) {
        return {
          kind: 'failed',
          cause: new MiniPodError('network', `GitHub Gist update failed (HTTP ${patchResp.status})`),
          retryable: patchResp.status >= 500 || patchResp.status === 429,
        };
      }

      const updated = JSON.parse(await patchResp.text()) as GistResponseJson;
      return {
        kind: 'ok',
        newEtag: patchResp.headers['etag'] ?? updated.updated_at ?? null,
      };
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      return {
        kind: 'failed',
        cause: wrapped,
        retryable: wrapped.code !== 'sync-auth' && wrapped.code !== 'cancelled',
      };
    }
  }

  async deleteRemote(signal?: AbortSignal): Promise<void> {
    if (!this.gistId) return;
    const resp = await this.http({
      url: `${this.apiBase}/gists/${encodeURIComponent(this.gistId)}`,
      method: 'DELETE',
      headers: this.authHeaders(),
      ...(signal ? { signal } : {}),
    });
    if (resp.status !== 404 && (resp.status < 200 || resp.status >= 300)) {
      if (resp.status === 401 || resp.status === 403) {
        throw new MiniPodError('sync-auth', `GitHub Gist delete unauthorized (HTTP ${resp.status})`);
      }
      throw new MiniPodError('network', `GitHub Gist delete failed (HTTP ${resp.status})`);
    }
    this.gistId = undefined;
  }
}

export function createGitHubGistProvider(deps: GitHubGistProviderDeps): GitHubGistProvider {
  return new GitHubGistProvider(deps);
}
