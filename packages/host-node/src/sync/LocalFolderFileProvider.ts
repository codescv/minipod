/**
 * `LocalFolderFileProvider`: desktop `CloudFileProvider` reading & writing
 * `minipod-sync-v1.json` in any user-chosen local cloud-synced folder
 * (Google Drive for Desktop, Dropbox, Syncthing, iCloud Drive, OneDrive, Nextcloud)
 * (`ARCHITECTURE.md §8.2`).
 *
 * - Writes via `.minipod-sync-v1.json.tmp-<pid>-<rand>` + `fsync` + `rename` so sync
 *   daemons never upload a half-written JSON file.
 * - Watches the **parent directory** (`fs.watch(folderPath)`) rather than the inode
 *   so atomic `rename()` replacements by cloud daemons are always detected, while
 *   ignoring `.tmp` / `.corrupt` files and our own writes.
 */
import {
  HostFileProvider,
  MiniPodError,
  SYNC_FILE_NAME,
  type CloudFileProvider,
  type HostFileAccess,
  type Unsubscribe,
} from '@minipod/core';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface LocalFolderFileProviderOptions {
  readonly fileName?: string;
  readonly watchDebounceMs?: number;
}

export interface LocalFolderCloudProvider extends CloudFileProvider {
  readonly filePath: string;
  readonly folderPath: string;
  deleteRemote(): Promise<void>;
  archiveCorrupt(bytes: Uint8Array, timestamp?: number): string;
}

export function createLocalFolderFileAccess(
  rawFolderPath: string,
  options?: LocalFolderFileProviderOptions,
): {
  readonly access: HostFileAccess;
  readonly folderPath: string;
  readonly filePath: string;
  readonly fileName: string;
} {
  const folderPath = resolve(rawFolderPath);
  const fileName = options?.fileName ?? SYNC_FILE_NAME;
  const filePath = join(folderPath, fileName);
  const debounceMs = options?.watchDebounceMs ?? 300;

  let selfWriteActive = false;
  let lastSelfWriteMtimeMs = -1;
  let lastSelfWriteSize = -1;

  const access: HostFileAccess = {
    async stat() {
      if (!existsSync(folderPath)) {
        throw new MiniPodError('not-found', `Sync folder does not exist: ${folderPath}`);
      }
      try {
        const dirSt = statSync(folderPath);
        if (!dirSt.isDirectory()) {
          throw new MiniPodError('invalid-argument', `Sync path is not a directory: ${folderPath}`);
        }
      } catch (err) {
        if (err instanceof MiniPodError) throw err;
        throw err;
      }

      try {
        const st = statSync(filePath);
        if (!st.isFile()) return null;
        return {
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
        };
      } catch (err) {
        if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },

    async read(): Promise<Uint8Array> {
      const buf = readFileSync(filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },

    async write(bytes: Uint8Array): Promise<void> {
      mkdirSync(folderPath, { recursive: true });
      const suffix = randomBytes(4).toString('hex');
      const tmpName = `.${fileName}.tmp-${process.pid}-${suffix}`;
      const tmpPath = join(folderPath, tmpName);

      selfWriteActive = true;
      try {
        const fd = openSync(tmpPath, 'w', 0o644);
        try {
          writeSync(fd, bytes, 0, bytes.byteLength, 0);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, filePath);

        try {
          const st = statSync(filePath);
          lastSelfWriteMtimeMs = Math.trunc(st.mtimeMs);
          lastSelfWriteSize = st.size;
        } catch {
          // ignore
        }
      } catch (err) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // ignore cleanup failure
        }
        throw err;
      } finally {
        selfWriteActive = false;
      }
    },

    watch(onChange: () => void): Unsubscribe {
      if (!existsSync(folderPath)) {
        return () => undefined;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      let watcher: ReturnType<typeof fsWatch> | null = null;
      try {
        watcher = fsWatch(folderPath, { persistent: false }, (_eventType, changedName) => {
          if (closed || selfWriteActive) return;

          if (typeof changedName === 'string' && changedName.length > 0) {
            // Ignore temp files and corrupt archive backups
            if (
              changedName.includes('.tmp-') ||
              changedName.includes('.corrupt-') ||
              (changedName !== fileName && !changedName.startsWith(fileName))
            ) {
              return;
            }
          }

          if (timer !== null) {
            clearTimeout(timer);
          }
          timer = setTimeout(() => {
            timer = null;
            if (closed || selfWriteActive) return;
            try {
              const st = statSync(filePath);
              if (
                Math.trunc(st.mtimeMs) === lastSelfWriteMtimeMs &&
                st.size === lastSelfWriteSize
              ) {
                return;
              }
            } catch {
              // File deleted or momentarily mid-rename; still notify scheduler
            }
            onChange();
          }, debounceMs);
          timer.unref?.();
        });
      } catch {
        watcher = null;
      }

      return () => {
        closed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        watcher?.close();
      };
    },
  };

  return { access, folderPath, filePath, fileName };
}

export function archiveCorruptSyncFile(
  rawFolderPath: string,
  bytes: Uint8Array,
  timestamp: number = Date.now(),
  fileName: string = SYNC_FILE_NAME,
): string {
  const folderPath = resolve(rawFolderPath);
  mkdirSync(folderPath, { recursive: true });
  const archivePath = join(folderPath, `${fileName}.corrupt-${timestamp}`);
  writeFileSync(archivePath, bytes);
  return archivePath;
}

export function createLocalFolderFileProvider(
  folderPath: string,
  options?: LocalFolderFileProviderOptions,
): LocalFolderCloudProvider {
  const { access, folderPath: resolvedFolder, filePath, fileName } = createLocalFolderFileAccess(
    folderPath,
    options,
  );
  const inner = new HostFileProvider({
    id: 'local-folder',
    access,
  });

  const provider: LocalFolderCloudProvider = {
    id: 'local-folder',
    supportsNativeConditionalWrite: inner.supportsNativeConditionalWrite,
    supportsCheapHead: inner.supportsCheapHead,
    folderPath: resolvedFolder,
    filePath,
    probe: (sig) => inner.probe(sig),
    head: (sig) => inner.head(sig),
    read: (ifNoneMatch, sig) => inner.read(ifNoneMatch, sig),
    write: (bytes, ifMatch, sig) => inner.write(bytes, ifMatch, sig),
    ...(inner.watch ? { watch: (cb: () => void) => inner.watch!(cb) } : {}),
    async deleteRemote(): Promise<void> {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // ignore
      }
    },
    archiveCorrupt(bytes: Uint8Array, ts?: number): string {
      return archiveCorruptSyncFile(resolvedFolder, bytes, ts, fileName);
    },
  };

  return provider;
}
