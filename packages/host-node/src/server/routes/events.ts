/**
 * Server-Sent Events (`/api/events`) endpoint pushing `HostEvent` JSON frames
 * to connected browser clients (`ARCHITECTURE.md §3.2`).
 */
import type { PlatformHost } from '@minipod/core';
import { Hono } from 'hono';

const encoder = new TextEncoder();
const KEEPALIVE_MS = 25_000;

export function createEventsRoutes(host: PlatformHost): Hono {
  const app = new Hono();

  app.get('/events', (c) => {
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const safeEnqueue = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            doCleanup();
          }
        };

        // Initial comment frame flushes headers immediately across reverse proxies & fetch streams
        safeEnqueue(': connected\n\n');

        const unsub = host.subscribe((event) => {
          safeEnqueue(`event: host-event\ndata: ${JSON.stringify(event)}\n\n`);
        });

        const keepAlive = setInterval(() => {
          safeEnqueue(': keep-alive\n\n');
        }, KEEPALIVE_MS);
        keepAlive.unref?.();

        const doCleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsub();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        cleanup = doCleanup;
        c.req.raw.signal.addEventListener('abort', doCleanup, { once: true });
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return app;
}
