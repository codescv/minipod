import { describe, expect, it } from 'vitest';
import { encodeIso88591 } from '../util/base64';
import {
  HtmlFeedDiscoverer,
  Opml,
  SyndParser,
  TypeDetector,
  decodeFeedBytes,
  detectFeedType,
  discoverFeeds,
  episodeIdentity,
  episodeKey,
  episodeKeyAsync,
  parseFeed,
  parseOpml,
  readOpml,
  tokenizeXml,
  writeOpml,
} from './index';

describe('feed/decode & xml/tokenizer', () => {
  it('decodes UTF-8 BOM, XML encoding="ISO-8859-1" declarations, and Content-Type charsets', () => {
    const utf8WithBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<rss/>')]);
    expect(decodeFeedBytes(utf8WithBom)).toBe('<rss/>');

    const isoXml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>Hörspiel &amp; Café</title></rss>';
    const isoBytes = encodeIso88591(isoXml);
    expect(decodeFeedBytes(isoBytes)).toContain('Hörspiel &amp; Café');

    const ctIsoBytes = encodeIso88591('<rss><title>Ümlaut</title></rss>');
    expect(decodeFeedBytes(ctIsoBytes, 'application/xml; charset=iso-8859-1')).toContain('Ümlaut');
  });

  it('tokenizes XML namespaces, CDATA, numeric entities, and tolerates bare ampersands', () => {
    const events = [
      ...tokenizeXml(
        `<root xmlns="urn:def" xmlns:p="urn:pod"><child p:attr="1 & 2"><![CDATA[<raw>&ok</raw>]]>&#x2665; &amp;</child></root>`,
      ),
    ];
    const starts = events.filter((e) => e.type === 'startElement');
    expect(starts[0]?.uri).toBe('urn:def');
    expect(starts[1]?.attributes[0]?.uri).toBe('urn:pod');
    expect(starts[1]?.attributes[0]?.value).toBe('1 & 2');

    const texts = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    expect(texts).toBe('<raw>&ok</raw>♥ &');
  });
});

describe('feed/TypeDetector & SyndParser', () => {
  it('parses RSS 2.0 with all namespaces (itunes, podcast 2.0, content:encoded, media, psc, dc)', () => {
    // Also exercises legacy mixed-case iTunes namespace `http://www.itunes.com/DTDs/Podcast-1.0.dtd`
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"
        xmlns:itunes="http://www.itunes.com/DTDs/Podcast-1.0.dtd"
        xmlns:podcast="https://podcastindex.org/namespace/1.0"
        xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:media="http://search.yahoo.com/mrss/"
        xmlns:psc="http://podlove.org/simple-chapters"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:atom="http://www.w3.org/2005/Atom">
        <channel>
          <title>  Tech Weekly  </title>
          <link>https://tech.example.com</link>
          <language>en-US</language>
          <description>Short channel summary</description>
          <itunes:author>Ada Lovelace</itunes:author>
          <itunes:image href="https://tech.example.com/cover.png" />
          <itunes:new-feed-url>https://new.tech.example.com/rss.xml</itunes:new-feed-url>
          <podcast:funding url="https://tech.example.com/donate">Support us</podcast:funding>
          <atom:link rel="next" href="/rss.xml?page=2" />

          <item>
            <guid isPermaLink="false">ep-042</guid>
            <title>Episode 42: Compilers</title>
            <description>Short blurb</description>
            <content:encoded><![CDATA[<p>Full <strong>rich</strong> shownotes with much more detail.</p>]]></content:encoded>
            <dc:date>2025-10-20T12:00:00Z</dc:date>
            <itunes:duration>01:05:30</itunes:duration>
            <itunes:image href="/img/ep42.jpg" />
            <enclosure url="https://cdn.tech.example.com/ep42.mp3" type="audio/mpeg" length="48000000" />
            <podcast:chapters url="https://tech.example.com/ep42.chapters.json" type="application/json+chapters" />
            <podcast:transcript url="https://tech.example.com/ep42.vtt" type="text/vtt" />
            <podcast:socialInteract uri="https://mastodon.example/@ada/123" protocol="activitypub" />
            <psc:chapters version="1.2">
              <psc:chapter start="00:10:00" title="Part 2" href="https://tech.example.com/p2" />
              <psc:chapter start="00:00:00" title="Intro" image="https://tech.example.com/ch0.jpg" />
            </psc:chapters>
          </item>

          <item>
            <guid>ep-small-enc</guid>
            <title>Tiny Enclosure Size</title>
            <pubDate>Mon, 27 Oct 2025 08:00:00 GMT</pubDate>
            <enclosure url="https://cdn.tech.example.com/ep43.mp3" type="audio/mpeg" length="512" />
          </item>

          <item>
            <guid>ep-media-video</guid>
            <title>Video Episode via Media RSS</title>
            <media:content url="https://cdn.tech.example.com/ep44.mp4" type="video/mp4" fileSize="99000000" duration="600" />
            <media:thumbnail url="https://cdn.tech.example.com/ep44-thumb.jpg" />
          </item>
        </channel>
      </rss>`;

    expect(detectFeedType(rssXml)).toBe('rss20');
    const feed = parseFeed(rssXml, { baseUrl: 'https://tech.example.com/rss.xml' });
    expect(feed.title).toBe('Tech Weekly');
    expect(feed.author).toBe('Ada Lovelace');
    expect(feed.imageUrl).toBe('https://tech.example.com/cover.png');
    expect(feed.redirectUrl).toBe('https://new.tech.example.com/rss.xml');
    expect(feed.fundingUrl).toBe('https://tech.example.com/donate');
    expect(feed.nextPageUrl).toBe('https://tech.example.com/rss.xml?page=2');
    expect(feed.episodes).toHaveLength(3);

    const ep1 = feed.episodes[0]!;
    expect(ep1.identity).toBe('ep-042');
    expect(ep1.description).toContain('<strong>rich</strong>');
    expect(ep1.durationMs).toBe(3_930_000);
    expect(ep1.imageUrl).toBe('https://tech.example.com/img/ep42.jpg');
    expect(ep1.enclosureSize).toBe(48_000_000);
    expect(ep1.mediaType).toBe('AUDIO');
    expect(ep1.chaptersUrl).toBe('https://tech.example.com/ep42.chapters.json');
    expect(ep1.transcriptUrl).toBe('https://tech.example.com/ep42.vtt');
    expect(ep1.link).toBe('https://mastodon.example/@ada/123');
    // PSC chapters sorted by startMs
    expect(ep1.chapters).toEqual([
      { startMs: 0, title: 'Intro', imageUrl: 'https://tech.example.com/ch0.jpg', source: 'PSC' },
      { startMs: 600_000, title: 'Part 2', link: 'https://tech.example.com/p2', source: 'PSC' },
    ]);

    // Enclosure < 16384 bytes is NOT dropped; only bogus small `enclosureSize` is omitted (AntennaPod Rss20.java)
    const ep2 = feed.episodes[1]!;
    expect(ep2.enclosureUrl).toBe('https://cdn.tech.example.com/ep43.mp3');
    expect(ep2.enclosureSize).toBeUndefined();

    // Media RSS video enclosure
    const ep3 = feed.episodes[2]!;
    expect(ep3.mediaType).toBe('VIDEO');
    expect(ep3.durationMs).toBe(600_000);
    expect(ep3.imageUrl).toBe('https://cdn.tech.example.com/ep44-thumb.jpg');
  });

  it('parses RSS 0.91/0.92, Atom 1.0 (incl. RFC 5005 rel="next" & XHTML content), and RDF 1.0', () => {
    const rss091 = `<rss version="0.91"><channel><title>Retro</title><item><title>Old Ep</title><enclosure url="http://ex.com/a.mp3" type="audio/mpeg" length="20000"/></item></channel></rss>`;
    expect(TypeDetector.detect(rss091)).toBe('rss091');
    expect(SyndParser.parse(rss091).episodes[0]?.identity).toBe('http://ex.com/a.mp3');

    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Cast</title>
        <subtitle>Sub</subtitle>
        <logo>https://atom.example/logo.png</logo>
        <link rel="alternate" href="https://atom.example/" />
        <link rel="next" href="page-2.atom" />
        <link rel="payment" href="https://atom.example/tip" />
        <author><name>Grace Hopper</name></author>
        <entry>
          <id>tag:atom.example,2025:1</id>
          <title>Atom Entry 1</title>
          <published>2025-05-01T00:00:00Z</published>
          <link rel="enclosure" href="/audio/1.ogg" type="audio/ogg" length="32768" />
          <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <em>XHTML</em></p></div></content>
        </entry>
      </feed>`;

    const parsedAtom = parseFeed(atom, { baseUrl: 'https://atom.example/feed.atom' });
    expect(parsedAtom.type).toBe('atom');
    expect(parsedAtom.author).toBe('Grace Hopper');
    expect(parsedAtom.nextPageUrl).toBe('https://atom.example/page-2.atom');
    expect(parsedAtom.fundingUrl).toBe('https://atom.example/tip');
    expect(parsedAtom.episodes[0]?.enclosureUrl).toBe('https://atom.example/audio/1.ogg');
    expect(parsedAtom.episodes[0]?.description).toContain('<p>Hello <em>XHTML</em></p>');

    const rdf = `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
               xmlns="http://purl.org/rss/1.0/"
               xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel rdf:about="https://rdf.example/">
          <title>RDF 1.0 Feed</title>
          <link>https://rdf.example/</link>
          <description>Semantic Web</description>
        </channel>
        <item rdf:about="https://rdf.example/ep1">
          <title>RDF Episode</title>
          <link>https://rdf.example/ep1</link>
          <dc:date>2025-01-15T10:00:00Z</dc:date>
        </item>
      </rdf:RDF>`;

    const parsedRdf = parseFeed(rdf);
    expect(parsedRdf.type).toBe('rdf');
    expect(parsedRdf.title).toBe('RDF 1.0 Feed');
    expect(parsedRdf.episodes[0]?.pubDate).toBe(Date.UTC(2025, 0, 15, 10, 0, 0));
  });
});

describe('feed/identity, HtmlFeedDiscoverer & Opml', () => {
  it('derives episodeIdentity fallback order and episodeKey matching WebCrypto SHA-1', async () => {
    expect(
      episodeIdentity({ guid: 'g-1', enclosureUrl: 'https://x/a.mp3', title: 'T', pubDate: 100 }),
    ).toBe('g-1');
    expect(episodeIdentity({ guid: '  ', enclosureUrl: 'https://x/a.mp3', title: 'T', pubDate: 100 })).toBe(
      'https://x/a.mp3',
    );
    expect(episodeIdentity({ title: 'Title Only', pubDate: 1700000000000 })).toBe(
      'Title Only|1700000000000',
    );

    const ek = episodeKey('f_abc', 'g-1');
    expect(ek).toMatch(/^e_[0-9a-f]{40}$/);
    expect(await episodeKeyAsync('f_abc', 'g-1')).toBe(ek);
  });

  it('discovers RSS and Atom links in HTML while ignoring stylesheets and comments', () => {
    const html = `<!doctype html><html><head>
      <!-- <link rel="alternate" type="application/rss+xml" href="/commented.xml"> -->
      <link rel="stylesheet" href="/style.css">
      <link href='/feeds/rss' rel='alternate' type='application/rss+xml; charset=utf-8' title='RSS &amp; Audio'>
      <link type="application/atom+xml" rel="feed alternate" href="https://cdn.example.org/atom.xml">
    </head></html>`;

    expect(HtmlFeedDiscoverer.discover(html, 'https://example.org/podcast/index.html')).toEqual(
      discoverFeeds(html, 'https://example.org/podcast/index.html'),
    );
    expect(discoverFeeds(html, 'https://example.org/podcast/index.html')).toEqual([
      { url: 'https://example.org/feeds/rss', type: 'application/rss+xml', title: 'RSS & Audio' },
      { url: 'https://cdn.example.org/atom.xml', type: 'application/atom+xml' },
    ]);
  });

  it('round-trips OPML 2.0, flattens nested category outlines, and omits LOCAL folder feeds', () => {
    const exported = writeOpml(
      [
        { url: 'https://a.example/rss.xml', title: 'Show A & B', link: 'https://a.example', kind: 'RSS', subscribed: true },
        { url: 'local-folder:/music/podcasts', title: 'Local Folder', kind: 'LOCAL', subscribed: true },
        { url: 'https://stub.example/rss.xml', title: 'Unsubscribed Stub', kind: 'RSS', subscribed: false },
      ],
      { dateCreatedMs: Date.UTC(2025, 9, 30, 12, 0, 0) },
    );

    expect(exported).toContain('<opml version="2.0">');
    expect(exported).not.toContain('local-folder:');
    expect(exported).not.toContain('stub.example');

    const reimported = readOpml(exported);
    expect(reimported).toEqual([
      {
        title: 'Show A & B',
        xmlUrl: 'https://a.example/rss.xml',
        htmlUrl: 'https://a.example',
        type: 'rss',
      },
    ]);

    const nestedOpml = `<opml version="1.0"><body>
      <outline text="Tech">
        <outline text="Fallback Text" xmlUrl="https://nested.example/feed.xml" />
      </outline>
    </body></opml>`;
    expect(Opml.parse(nestedOpml)).toEqual(parseOpml(nestedOpml));
    expect(parseOpml(nestedOpml)).toEqual([
      { title: 'Fallback Text', xmlUrl: 'https://nested.example/feed.xml' },
    ]);
  });
});
