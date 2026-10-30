import { encodeBasicAuth, MiniPodError, RedirectRecorder } from '@minipod/core';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeHttpClient } from './fetcher';

const activeServers: Server[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const s = activeServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function startTestHttpServer(
  handler: RequestListener,
): Promise<{ url: string; port: number }> {
  const server = createServer(handler);
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port };
}

describe('createNodeHttpClient', () => {
  it('records full manual redirect chain (301 -> 302 -> 200) for RedirectRecorder', async () => {
    const srv = await startTestHttpServer((req, res) => {
      if (req.url === '/old-feed') {
        res.writeHead(301, { Location: '/perm-feed' });
        res.end();
        return;
      }
      if (req.url === '/perm-feed') {
        res.writeHead(302, { Location: '/cdn-temp-feed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end('<rss version="2.0"><channel><title>OK</title></channel></rss>');
    });

    const http = createNodeHttpClient();
    const resp = await http({ url: `${srv.url}/old-feed` });

    expect(resp.status).toBe(200);
    expect(resp.finalUrl).toBe(`${srv.url}/cdn-temp-feed`);
    expect(resp.chain).toEqual([
      { status: 301, url: `${srv.url}/old-feed`, location: `${srv.url}/perm-feed` },
      { status: 302, url: `${srv.url}/perm-feed`, location: `${srv.url}/cdn-temp-feed` },
    ]);

    // RedirectRecorder stops at /perm-feed and does NOT persist the temporary 302 CDN URL!
    const perm = RedirectRecorder.analyse(resp.chain);
    expect(perm).toEqual({
      from: `${srv.url}/old-feed`,
      to: `${srv.url}/perm-feed`,
      reason: '301',
    });
  });

  it('retries Basic Auth in ISO-8859-1 -> UTF-8 order and preserves auth across redirects', async () => {
    const seenAuthHeaders: string[] = [];
    const expectedUtf8 = encodeBasicAuth('user', 'päss€', 'UTF-8');

    const backend = await startTestHttpServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth) seenAuthHeaders.push(auth);
      if (auth !== expectedUtf8) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Members"' });
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('secret-ok');
    });

    const frontend = await startTestHttpServer((_req, res) => {
      // Cross-origin redirect (different port)
      res.writeHead(302, { Location: `${backend.url}/private.xml` });
      res.end();
    });

    const http = createNodeHttpClient();
    const resp = await http({
      url: `${frontend.url}/start`,
      auth: { username: 'user', password: 'päss€' },
    });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('secret-ok');
    // Tried ISO-8859-1 first, then UTF-8!
    expect(seenAuthHeaders).toHaveLength(2);
    expect(seenAuthHeaders[0]).toBe(encodeBasicAuth('user', 'päss€', 'ISO-8859-1'));
    expect(seenAuthHeaders[1]).toBe(expectedUtf8);
  });

  it('supports Range requests and enforces maxBodyBytes cap', async () => {
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
    const srv = await startTestHttpServer((req, res) => {
      const range = req.headers.range;
      if (range === 'bytes=10-15') {
        const slice = payload.subarray(10, 16);
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes 10-15/${payload.length}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const http = createNodeHttpClient();
    const ranged = await http({
      url: `${srv.url}/audio.mp3`,
      range: { start: 10, end: 15 },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('abcdef');

    await expect(async () => {
      const tooBig = await http({
        url: `${srv.url}/audio.mp3`,
        maxBodyBytes: 10,
      });
      await tooBig.bytes();
    }).rejects.toMatchObject({ code: 'invalid-argument' } satisfies Partial<MiniPodError>);
  });
});
