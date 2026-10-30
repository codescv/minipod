import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeBase64,
  decodeIso88591,
  encodeBase64,
  encodeIso88591,
  extractUrlCredentials,
  extractUrlFromSharedText,
  formatRfc822Date,
  generateDeviceId,
  gzipCompress,
  gzipDecompress,
  isGzipBase64,
  isGzipBytes,
  looksLikeUrl,
  parseChapterTimestampMs,
  parseDurationMs,
  parsePubDateMs,
  resolveRelativeUrl,
  sha1Hex,
  sha1HexSync,
} from './index';

describe('util/sha1', () => {
  it('matches standard FIPS 180-4 vectors and WebCrypto across sync & async', async () => {
    const vectors: readonly [string, string][] = [
      ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
      ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
      ],
      ['MiniPod 播客 ポッドキャスト 🎧', ''],
    ];

    for (const [input, expected] of vectors) {
      const asyncDigest = await sha1Hex(input);
      const syncDigest = sha1HexSync(input);
      expect(syncDigest).toBe(asyncDigest);
      if (expected) {
        expect(asyncDigest).toBe(expected);
      }
    }

    // Multi-block binary buffer (> 8 KB) and non-zero byteOffset subarray
    const big = new Uint8Array(9_001);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const sub = big.subarray(13, 8_500);
    expect(sha1HexSync(sub)).toBe(await sha1Hex(sub));
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xa5, 0xff]))).toBe('000fa5ff');
  });

  it('generates valid d_<32 hex> device IDs', () => {
    const id1 = generateDeviceId();
    const id2 = generateDeviceId();
    expect(id1).toMatch(/^d_[0-9a-f]{32}$/);
    expect(id2).toMatch(/^d_[0-9a-f]{32}$/);
    expect(id1).not.toBe(id2);
  });
});

describe('util/base64', () => {
  it('round-trips empty, unpadded URL-safe, all byte values, and >100KB buffers', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
    expect(decodeBase64('')).toEqual(new Uint8Array(0));

    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const b64 = encodeBase64(allBytes);
    expect(decodeBase64(b64)).toEqual(allBytes);

    // URL-safe base64 without '=' padding
    const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeBase64(urlSafe)).toEqual(allBytes);

    // Large buffer (> 128 KB, exceeds single 0x8000 chunk)
    const large = new Uint8Array(140_000);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
    expect(decodeBase64(encodeBase64(large))).toEqual(large);
  });

  it('encodes and decodes ISO-8859-1 following Java getBytes("ISO-8859-1")', () => {
    const latin = 'café:müller';
    const bytes = encodeIso88591(latin);
    expect(decodeIso88591(bytes)).toBe(latin);

    // Non-ISO-8859-1 code points map to '?' (0x3f)
    const nonLatin = encodeIso88591('a播b');
    expect(Array.from(nonLatin)).toEqual([0x61, 0x3f, 0x62]);
  });
});

describe('util/gzip', () => {
  it('compresses and decompresses >850KB payload cleanly without stream backpressure deadlock', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const repeated = '{"episode":"ep_12345","positionMs":42000,"state":"IN_PROGRESS"},'.repeat(14_000);
    const rawBytes = encoder.encode(`[${repeated}{}]`);
    expect(rawBytes.byteLength).toBeGreaterThan(850 * 1024);

    const compressed = await gzipCompress(rawBytes);
    expect(isGzipBytes(compressed)).toBe(true);
    const b64 = encodeBase64(compressed);
    expect(isGzipBase64(b64)).toBe(true);
    expect(compressed.byteLength).toBeLessThan(rawBytes.byteLength / 10);

    const restored = await gzipDecompress(decodeBase64(b64));
    expect(decoder.decode(restored)).toBe(decoder.decode(rawBytes));
  });
});

describe('util/url', () => {
  it('extracts URL userInfo credentials and strips them from the URL', () => {
    const res = extractUrlCredentials('https://alice%40mail.com:s3cr%3At@feeds.example.com/private.xml?x=1');
    expect(res.cleanUrl).toBe('https://feeds.example.com/private.xml?x=1');
    expect(res.credentials).toEqual({
      username: 'alice@mail.com',
      password: 's3cr:t',
    });

    const plain = extractUrlCredentials('https://feeds.example.com/public.xml');
    expect(plain.cleanUrl).toBe('https://feeds.example.com/public.xml');
    expect(plain.credentials).toBeUndefined();
  });

  it('resolves relative URLs and extracts URLs from shared text', () => {
    expect(resolveRelativeUrl('/rss/podcast.xml', 'https://example.org/blog/post')).toBe(
      'https://example.org/rss/podcast.xml',
    );
    expect(
      extractUrlFromSharedText('Listen to this show: itpc://feeds.example.com/show.rss!'),
    ).toBe('itpc://feeds.example.com/show.rss');
    expect(extractUrlFromSharedText('just plain search keywords')).toBeUndefined();

    expect(looksLikeUrl('relay.fm/cortex')).toBe(true);
    expect(looksLikeUrl('pcast:https://example.com/rss')).toBe(true);
    expect(looksLikeUrl('hardcore history')).toBe(false);
  });
});

describe('util/time', () => {
  it('parses itunes:duration and NPT chapter timestamps with millisecond precision', () => {
    expect(parseDurationMs('01:02:03')).toBe(3_723_000);
    expect(parseDurationMs('45:10')).toBe(2_710_000);
    expect(parseDurationMs('125.5')).toBe(125_500);
    expect(parseDurationMs(90)).toBe(90_000);
    expect(parseDurationMs('0')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();

    // Preserves fractional milliseconds without upstream float->long truncation
    expect(parseChapterTimestampMs('00:00:12.850')).toBe(12_850);
    expect(parseChapterTimestampMs('01:02:03.45')).toBe(3_723_450);
    expect(parseChapterTimestampMs('00:05.250 --> 00:10.000')).toBe(5_250);
    expect(parseChapterTimestampMs('0')).toBe(0);
  });

  it('parses RFC 2822 (including named TZ & wrong weekday), ISO-8601, and ignores 1904 placeholder', () => {
    // Mismatched weekday ("Fri" on a Monday) + named "EDT" (-0400)
    const edt = parsePubDateMs('Fri, 27 Oct 2025 10:30:00 EDT');
    expect(edt).toBe(Date.UTC(2025, 9, 27, 14, 30, 0));

    expect(parsePubDateMs('2025-10-27T14:30:00Z')).toBe(Date.UTC(2025, 9, 27, 14, 30, 0));
    expect(parsePubDateMs('20251027T143000Z')).toBe(Date.UTC(2025, 9, 27, 14, 30, 0));
    expect(parsePubDateMs('1904-01-01T00:00:00Z')).toBeUndefined();

    const formatted = formatRfc822Date(Date.UTC(2025, 9, 27, 14, 30, 0));
    expect(formatted).toBe('Mon, 27 Oct 2025 14:30:00 +0000');
    expect(parsePubDateMs(formatted)).toBe(Date.UTC(2025, 9, 27, 14, 30, 0));
  });
});
