import { encodeBasicAuth } from '@minipod/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeHttpClient } from './fetcher';
import { MediaProxy, parseRangeHeader } from './range-proxy';

const activeServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const s = activeServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('MediaProxy & parseRangeHeader', () => {
  it('parses RFC 9110 Range headers accurately', () => {
    expect(parseRangeHeader(undefined, 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ kind: 'ok', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=900-', 1000)).toEqual({ kind: 'ok', start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-200', 1000)).toEqual({ kind: 'ok', start: 800, end: 999 });
    expect(parseRangeHeader('bytes=1000-1100', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=500-200', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('serves local downloaded files with HTTP 206 Partial Content, 416, and HEAD, plus chapter APIC slices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minipod-proxy-'));
    tempDirs.push(dir);
    const mp3Path = join(dir, 'ep1.mp3');

    // Fake file: 32 header bytes + 8 PNG magic bytes at offset 32 + trailing audio bytes
    const header = Buffer.alloc(32, 0x11);
    const embeddedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tail = Buffer.from('AUDIO_STREAM_PAYLOAD_0123456789');
    const fullBuf = Buffer.concat([header, embeddedPng, tail]);
    writeFileSync(mp3Path, fullBuf);

    const http = createNodeHttpClient();
    const proxy = new MediaProxy({
      http,
      userAgent: 'MiniPod/0.1.0-test',
      resolveEpisode: (key) =>
        key === 'e_local1'
          ? {
              episodeKey: 'e_local1',
              feedKey: 'f_1',
              isLocalFeed: false,
              downloadState: 'DONE',
              downloadPath: mp3Path,
              enclosureMime: 'audio/mpeg',
            }
          : undefined,
      loadChaptersForEpisode: async () => [
        {
          startMs: 0,
          title: 'Intro',
          source: 'ID3',
          embeddedImage: { offset: 32, length: 8, mime: 'image/png' },
        },
      ],
      resolveLocalFeedCover: () => undefined,
    });

    // 206 Range request
    const res206 = await proxy.handleEpisodeMedia({
      episodeKey: 'e_local1',
      method: 'GET',
      rangeHeader: 'bytes=40-51',
    });
    expect(res206.status).toBe(206);
    expect(res206.headers.get('content-range')).toBe(`bytes 40-51/${fullBuf.length}`);
    expect(res206.headers.get('content-type')).toBe('audio/mpeg');
    expect(await res206.text()).toBe('AUDIO_STREAM');

    // 416 out of range
    const res416 = await proxy.handleEpisodeMedia({
      episodeKey: 'e_local1',
      method: 'GET',
      rangeHeader: `bytes=${fullBuf.length + 10}-${fullBuf.length + 20}`,
    });
    expect(res416.status).toBe(416);

    // Chapter APIC slice route
    const imgRes = await proxy.handleChapterImage({
      episodeKey: 'e_local1',
      chapterIndex: 0,
      method: 'GET',
    });
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
    expect(imgRes.headers.get('cache-control')).toContain('immutable');
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    expect(Buffer.from(imgBytes).equals(embeddedPng)).toBe(true);
  });

  it('proxies remote enclosures with HTTP 206 Range, Basic Auth, and session-cached CDN redirect URL', async () => {
    let redirectHits = 0;
    const expectedAuth = encodeBasicAuth('patron', 'secret123', 'ISO-8859-1');
    const remoteBytes = Buffer.from('REMOTE_ENCLOSURE_0123456789ABCDEF');

    const server = createServer((req, res) => {
      if (req.url === '/redirect-enclosure.mp3') {
        redirectHits += 1;
        res.writeHead(302, { Location: '/cdn/real.mp3' });
        res.end();
        return;
      }
      if (req.url === '/cdn/real.mp3') {
        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Patreon"' });
          res.end();
          return;
        }
        const range = req.headers.range;
        if (range === 'bytes=0-15') {
          const part = remoteBytes.subarray(0, 16);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream', // proxy should normalize to audio/mpeg via .mp3!
            'Content-Range': `bytes 0-15/${remoteBytes.length}`,
            'Content-Length': String(part.length),
          });
          res.end(part);
          return;
        }
        if (range === 'bytes=17-26') {
          const part = remoteBytes.subarray(17, 27);
          res.writeHead(206, {
            'Content-Type': 'audio/mpeg',
            'Content-Range': `bytes 17-26/${remoteBytes.length}`,
            'Content-Length': String(part.length),
          });
          res.end(part);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(remoteBytes);
      }
    });
    activeServers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const http = createNodeHttpClient();
    const proxy = new MediaProxy({
      http,
      userAgent: 'MiniPod/0.1.0-test',
      resolveEpisode: () => ({
        episodeKey: 'e_remote1',
        feedKey: 'f_1',
        isLocalFeed: false,
        downloadState: 'NONE',
        enclosureUrl: `${baseUrl}/redirect-enclosure.mp3`,
        credentials: { username: 'patron', password: 'secret123' },
      }),
      loadChaptersForEpisode: async () => [],
      resolveLocalFeedCover: () => undefined,
    });

    const first = await proxy.handleEpisodeMedia({
      episodeKey: 'e_remote1',
      method: 'GET',
      rangeHeader: 'bytes=0-15',
    });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-type')).toBe('audio/mpeg');
    expect(await first.text()).toBe('REMOTE_ENCLOSURE');
    expect(redirectHits).toBe(1);

    // Second seek goes straight to cached `/cdn/real.mp3` without hitting `/redirect-enclosure.mp3`!
    const second = await proxy.handleEpisodeMedia({
      episodeKey: 'e_remote1',
      method: 'GET',
      rangeHeader: 'bytes=17-26',
    });
    expect(second.status).toBe(206);
    expect(await second.text()).toBe('0123456789');
    expect(redirectHits).toBe(1);
  });
});
