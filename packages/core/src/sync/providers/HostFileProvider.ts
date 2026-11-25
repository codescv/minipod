import { MiniPodError } from '../../errors';
import type {
  CloudFileProvider,
  HostFileAccess,
  ProbeResult,
  ReadResult,
  Unsubscribe,
  WriteResult,
} from '../../types';
import { sha1HexSync } from '../../util/sha1';

const RACY_WINDOW_MS = 2_000;
const MAX_READ_CONSISTENCY_ATTEMPTS = 3;

export interface HostFileProviderDeps {
  readonly id: 'local-folder' | 'saf';
  readonly access: HostFileAccess;
  readonly now?: () => number;
}

type ParsedEtag =
  | { readonly kind: 'strong'; readonly mtimeMs: number; readonly size: number; readonly hash: string }
  | { readonly kind: 'racy'; readonly hash: string }
  | { readonly kind: 'legacy'; readonly raw: string };

function legacySyntheticEtag(stat: { readonly size: number; readonly mtimeMs: number }): string {
  return `${Math.trunc(stat.mtimeMs)}-${Math.trunc(stat.size)}`;
}

function contentHash16(bytes: Uint8Array): string {
  return sha1HexSync(bytes).slice(0, 16);
}

/**
 * Builds a racy-git-safe `v2` ETag at ETag-recording time (`read()` / `write()`).
 * Only emits a stat-skippable `v2:<mtime>:<size>:<hash>` when `mtimeMs > 0`, `size > 0`,
 * and `recordNow - mtimeMs >= 2000ms`; otherwise emits `v2:racy:<hash>` so `read()` and
 * `write()` verify actual content hash instead of trusting coarse/zero stat metadata (SYNC-P1-01).
 */
function buildV2Etag(
  stat: { readonly size: number; readonly mtimeMs: number },
  hash16: string,
  recordNow: number,
): string {
  const mtime = Math.trunc(stat.mtimeMs);
  const size = Math.trunc(stat.size);
  if (mtime > 0 && size > 0 && recordNow - mtime >= RACY_WINDOW_MS) {
    return `v2:${mtime}:${size}:${hash16}`;
  }
  return `v2:racy:${hash16}`;
}

function parseEtag(etag: string): ParsedEtag {
  const strong = /^v2:(\d+):(\d+):([0-9a-f]{16})$/.exec(etag);
  if (strong) {
    return {
      kind: 'strong',
      mtimeMs: Number(strong[1]),
      size: Number(strong[2]),
      hash: strong[3]!,
    };
  }
  const racy = /^v2:racy:([0-9a-f]{16})$/.exec(etag);
  if (racy) {
    return { kind: 'racy', hash: racy[1]! };
  }
  return { kind: 'legacy', raw: etag };
}

function statsMatch(
  a: { readonly size: number; readonly mtimeMs: number },
  b: { readonly size: number; readonly mtimeMs: number },
): boolean {
  return Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs) && Math.trunc(a.size) === Math.trunc(b.size);
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

/**
 * Classifies persistent permission/configuration errors as non-retryable (`sync-auth`),
 * while treating transient filesystem states (`ENOENT` on unmounted drives, Windows `EPERM`/`EBUSY`)
 * as retryable (`network`) (SYNC-P2-08).
 */
function isNonRetryableFsError(err: unknown): boolean {
  if (err instanceof MiniPodError) {
    return err.code === 'sync-auth' || err.code === 'invalid-argument';
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (code === 'EACCES' || code === 'ENOTDIR') {
      return true;
    }
    const name = (err as { name?: unknown }).name;
    if (name === 'SecurityException' || name === 'NotAllowedError') {
      return true;
    }
    const msg = String((err as { message?: unknown }).message ?? '');
    if (/SecurityException|NotAllowedError|EACCES|permission denied/i.test(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Core `CloudFileProvider` backed by a host-supplied `HostFileAccess` primitive
 * (desktop `node:fs` synced folder file, or Android SAF `content://` document URI).
 *
 * Uses racy-git + SHA-1 content-hash `v2` ETags, retries torn reads when pre/post stat
 * diverges, performs content-hash fallback on racy/SAF-zero-stat writes, and filters out
 * self-writes in `watch()`.
 */
export class HostFileProvider implements CloudFileProvider {
  readonly id: 'local-folder' | 'saf';
  readonly supportsNativeConditionalWrite = false;
  readonly supportsCheapHead = true;

  private readonly access: HostFileAccess;
  private readonly now: () => number;
  private writeInProgress = false;
  private lastWrittenHash: string | null = null;
  private lastWrittenStat: { readonly mtimeMs: number; readonly size: number } | null = null;

  constructor(deps: HostFileProviderDeps) {
    this.id = deps.id;
    this.access = deps.access;
    this.now = deps.now ?? Date.now;
    if (deps.access.watch) {
      this.watch = (onChange: () => void): Unsubscribe => {
        return this.access.watch!(() => {
          if (this.writeInProgress) return;
          void this.access
            .stat()
            .then(async (st) => {
              if (this.writeInProgress) return;
              if (
                st &&
                this.lastWrittenStat &&
                st.mtimeMs > 0 &&
                st.size > 0 &&
                statsMatch(st, this.lastWrittenStat)
              ) {
                if (this.lastWrittenHash !== null) {
                  try {
                    const bytes = await this.access.read();
                    if (contentHash16(bytes) === this.lastWrittenHash) {
                      return;
                    }
                  } catch {
                    // Fall through and notify
                  }
                } else {
                  return;
                }
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
      return { ok: true, exists: true, etag: legacySyntheticEtag(st) };
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
    return st ? legacySyntheticEtag(st) : null;
  }

  async read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult> {
    if (signal?.aborted) throw new MiniPodError('cancelled', 'Read cancelled');
    try {
      const parsedIfNoneMatch = ifNoneMatch !== null ? parseEtag(ifNoneMatch) : null;
      const initialSt = await this.access.stat();
      if (!initialSt) {
        return { kind: 'missing' };
      }

      // Fast-path stat-only 304 ONLY for non-racy `v2:<m>:<s>:<h>` with valid positive stat
      if (
        parsedIfNoneMatch?.kind === 'strong' &&
        initialSt.mtimeMs > 0 &&
        initialSt.size > 0 &&
        Math.trunc(initialSt.mtimeMs) === parsedIfNoneMatch.mtimeMs &&
        Math.trunc(initialSt.size) === parsedIfNoneMatch.size
      ) {
        return { kind: 'not-modified' };
      }

      // Read bytes with pre/post stat consistency check to prevent torn (bytes, etag) pairs (SYNC-P1-01)
      let bytes: Uint8Array = new Uint8Array(0);
      let effectiveSt: { readonly size: number; readonly mtimeMs: number } = initialSt;

      for (let attempt = 0; attempt < MAX_READ_CONSISTENCY_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw new MiniPodError('cancelled', 'Read cancelled');
        const preSt = attempt === 0 ? initialSt : await this.access.stat();
        if (!preSt) {
          return { kind: 'missing' };
        }
        bytes = await this.access.read();
        const postSt = await this.access.stat();

        const hasMeaningfulStat =
          preSt.mtimeMs > 0 ||
          preSt.size > 0 ||
          (postSt !== null && (postSt.mtimeMs > 0 || postSt.size > 0));
        if (
          postSt !== null &&
          hasMeaningfulStat &&
          !statsMatch(preSt, postSt) &&
          attempt + 1 < MAX_READ_CONSISTENCY_ATTEMPTS
        ) {
          continue;
        }

        effectiveSt = postSt
          ? {
              size: postSt.size > 0 ? postSt.size : bytes.byteLength,
              mtimeMs: postSt.mtimeMs > 0 ? postSt.mtimeMs : preSt.mtimeMs,
            }
          : { size: bytes.byteLength, mtimeMs: preSt.mtimeMs };
        break;
      }

      if (isBlankBytes(bytes)) {
        return { kind: 'missing' };
      }

      const hash = contentHash16(bytes);
      if (
        parsedIfNoneMatch !== null &&
        (parsedIfNoneMatch.kind === 'strong' || parsedIfNoneMatch.kind === 'racy') &&
        parsedIfNoneMatch.hash === hash
      ) {
        return { kind: 'not-modified' };
      }

      const finalEtag = buildV2Etag(effectiveSt, hash, this.now());
      return {
        kind: 'blob',
        bytes,
        etag: finalEtag,
        lastModified: effectiveSt.mtimeMs,
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
      if (ifMatch === null) {
        if (preStat !== null) {
          // Never trust `preStat.size === 0` alone (SAF may report size 0 for non-empty docs).
          const existingBytes = await this.access.read();
          if (!isBlankBytes(existingBytes)) {
            return { kind: 'conflict' };
          }
        }
      } else {
        if (preStat === null) {
          return { kind: 'conflict' };
        }
        const parsedIfMatch = parseEtag(ifMatch);
        const strongStatMatches =
          parsedIfMatch.kind === 'strong' &&
          preStat.mtimeMs > 0 &&
          preStat.size > 0 &&
          Math.trunc(preStat.mtimeMs) === parsedIfMatch.mtimeMs &&
          Math.trunc(preStat.size) === parsedIfMatch.size;

        if (!strongStatMatches) {
          const existingBytes = await this.access.read();
          if (!isBlankBytes(existingBytes)) {
            if (parsedIfMatch.kind === 'strong' || parsedIfMatch.kind === 'racy') {
              if (contentHash16(existingBytes) !== parsedIfMatch.hash) {
                return { kind: 'conflict' };
              }
            } else if (legacySyntheticEtag(preStat) !== ifMatch) {
              return { kind: 'conflict' };
            }
          }
        }
      }

      this.writeInProgress = true;
      try {
        await this.access.write(bytes);
        const postStat = await this.access.stat();
        const effectiveStat = postStat
          ? {
              size: postStat.size > 0 ? postStat.size : bytes.byteLength,
              mtimeMs: postStat.mtimeMs > 0 ? postStat.mtimeMs : 0,
            }
          : { size: bytes.byteLength, mtimeMs: 0 };
        const hash = contentHash16(bytes);
        const newEtag = buildV2Etag(effectiveStat, hash, this.now());
        this.lastWrittenHash = hash;
        this.lastWrittenStat = postStat
          ? { mtimeMs: Math.trunc(postStat.mtimeMs), size: Math.trunc(postStat.size) }
          : null;
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
