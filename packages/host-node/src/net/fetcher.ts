/**
 * Node `HttpClient` over built-in `fetch` (`ARCHITECTURE.md §4.0`, `§4.3`).
 *
 * Guarantees:
 * - Manual `redirect: 'manual'` loop recording every hop in `chain: [{ status, url, location }]`
 *   so `RedirectRecorder` can distinguish permanent (`301`/`308`/`http->https`) vs temporary (`302`/`307`) hops.
 * - Extracts inline URL `userInfo` (`https://user:pass@host/rss`) before calling `fetch` (Node's
 *   WHATWG `fetch` rejects URLs containing credentials).
 * - Two-stage Basic Auth challenge-response matching AntennaPod's `BasicAuthorizationInterceptor`:
 *   on HTTP 401, tries `ISO-8859-1` encoding first, then `UTF-8`, and re-injects `Authorization`
 *   at `finalUrl` when a cross-host redirect stripped it.
 * - Byte-range header formatting (`Range: bytes=start-end` / `bytes=start-`).
 * - Streaming `maxBodyBytes` enforcement (cancels response body immediately if exceeded).
 */
import {
  DEFAULT_USER_AGENT,
  encodeBasicAuthHeaders,
  extractUrlCredentials,
  MiniPodError,
  type HttpBasicCredentials,
  type HttpClient,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  type RedirectHop,
} from '@minipod/core';

export interface NodeHttpClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
  readonly defaultTimeoutMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const utf8Decoder = new TextDecoder('utf-8');

function sameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

export function formatRangeHeader(range: { readonly start: number; readonly end?: number }): string {
  const start = Math.max(0, Math.trunc(range.start));
  if (range.end !== undefined) {
    const end = Math.max(start, Math.trunc(range.end));
    return `bytes=${start}-${end}`;
  }
  return `bytes=${start}-`;
}

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>> | undefined,
  targetName: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function omitHeaderCaseInsensitive(
  headers: Record<string, string>,
  targetName: string,
): Record<string, string> {
  const lower = targetName.toLowerCase();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) {
      out[k] = v;
    }
  }
  return out;
}

async function readBodyBytesWithCap(
  response: Response,
  maxBodyBytes: number | undefined,
): Promise<Uint8Array> {
  if (maxBodyBytes !== undefined) {
    const clRaw = response.headers.get('content-length');
    if (clRaw !== null) {
      const cl = Number.parseInt(clRaw, 10);
      if (Number.isFinite(cl) && cl > maxBodyBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new MiniPodError(
          'invalid-argument',
          `Response Content-Length (${cl}) exceeds maxBodyBytes (${maxBodyBytes})`,
          { details: { contentLength: cl, maxBodyBytes } },
        );
      }
    }
  }

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (maxBodyBytes !== undefined && total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MiniPodError(
          'invalid-argument',
          `Response body exceeded maxBodyBytes (${maxBodyBytes})`,
          { details: { maxBodyBytes } },
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MiniPodError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MiniPodError('cancelled', err.message, { cause: err });
    }
    throw new MiniPodError('network', err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

interface RawRedirectResult {
  readonly response: Response;
  readonly finalUrl: string;
  readonly chain: readonly RedirectHop[];
}

async function executeManualRedirectFetch(params: {
  readonly fetchFn: typeof fetch;
  readonly startUrl: string;
  readonly method: HttpMethod;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array | undefined;
  readonly maxRedirects: number;
  readonly signal: AbortSignal;
  readonly preserveAuthAcrossOrigins: boolean;
}): Promise<RawRedirectResult> {
  let currentUrl = params.startUrl;
  let currentMethod: HttpMethod = params.method;
  let currentBody = params.body;
  let currentHeaders = { ...params.headers };
  const chain: RedirectHop[] = [];

  for (let hopCount = 0; ; hopCount++) {
    let fetchBody: BodyInit | null = null;
    if (currentBody !== undefined && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
      fetchBody =
        typeof currentBody === 'string'
          ? currentBody
          : new Uint8Array(currentBody.buffer, currentBody.byteOffset, currentBody.byteLength) as unknown as BodyInit;
    }

    let resp: Response;
    try {
      resp = await params.fetchFn(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body: fetchBody,
        redirect: 'manual',
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new MiniPodError('cancelled', err.message, { cause: err });
      }
      throw new MiniPodError('network', err instanceof Error ? err.message : String(err), {
        cause: err,
        details: { url: currentUrl },
      });
    }

    if (!REDIRECT_STATUSES.has(resp.status) || params.maxRedirects <= 0) {
      return { response: resp, finalUrl: currentUrl, chain };
    }

    const locationHeader = resp.headers.get('location');
    if (!locationHeader) {
      return { response: resp, finalUrl: currentUrl, chain };
    }

    await resp.body?.cancel().catch(() => undefined);

    if (hopCount >= params.maxRedirects) {
      throw new MiniPodError(
        'network',
        `Too many redirects (exceeded ${params.maxRedirects}) fetching ${params.startUrl}`,
        { details: { maxRedirects: params.maxRedirects, url: currentUrl } },
      );
    }

    let resolvedNext: string;
    let hopCredentials: HttpBasicCredentials | undefined;
    try {
      const nextRaw = new URL(locationHeader, currentUrl).toString();
      const extracted = extractUrlCredentials(nextRaw);
      resolvedNext = extracted.cleanUrl;
      hopCredentials = extracted.credentials;
    } catch (err) {
      throw new MiniPodError('invalid-url', `Invalid redirect Location: ${locationHeader}`, {
        cause: err,
      });
    }

    chain.push({
      status: resp.status,
      url: currentUrl,
      location: resolvedNext,
    });

    if (
      resp.status === 303 ||
      ((resp.status === 301 || resp.status === 302) && currentMethod === 'POST')
    ) {
      currentMethod = 'GET';
      currentBody = undefined;
      currentHeaders = omitHeaderCaseInsensitive(currentHeaders, 'content-length');
      currentHeaders = omitHeaderCaseInsensitive(currentHeaders, 'content-type');
    }

    if (!params.preserveAuthAcrossOrigins && !sameOrigin(currentUrl, resolvedNext)) {
      currentHeaders = omitHeaderCaseInsensitive(currentHeaders, 'authorization');
    }

    if (hopCredentials) {
      const encoded = encodeBasicAuthHeaders(hopCredentials)[0]!;
      currentHeaders = {
        ...omitHeaderCaseInsensitive(currentHeaders, 'authorization'),
        Authorization: encoded,
      };
    }

    currentUrl = resolvedNext;
  }
}

export function createNodeHttpClient(options?: NodeHttpClientOptions): HttpClient {
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const defaultUa = options?.userAgent ?? DEFAULT_USER_AGENT;
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function nodeHttpClient(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) {
      throw new MiniPodError('cancelled', 'HTTP request aborted');
    }

    let extracted: { cleanUrl: string; credentials?: HttpBasicCredentials };
    try {
      extracted = extractUrlCredentials(request.url);
    } catch (err) {
      throw new MiniPodError('invalid-url', `Invalid URL: ${request.url}`, { cause: err });
    }

    let parsedCheck: URL;
    try {
      parsedCheck = new URL(extracted.cleanUrl);
    } catch (err) {
      throw new MiniPodError('invalid-url', `Invalid URL: ${request.url}`, { cause: err });
    }
    if (parsedCheck.protocol !== 'http:' && parsedCheck.protocol !== 'https:') {
      throw new MiniPodError('invalid-url', `Unsupported URL protocol: ${parsedCheck.protocol}`);
    }

    const method: HttpMethod = request.method ?? 'GET';
    const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;

    const headers: Record<string, string> = {};
    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k] = v;
      }
    }
    if (getHeaderCaseInsensitive(headers, 'user-agent') === undefined) {
      headers['User-Agent'] = defaultUa;
    }
    if (request.range && getHeaderCaseInsensitive(headers, 'range') === undefined) {
      headers['Range'] = formatRangeHeader(request.range);
    }

    const explicitAuthHeader = getHeaderCaseInsensitive(headers, 'authorization');
    const credentials = extracted.credentials ?? request.auth;

    const abortController = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            abortController.abort(new Error(`HTTP timeout after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;

    const onCallerAbort = (): void => {
      abortController.abort(request.signal?.reason);
    };
    if (request.signal) {
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const cleanupTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort);
      }
    };

    try {
      let rawResult = await executeManualRedirectFetch({
        fetchFn,
        startUrl: extracted.cleanUrl,
        method,
        headers,
        body: request.body,
        maxRedirects,
        signal: abortController.signal,
        preserveAuthAcrossOrigins: false,
      });

      const accumulatedChain: RedirectHop[] = [...rawResult.chain];

      if (rawResult.response.status === 401) {
        if (explicitAuthHeader && rawResult.finalUrl !== extracted.cleanUrl) {
          // Cross-host redirect stripped caller's explicit Authorization -> re-attach at finalUrl
          await rawResult.response.body?.cancel().catch(() => undefined);
          const retryHeaders = {
            ...omitHeaderCaseInsensitive(headers, 'authorization'),
            Authorization: explicitAuthHeader,
          };
          const retry = await executeManualRedirectFetch({
            fetchFn,
            startUrl: rawResult.finalUrl,
            method,
            headers: retryHeaders,
            body: request.body,
            maxRedirects,
            signal: abortController.signal,
            preserveAuthAcrossOrigins: true,
          });
          accumulatedChain.push(...retry.chain);
          rawResult = {
            response: retry.response,
            finalUrl: retry.finalUrl,
            chain: accumulatedChain,
          };
        } else if (!explicitAuthHeader && credentials) {
          // AntennaPod BasicAuthorizationInterceptor order: ISO-8859-1 first, then UTF-8
          const candidates = encodeBasicAuthHeaders(credentials);
          const challengeUrl = rawResult.finalUrl || extracted.cleanUrl;
          for (const candidateHeader of candidates) {
            await rawResult.response.body?.cancel().catch(() => undefined);
            const retryHeaders = {
              ...omitHeaderCaseInsensitive(headers, 'authorization'),
              Authorization: candidateHeader,
            };
            const retry = await executeManualRedirectFetch({
              fetchFn,
              startUrl: challengeUrl,
              method,
              headers: retryHeaders,
              body: request.body,
              maxRedirects,
              signal: abortController.signal,
              preserveAuthAcrossOrigins: true,
            });
            accumulatedChain.push(...retry.chain);
            rawResult = {
              response: retry.response,
              finalUrl: retry.finalUrl,
              chain: accumulatedChain,
            };
            if (rawResult.response.status !== 401) {
              break;
            }
          }
        }
      }

      const finalResponse = rawResult.response;
      const responseHeaders = lowerCaseHeaders(finalResponse.headers);
      const finalUrl = rawResult.finalUrl;
      const finalChain: readonly RedirectHop[] = rawResult.chain;

      let cachedBytesPromise: Promise<Uint8Array> | null = null;
      const loadBytes = (): Promise<Uint8Array> => {
        if (!cachedBytesPromise) {
          cachedBytesPromise = readBodyBytesWithCap(finalResponse, request.maxBodyBytes).finally(
            cleanupTimers,
          );
        }
        return cachedBytesPromise;
      };

      // If caller never reads body on a bodyless status (e.g. HEAD / 204 / 304), release timer eagerly
      if (method === 'HEAD' || finalResponse.status === 204 || finalResponse.status === 304) {
        cleanupTimers();
      } else {
        // Unref timeout once headers arrive? Keep timeout active until body read completes or GC'd,
        // unreffing so idle unconsumed responses never pin Node's event loop in tests.
        timer?.unref?.();
      }

      return {
        status: finalResponse.status,
        headers: responseHeaders,
        finalUrl,
        chain: finalChain,
        bytes: loadBytes,
        async text(): Promise<string> {
          const b = await loadBytes();
          return utf8Decoder.decode(b);
        },
      };
    } catch (err) {
      cleanupTimers();
      if (timedOut) {
        throw new MiniPodError('network', `HTTP request timed out after ${timeoutMs}ms`, {
          cause: err,
          details: { url: extracted.cleanUrl, timeoutMs },
        });
      }
      if (err instanceof MiniPodError) throw err;
      throw MiniPodError.wrap(err, 'network');
    }
  };
}
