import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64, MiniPodError } from '@minipod/core';
import { createSafFileProvider } from './SafFileProvider';

describe('SafFileProvider', () => {
  it('supports create/read/conditional-write conflict detection, self-write suppression, and SecurityException mapping', async () => {
    let fileBytes: Uint8Array | null = null;
    let fileMtime = 1_000;
    let revoked = false;
    const pollHooks: { trigger?: () => void } = {};

    const saf = {
      async pick() {
        return null;
      },
      async stat() {
        if (revoked) throw new Error('java.lang.SecurityException: Permission Denial');
        if (!fileBytes) return { exists: false };
        return { exists: true, size: fileBytes.length, mtimeMs: fileMtime };
      },
      async read() {
        if (revoked) throw new Error('java.lang.SecurityException: Permission Denial');
        if (!fileBytes) throw new Error('FileNotFoundException');
        return { base64: encodeBase64(fileBytes) };
      },
      async readRange() {
        return { base64: '' };
      },
      async write({ base64 }: { uri: string; base64: string }) {
        if (revoked) throw new Error('java.lang.SecurityException: Permission Denial');
        fileBytes = decodeBase64(base64);
        fileMtime += 500;
      },
      async listTree() {
        return { entries: [] };
      },
    };

    const provider = createSafFileProvider({
      documentUri: 'content://com.android.externalstorage.documents/document/primary%3Aminipod-sync-v1.json',
      plugin: { saf },
      isVisible: () => true,
      setIntervalFn: (fn) => {
        pollHooks.trigger = fn;
        return () => {
          delete pollHooks.trigger;
        };
      },
    });

    let watchNotifications = 0;
    const unsub = provider.watch!(() => {
      watchNotifications += 1;
    });

    expect(await provider.read(null)).toEqual({ kind: 'missing' });

    const payload1 = new TextEncoder().encode('{"rev":1}');
    const w1 = await provider.write(payload1, null);
    expect(w1.kind).toBe('ok');
    if (w1.kind !== 'ok') throw new Error('expected ok');

    // Poll right after our own write -> ignored!
    pollHooks.trigger?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(watchNotifications).toBe(0);

    // External cloud sync client modifies the file -> conflict on stale etag & watcher fires!
    fileBytes = new TextEncoder().encode('{"rev":2}');
    fileMtime += 2_000;

    pollHooks.trigger?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(watchNotifications).toBe(1);

    const conflict = await provider.write(new TextEncoder().encode('{"rev":3}'), w1.newEtag);
    expect(conflict).toEqual({ kind: 'conflict' });

    // Revoking SAF persistable permission maps to non-retryable `sync-auth`
    revoked = true;
    await expect(provider.head()).rejects.toMatchObject({
      code: 'sync-auth',
    } satisfies Partial<MiniPodError>);

    unsub();
  });
});
