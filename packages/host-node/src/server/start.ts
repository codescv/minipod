/**
 * Starts the MiniPod loopback HTTP server bound strictly to `127.0.0.1` (`ARCHITECTURE.md §3.2`).
 */
import { serve, type ServerType } from '@hono/node-server';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createServerApp } from './app';
import { createNodePlatformHost, type NodeHostBundle, type NodeHostOptions } from './context';

export interface StartServerOptions extends NodeHostOptions {
  /** Port on `127.0.0.1`; `0` (default) picks an ephemeral free port. */
  readonly port?: number;
  readonly webRootDir?: string;
  readonly extraAllowedOrigins?: readonly string[];
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly app: Hono;
  readonly bundle: NodeHostBundle;
  readonly server: ServerType;
  close(): Promise<void>;
}

function defaultWebRootDir(): string | undefined {
  const candidates = [
    new URL('./web', import.meta.url),
    new URL('../../dist/web', import.meta.url),
  ];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function startServer(options?: StartServerOptions): Promise<RunningServer> {
  const bundle = createNodePlatformHost(options);
  const webRootDir = options?.webRootDir ?? defaultWebRootDir();
  const app = createServerApp(bundle, {
    ...(webRootDir ? { webRootDir } : {}),
    ...(options?.extraAllowedOrigins ? { extraAllowedOrigins: options.extraAllowedOrigins } : {}),
  });

  const requestedPort = options?.port ?? 0;

  let resolvedAddress: AddressInfo | undefined;
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: requestedPort,
      },
      (info) => {
        resolvedAddress = info as AddressInfo;
        resolve(s);
      },
    );
    s.once('error', reject);
  });

  const port = resolvedAddress?.port ?? (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    app,
    bundle,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await bundle.host.dispose();
    },
  };
}
