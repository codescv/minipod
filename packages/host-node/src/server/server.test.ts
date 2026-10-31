import { SYNC_FILE_NAME, type HostEvent } from '@minipod/core';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRestPlatformHost } from '../client/rest-host';
import { startServer, type RunningServer } from './start';

const tempDirs: string[] = [];
const runningServers: RunningServer[] = [];
const upstreamServers: Server[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    await runningServers.pop()!.close();
  }
  while (upstreamServers.length > 0) {
    const s = upstreamServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('MiniPod Hono server + REST client integration', () => {
  it('enforces loopback DNS-rebinding Host, Origin CSRF, and Content-Type guards while allowing XML OPML', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'minipod-srv-guard-'));
    tempDirs.push(dataDir);
    const srv = await startServer({ dataDir });
    runningServers.push(srv);

    // 1. Non-loopback Host header rejected with 403
    const rebindRes = await srv.app.request('http://evil.example/api/info', {
      headers: { Host: 'evil.example' },
    });
    expect(rebindRes.status).toBe(403);

    // 2. Cross-origin mutating request rejected with 403
    const csrfRes = await fetch(`${srv.url}/api/queue/clear`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(csrfRes.status).toBe(403);

    // 3. Form-encoded / text/plain POST to JSON endpoint rejected with 415
    const badCtRes = await fetch(`${srv.url}/api/feeds/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"previewIdOrUrl":"https://example.com/rss"}',
    });
    expect(badCtRes.status).toBe(415);

    // 4. Raw text/xml POST to /api/feeds/opml succeeds!
    const opmlXml = `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0">
        <body>
          <outline text="ATP" title="ATP" type="rss" xmlUrl="https://atp.fm/rss" />
        </body>
      </opml>`;
    const opmlRes = await fetch(`${srv.url}/api/feeds/opml`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: opmlXml,
    });
    expect(opmlRes.status).toBe(200);
    const opmlJson = (await opmlRes.json()) as { ok: boolean; data: Array<{ xmlUrl: string }> };
    expect(opmlJson.ok).toBe(true);
    expect(opmlJson.data[0]?.xmlUrl).toBe('https://atp.fm/rss');
  });

  it('runs end-to-end PlatformHost client⇄server: preview->subscribe single fetch, queue, download cleanup, SSE, and flush:true sync push', async () => {
    let feedFetchCount = 0;
    const audioPayload = Buffer.from('FAKE_MP3_AUDIO_BYTES_0123456789ABCDEF');

    const upstream = createServer((req, res) => {
      if (req.url === '/show.xml') {
        feedFetchCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Integration Podcast</title>
              <link>https://podcast.example</link>
              <description>End-to-end show</description>
              <item>
                <guid>item-1</guid>
                <title>First Episode</title>
                <enclosure url="http://127.0.0.1:${(upstream.address() as AddressInfo).port}/ep1.mp3" type="audio/mpeg" length="${audioPayload.length}" />
              </item>
              <item>
                <guid>item-2</guid>
                <title>Second Episode</title>
                <enclosure url="http://127.0.0.1:${(upstream.address() as AddressInfo).port}/ep2.mp3" type="audio/mpeg" length="${audioPayload.length}" />
              </item>
            </channel>
          </rss>`);
        return;
      }
      if (req.url === '/ep1.mp3' || req.url === '/ep2.mp3') {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audioPayload.length),
          'Accept-Ranges': 'bytes',
        });
        res.end(audioPayload);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    upstreamServers.push(upstream);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const feedUrl = `http://127.0.0.1:${upstreamPort}/show.xml`;

    const dataDir = mkdtempSync(join(tmpdir(), 'minipod-e2e-data-'));
    const syncDir = mkdtempSync(join(tmpdir(), 'minipod-e2e-sync-'));
    tempDirs.push(dataDir, syncDir);

    const srv = await startServer({ dataDir });
    runningServers.push(srv);

    const clientHost = await connectRestPlatformHost({ baseUrl: srv.url });
    expect(clientHost.info.platform).toBe('desktop');
    expect(clientHost.info.dataDir).toBe(dataDir);

    const receivedEvents: HostEvent[] = [];
    const unsubSse = clientHost.subscribe((ev) => {
      receivedEvents.push(ev);
    });
    // Allow SSE stream connection to establish
    await new Promise((r) => setTimeout(r, 60));

    // Preview + subscribe by previewId -> fetches RSS XML ONLY ONCE!
    const resolved = await clientHost.feeds.preview(feedUrl);
    expect(resolved.kind).toBe('feed');
    if (resolved.kind !== 'feed') throw new Error('expected feed');
    expect(feedFetchCount).toBe(1);

    const subscribedFeed = await clientHost.feeds.subscribe(resolved.preview.previewId);
    expect(feedFetchCount).toBe(1);
    expect(subscribedFeed.title).toBe('Integration Podcast');

    const epPage = await clientHost.episodes.list(subscribedFeed.feedKey, 'all');
    expect(epPage.items).toHaveLength(2);
    const ep1 = epPage.items.find((i) => i.episode.identity === 'item-1')!.episode;
    const ep2 = epPage.items.find((i) => i.episode.identity === 'item-2')!.episode;

    // Queue add + playNext + move
    await clientHost.queue.add(ep1.episodeKey);
    await clientHost.queue.playNext(ep2.episodeKey);
    const qList = await clientHost.queue.list();
    expect(qList.map((r) => r.episode.episodeKey)).toEqual([ep1.episodeKey, ep2.episodeKey]);

    // Enable deleteDownloadWhenPlayed, download ep1, verify /media 206, then mark played -> auto-deletes download & removes from queue!
    await clientHost.settings.update({ deleteDownloadWhenPlayed: true });
    await clientHost.episodes.download(ep1.episodeKey);

    const afterDl = await clientHost.episodes.get(ep1.episodeKey);
    expect(afterDl.episode.downloadState).toBe('DONE');

    const mediaSrc = await clientHost.playback.sourceFor(ep1.episodeKey);
    expect(mediaSrc.kind).toBe('url');
    if (mediaSrc.kind === 'url') {
      const rangeResp = await fetch(mediaSrc.url, { headers: { Range: 'bytes=0-13' } });
      expect(rangeResp.status).toBe(206);
      expect(await rangeResp.text()).toBe('FAKE_MP3_AUDIO');
    }

    await clientHost.progress.markPlayed(ep1.episodeKey, true);
    const afterPlayed = await clientHost.episodes.get(ep1.episodeKey);
    expect(afterPlayed.progress?.state).toBe('PLAYED');
    expect(afterPlayed.episode.downloadState).toBe('NONE');

    // Configure local-folder cloud sync and test immediate flush: true on progress.save
    const syncStatus = await clientHost.sync.configure({
      provider: { id: 'local-folder', folderPath: syncDir },
      wifiOnly: false,
      deviceName: 'Test Desktop',
    });
    expect(syncStatus.enabled).toBe(true);
    expect(existsSync(join(syncDir, SYNC_FILE_NAME))).toBe(true);

    await clientHost.progress.save({
      episodeKey: ep2.episodeKey,
      positionMs: 33_000,
      durationMs: 120_000,
      state: 'IN_PROGRESS',
      flush: true,
    });

    const syncedStatusAfterFlush = await clientHost.sync.status();
    expect(syncedStatusAfterFlush.dirtyCount).toBe(0);

    // Wait briefly for SSE delivery
    await new Promise((r) => setTimeout(r, 80));
    expect(receivedEvents.some((e) => e.type === 'feeds-changed')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'queue-changed')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'download-updated')).toBe(true);

    unsubSse();
    await clientHost.dispose();
  });

  it('proxies episode/feed artwork via GET /api/image-proxy without Referer and with caching & MIME sniffing', async () => {
    // 1x1 PNG magic bytes + payload
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    let capturedHeaders: Record<string, string | string[] | undefined> = {};

    const upstream = createServer((req, res) => {
      capturedHeaders = req.headers;
      if (req.url === '/hotlink-protected.png') {
        if (req.headers.referer) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Hotlink forbidden');
          return;
        }
        // Intentionally return generic octet-stream to verify magic-byte MIME resolution
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(pngBytes);
        return;
      }
      if (req.url === '/captive-error') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Blocked</body></html>');
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    upstreamServers.push(upstream);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const dataDir = mkdtempSync(join(tmpdir(), 'minipod-img-proxy-'));
    tempDirs.push(dataDir);
    const srv = await startServer({ dataDir });
    runningServers.push(srv);

    // 1. Missing or invalid URL -> 400
    const missingRes = await fetch(`${srv.url}/api/image-proxy`);
    expect(missingRes.status).toBe(400);

    const badSchemeRes = await fetch(
      `${srv.url}/api/image-proxy?url=${encodeURIComponent('file:///etc/passwd')}`,
    );
    expect(badSchemeRes.status).toBe(400);

    // 2. Valid hotlink-protected image -> 200 with no Referer, MiniPod User-Agent, sniffed image/png, Cache-Control
    const targetImgUrl = `http://127.0.0.1:${upstreamPort}/hotlink-protected.png`;
    const okRes = await fetch(
      `${srv.url}/api/image-proxy?url=${encodeURIComponent(targetImgUrl)}`,
      { headers: { Referer: `${srv.url}/` } },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('content-type')).toBe('image/png');
    expect(okRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(okRes.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(capturedHeaders['referer']).toBeUndefined();
    expect(String(capturedHeaders['user-agent'] ?? '')).toContain('MiniPod/');
    const bodyBuf = Buffer.from(await okRes.arrayBuffer());
    expect(bodyBuf.equals(pngBytes)).toBe(true);

    // 3. HTML captive error page disguised as 200 -> rejected as 502 so UI falls back cleanly
    const htmlErrUrl = `http://127.0.0.1:${upstreamPort}/captive-error`;
    const htmlRes = await fetch(
      `${srv.url}/api/image-proxy?url=${encodeURIComponent(htmlErrUrl)}`,
    );
    expect(htmlRes.status).toBe(502);
  });
});
