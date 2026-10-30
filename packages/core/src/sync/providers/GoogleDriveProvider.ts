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
import { mergeSyncDocuments } from '../merge';
import { parseSyncDocument, serializeSyncDocument } from '../schema';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

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
}

interface DriveFileMeta {
  readonly id: string;
  readonly name?: string;
  readonly md5Checksum?: string;
  readonly modifiedTime?: string;
  readonly trashed?: boolean;
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

/**
 * Google Drive REST v3 `CloudFileProvider` supporting both `appDataFolder` (`drive.appdata`)
 * and visible `MiniPod/minipod-sync.json` (`drive.file`) modes (ARCHITECTURE.md §8.2).
 *
 * Key guarantees:
 * - Uses `md5Checksum` as the content ETag (never Drive's account-wide `version`).
 * - Self-heals duplicate sync files created by concurrent first-time devices: downloads all,
 *   merges all via CRDT `mergeSyncDocuments`, writes to the lexicographically smallest `fileId`,
 *   and deletes the duplicates.
 * - Retries HTTP 401 **once** with `getToken({ forceRefresh: true })` before reporting `sync-auth`.
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
  private readonly onFileIdChanged?: (fileId: string | null) => void;

  private cachedFileId: string | null;
  private cachedFolderId: string | null = null;

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

  private throwForAuthOrNetwork(resp: HttpResponse, action: string): never {
    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('sync-auth', `Google Drive ${action} unauthorized (HTTP ${resp.status})`, {
        details: { status: resp.status },
      });
    }
    throw new MiniPodError('network', `Google Drive ${action} failed (HTTP ${resp.status})`, {
      details: { status: resp.status },
    });
  }

  private async ensureVisibleFolder(createIfMissing: boolean, signal?: AbortSignal): Promise<string | null> {
    if (this.mode === 'appdata') return 'appDataFolder';
    if (this.cachedFolderId) return this.cachedFolderId;

    const q = `name = '${escapeDriveQueryValue(this.folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const listUrl = `${this.apiBase}/files?spaces=drive&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}`;
    const resp = await this.authedRequest({
      url: listUrl,
      method: 'GET',
      ...(signal ? { signal } : {}),
    });

    if (resp.status < 200 || resp.status >= 300) {
      this.throwForAuthOrNetwork(resp, 'folder list');
    }

    const listJson = JSON.parse(await resp.text()) as DriveFileListJson;
    const folders = [...(listJson.files ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      this.throwForAuthOrNetwork(createResp, 'folder create');
    }

    const created = JSON.parse(await createResp.text()) as DriveFileMeta;
    this.cachedFolderId = created.id;
    return created.id;
  }

  private async locateFileMeta(signal?: AbortSignal): Promise<DriveFileMeta | null> {
    // Always list when no cachedFileId, or verify cachedFileId AND check if duplicates exist when bootstrapping
    if (this.cachedFileId) {
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
        this.throwForAuthOrNetwork(resp, 'file metadata');
      }
    }

    const parentFolder = await this.ensureVisibleFolder(false, signal);
    if (this.mode === 'file' && !parentFolder) {
      return null;
    }

    const spaces = this.mode === 'appdata' ? 'appDataFolder' : 'drive';
    const parentClause =
      this.mode === 'appdata'
        ? "'appDataFolder' in parents"
        : `'${escapeDriveQueryValue(parentFolder!)}' in parents`;
    const q = `name = '${escapeDriveQueryValue(this.fileName)}' and ${parentClause} and trashed = false`;
    const listUrl = `${this.apiBase}/files?spaces=${spaces}&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,md5Checksum,modifiedTime)')}`;

    const listResp = await this.authedRequest({
      url: listUrl,
      method: 'GET',
      ...(signal ? { signal } : {}),
    });

    if (listResp.status < 200 || listResp.status >= 300) {
      this.throwForAuthOrNetwork(listResp, 'files.list');
    }

    const parsed = JSON.parse(await listResp.text()) as DriveFileListJson;
    const files = [...(parsed.files ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (files.length === 0) {
      this.setFileId(null);
      return null;
    }

    if (files.length === 1) {
      const sole = files[0]!;
      this.setFileId(sole.id);
      return sole;
    }

    // Duplicate-file self-healing merge (ARCHITECTURE.md §8.2)
    return this.healDuplicateFiles(files, signal);
  }

  private async healDuplicateFiles(
    sortedFiles: readonly DriveFileMeta[],
    signal?: AbortSignal,
  ): Promise<DriveFileMeta> {
    const survivor = sortedFiles[0]!;
    const duplicates = sortedFiles.slice(1);

    const parsedDocs: SyncDocument[] = [];
    let fallbackBytes: Uint8Array | undefined;

    for (const f of sortedFiles) {
      const dlResp = await this.authedRequest({
        url: `${this.apiBase}/files/${encodeURIComponent(f.id)}?alt=media`,
        method: 'GET',
        ...(signal ? { signal } : {}),
      });
      if (dlResp.status >= 200 && dlResp.status < 300) {
        const bytes = await dlResp.bytes();
        if (!fallbackBytes) fallbackBytes = bytes;
        try {
          parsedDocs.push(parseSyncDocument(bytes));
        } catch {
          // Ignore corrupt duplicate if valid ones exist
        }
      }
    }

    let mergedMeta: DriveFileMeta = survivor;
    if (parsedDocs.length > 0) {
      let merged = parsedDocs[0]!;
      for (let i = 1; i < parsedDocs.length; i++) {
        merged = mergeSyncDocuments(merged, parsedDocs[i]!);
      }
      const mergedBytes = serializeSyncDocument(merged);
      const updateResp = await this.authedRequest({
        url: `${this.uploadBase}/files/${encodeURIComponent(survivor.id)}?uploadType=media&fields=${encodeURIComponent('id,md5Checksum,modifiedTime')}`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: mergedBytes,
        ...(signal ? { signal } : {}),
      });
      if (updateResp.status >= 200 && updateResp.status < 300) {
        mergedMeta = JSON.parse(await updateResp.text()) as DriveFileMeta;
      }
    }

    for (const dup of duplicates) {
      await this.authedRequest({
        url: `${this.apiBase}/files/${encodeURIComponent(dup.id)}`,
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
      return { ok: true, exists: true, etag: meta.md5Checksum ?? null };
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
    const etag = meta.md5Checksum ?? null;
    if (ifNoneMatch !== null && etag !== null && etag === ifNoneMatch) {
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
      this.throwForAuthOrNetwork(dlResp, 'file download');
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

        const boundary = 'minipod_drive_multipart_boundary_v1';
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

        if (createResp.status === 401 || createResp.status === 403) {
          return {
            kind: 'failed',
            cause: new MiniPodError('sync-auth', `Google Drive create unauthorized (HTTP ${createResp.status})`),
            retryable: false,
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
      if (updateResp.status === 401 || updateResp.status === 403) {
        return {
          kind: 'failed',
          cause: new MiniPodError('sync-auth', `Google Drive update unauthorized (HTTP ${updateResp.status})`),
          retryable: false,
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
        retryable: wrapped.code !== 'sync-auth' && wrapped.code !== 'cancelled',
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
      this.throwForAuthOrNetwork(resp, 'delete');
    }
    this.setFileId(null);
  }
}

export function createGoogleDriveProvider(deps: GoogleDriveProviderDeps): GoogleDriveProvider {
  return new GoogleDriveProvider(deps);
}
