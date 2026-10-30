import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '../types';
import {
  BasicAuth,
  DEFAULT_USER_AGENT,
  RedirectRecorder,
  UserAgent,
  analyseRedirects,
  encodeBasicAuth,
  encodeBasicAuthHeaders,
  fetchWithBasicAuth,
  parseWwwAuthenticateRealm,
} from './index';

function makeResponse(
  status: number,
  body: string,
  opts?: { headers?: Record<string, string>; finalUrl?: string; chain?: HttpResponse['chain'] },
): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: opts?.headers ?? {},
    finalUrl: opts?.finalUrl ?? 'https://example.com/feed.xml',
    chain: opts?.chain ?? [],
    bytes: async () => bytes,
    text: async () => body,
  };
}

describe('http/userAgent', () => {
  it('formats MiniPod User-Agent strings', () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^MiniPod\/\d+\.\d+\.\d+$/);
    expect(UserAgent.build('1.2.3', 'Linux')).toBe('MiniPod/1.2.3 (Linux)');
  });
});

describe('http/basicAuth', () => {
  it('encodes ISO-8859-1 first and UTF-8 second when credentials contain non-ASCII chars', () => {
    const asciiHeaders = encodeBasicAuthHeaders({ username: 'user', password: 'pw' });
    expect(asciiHeaders).toHaveLength(1);
    expect(asciiHeaders[0]).toBe('Basic dXNlcjpwdw==');

    const umlautHeaders = encodeBasicAuthHeaders({ username: 'müller', password: 'päss' });
    expect(umlautHeaders).toHaveLength(2);
    expect(umlautHeaders[0]).toBe(encodeBasicAuth('müller', 'päss', 'ISO-8859-1'));
    expect(umlautHeaders[1]).toBe(encodeBasicAuth('müller', 'päss', 'UTF-8'));
    expect(umlautHeaders[0]).not.toBe(umlautHeaders[1]);
  });

  it('retries 401 with ISO-8859-1 first, then UTF-8, and preserves URL userInfo precedence', async () => {
    const seenRequests: HttpRequest[] = [];
    const expectedUtf8 = encodeBasicAuth('müller', 'geheim🔒', 'UTF-8');

    const mockHttp: HttpClient = async (req) => {
      seenRequests.push(req);
      const auth = req.headers?.['Authorization'];
      if (!auth) {
        return makeResponse(401, 'Unauthorized', {
          headers: { 'www-authenticate': 'Basic realm="Patreon Feed"' },
          finalUrl: 'https://cdn.example.net/feed.xml',
          chain: [{ status: 302, url: req.url, location: 'https://cdn.example.net/feed.xml' }],
        });
      }
      if (auth === expectedUtf8) {
        return makeResponse(200, '<rss version="2.0"/>', {
          finalUrl: 'https://cdn.example.net/feed.xml',
        });
      }
      return makeResponse(401, 'Wrong encoding', {
        finalUrl: 'https://cdn.example.net/feed.xml',
      });
    };

    const resp = await fetchWithBasicAuth(
      mockHttp,
      { url: 'https://m%C3%BCller:geheim%F0%9F%94%92@example.com/feed.xml' },
      { username: 'fallback', password: 'ignored' },
    );

    expect(resp.status).toBe(200);
    // 1. unauthenticated probe (clean URL without userInfo)
    // 2. ISO-8859-1 retry against redirected finalUrl
    // 3. UTF-8 retry against redirected finalUrl -> 200
    expect(seenRequests).toHaveLength(3);
    expect(seenRequests[0]!.url).toBe('https://example.com/feed.xml');
    expect(seenRequests[1]!.url).toBe('https://cdn.example.net/feed.xml');
    expect(seenRequests[1]!.headers?.['Authorization']).toBe(
      encodeBasicAuth('müller', 'geheim🔒', 'ISO-8859-1'),
    );
    expect(seenRequests[2]!.headers?.['Authorization']).toBe(expectedUtf8);
    expect(resp.chain).toHaveLength(1);
    expect(parseWwwAuthenticateRealm('Basic realm="Patreon Feed", charset="UTF-8"')).toBe(
      'Patreon Feed',
    );
    expect(BasicAuth.parseRealm('Basic realm=MembersOnly')).toBe('MembersOnly');
  });
});

describe('http/redirectRecorder', () => {
  it('records 301, 308, and http->https upgrades, stopping before temporary 302 CDN hops', () => {
    expect(analyseRedirects([])).toBeUndefined();

    // Temporary 302 to different host -> NOT permanent
    expect(
      analyseRedirects([
        { status: 302, url: 'https://a.example.com/rss', location: 'https://cdn.example.net/rss' },
      ]),
    ).toBeUndefined();

    // 302 http -> identical https -> permanent upgrade!
    expect(
      RedirectRecorder.analyse([
        { status: 302, url: 'http://example.com/feed.xml', location: 'https://example.com/feed.xml' },
      ]),
    ).toEqual({
      from: 'http://example.com/feed.xml',
      to: 'https://example.com/feed.xml',
      reason: 'http-to-https',
    });

    // 301 permanent move followed by 302 temporary CDN redirect -> persists the 301 target, NOT the 302 CDN URL!
    expect(
      analyseRedirects([
        { status: 301, url: 'http://old.example.com/rss', location: 'https://new.example.com/rss' },
        { status: 308, url: 'https://new.example.com/rss', location: 'https://final.example.com/rss' },
        { status: 302, url: 'https://final.example.com/rss', location: 'https://temp-cdn.example.net/rss?sig=123' },
      ]),
    ).toEqual({
      from: 'http://old.example.com/rss',
      to: 'https://final.example.com/rss',
      reason: '308',
    });
  });
});
