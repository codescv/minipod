import { describe, expect, it } from 'vitest';
import { FeedUrlNotFoundError, MiniPodError } from '../errors';
import { DEFAULT_PODCASTINDEX_KEYS, type HttpClient, type HttpRequest, type HttpResponse } from '../types';
import { sha1Hex } from '../util/sha1';
import {
  CombinedSearcher,
  FeedUrlResolver,
  FyydSearcher,
  GpodderSearcher,
  ItunesSearcher,
  ItunesTopListLoader,
  PodcastIndexSearcher,
  UrlNormalizer,
  createSearcherRegistry,
  feedKey,
  feedKeyAsync,
  filterOutSubscribed,
  localFolderFeedKey,
  prepareUrl,
  schemeLessCanonical,
  urlEquals,
  weightSearchResults,
} from './index';

function jsonResp(status: number, body: unknown, opts?: { finalUrl?: string }): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    finalUrl: opts?.finalUrl ?? 'https://example.com',
    chain: [],
    bytes: async () => bytes,
    text: async () => text,
  };
}

function xmlOrHtmlResp(
  status: number,
  body: string,
  opts?: {
    contentType?: string;
    finalUrl?: string;
    chain?: HttpResponse['chain'];
    headers?: Record<string, string>;
  },
): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: {
      'content-type': opts?.contentType ?? 'application/rss+xml; charset=utf-8',
      ...opts?.headers,
    },
    finalUrl: opts?.finalUrl ?? 'https://example.com/feed.xml',
    chain: opts?.chain ?? [],
    bytes: async () => bytes,
    text: async () => body,
  };
}

describe('discovery/UrlNormalizer', () => {
  it('normalizes all AntennaPod custom schemes and deeplinks', () => {
    expect(prepareUrl('feed://example.com/rss.xml')).toBe('http://example.com/rss.xml');
    expect(prepareUrl('FEED://https://example.com/rss.xml')).toBe('https://example.com/rss.xml');
    expect(prepareUrl('pcast://feeds.example.com/show')).toBe('http://feeds.example.com/show');
    expect(prepareUrl('pcast:https://feeds.example.com/show')).toBe('https://feeds.example.com/show');
    expect(prepareUrl('itpc://feeds.example.com/show')).toBe('http://feeds.example.com/show');
    expect(prepareUrl('antennapod-subscribe://https://example.com/pod.xml')).toBe(
      'https://example.com/pod.xml',
    );
    expect(
      prepareUrl(
        'https://antennapod.org/deeplink/subscribe?url=https%3A%2F%2Ffeeds.example.com%2Fshow.xml&title=Demo',
      ),
    ).toBe('https://feeds.example.com/show.xml');
    expect(prepareUrl('https://subscribeonandroid.com/feeds.example.com/podcast.rss')).toBe(
      'https://feeds.example.com/podcast.rss',
    );
    expect(prepareUrl('subscribeonandroid.com/feeds.example.com/podcast.rss')).toBe(
      'http://feeds.example.com/podcast.rss',
    );
    expect(prepareUrl('https://www.subscribeonandroid.com/https://feeds.example.com/podcast.rss')).toBe(
      'https://feeds.example.com/podcast.rss',
    );
    expect(prepareUrl('example.com/feed.xml')).toBe('http://example.com/feed.xml');
    expect(prepareUrl('/rss/main.xml', 'https://blog.example.org/about')).toBe(
      'https://blog.example.org/rss/main.xml',
    );
    expect(UrlNormalizer.isDeeplinkWithoutUrl('https://antennapod.org/deeplink/subscribe')).toBe(
      true,
    );
  });

  it('computes scheme-less canonical feedKey matching AntennaPod urlEquals', async () => {
    const a = 'http://Feeds.Example.COM:80/podcast//feed/?token=AbC#frag';
    const b = 'https://feeds.example.com:443/podcast/feed?token=AbC';
    expect(schemeLessCanonical(a)).toBe('feeds.example.com/podcast/feed?token=AbC');
    expect(feedKey(a)).toBe(feedKey(b));
    expect(await feedKeyAsync(a)).toBe(feedKey(a));
    expect(urlEquals(a, b)).toBe(true);

    // Different query -> different feedKey
    expect(feedKey('https://example.com/feed?id=1')).not.toBe(feedKey('https://example.com/feed?id=2'));
    // Empty query === absent query
    expect(feedKey('https://example.com/feed?')).toBe(feedKey('https://example.com/feed'));

    // Local folder key uses `l_` prefix
    const lk = localFolderFeedKey('/home/user/Audiobooks');
    expect(lk).toMatch(/^l_[0-9a-f]{40}$/);
    expect(feedKey('local-folder:/home/user/Audiobooks')).toBe(lk);
  });
});

describe('discovery/searchers & CombinedSearcher', () => {
  it('ItunesSearcher searches, detects lookup URLs, and throws FeedUrlNotFoundError when feedUrl missing', async () => {
    const http: HttpClient = async (req) => {
      if (req.url.includes('/search?')) {
        return jsonResp(200, {
          results: [
            {
              collectionName: 'Syntax',
              artistName: 'Wes & Scott',
              artworkUrl100: 'https://img.example/100.jpg',
              feedUrl: 'https://feed.syntax.fm/rss',
            },
          ],
        });
      }
      if (req.url.includes('lookup?id=111')) {
        return jsonResp(200, {
          results: [{ feedUrl: 'https://feed.syntax.fm/rss' }],
        });
      }
      if (req.url.includes('lookup?id=222')) {
        return jsonResp(200, {
          results: [{ trackName: 'Exclusive Show', artistName: 'Studio X' }],
        });
      }
      return jsonResp(404, {});
    };

    const itunes = new ItunesSearcher({ http });
    expect(itunes.urlNeedsLookup('https://podcasts.apple.com/us/podcast/syntax/id111')).toBe(true);
    expect(itunes.urlNeedsLookup('https://itunes.apple.com/lookup?id=111')).toBe(true);
    expect(itunes.urlNeedsLookup('https://feeds.example.com/rss.xml')).toBe(false);

    const searchRes = await itunes.search('syntax');
    expect(searchRes).toEqual([
      {
        title: 'Syntax',
        author: 'Wes & Scott',
        imageUrl: 'https://img.example/100.jpg',
        feedUrl: 'https://feed.syntax.fm/rss',
        source: 'apple',
      },
    ]);

    expect(await itunes.lookupUrl('https://podcasts.apple.com/us/podcast/syntax/id111')).toBe(
      'https://feed.syntax.fm/rss',
    );
    await expect(
      itunes.lookupUrl('https://podcasts.apple.com/us/podcast/exclusive/id222'),
    ).rejects.toBeInstanceOf(FeedUrlNotFoundError);
  });

  it('ItunesTopListLoader falls back to US ONLY when country is unset ("99")', async () => {
    const requestedUrls: string[] = [];
    const http: HttpClient = async (req) => {
      requestedUrls.push(req.url);
      if (req.url.includes('/us/rss/toppodcasts/')) {
        return jsonResp(200, {
          feed: {
            entry: [
              {
                'im:name': { label: 'Show One' },
                'im:artist': { label: 'Host A' },
                'im:image': [
                  { label: 'https://img/55.jpg', attributes: { height: '55' } },
                  { label: 'https://img/170.jpg', attributes: { height: '170' } },
                ],
                id: { attributes: { 'im:id': '999888' } },
              },
            ],
          },
        });
      }
      return jsonResp(404, {});
    };

    // Unset ('99') with broken defaultCountry ('ZZ') -> falls back to 'US'
    const loader = new ItunesTopListLoader({ http, defaultCountry: 'ZZ' });
    const unsetResults = await loader.topPodcasts('99', 25);
    expect(unsetResults).toEqual([
      {
        title: 'Show One',
        author: 'Host A',
        imageUrl: 'https://img/170.jpg',
        feedUrl: 'https://itunes.apple.com/lookup?id=999888',
        source: 'apple',
      },
    ]);

    // Explicit country ('AQ') returning 404 -> throws feed-not-found (MUST NOT silently fall back to US)
    await expect(loader.topPodcasts('AQ', 25)).rejects.toMatchObject({
      code: 'feed-not-found',
    });

    expect(filterOutSubscribed(unsetResults, ['Show One'])).toEqual([]);
  });

  it('PodcastIndexSearcher signs SHA-1 auth headers using default AntennaPod keys', async () => {
    let captured: HttpRequest | undefined;
    const fixedNow = 1_730_000_000_123;
    const http: HttpClient = async (req) => {
      captured = req;
      return jsonResp(200, {
        feeds: [
          {
            title: 'Linux Unplugged',
            author: 'Jupiter Broadcasting',
            artwork: 'https://jb.example/art.png',
            url: 'https://feeds.jupiterbroadcasting.com/lup',
          },
        ],
      });
    };

    const pi = new PodcastIndexSearcher({ http, now: () => fixedNow });
    const res = await pi.search('linux');
    expect(res).toHaveLength(1);
    expect(captured?.headers?.['X-Auth-Key']).toBe(DEFAULT_PODCASTINDEX_KEYS.key);
    expect(captured?.headers?.['X-Auth-Date']).toBe('1730000000');
    const expectedAuth = await sha1Hex(
      `${DEFAULT_PODCASTINDEX_KEYS.key}${DEFAULT_PODCASTINDEX_KEYS.secret}1730000000`,
    );
    expect(captured?.headers?.['Authorization']).toBe(expectedAuth);
  });

  it('FyydSearcher and GpodderSearcher have combinedWeight=0 and parse results', async () => {
    const http: HttpClient = async (req) => {
      if (req.url.includes('api.fyyd.de')) {
        return jsonResp(200, {
          data: [{ title: 'Fyyd Cast', author: 'Alice', xmlURL: 'https://fyyd.example/rss.xml' }],
        });
      }
      return jsonResp(200, [
        { title: 'Gpod Cast', author: 'Bob', url: 'https://gpod.example/rss.xml', scaled_logo_url: 'https://gpod.example/logo.png' },
      ]);
    };

    const fyyd = new FyydSearcher({ http });
    const gpod = new GpodderSearcher({ http });
    expect(fyyd.combinedWeight).toBe(0);
    expect(gpod.combinedWeight).toBe(0);
    expect((await fyyd.search('cast'))[0]?.feedUrl).toBe('https://fyyd.example/rss.xml');
    expect((await gpod.search('cast'))[0]?.feedUrl).toBe('https://gpod.example/rss.xml');
  });

  it('CombinedSearcher deduplicates by scheme-less feedKey and applies AntennaPod harmonic ranking', async () => {
    const ranked = weightSearchResults([
      {
        weight: 1.0,
        results: [
          { title: 'AlphaOnlyApple', feedUrl: 'https://alpha.example.com/rss', source: 'apple' },
          { title: 'SharedPodcast', feedUrl: 'http://shared.example.com/feed/', source: 'apple' },
        ],
      },
      {
        weight: 1.0,
        results: [
          {
            title: 'SharedPodcast',
            author: 'Enriched Author',
            imageUrl: 'https://shared.example.com/art.jpg',
            feedUrl: 'https://SHARED.example.com/feed',
            source: 'podcastindex',
          },
          { title: 'BetaOnlyPI', feedUrl: 'https://beta.example.com/rss', source: 'podcastindex' },
        ],
      },
    ]);

    // SharedPodcast score = ((0 + 1/2) * 1.0 + 1/1) * 1.0 = 1.5 > AlphaOnlyApple (1.0) > BetaOnlyPI (0.5)
    expect(ranked.map((r) => r.title)).toEqual(['SharedPodcast', 'AlphaOnlyApple', 'BetaOnlyPI']);
    expect(ranked[0]?.author).toBe('Enriched Author');
    expect(ranked[0]?.imageUrl).toBe('https://shared.example.com/art.jpg');

    // CombinedSearcher skips weight=0 providers and survives partial provider failure
    const failingApple = {
      id: 'apple' as const,
      displayName: 'Apple',
      combinedWeight: 1.0,
      search: async () => {
        throw new MiniPodError('network', 'Apple down');
      },
    };
    const okPi = {
      id: 'podcastindex' as const,
      displayName: 'PI',
      combinedWeight: 1.0,
      search: async () => [{ title: 'Survivor', feedUrl: 'https://ok.example/rss', source: 'podcastindex' as const }],
    };
    const skippedGpod = {
      id: 'gpodder' as const,
      displayName: 'gpodder',
      combinedWeight: 0.0,
      search: async () => {
        throw new Error('Should never be called');
      },
    };
    const combined = new CombinedSearcher({ searchers: [failingApple, okPi, skippedGpod] });
    const out = await combined.search('test');
    expect(out.map((r) => r.title)).toEqual(['Survivor']);
  });
});

describe('discovery/FeedUrlResolver', () => {
  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title>Resolved Show</title>
        <itunes:new-feed-url>https://migrated.example.com/rss.xml</itunes:new-feed-url>
        <item>
          <guid>ep-1</guid>
          <title>Episode 1</title>
          <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="32000" />
        </item>
      </channel>
    </rss>`;

  it('resolves Apple lookup missing feedUrl via CombinedSearcher exact title+author fallback', async () => {
    const http: HttpClient = async (req) => {
      if (req.url.includes('itunes.apple.com/lookup?id=777')) {
        return jsonResp(200, {
          results: [{ trackName: 'Resolved Show', artistName: 'Jane Doe' }],
        });
      }
      if (req.url.includes('itunes.apple.com/search')) {
        return jsonResp(200, { results: [] });
      }
      if (req.url.includes('api.podcastindex.org')) {
        return jsonResp(200, {
          feeds: [
            {
              title: 'Resolved Show',
              author: 'Jane Doe',
              url: 'https://orig.example.com/rss.xml',
            },
          ],
        });
      }
      if (req.url === 'https://orig.example.com/rss.xml') {
        return xmlOrHtmlResp(200, sampleRss, { finalUrl: req.url });
      }
      return jsonResp(404, {});
    };

    const registry = createSearcherRegistry({ http });
    const resolver = new FeedUrlResolver({ http, registry, createPreviewId: () => 'p_fixed' });
    const res = await resolver.resolve('Check out https://podcasts.apple.com/us/podcast/resolved/id777!');

    expect(res.kind).toBe('feed');
    if (res.kind === 'feed') {
      expect(res.preview.previewId).toBe('p_fixed');
      expect(res.preview.parsed.title).toBe('Resolved Show');
      expect(res.preview.episodeCount).toBe(1);
      // `<itunes:new-feed-url>` recorded as permanentRedirect
      expect(res.preview.url).toBe('https://migrated.example.com/rss.xml');
      expect(res.preview.permanentRedirect).toEqual({
        from: 'https://orig.example.com/rss.xml',
        to: 'https://migrated.example.com/rss.xml',
        reason: '301',
      });
    }
  });

  it('handles 401 auth-required, HTML 1-feed auto-follow, N-feed choices, and 0-feed error', async () => {
    const http: HttpClient = async (req) => {
      if (req.url === 'https://private.example.com/feed.xml') {
        return xmlOrHtmlResp(401, 'Unauthorized', {
          finalUrl: req.url,
          headers: { 'www-authenticate': 'Basic realm="VIP"' },
        });
      }
      if (req.url === 'https://single.example.com/') {
        return xmlOrHtmlResp(
          200,
          `<html><head><link rel="alternate" type="application/rss+xml" title="Main" href="/podcast.xml"></head><body>Hi</body></html>`,
          { contentType: 'text/html', finalUrl: req.url },
        );
      }
      if (req.url === 'https://single.example.com/podcast.xml') {
        return xmlOrHtmlResp(200, sampleRss, { finalUrl: req.url });
      }
      if (req.url === 'https://multi.example.com/') {
        return xmlOrHtmlResp(
          200,
          `<html><head>
            <link rel="alternate" type="application/rss+xml" title="Audio MP3" href="/mp3.xml">
            <link rel="alternate" type="application/atom+xml" title="Audio Opus" href="https://cdn.example.com/opus.atom">
          </head></html>`,
          { contentType: 'text/html', finalUrl: req.url },
        );
      }
      if (req.url === 'https://nofeed.example.com/') {
        return xmlOrHtmlResp(200, `<html><head><title>Plain Blog</title></head><body>No RSS</body></html>`, {
          contentType: 'text/html',
          finalUrl: req.url,
        });
      }
      return xmlOrHtmlResp(404, 'Not found', { finalUrl: req.url });
    };

    const registry = createSearcherRegistry({ http });
    const resolver = new FeedUrlResolver({ http, registry });

    const authRes = await resolver.resolve('https://private.example.com/feed.xml');
    expect(authRes).toEqual({
      kind: 'auth-required',
      url: 'https://private.example.com/feed.xml',
      realm: 'VIP',
    });

    const singleHtmlRes = await resolver.resolve('https://single.example.com/');
    expect(singleHtmlRes.kind).toBe('feed');

    const multiHtmlRes = await resolver.resolve('https://multi.example.com/');
    expect(multiHtmlRes).toEqual({
      kind: 'choices',
      pageUrl: 'https://multi.example.com/',
      choices: [
        { url: 'https://multi.example.com/mp3.xml', title: 'Audio MP3', type: 'application/rss+xml' },
        { url: 'https://cdn.example.com/opus.atom', title: 'Audio Opus', type: 'application/atom+xml' },
      ],
    });

    await expect(resolver.resolve('https://nofeed.example.com/')).rejects.toMatchObject({
      code: 'unsupported-feed',
    });
  });
});
