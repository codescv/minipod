/**
 * Assembles the full MiniPod Hono server application:
 * - Loopback DNS-rebinding & CSRF guard (`createLoopbackGuard`)
 * - HTTP 206 Byte-Range media proxy (`/media/:episodeKey`)
 * - SSE event stream (`/api/events`)
 * - Typed JSON REST endpoints (`/api/*`)
 * - Static SPA asset serving (`dist/web/*` with `index.html` fallback)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import type { NodeHostBundle } from './context';
import { createLoopbackGuard } from './guard';
import { createApiRoutes } from './routes/api';
import { createEventsRoutes } from './routes/events';
import { createMediaRoutes } from './routes/media';

const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface ServerAppOptions {
  readonly webRootDir?: string;
  readonly extraAllowedOrigins?: readonly string[];
}

export function createServerApp(bundle: NodeHostBundle, options?: ServerAppOptions): Hono {
  const app = new Hono();

  app.use(
    '*',
    createLoopbackGuard(
      options?.extraAllowedOrigins ? { extraAllowedOrigins: options.extraAllowedOrigins } : undefined,
    ),
  );

  app.route('/media', createMediaRoutes(bundle.mediaProxy));
  app.route('/api', createEventsRoutes(bundle.host));
  app.route('/api', createApiRoutes(bundle.host, bundle.mediaProxy));

  const webRoot = options?.webRootDir ? resolve(options.webRootDir) : undefined;
  if (webRoot && existsSync(webRoot)) {
    app.get('*', (c) => {
      const reqPath = new URL(c.req.url, 'http://127.0.0.1').pathname;
      if (reqPath.startsWith('/api/') || reqPath.startsWith('/media/')) {
        return c.notFound();
      }
      const cleanRel = normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
      const candidate = resolve(webRoot, cleanRel || 'index.html');
      if (candidate.startsWith(webRoot) && existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) {
            const ext = extname(candidate).toLowerCase();
            const contentType = STATIC_MIME[ext] ?? 'application/octet-stream';
            const body = readFileSync(candidate);
            return new Response(body, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                ...(ext === '.html'
                  ? { 'Cache-Control': 'no-cache' }
                  : { 'Cache-Control': 'public, max-age=31536000, immutable' }),
              },
            });
          }
        } catch {
          // fall through to SPA index.html
        }
      }

      const spaIndex = join(webRoot, 'index.html');
      if (existsSync(spaIndex)) {
        return new Response(readFileSync(spaIndex), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      return c.notFound();
    });
  }

  return app;
}
