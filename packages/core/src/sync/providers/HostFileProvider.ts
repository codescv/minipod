import { MiniPodError } from '../../errors';
import type {
  CloudFileProvider,
  HostFileAccess,
  ProbeResult,
  ReadResult,
  Unsubscribe,
  WriteResult,
} from '../../types';

export interface HostFileProviderDeps {
  readonly id: 'local-folder' | 'saf';
  readonly access: HostFileAccess;
}

function syntheticEtag(stat: { readonly size: number; readonly mtimeMs: number }): string {
  return `${Math.trunc(stat.mtimeMs)}-${Math.trunc(stat.size)}`;
}

function isNonRetryableFsError(err: unknown): boolean {
  if (err instanceof MiniPodError) {
    return err.code === 'sync-auth' || err.code === 'not-found' || err.code === 'invalid-argument';
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' || code === 'ENOTDIR') {
      return true;
    }
    const name = (err as { name?: unknown }).name;
    if (name === 'SecurityException' || name === 'NotAllowedError') {
      return true;
    }
    const msg = String((err as { message?: unknown }).message ?? '');
    if (/SecurityException|permission|ENOENT|EACCES|EPERM/i.test(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Core `CloudFileProvider` backed by a host-supplied `HostFileAccess` primitive
 * (desktop `node:fs` synced folder file, or Android SAF `content://` document URI).
 *
 * Uses synthetic etag `"${mtimeMs}-${size}"`, performs emulated pre-write `head()`
 * conflict detection BEFORE writing bytes, and filters out self-writes in `watch()`.
 */
export class HostFileProvider implements CloudFileProvider {
  readonly id: 'local-folder' | 'saf';
  readonly supportsNativeConditionalWrite = false;
  readonly supportsCheapHead = true;

  private readonly access: HostFileAccess;
  private writeInProgress = false;
  private lastWrittenEtag: string | null = null;

  constructor(deps: HostFileProviderDeps) {
    this.id = deps.id;
    this.access = deps.access;
    if (deps.access.watch) {
      this.watch = (onChange: () => void): Unsubscribe => {
        return this.access.watch!(() => {
          if (this.writeInProgress) return;
          void this.access
            .stat()
            .then((st) => {
              if (this.writeInProgress) return;
              const etag = st ? syntheticEtag(st) : null;
              if (etag !== null && etag === this.lastWrittenEtag) {
                return;
              }
              onChange();
            })
            .catch(() => {
              onChange();
            });
        });
      };
    }
  }

  watch?: (onChange: () => void) => Unsubscribe;

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    if (signal?.aborted) {
      return {
        ok: false,
        exists: false,
        etag: null,
        error: new MiniPodError('cancelled', 'Probe cancelled').toShape(),
      };
    }
    try {
      const st = await this.access.stat();
      if (!st) {
        return { ok: true, exists: false, etag: null };
      }
      return { ok: true, exists: true, etag: syntheticEtag(st) };
    } catch (err) {
      const code = isNonRetryableFsError(err) ? 'sync-auth' : 'network';
      return {
        ok: false,
        exists: false,
        etag: null,
        error: MiniPodError.wrap(err, code).toShape(),
      };
    }
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) throw new MiniPodError('cancelled', 'Head cancelled');
    const st = await this.access.stat();
    return st ? syntheticEtag(st) : null;
  }

  async read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult> {
    if (signal?.aborted) throw new MiniPodError('cancelled', 'Read cancelled');
    try {
      const st = await this.access.stat();
      if (!st) {
        return { kind: 'missing' };
      }
      const etag = syntheticEtag(st);
      if (ifNoneMatch !== null && etag === ifNoneMatch) {
        return { kind: 'not-modified' };
      }
      const bytes = await this.access.read();
      const postSt = await this.access.stat();
      const finalEtag = postSt ? syntheticEtag(postSt) : etag;
      return {
        kind: 'blob',
        bytes,
        etag: finalEtag,
        lastModified: postSt ? postSt.mtimeMs : st.mtimeMs,
      };
    } catch (err) {
      if (err instanceof MiniPodError) throw err;
      throw MiniPodError.wrap(err, isNonRetryableFsError(err) ? 'sync-auth' : 'network');
    }
  }

  async write(bytes: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<WriteResult> {
    if (signal?.aborted) {
      return { kind: 'failed', cause: new MiniPodError('cancelled', 'Write cancelled'), retryable: false };
    }

    try {
      const currentEtag = await this.head(signal);
      if (ifMatch === null) {
        if (currentEtag !== null) {
          return { kind: 'conflict' };
        }
      } else if (currentEtag !== ifMatch) {
        return { kind: 'conflict' };
      }

      this.writeInProgress = true;
      try {
        await this.access.write(bytes);
        const postStat = await this.access.stat();
        const newEtag = postStat ? syntheticEtag(postStat) : null;
        this.lastWrittenEtag = newEtag;
        return { kind: 'ok', newEtag };
      } finally {
        this.writeInProgress = false;
      }
    } catch (err) {
      return {
        kind: 'failed',
        cause: err,
        retryable: !isNonRetryableFsError(err),
      };
    }
  }
}

export function createHostFileProvider(deps: HostFileProviderDeps): CloudFileProvider {
  return new HostFileProvider(deps);
}
