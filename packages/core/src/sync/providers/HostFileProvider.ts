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

function isBlankBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  let start = 0;
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    start = 3;
  }
  for (let i = start; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x00) {
      return false;
    }
  }
  return true;
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
      if (st.size > 0 && ifNoneMatch !== null && etag === ifNoneMatch) {
        return { kind: 'not-modified' };
      }
      const bytes = await this.access.read();
      if (isBlankBytes(bytes)) {
        return { kind: 'missing' };
      }
      const postSt = await this.access.stat();
      const effectivePostSt = postSt
        ? {
            size: postSt.size > 0 ? postSt.size : bytes.byteLength,
            mtimeMs: postSt.mtimeMs > 0 ? postSt.mtimeMs : st.mtimeMs,
          }
        : { size: bytes.byteLength, mtimeMs: st.mtimeMs };
      const finalEtag = syntheticEtag(effectivePostSt);
      return {
        kind: 'blob',
        bytes,
        etag: finalEtag,
        lastModified: effectivePostSt.mtimeMs,
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
      const preStat = await this.access.stat();
      const currentEtag = preStat ? syntheticEtag(preStat) : null;
      if (ifMatch === null) {
        if (preStat !== null) {
          const isBlankExisting =
            preStat.size === 0 || isBlankBytes(await this.access.read());
          if (!isBlankExisting) {
            return { kind: 'conflict' };
          }
        }
      } else if (currentEtag !== ifMatch) {
        const isBlankExisting =
          preStat !== null &&
          preStat.size === 0 &&
          isBlankBytes(await this.access.read());
        if (!isBlankExisting) {
          return { kind: 'conflict' };
        }
      }

      this.writeInProgress = true;
      try {
        await this.access.write(bytes);
        const postStat = await this.access.stat();
        const effectiveStat = postStat
          ? {
              size: postStat.size > 0 ? postStat.size : bytes.byteLength,
              mtimeMs: postStat.mtimeMs > 0 ? postStat.mtimeMs : (preStat?.mtimeMs || Date.now()),
            }
          : { size: bytes.byteLength, mtimeMs: Date.now() };
        const newEtag = syntheticEtag(effectiveStat);
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
