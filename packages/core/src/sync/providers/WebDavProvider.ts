import { MiniPodError } from '../../errors';
import { encodeBasicAuthHeaders } from '../../http/basicAuth';
import { DEFAULT_USER_AGENT } from '../../http/userAgent';
import type {
  CloudFileProvider,
  HttpBasicCredentials,
  HttpClient,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  ProbeResult,
  ReadResult,
  WriteResult,
} from '../../types';
import { bytesToHex } from '../../util/sha1';

export interface WebDavProviderDeps {
  readonly fileUrl: string;
  readonly username: string;
  readonly password: string;
  readonly http: HttpClient;
  readonly userAgent?: string;
}

const utf8Encoder = new TextEncoder();

// Compact pure-TS RFC 1321 MD5 used strictly for HTTP Digest Authentication challenges on WebDAV servers
const MD5_S: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K: Uint32Array = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000) >>> 0;
  }
  return k;
})();

export function md5Hex(input: string): string {
  const msg = utf8Encoder.encode(input);
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (len * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((len * 8) / 0x1_0000_0000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(off + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i]! + m[g]!) >>> 0;
      const s = MD5_S[i]!;
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return bytesToHex(out);
}

function buildDigestAuthorization(
  challengeHeader: string,
  method: HttpMethod,
  requestUrl: string,
  creds: HttpBasicCredentials,
  ncCounter: number,
): string | undefined {
  if (!/^Digest\s+/i.test(challengeHeader.trim())) return undefined;
  const params: Record<string, string> = {};
  const paramRe = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(challengeHeader)) !== null) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }

  const realm = params['realm'];
  const nonce = params['nonce'];
  if (!realm || !nonce) return undefined;

  let uri = '/';
  try {
    const u = new URL(requestUrl);
    uri = `${u.pathname}${u.search}`;
  } catch {
    // default '/'
  }

  const qopRaw = params['qop'];
  const qopTokens = qopRaw ? qopRaw.split(',').map((s) => s.trim()) : [];
  const qop = qopTokens.includes('auth') ? 'auth' : undefined;
  const cnonceBytes = new Uint8Array(8);
  crypto.getRandomValues(cnonceBytes);
  const cnonce = bytesToHex(cnonceBytes);
  const nc = ncCounter.toString(16).padStart(8, '0');

  let ha1 = md5Hex(`${creds.username}:${realm}:${creds.password}`);
  if (params['algorithm']?.toUpperCase() === 'MD5-SESS') {
    ha1 = md5Hex(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = md5Hex(`${method}:${uri}`);
  const response = qop
    ? md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5Hex(`${ha1}:${nonce}:${ha2}`);

  const fields = [
    `username="${creds.username.replace(/"/g, '\\"')}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) {
    fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (params['opaque']) {
    fields.push(`opaque="${params['opaque']}"`);
  }
  return `Digest ${fields.join(', ')}`;
}

/**
 * WebDAV `CloudFileProvider` storing raw UTF-8 JSON (never gzipped) with native
 * `ETag`, `If-None-Match`, and `If-Match` / `If-None-Match: *` preconditions
 * (ARCHITECTURE.md §7.1, §8.2).
 */
export class WebDavProvider implements CloudFileProvider {
  readonly id = 'webdav' as const;
  readonly supportsNativeConditionalWrite = true;
  readonly supportsCheapHead = true;

  private readonly fileUrl: string;
  private readonly credentials: HttpBasicCredentials;
  private readonly http: HttpClient;
  private readonly userAgent: string;
  private digestNonceCount = 0;

  constructor(deps: WebDavProviderDeps) {
    this.fileUrl = deps.fileUrl.trim();
    this.credentials = { username: deps.username, password: deps.password };
    this.http = deps.http;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  private async send(
    method: HttpMethod,
    extraHeaders: Record<string, string>,
    body?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const basicCandidates = encodeBasicAuthHeaders(this.credentials);
    const primaryBasic = basicCandidates[0]!;

    const baseReq: HttpRequest = {
      url: this.fileUrl,
      method,
      headers: {
        ...extraHeaders,
        Authorization: primaryBasic,
        'User-Agent': this.userAgent,
      },
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    };

    const first = await this.http(baseReq);
    if (first.status !== 401) {
      return first;
    }

    // Check Digest Auth challenge first if advertised
    const wwwAuth = first.headers['www-authenticate'];
    if (wwwAuth && /^Digest\s+/i.test(wwwAuth.trim())) {
      this.digestNonceCount += 1;
      const digestHeader = buildDigestAuthorization(
        wwwAuth,
        method,
        first.finalUrl || this.fileUrl,
        this.credentials,
        this.digestNonceCount,
      );
      if (digestHeader) {
        return this.http({
          ...baseReq,
          url: first.finalUrl || this.fileUrl,
          headers: {
            ...extraHeaders,
            Authorization: digestHeader,
            'User-Agent': this.userAgent,
          },
        });
      }
    }

    // Try UTF-8 Basic Auth fallback if non-ASCII credentials differed from ISO-8859-1
    if (basicCandidates.length > 1) {
      return this.http({
        ...baseReq,
        url: first.finalUrl || this.fileUrl,
        headers: {
          ...extraHeaders,
          Authorization: basicCandidates[1]!,
          'User-Agent': this.userAgent,
        },
      });
    }

    return first;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const resp = await this.send('HEAD', {}, undefined, signal);
      if (resp.status === 404) {
        return { ok: true, exists: false, etag: null };
      }
      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          exists: false,
          etag: null,
          error: new MiniPodError('sync-auth', `WebDAV authentication failed (HTTP ${resp.status})`).toShape(),
        };
      }
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, exists: true, etag: resp.headers['etag'] ?? null };
      }
      return {
        ok: false,
        exists: false,
        etag: null,
        error: new MiniPodError('network', `WebDAV probe failed (HTTP ${resp.status})`).toShape(),
      };
    } catch (err) {
      return {
        ok: false,
        exists: false,
        etag: null,
        error: MiniPodError.wrap(err, 'network').toShape(),
      };
    }
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    const resp = await this.send('HEAD', {}, undefined, signal);
    if (resp.status === 404) return null;
    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('sync-auth', `WebDAV unauthorized (HTTP ${resp.status})`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `WebDAV HEAD failed (HTTP ${resp.status})`);
    }
    return resp.headers['etag'] ?? null;
  }

  async read(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ReadResult> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (ifNoneMatch !== null) {
      headers['If-None-Match'] = ifNoneMatch;
    }

    const resp = await this.send('GET', headers, undefined, signal);
    if (resp.status === 304) {
      return { kind: 'not-modified' };
    }
    if (resp.status === 404) {
      return { kind: 'missing' };
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new MiniPodError('sync-auth', `WebDAV unauthorized (HTTP ${resp.status})`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `WebDAV GET failed (HTTP ${resp.status})`);
    }

    const bytes = await resp.bytes();
    const lastModHeader = resp.headers['last-modified'];
    const lastModMs = lastModHeader ? Date.parse(lastModHeader) : Number.NaN;
    return {
      kind: 'blob',
      bytes,
      etag: resp.headers['etag'] ?? null,
      ...(Number.isFinite(lastModMs) ? { lastModified: lastModMs } : {}),
    };
  }

  async write(bytes: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<WriteResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
      };
      if (ifMatch === null) {
        headers['If-None-Match'] = '*';
      } else {
        headers['If-Match'] = ifMatch;
      }

      const resp = await this.send('PUT', headers, bytes, signal);
      if (resp.status === 412) {
        return { kind: 'conflict' };
      }
      if (resp.status === 401 || resp.status === 403) {
        return {
          kind: 'failed',
          cause: new MiniPodError('sync-auth', `WebDAV PUT unauthorized (HTTP ${resp.status})`),
          retryable: false,
        };
      }
      if (resp.status >= 200 && resp.status < 300) {
        let newEtag = resp.headers['etag'] ?? null;
        if (!newEtag) {
          newEtag = await this.head(signal).catch(() => null);
        }
        return { kind: 'ok', newEtag };
      }
      return {
        kind: 'failed',
        cause: new MiniPodError('network', `WebDAV PUT failed (HTTP ${resp.status})`),
        retryable: resp.status >= 500 || resp.status === 429 || resp.status === 423,
      };
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      return {
        kind: 'failed',
        cause: wrapped,
        retryable: wrapped.code !== 'sync-auth' && wrapped.code !== 'cancelled',
      };
    }
  }

  async deleteRemote(signal?: AbortSignal): Promise<void> {
    const resp = await this.send('DELETE', {}, undefined, signal);
    if (resp.status !== 404 && (resp.status < 200 || resp.status >= 300)) {
      if (resp.status === 401 || resp.status === 403) {
        throw new MiniPodError('sync-auth', `WebDAV DELETE unauthorized (HTTP ${resp.status})`);
      }
      throw new MiniPodError('network', `WebDAV DELETE failed (HTTP ${resp.status})`);
    }
  }
}

export function createWebDavProvider(deps: WebDavProviderDeps): WebDavProvider {
  return new WebDavProvider(deps);
}
