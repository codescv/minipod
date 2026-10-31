/**
 * Android SAF (`content://` document URI) `CloudFileProvider` (`ARCHITECTURE.md §8.2`, `§9.3`).
 *
 * Wraps `@minipod/core`'s `HostFileProvider` (`id: 'saf'`) over `MiniPodPlugin.saf`:
 *   - `stat()` -> `DocumentsContract` `COLUMN_LAST_MODIFIED` + `COLUMN_SIZE`
 *   - `read()` -> `ContentResolver.openInputStream(uri)`
 *   - `write()` -> `openFileDescriptor(uri, "rw")` + write from offset 0 + `truncate(size)` + `fsync`
 *   - `watch()` -> 60 s `stat()` poll while `isVisible()` is true, ignoring our own writes
 *   - Revoked SAF permissions (`SecurityException`) map to non-retryable `sync-auth` errors.
 */
import {
  decodeBase64,
  encodeBase64,
  HostFileProvider,
  MiniPodError,
  type CloudFileProvider,
  type HostFileAccess,
  type Unsubscribe,
} from '@minipod/core';
import type { MiniPodPlugin } from '../plugin-types';

const DEFAULT_SAF_POLL_MS = 60_000;

export interface SafFileProviderOptions {
  readonly documentUri: string;
  readonly plugin: Pick<MiniPodPlugin, 'saf'>;
  readonly isVisible?: () => boolean;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => Unsubscribe;
}

function mapSafError(err: unknown, uri: string): MiniPodError {
  if (err instanceof MiniPodError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/SecurityException|permission|persistable|ENOENT|FileNotFoundException/i.test(msg)) {
    return new MiniPodError(
      'sync-auth',
      `SAF document permission lost or file missing (${uri}): ${msg}`,
      { cause: err },
    );
  }
  return new MiniPodError('network', msg || 'SAF operation failed', { cause: err });
}

function syntheticEtag(mtimeMs: number, size: number): string {
  return `${Math.trunc(mtimeMs)}-${Math.trunc(size)}`;
}

export function createSafFileProvider(options: SafFileProviderOptions): CloudFileProvider {
  const { documentUri, plugin } = options;
  const isVisible =
    options.isVisible ??
    (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  const pollMs = options.pollIntervalMs ?? DEFAULT_SAF_POLL_MS;
  const scheduleInterval: (fn: () => void, ms: number) => Unsubscribe =
    options.setIntervalFn ??
    ((fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });

  let writing = false;
  let lastKnownEtag: string | null = null;
  let lastWrittenEtag: string | null = null;

  const access: HostFileAccess = {
    async stat() {
      try {
        const res = await plugin.saf.stat({ uri: documentUri });
        if (!res.exists) return null;
        const size = res.size ?? 0;
        const mtimeMs = res.mtimeMs ?? 0;
        lastKnownEtag = syntheticEtag(mtimeMs, size);
        return { size, mtimeMs };
      } catch (err) {
        throw mapSafError(err, documentUri);
      }
    },

    async read(): Promise<Uint8Array> {
      try {
        const res = await plugin.saf.read({ uri: documentUri });
        return decodeBase64(res.base64);
      } catch (err) {
        throw mapSafError(err, documentUri);
      }
    },

    async write(bytes: Uint8Array): Promise<void> {
      writing = true;
      try {
        await plugin.saf.write({
          uri: documentUri,
          base64: encodeBase64(bytes),
        });
        const postStat = await plugin.saf.stat({ uri: documentUri });
        if (postStat.exists) {
          const effectiveSize =
            postStat.size && postStat.size > 0 ? postStat.size : bytes.byteLength;
          const effectiveMtime =
            postStat.mtimeMs && postStat.mtimeMs > 0 ? postStat.mtimeMs : Date.now();
          const etag = syntheticEtag(effectiveMtime, effectiveSize);
          lastWrittenEtag = etag;
          lastKnownEtag = etag;
        }
      } catch (err) {
        throw mapSafError(err, documentUri);
      } finally {
        writing = false;
      }
    },

    watch(onChange: () => void): Unsubscribe {
      return scheduleInterval(() => {
        if (writing || !isVisible()) return;
        void plugin.saf
          .stat({ uri: documentUri })
          .then((res) => {
            if (!res.exists || writing) return;
            const current = syntheticEtag(res.mtimeMs ?? 0, res.size ?? 0);
            if (current === lastWrittenEtag) {
              lastKnownEtag = current;
              return;
            }
            if (lastKnownEtag !== null && current !== lastKnownEtag) {
              lastKnownEtag = current;
              onChange();
            } else {
              lastKnownEtag = current;
            }
          })
          .catch(() => {
            // Transient poll error; SyncEngine surfaces auth errors on the next real cycle.
          });
      }, pollMs);
    },
  };

  return new HostFileProvider({
    id: 'saf',
    access,
  });
}
