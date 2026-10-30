/**
 * Deterministic SHA-1, URL/scheme normalization, and identity key derivation
 * matching `@minipod/core` (ARCHITECTURE.md §4.1.2, §4.1.3, §7.2).
 */
import { LOCAL_FOLDER_URL_PREFIX, type EpisodeKey, type FeedKey } from '@minipod/core';

/** Pure synchronous SHA-1 returning 40-char lowercase hex. */
export function sha1HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const padLen = (56 - (withOne % 64) + 64) % 64;
  const totalLen = withOne + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  const rotl = (n: number, s: number): number => ((n << s) | (n >>> (32 - s))) >>> 0;

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5a827999;
      } else if (i < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8f1bbcdc;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const AP_SUBSCRIBE = 'antennapod-subscribe://';
const AP_SUBSCRIBE_DEEPLINK = 'antennapod.org/deeplink/subscribe';

export function prepareFeedUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith(LOCAL_FOLDER_URL_PREFIX)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('feed://')) return prepareFeedUrl(trimmed.slice('feed://'.length));
  if (lower.startsWith('pcast://')) return prepareFeedUrl(trimmed.slice('pcast://'.length));
  if (lower.startsWith('pcast:')) return prepareFeedUrl(trimmed.slice('pcast:'.length));
  if (lower.startsWith('itpc://')) return prepareFeedUrl(trimmed.slice('itpc://'.length));
  if (lower.startsWith('itpc:')) return prepareFeedUrl(trimmed.slice('itpc:'.length));
  if (lower.startsWith(AP_SUBSCRIBE)) return prepareFeedUrl(trimmed.slice(AP_SUBSCRIBE.length));

  if (lower.includes(AP_SUBSCRIBE_DEEPLINK)) {
    const withScheme = lower.startsWith('http://') || lower.startsWith('https://') ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      const target = parsed.searchParams.get('url');
      if (target) return prepareFeedUrl(decodeURIComponent(target));
    } catch {
      // ignore
    }
  }

  if (lower.includes('subscribeonandroid.com/')) {
    const nested = trimmed.replace(
      /^(?:https?:\/\/)?(?:www\.)?subscribeonandroid\.com\/(?=https?:\/\/|feed:\/\/|itpc:\/\/|pcast:)/i,
      '',
    );
    if (nested !== trimmed) return prepareFeedUrl(nested);
    return prepareFeedUrl(trimmed.replace(/(?:www\.)?subscribeonandroid\.com\//i, ''));
  }

  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export function schemeLessCanonical(rawUrl: string): string {
  const prepared = prepareFeedUrl(rawUrl);
  const parsed = new URL(prepared);
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '';
  const host = `${hostname}${port}`;

  const segments = parsed.pathname.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else resolved.push(seg);
  }
  const path = resolved.join('/');

  const qIndex = prepared.indexOf('?');
  let query = '';
  if (qIndex >= 0) {
    const hashIndex = prepared.indexOf('#', qIndex);
    query = (hashIndex >= 0 ? prepared.slice(qIndex + 1, hashIndex) : prepared.slice(qIndex + 1)).trim();
  }
  return query.length > 0 ? `${host}/${path}?${query}` : `${host}/${path}`;
}

export function deriveFeedKey(rawUrl: string): FeedKey {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
    return `l_${sha1HexSync(trimmed.slice(LOCAL_FOLDER_URL_PREFIX.length))}`;
  }
  return `f_${sha1HexSync(schemeLessCanonical(trimmed))}`;
}

export function deriveEpisodeKey(feedKey: FeedKey, identity: string): EpisodeKey {
  return `e_${sha1HexSync(`${feedKey}\n${identity}`)}`;
}

/**
 * Detects whether unified Add input is a URL / podcast scheme / Apple link / website
 * rather than plain search text (DESIGN.md §4.2).
 */
export function looksLikeUrlInput(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^(https?:\/\/|itpc:\/\/|itpc:|pcast:\/\/|pcast:|feed:\/\/|antennapod-subscribe:\/\/)/i.test(s)) {
    return true;
  }
  if (/^(podcasts\.apple\.com|itunes\.apple\.com|subscribeonandroid\.com|antennapod\.org\/deeplink)/i.test(s)) {
    return true;
  }
  // Domain with a path or common feed TLD, e.g. `example.com/feed.xml` or `atp.fm/rss`
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*|\.(xml|rss|atom))$/i.test(s)) {
    return true;
  }
  return false;
}
