import { MiniPodError } from '../../errors';
import { DEFAULT_USER_AGENT } from '../../http/userAgent';
import {
  SYNC_FILE_NAME,
  type CloudFileProvider,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ProbeResult,
  type ReadResult,
  type SyncDocument,
  type TokenProvider,
  type WriteResult,
} from '../../types';
import { bytesToHex } from '../../util/sha1';
import { mergeSyncDocuments } from '../merge';
import { parseSyncDocument, serializeSyncDocument } from '../schema';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LIST_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'sharingRateLimitExceeded',
]);

export interface GoogleDriveProviderDeps {
  readonly mode: 'appdata' | 'file';
  readonly http: HttpClient;
  readonly getToken: TokenProvider;
  readonly folderName?: string;
  readonly fileName?: string;
  readonly initialFileId?: string | null;
  readonly onFileIdChanged?: (fileId: string | null) => void;
  readonly apiBaseUrl?: string;
  readonly uploadBaseUrl?: string;
  readonly userAgent?: string;
  readonly now?: () => number;
}

interface DriveFileMeta {
  readonly id: string;
  readonly name?: string;
  readonly md5Checksum?: string;
  readonly modifiedTime?: string;
  readonly trashed?: boolean;
  readonly parents?: readonly string[];
}

interface DriveFileListJson {
  readonly files?: readonly DriveFileMeta[];
}

function escapeDriveQueryValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function randomMultipartBoundary(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `minipod_${bytesToHex(bytes)}`;
}

async function isDriveRateLimit403(resp: HttpResponse): Promise<boolean> {
  if (resp.status !== 403) return false;
  try {
    const text = await resp.text();
    const parsed = JSON.parse(text) as {
      error?: {
        errors?: ReadonlyArray<{ reason?: string }>;
        status?: string;
        message?: string;
      };
    };
    const errors = parsed.error?.errors;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        if (e?.reason && RATE_LIMIT_REASONS.has(e.reason)) {
          return true;
        }
      }
    }
    if (parsed.error?.status === 'RESOURCE_EXHAUSTED') {
      return true;
    }
    if (
      typeof parsed.error?.message === 'string' &&
      /rate limit|quota exceeded/i.test(parsed.error.message)
    ) {
      return true;
    }
  } catch {
    // Non-JSON 403 body -> treat as auth error
  }
  return false;
}

/**
 * Google Drive REST v3 `CloudFileProvider` supporting both `appDataFolder` (`drive.appdata`)
 * and visible `MiniPod/minipod-sync.json` (`drive.file`) modes (ARCHITECTURE.md §8.2).
 *
 * Key guarantees:
 * - Uses `md5Checksum ?? id` consistently as the content ETag across probe/head/read/write.
 * - Self-heals duplicate sync files (and duplicate `MiniPod` folders in `drive-file` mode)
 *   safely: aborts with zero deletions on any download failure, `newerSchemaVersion`, or
 *   failed survivor PATCH; deletes only duplicates that were parsed and merged.
 * - Re-lists once per session (and every 24h) plus immediately after `POST` create so
 *   concurrently created first-time files converge rather than split-braining.
 * - Retries HTTP 401 **once** with `getToken({ forceRefresh: true })`, preserving transient
 *   network / rate-limit errors as retryable `'network'` instead of `'sync-auth'`.
 */
export class GoogleDriveProvider implements CloudFileProvider {
  readonly id: 'drive-appdata' | 'drive-file';
  readonly supportsNativeConditionalWrite = false;
  readonly supportsCheapHead = true;

  private readonly mode: 'appdata' | 'file';
  private readonly http: HttpClient;
  private readonly getToken: TokenProvider;
  private readonly folderName: string;
  private readonly fileName: string;
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly onFileIdChanged?: (fileId: string | null) => void;

  private cachedFileId: string | null;
  private cachedFolderId: string | null = null;
  private lastListedAt = 0;

  constructor(deps: GoogleDriveProviderDeps) {
    this.mode = deps.mode;
    this.id = deps.mode === 'appdata' ? 'drive-appdata' : 'drive-file';
    this.http = deps.http;
    this.getToken = deps.getToken;
    this.folderName = deps.folderName?.trim() || 'MiniPod';
    this.fileName =
      deps.fileName?.trim() || (deps.mode === 'appdata' ? SYNC_FILE_NAME : 'minipod-sync.json');
    this.apiBase = (deps.apiBaseUrl ?? DRIVE_API_BASE).replace(/\/+$/, '');
    this.uploadBase = (deps.uploadBaseUrl ?? DRIVE_UPLOAD_BASE).replace(/\/+$/, '');
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
    this.now = deps.now ?? Date.now;
    this.cachedFileId = deps.initialFileId ?? null;
    if (deps.onFileIdChanged !== undefined) {
      this.onFileIdChanged = deps.onFileIdChanged;
    }
  }

  getFileId(): string | null {
    return this.cachedFileId;
  }

  private setFileId(id: string | null): void {
    if (this.cachedFileId !== id) {
      this.cachedFileId = id;
      this.onFileIdChanged?.(id);
    }
  }

  private async authedRequest(
    req: Omit<HttpRequest, 'headers'> & { readonly headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      // Preserve transient `network` / `cancelled` / `unsupported` errors instead of relabelling `sync-auth` (SYNC-P1-14).
      if (err instanceof MiniPodError) throw err;
      throw MiniPodError.wrap(err, 'sync-auth');
    }

    const firstResp = await this.http({
      ...req,
      headers: {
        ...req.headers,
        Authorization: `Bearer ${token}`,
        'User-Agent': this.userAgent,
      },
    });

    if (firstResp.status !== 401) {
      return firstResp;
    }

    // Retry exactly once with `{ forceRefresh: true }`
    let refreshedToken: string;
    try {
      refreshedToken = await this.getToken({ forceRefresh: true });
    } catch (err) {
      if (err instanceof MiniPodError) throw err;
      throw MiniPodError.wrap(err, 'sync-auth');
    }

    return this.http({
      ...req,
      headers: {
        ...req.headers,
        Authorization: `Bearer ${refreshedToken}`,
        'User-Agent': this.userAgent,
      },
    });
  }

  private async throwForAuthOrNetwork(resp: HttpResponse, action: string): Promise<never> {
    if (resp.status === 401) {
      throw new MiniPodError('sync-auth', `Google Drive ${action} unauthorized (HTTP 401)`, {
        details: { status: 401 },
      });
    }
    if (resp.status === 403) {
      if (await isDriveRateLimit403(resp)) {
        throw new MiniPodError('network', `Google Drive ${action} rate-limited (HTTP 403)`, {
          details: { status: 403, rateLimited: true },
        });
      }
      throw new MiniPodError('sync-auth', `Google Drive ${action} forbidden (HTTP 403)`, {
        details: { status: 403 },
      });
    }
    throw new MiniPodError('network', `Google Drive ${action} failed (HTTP ${resp.status})`, {
      details: { status: resp.status },
    });
  }

  private async listVisibleFolders(signal?: AbortSignal): Promise<readonly DriveFileMeta[]> {
    const q = `name = '${escapeDriveQueryValue(this.folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const listUrl = `${this.apiBase}/files?spaces=drive&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}`;
    const resp = await this.authedRequest({
      url: listUrl,
      method: 'GET',
      ...(signal ? { signal } : {}),
    });

    if (resp.status < 200 || resp.status >= 300) {
      await this.throwForAuthOrNetwork(resp, 'folder list');
    }

    const listJson = JSON.parse(await resp.text()) as DriveFileListJson;
    return [...(listJson.files ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async ensureVisibleFolder(createIfMissing: boolean, signal?: AbortSignal): Promise<string | null> {
    if (this.mode === 'appdata') return 'appDataFolder';
    if (this.cachedFolderId) return this.cachedFolderId;

    const folders = await this.listVisibleFolders(signal);
    if (folders.length > 0) {
      this.cachedFolderId = folders[0]!.id;
      return this.cachedFolderId;
    }

    if (!createIfMissing) return null;

    const createResp = await this.authedRequest({
      url: `${this.apiBase}/files?fields=id`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        name: this.folderName,
        mimeType: FOLDER_MIME,
      }),
      ...(signal ? { signal } : {}),
    });

    if (createResp.status < 200 || createResp.status >= 300) {
      await this.throwForAuthOrNetwork(createResp, 'folder create');
    }

    const created = JSON.parse(await createResp.text()) as DriveFileMeta;
    this.cachedFolderId = created.id;
    return created.id;
  }

  private async locateFileMeta(signal?: AbortSignal, forceList: boolean = false): Promise<DriveFileMeta | null> {
    const nowMs = this.now();
    // Re-list at least once per session and every 24h (or when forced after POST create)
    // so concurrent first-time devices converge instead of remaining split-brained (SYNC-P1-09).
    const needListCheck =
      forceList ||
      !this.cachedFileId ||
      this.lastListedAt === 0 ||
      nowMs - this.lastListedAt >= LIST_REFRESH_INTERVAL_MS;

    if (!needListCheck && this.cachedFileId) {
      const getUrl = `${this.apiBase}/files/${encodeURIComponent(this.cachedFileId)}?fields=${encodeURIComponent('id,name,md5Checksum,modifiedTime,trashed')}`;
      const resp = await this.authedRequest({
        url: getUrl,
        method: 'GET',
        ...(signal ? { signal } : {}),
      });
      if (resp.status === 404) {
        this.setFileId(null);
      } else if (resp.status >= 200 && resp.status < 300) {
        const meta = JSON.parse(await resp.text()) as DriveFileMeta;
        if (!meta.trashed) {
          return meta;
        }
        this.setFileId(null);
      } else {
        await this.throwForAuthOrNetwork(resp, 'file metadata');
      }
    }

    let duplicateFolders: readonly DriveFileMeta[] = [];
    let parentClause: string;
    let canonicalFolderId: string | null = null;
    if (this.mode === 'appdata') {
      parentClause = "'appDataFolder' in parents";
    } else {
      const folders = await this.listVisibleFolders(signal);
      if (folders.length === 0) {
        this.cachedFolderId = null;
        this.setFileId(null);
        this.lastListedAt = nowMs;
        return null;
      }
      canonicalFolderId = folders[0]!.id;
      this.cachedFolderId = canonicalFolderId;
      duplicateFolders = folders.slice(1);
      if (folders.length === 1) {
        parentClause = `'${escapeDriveQueryValue(canonicalFolderId)}' in parents`;
      } else {
        const orClauses = folders.map((f) => `'${escapeDriveQueryValue(f.id)}' in parents`);
        parentClause = `(${orClauses.join(' or ')})`;
      }
    }

    const spaces = this.mode === 'appdata' ? 'appDataFolder' : 'drive';
    const q = `name = '${escapeDriveQueryValue(this.fileName)}' and ${parentClause} and trashed = false`;
    const listUrl = `${this.apiBase}/files?spaces=${spaces}&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,md5Checksum,modifiedTime,parents)')}`;

    const listResp = await this.authedRequest({
      url: listUrl,
      method: 'GET',
      ...(signal ? { signal } : {}),
    });

    if (listResp.status < 200 || listResp.status >= 300) {
      await this.throwForAuthOrNetwork(listResp, 'files.list');
    }

    const parsed = JSON.parse(await listResp.text()) as DriveFileListJson;
    const files = [...(parsed.files ?? [])].sort((a, b) => {
      // In drive-file mode with duplicate folders, prefer files inside the canonical (smallest id) folder
      if (canonicalFolderId !== null) {
        const aInCanon = a.parents?.includes(canonicalFolderId) ? 0 : 1;
        const bInCanon = b.parents?.includes(canonicalFolderId) ? 0 : 1;
        if (aInCanon !== bInCanon) return aInCanon - bInCanon;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    this.lastListedAt = nowMs;

    if (files.length === 0) {
      this.setFileId(null);
      return null;
    }

    if (files.length === 1) {
      const sole = files[0]!;
      this.setFileId(sole.id);
      return sole;
    }

    // Safe duplicate-file self-healing merge (SYNC-P1-02, SYNC-P1-09)
    const survivor = await this.healDuplicateFiles(files, signal);

    // Best-effort cleanup of now-empty duplicate `MiniPod` folders in `drive-file` mode
    if (duplicateFolders.length > 0) {
      const survivorParents = new Set(survivor.parents ?? []);
      for (const dupFolder of duplicateFolders) {
        if (survivorParents.has(dupFolder.id)) continue;
        // Only remove if no remaining non-trashed files reside in the duplicate folder
        try {
          const checkQ = `'${escapeDriveQueryValue(dupFolder.id)}' in parents and trashed = false`;
          const checkResp = await this.authedRequest({
            url: `${this.apiBase}/files?spaces=drive&q=${encodeURIComponent(checkQ)}&pageSize=1&fields=files(id)`,
            method: 'GET',
            ...(signal ? { signal } : {}),
          });
          if (checkResp.status >= 200 && checkResp.status < 300) {
            const checkJson = JSON.parse(await checkResp.text()) as DriveFileListJson;
            if ((checkJson.files ?? []).length === 0) {
              await this.authedRequest({
                url: `${this.apiBase}/files/${encodeURIComponent(dupFolder.id)}`,
                method: 'DELETE',
                ...(signal ? { signal } : {}),
              });
            }
          }
        } catch {
          // Best-effort folder cleanup
        }
      }
    }

    return survivor;
  }

  private async healDuplicateFiles(
    sortedFiles: readonly DriveFileMeta[],
    signal?: AbortSignal,
  ): Promise<DriveFileMeta> {
    const survivor = sortedFiles[0]!;

    const mergedEntries: Array<{ readonly meta: DriveFileMeta; readonly doc: SyncDocument }> = [];

    for (const f of sortedFiles) {
      const dlResp = await this.authedRequest({
        url: `${this.apiBase}/files/${encodeURIComponent(f.id)}?alt=media`,
        method: 'GET',
        ...(signal ? { signal } : {}),
      });
      if (dlResp.status === 404) {
        // Already deleted concurrently by another device
        continue;
      }
      if (dlResp.status < 200 || dlResp.status >= 300) {
        // Abort immediately with ZERO deletions if any duplicate fails to download (SYNC-P1-02)
        await this.throwForAuthOrNetwork(dlResp, 'duplicate file download');
      }
      const bytes = await dlResp.bytes();
      try {
        const doc = parseSyncDocument(bytes);
        mergedEntries.push({ meta: f, doc });
      } catch (err) {
        // NEVER swallow `newerSchemaVersion`: abort immediately with ZERO deletions (§9.3, SYNC-P1-02)
        if (err instanceof MiniPodError && err.details?.['newerSchemaVersion']) {
          throw err;
        }
        // Leave corrupt/unparseable duplicate untouched (do not add to deletable list)
      }
    }

    if (mergedEntries.length === 0) {
      this.setFileId(survivor.id);
      return survivor;
    }

    let merged = mergedEntries[0]!.doc;
    for (let i = 1; i < mergedEntries.length; i++) {
      merged = mergeSyncDocuments(merged, mergedEntries[i]!.doc);
    }
    const mergedBytes = serializeSyncDocument(merged);
    const updateResp = await this.authedRequest({
      url: `${this.uploadBase}/files/${encodeURIComponent(survivor.id)}?uploadType=media&fields=${encodeURIComponent('id,md5Checksum,modifiedTime,parents')}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: mergedBytes,
      ...(signal ? { signal } : {}),
    });

    if (updateResp.status < 200 || updateResp.status >= 300) {
      // Abort with ZERO deletions if survivor PATCH did not succeed (SYNC-P1-02)
      await this.throwForAuthOrNetwork(updateResp, 'duplicate merge update');
    }

    const mergedMeta = JSON.parse(await updateResp.text()) as DriveFileMeta;

    // Delete ONLY duplicates whose contents were successfully parsed and merged into survivor
    for (const entry of mergedEntries) {
      if (entry.meta.id === survivor.id) continue;
      await this.authedRequest({
        url: `${this.apiBase}/files/${encodeURIComponent(entry.meta.id)}`,
        method: 'DELETE',
        ...(signal ? { signal } : {}),
      }).catch(() => undefined);
    }

    this.setFileId(survivor.id);
    return mergedMeta;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const meta = await this.locateFileMeta(signal);
      if (!meta) {
        return { ok: true, exists: false, etag: null };
      }
      return { ok: true, exists: true, etag: meta.md5Checksum ?? meta.id };
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
    const meta = await this.locateFileMeta(signal);
    return meta ? (meta.md5Checksum ?? meta.id) : null;
  }

  async read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult> {
    const meta = await this.locateFileMeta(signal);
    if (!meta) {
      return { kind: 'missing' };
    }
    // Keep ETag fallback consistent across `head()`, `read()`, and `write()` (SYNC-P1-14)
    const etag = meta.md5Checksum ?? meta.id;
    if (ifNoneMatch !== null && etag === ifNoneMatch) {
      return { kind: 'not-modified' };
    }

    const dlResp = await this.authedRequest({
      url: `${this.apiBase}/files/${encodeURIComponent(meta.id)}?alt=media`,
      method: 'GET',
      ...(signal ? { signal } : {}),
    });

    if (dlResp.status === 404) {
      this.setFileId(null);
      return { kind: 'missing' };
    }
    if (dlResp.status < 200 || dlResp.status >= 300) {
      await this.throwForAuthOrNetwork(dlResp, 'file download');
    }

    const bytes = await dlResp.bytes();
    const modMs = meta.modifiedTime ? Date.parse(meta.modifiedTime) : Number.NaN;
    return {
      kind: 'blob',
      bytes,
      etag,
      ...(Number.isFinite(modMs) ? { lastModified: modMs } : {}),
    };
  }

  async write(bytes: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<WriteResult> {
    try {
      // Pre-write `head()` conflict check before transferring bytes
      const existingMeta = await this.locateFileMeta(signal);
      const currentEtag = existingMeta ? (existingMeta.md5Checksum ?? existingMeta.id) : null;

      if (ifMatch === null) {
        if (currentEtag !== null) {
          return { kind: 'conflict' };
        }
      } else if (currentEtag !== ifMatch) {
        return { kind: 'conflict' };
      }

      if (!existingMeta) {
        const parentId = await this.ensureVisibleFolder(true, signal);
        const metadataJson = JSON.stringify({
          name: this.fileName,
          mimeType: 'application/json',
          parents: [parentId ?? 'appDataFolder'],
        });

        const boundary = randomMultipartBoundary();
        const enc = new TextEncoder();
        const prefix = enc.encode(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
        );
        const suffix = enc.encode(`\r\n--${boundary}--`);
        const multipartBody = concatBytes([prefix, bytes, suffix]);

        const createResp = await this.authedRequest({
          url: `${this.uploadBase}/files?uploadType=multipart&fields=${encodeURIComponent('id,md5Checksum')}`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
          ...(signal ? { signal } : {}),
        });

        if (createResp.status === 401) {
          return {
            kind: 'failed',
            cause: new MiniPodError('sync-auth', 'Google Drive create unauthorized (HTTP 401)'),
            retryable: false,
          };
        }
        if (createResp.status === 403) {
          const rateLimited = await isDriveRateLimit403(createResp);
          return {
            kind: 'failed',
            cause: new MiniPodError(
              rateLimited ? 'network' : 'sync-auth',
              rateLimited
                ? 'Google Drive create rate-limited (HTTP 403)'
                : 'Google Drive create forbidden (HTTP 403)',
            ),
            retryable: rateLimited,
          };
        }
        if (createResp.status < 200 || createResp.status >= 300) {
          return {
            kind: 'failed',
            cause: new MiniPodError('network', `Google Drive create failed (HTTP ${createResp.status})`),
            retryable: createResp.status >= 500 || createResp.status === 429,
          };
        }

        const created = JSON.parse(await createResp.text()) as DriveFileMeta;
        this.setFileId(created.id);

        // Immediately re-list to detect & heal concurrent first-time creations (SYNC-P1-09)
        try {
          const verified = await this.locateFileMeta(signal, true);
          if (verified) {
            return { kind: 'ok', newEtag: verified.md5Checksum ?? verified.id };
          }
        } catch {
          // Create itself succeeded; duplicate healing will retry on the next read
        }

        return { kind: 'ok', newEtag: created.md5Checksum ?? created.id };
      }

      const updateResp = await this.authedRequest({
        url: `${this.uploadBase}/files/${encodeURIComponent(existingMeta.id)}?uploadType=media&fields=${encodeURIComponent('id,md5Checksum')}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: bytes,
        ...(signal ? { signal } : {}),
      });

      if (updateResp.status === 404) {
        this.setFileId(null);
        return { kind: 'conflict' };
      }
      if (updateResp.status === 401) {
        return {
          kind: 'failed',
          cause: new MiniPodError('sync-auth', 'Google Drive update unauthorized (HTTP 401)'),
          retryable: false,
        };
      }
      if (updateResp.status === 403) {
        const rateLimited = await isDriveRateLimit403(updateResp);
        return {
          kind: 'failed',
          cause: new MiniPodError(
            rateLimited ? 'network' : 'sync-auth',
            rateLimited
              ? 'Google Drive update rate-limited (HTTP 403)'
              : 'Google Drive update forbidden (HTTP 403)',
          ),
          retryable: rateLimited,
        };
      }
      if (updateResp.status < 200 || updateResp.status >= 300) {
        return {
          kind: 'failed',
          cause: new MiniPodError('network', `Google Drive update failed (HTTP ${updateResp.status})`),
          retryable: updateResp.status >= 500 || updateResp.status === 429,
        };
      }

      const updated = JSON.parse(await updateResp.text()) as DriveFileMeta;
      return { kind: 'ok', newEtag: updated.md5Checksum ?? updated.id };
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      return {
        kind: 'failed',
        cause: wrapped,
        retryable:
          wrapped.code !== 'sync-auth' &&
          wrapped.code !== 'sync-schema' &&
          wrapped.code !== 'cancelled',
      };
    }
  }

  /** Deletes the remote sync file (implements `SyncApi.resetRemote()` for Drive). */
  async deleteRemote(signal?: AbortSignal): Promise<void> {
    const meta = await this.locateFileMeta(signal);
    if (!meta) return;
    const resp = await this.authedRequest({
      url: `${this.apiBase}/files/${encodeURIComponent(meta.id)}`,
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
    if (resp.status !== 404 && (resp.status < 200 || resp.status >= 300)) {
      await this.throwForAuthOrNetwork(resp, 'delete');
    }
    this.setFileId(null);
  }
}

export function createGoogleDriveProvider(deps: GoogleDriveProviderDeps): GoogleDriveProvider {
  return new GoogleDriveProvider(deps);
}
