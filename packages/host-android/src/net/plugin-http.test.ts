import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, MiniPodError, RedirectRecorder } from '@minipod/core';
import { createPluginHttpClient } from './plugin-http';
import type { MiniPodPluginHttpRequest, MiniPodPluginHttpResponse } from '../plugin-types';

describe('createPluginHttpClient', () => {
  it('shapes requests, normalizes lowercase headers, decodes Base64 bodies, and preserves redirect chains', async () => {
    let captured: MiniPodPluginHttpRequest | undefined;
    const bodyBytes = new TextEncoder().encode('<rss version="2.0"><channel><title>Hi</title></channel></rss>');

    const http = createPluginHttpClient(
      {
        async http(req): Promise<MiniPodPluginHttpResponse> {
          captured = req;
          return {
            status: 200,
            headers: {
              'Content-Type': 'application/rss+xml; charset=utf-8',
              ETag: '"v1"',
            },
            finalUrl: 'https://feeds.example.com/podcast.xml',
            chain: [
              {
                status: 301,
                url: 'http://example.com/feed.xml',
                location: 'https://feeds.example.com/podcast.xml',
              },
            ],
            bodyBase64: encodeBase64(bodyBytes),
          };
        },
      },
      { userAgent: 'MiniPod/0.1.0 (android)' },
    );

    const resp = await http({
      url: 'http://example.com/feed.xml',
      method: 'GET',
      range: { start: 0, end: 1023 },
      auth: { username: 'u', password: 'p' },
      maxRedirects: 5,
    });

    expect(captured).toMatchObject({
      url: 'http://example.com/feed.xml',
      method: 'GET',
      headers: { 'User-Agent': 'MiniPod/0.1.0 (android)' },
      range: { start: 0, end: 1023 },
      auth: { username: 'u', password: 'p' },
      maxRedirects: 5,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(resp.headers['etag']).toBe('"v1"');
    expect(resp.finalUrl).toBe('https://feeds.example.com/podcast.xml');
    expect(RedirectRecorder.analyse(resp.chain)).toEqual({
      from: 'http://example.com/feed.xml',
      to: 'https://feeds.example.com/podcast.xml',
      reason: '301',
    });
    expect(await resp.text()).toContain('<title>Hi</title>');
  });

  it('enforces maxBodyBytes and AbortSignal cancellation', async () => {
    const http = createPluginHttpClient({
      http: vi.fn(async () => ({
        status: 200,
        headers: {},
        finalUrl: 'https://example.com/big',
        chain: [],
        bodyBase64: encodeBase64(new Uint8Array(128)),
      })),
    });

    const resp = await http({
      url: 'https://example.com/big',
      maxBodyBytes: 32,
    });
    await expect(resp.bytes()).rejects.toMatchObject({
      code: 'invalid-argument',
    });

    const ac = new AbortController();
    ac.abort();
    await expect(http({ url: 'https://example.com/aborted', signal: ac.signal })).rejects.toBeInstanceOf(
      MiniPodError,
    );
  });
});
