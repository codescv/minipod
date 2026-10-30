/**
 * HTTP 206 Byte-Range media proxy & embedded chapter/cover art responder
 * (`ARCHITECTURE.md §3.2`, `§4.4`).
 *
 * Serves:
 * - `GET|HEAD /media/:episodeKey`: streams local downloaded/folder files directly with
 *   RFC 9110 Range slicing (`200`/`206`/`416`), or proxies remote podcast enclosures
 *   with `Range` forwarding, Basic Auth (`ISO-8859-1` -> `UTF-8` + cross-host redirect
 *   re-injection), session-cached redirect final URLs, and MIME normalization.
 * - `GET|HEAD /api/episodes/:episodeKey/chapters/:index/image`: serves ID3 `APIC` byte
 *   slices (`[offset, offset + length - 1]`) with `Cache-Control: public, max-age=31536000, immutable`.
 * - `GET|HEAD /api/feeds/:feedKey/cover`: serves local-folder `folder.jpg`/`folder.png`
 *   or embedded audio cover art.
 */
import {
  encodeBasicAuthHeaders,
  extractUrlCredentials,
  inferMediaMimeType,
  MiniPodError,
  parseMediaMetadata,
  type Chapter,
  type EpisodeKey,
  type FeedKey,
  type HttpBasicCredentials,
  type HttpClient,
} from '@minipod/core';
import { createReadStream, existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

export type ParsedByteRange =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

/**
 * Parses a single RFC 9110 `Range: bytes=...` header against `totalSize`.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined | null,
  totalSize: number,
): ParsedByteRange {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { kind: 'none' };
  }
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return { kind: 'none' };
  }
  const spec = trimmed.slice('bytes='.length).trim();
  // Multi-part ranges fall back to full 200 response per RFC 9110 §14.2
  if (spec.includes(',')) {
    return { kind: 'none' };
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) {
    return { kind: 'unsatisfiable' };
  }
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { kind: 'unsatisfiable' };
  }
  if (totalSize <= 0) {
    return { kind: 'unsatisfiable' };
  }

  if (!rawStart) {
    // Suffix range `bytes=-N`
    const suffixLen = Number.parseInt(rawEnd!, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, totalSize - suffixLen);
    return { kind: 'ok', start, end: totalSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
    return { kind: 'unsatisfiable' };
  }

  if (!rawEnd) {
    return { kind: 'ok', start, end: totalSize - 1 };
  }

  const parsedEnd = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) {
    return { kind: 'unsatisfiable' };
  }
  const end = Math.min(totalSize - 1, parsedEnd);
  return { kind: 'ok', start, end };
}

export function readLocalFileSliceSync(
  filePath: string,
  start: number,
  endInclusive?: number,
): Uint8Array {
  const st = statSync(filePath);
  if (!st.isFile() || st.size === 0 || start >= st.size) {
    return new Uint8Array(0);
  }
  const safeStart = Math.max(0, Math.trunc(start));
  const safeEnd =
    endInclusive !== undefined
      ? Math.min(st.size - 1, Math.max(safeStart, Math.trunc(endInclusive)))
      : st.size - 1;
  const length = safeEnd - safeStart + 1;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  try {
    const bytesRead = readSync(fd, buf, 0, length, safeStart);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function serveLocalFileRange(params: {
  readonly method: 'GET' | 'HEAD';
  readonly rangeHeader?: string | undefined;
  readonly filePath: string;
  readonly declaredMime?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}): Response {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(params.filePath);
  } catch {
    return new Response('Media file not found', { status: 404 });
  }
  if (!st.isFile()) {
    return new Response('Media file not found', { status: 404 });
  }

  const totalSize = st.size;
  const contentType =
    inferMediaMimeType(params.declaredMime, params.filePath) ?? 'application/octet-stream';
  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    ...params.extraHeaders,
  };

  const range = parseRangeHeader(params.rangeHeader, totalSize);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes */${totalSize}`,
      },
    });
  }

  const status = range.kind === 'ok' ? 206 : 200;
  const start = range.kind === 'ok' ? range.start : 0;
  const end = range.kind === 'ok' ? range.end : Math.max(0, totalSize - 1);
  const contentLength = totalSize === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    ...baseHeaders,
    'Content-Length': String(contentLength),
  };
  if (range.kind === 'ok') {
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
  }

  if (params.method === 'HEAD' || contentLength === 0) {
    return new Response(null, { status, headers });
  }

  const nodeStream = createReadStream(params.filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status, headers });
}

export interface MediaProxyEpisodeInfo {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly isLocalFeed: boolean;
  readonly enclosureUrl?: string;
  readonly enclosureMime?: string;
  readonly downloadState: string;
  readonly downloadPath?: string;
  readonly credentials?: HttpBasicCredentials;
}

export interface MediaProxyDeps {
  readonly fetchImpl?: typeof fetch;
  readonly http: HttpClient;
  readonly userAgent: string;
  readonly resolveEpisode: (episodeKey: EpisodeKey) => MediaProxyEpisodeInfo | undefined;
  readonly loadChaptersForEpisode: (episodeKey: EpisodeKey) => Promise<readonly Chapter[]>;
  readonly resolveLocalFeedCover: (feedKey: FeedKey) => { readonly coverPath: string; readonly isAudioFile: boolean } | undefined;
}

const STREAM_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class MediaProxy {
  private readonly fetchFn: typeof fetch;
  private readonly http: HttpClient;
  private readonly userAgent: string;
  private readonly deps: MediaProxyDeps;
  /** Session-scoped cache mapping enclosure URL -> resolved final CDN URL (`ARCHITECTURE.md §3.2`). */
  private readonly resolvedUrlCache = new Map<string, string>();

  constructor(deps: MediaProxyDeps) {
    this.deps = deps;
    this.fetchFn = deps.fetchImpl ?? globalThis.fetch;
    this.http = deps.http;
    this.userAgent = deps.userAgent;
  }

  clearCache(): void {
    this.resolvedUrlCache.clear();
  }

  private getLocalFilePathForEpisode(ep: MediaProxyEpisodeInfo): string | undefined {
    if (ep.downloadState === 'DONE' && ep.downloadPath && existsSync(ep.downloadPath)) {
      return ep.downloadPath;
    }
    if (ep.isLocalFeed) {
      if (ep.downloadPath && existsSync(ep.downloadPath)) {
        return ep.downloadPath;
      }
      if (ep.enclosureUrl && !/^https?:\/\//i.test(ep.enclosureUrl) && existsSync(ep.enclosureUrl)) {
        return ep.enclosureUrl;
      }
    }
    return undefined;
  }

  async handleEpisodeMedia(params: {
    readonly episodeKey: EpisodeKey;
    readonly method: 'GET' | 'HEAD';
    readonly rangeHeader?: string | undefined;
    readonly ifRangeHeader?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<Response> {
    const ep = this.deps.resolveEpisode(params.episodeKey);
    if (!ep) {
      return new Response('Episode not found', { status: 404 });
    }

    const localPath = this.getLocalFilePathForEpisode(ep);
    if (localPath) {
      return serveLocalFileRange({
        method: params.method,
        rangeHeader: params.rangeHeader,
        filePath: localPath,
        declaredMime: ep.enclosureMime,
      });
    }

    if (!ep.enclosureUrl || !/^https?:\/\//i.test(ep.enclosureUrl)) {
      return new Response('Episode has no playable enclosure URL', { status: 404 });
    }

    return this.proxyRemoteEnclosure({
      enclosureUrl: ep.enclosureUrl,
      declaredMime: ep.enclosureMime,
      credentials: ep.credentials,
      method: params.method,
      rangeHeader: params.rangeHeader,
      ifRangeHeader: params.ifRangeHeader,
      signal: params.signal,
    });
  }

  private async proxyRemoteEnclosure(params: {
    readonly enclosureUrl: string;
    readonly declaredMime?: string | undefined;
    readonly credentials?: HttpBasicCredentials | undefined;
    readonly method: 'GET' | 'HEAD';
    readonly rangeHeader?: string | undefined;
    readonly ifRangeHeader?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<Response> {
    const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(params.enclosureUrl);
    const effectiveCreds = inlineCreds ?? params.credentials;

    const cachedFinal = this.resolvedUrlCache.get(cleanUrl);
    let result = await this.fetchStreamingWithAuth({
      startUrl: cachedFinal ?? cleanUrl,
      credentials: effectiveCreds,
      method: params.method,
      rangeHeader: params.rangeHeader,
      ifRangeHeader: params.ifRangeHeader,
      signal: params.signal,
    });

    // If a cached signed CDN URL expired (403/404/410), evict and re-resolve from the canonical enclosure URL
    if (
      cachedFinal &&
      (result.response.status === 403 || result.response.status === 404 || result.response.status === 410)
    ) {
      await result.response.body?.cancel().catch(() => undefined);
      this.resolvedUrlCache.delete(cleanUrl);
      result = await this.fetchStreamingWithAuth({
        startUrl: cleanUrl,
        credentials: effectiveCreds,
        method: params.method,
        rangeHeader: params.rangeHeader,
        ifRangeHeader: params.ifRangeHeader,
        signal: params.signal,
      });
    }

    if (result.response.status >= 200 && result.response.status < 300 && result.finalUrl !== cleanUrl) {
      this.resolvedUrlCache.set(cleanUrl, result.finalUrl);
    }

    const upstream = result.response;
    const upstreamType = upstream.headers.get('content-type') ?? undefined;
    const contentType =
      inferMediaMimeType(upstreamType, result.finalUrl) ??
      inferMediaMimeType(params.declaredMime, cleanUrl) ??
      'audio/mpeg';

    const outHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
    };

    for (const passHeader of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const val = upstream.headers.get(passHeader);
      if (val !== null) {
        outHeaders[passHeader] = val;
      }
    }

    if (params.method === 'HEAD') {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  private async fetchStreamingWithAuth(params: {
    readonly startUrl: string;
    readonly credentials?: HttpBasicCredentials | undefined;
    readonly method: 'GET' | 'HEAD';
    readonly rangeHeader?: string | undefined;
    readonly ifRangeHeader?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly response: Response; readonly finalUrl: string }> {
    const baseHeaders: Record<string, string> = {
      'User-Agent': this.userAgent,
    };
    if (params.rangeHeader) {
      baseHeaders['Range'] = params.rangeHeader;
    }
    if (params.ifRangeHeader) {
      baseHeaders['If-Range'] = params.ifRangeHeader;
    }

    const follow = async (
      initialUrl: string,
      authHeader?: string,
    ): Promise<{ readonly response: Response; readonly finalUrl: string }> => {
      let currentUrl = initialUrl;
      let currentAuth = authHeader;

      for (let hop = 0; hop <= 10; hop++) {
        const reqHeaders: Record<string, string> = { ...baseHeaders };
        if (currentAuth) {
          reqHeaders['Authorization'] = currentAuth;
        }
        const resp = await this.fetchFn(currentUrl, {
          method: params.method,
          headers: reqHeaders,
          redirect: 'manual',
          ...(params.signal ? { signal: params.signal } : {}),
        });

        if (!STREAM_REDIRECT_STATUSES.has(resp.status)) {
          return { response: resp, finalUrl: currentUrl };
        }
        const loc = resp.headers.get('location');
        if (!loc) {
          return { response: resp, finalUrl: currentUrl };
        }
        await resp.body?.cancel().catch(() => undefined);
        const resolved = extractUrlCredentials(new URL(loc, currentUrl).toString());
        if (resolved.credentials) {
          currentAuth = encodeBasicAuthHeaders(resolved.credentials)[0];
        } else if (!authHeader) {
          currentAuth = undefined;
        }
        currentUrl = resolved.cleanUrl;
      }

      throw new MiniPodError('network', `Too many media redirects for ${initialUrl}`);
    };

    let res = await follow(params.startUrl);
    if (res.response.status === 401 && params.credentials) {
      const challengeUrl = res.finalUrl || params.startUrl;
      const candidates = encodeBasicAuthHeaders(params.credentials);
      for (const candidate of candidates) {
        await res.response.body?.cancel().catch(() => undefined);
        res = await follow(challengeUrl, candidate);
        if (res.response.status !== 401) {
          break;
        }
      }
    }
    return res;
  }

  async handleChapterImage(params: {
    readonly episodeKey: EpisodeKey;
    readonly chapterIndex: number;
    readonly method: 'GET' | 'HEAD';
    readonly signal?: AbortSignal | undefined;
  }): Promise<Response> {
    if (!Number.isInteger(params.chapterIndex) || params.chapterIndex < 0) {
      return new Response('Invalid chapter index', { status: 400 });
    }

    const ep = this.deps.resolveEpisode(params.episodeKey);
    if (!ep) {
      return new Response('Episode not found', { status: 404 });
    }

    const chapters = await this.deps.loadChaptersForEpisode(params.episodeKey);
    const chapter = chapters[params.chapterIndex];
    if (!chapter) {
      return new Response('Chapter not found', { status: 404 });
    }

    if (chapter.embeddedImage) {
      const { offset, length, mime } = chapter.embeddedImage;
      if (length <= 0 || offset < 0 || length > 8 * 1024 * 1024) {
        return new Response('Invalid embedded chapter image bounds', { status: 404 });
      }

      const headers = {
        'Content-Type': mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };

      const localPath = this.getLocalFilePathForEpisode(ep);
      if (localPath) {
        const slice = readLocalFileSliceSync(localPath, offset, offset + length - 1);
        if (slice.byteLength === 0) {
          return new Response('Embedded chapter image slice empty', { status: 404 });
        }
        return new Response(
          params.method === 'HEAD' ? null : (slice as unknown as BodyInit),
          {
            status: 200,
            headers: { ...headers, 'Content-Length': String(slice.byteLength) },
          },
        );
      }

      if (!ep.enclosureUrl || !/^https?:\/\//i.test(ep.enclosureUrl)) {
        return new Response('No enclosure available for chapter image', { status: 404 });
      }

      const resp = await this.http({
        url: ep.enclosureUrl,
        method: 'GET',
        range: { start: offset, end: offset + length - 1 },
        maxBodyBytes: length + 4096,
        ...(ep.credentials ? { auth: ep.credentials } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });

      if (resp.status !== 206 && resp.status !== 200) {
        return new Response('Upstream chapter image range failed', { status: 502 });
      }
      const rawBytes = await resp.bytes();
      const slice =
        resp.status === 200
          ? rawBytes.subarray(offset, Math.min(rawBytes.byteLength, offset + length))
          : rawBytes.subarray(0, Math.min(rawBytes.byteLength, length));
      if (slice.byteLength === 0) {
        return new Response('Embedded chapter image empty', { status: 404 });
      }
      return new Response(
        params.method === 'HEAD' ? null : (slice as unknown as BodyInit),
        {
          status: 200,
          headers: { ...headers, 'Content-Length': String(slice.byteLength) },
        },
      );
    }

    if (chapter.imageUrl && /^https?:\/\//i.test(chapter.imageUrl)) {
      return new Response(null, {
        status: 302,
        headers: { Location: chapter.imageUrl },
      });
    }

    return new Response('Chapter has no image', { status: 404 });
  }

  handleFeedCover(feedKey: FeedKey, method: 'GET' | 'HEAD'): Response {
    const resolved = this.deps.resolveLocalFeedCover(feedKey);
    if (!resolved || !existsSync(resolved.coverPath)) {
      return new Response('Cover not found', { status: 404 });
    }

    if (!resolved.isAudioFile) {
      return serveLocalFileRange({
        method,
        filePath: resolved.coverPath,
        extraHeaders: { 'Cache-Control': 'private, max-age=300' },
      });
    }

    // Extract ID3 APIC cover from first audio file
    const headBytes = readLocalFileSliceSync(resolved.coverPath, 0, 512 * 1024 - 1);
    const meta = parseMediaMetadata(headBytes, 0);
    if (!meta.coverImage) {
      return new Response('No embedded cover in audio file', { status: 404 });
    }
    const { offset, length, mime } = meta.coverImage;
    const picBytes = readLocalFileSliceSync(resolved.coverPath, offset, offset + length - 1);
    if (picBytes.byteLength === 0) {
      return new Response('Empty embedded cover', { status: 404 });
    }
    return new Response(method === 'HEAD' ? null : (picBytes as unknown as BodyInit), {
      status: 200,
      headers: {
        'Content-Type': mime || 'image/jpeg',
        'Content-Length': String(picBytes.byteLength),
        'Cache-Control': 'private, max-age=300',
      },
    });
  }
}
