/**
 * `HttpClient` implementation over `MiniPodPlugin.http` (`ARCHITECTURE.md §3.2`, `§4.0`).
 *
 * All HTTP traffic on Android runs through OkHttp in `MiniPodPlugin.java` so
 * requests bypass WebView CORS, follow redirects manually while recording every
 * `RedirectHop`, retry Basic Auth in `ISO-8859-1` -> `UTF-8` order, and support `Range`.
 */
import {
  decodeBase64,
  encodeBase64,
  MiniPodError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@minipod/core';
import type { MiniPodPlugin } from '../plugin-types';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export interface PluginHttpOptions {
  readonly userAgent?: string;
}

export function createPluginHttpClient(
  plugin: Pick<MiniPodPlugin, 'http'>,
  options?: PluginHttpOptions,
): HttpClient {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.signal?.aborted) {
      throw new MiniPodError('cancelled', 'HTTP request aborted');
    }

    const headers: Record<string, string> = {};
    if (options?.userAgent) {
      headers['User-Agent'] = options.userAgent;
    }
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = v;
      }
    }

    let bodyBase64: string | undefined;
    if (req.body !== undefined) {
      const rawBytes = typeof req.body === 'string' ? utf8Encoder.encode(req.body) : req.body;
      bodyBase64 = encodeBase64(rawBytes);
    }

    const abortPromise = req.signal
      ? new Promise<never>((_, reject) => {
          req.signal!.addEventListener(
            'abort',
            () => reject(new MiniPodError('cancelled', 'HTTP request aborted')),
            { once: true },
          );
        })
      : null;

    let nativeRes;
    try {
      const callPromise = plugin.http({
        url: req.url,
        method: req.method ?? 'GET',
        headers,
        ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
        ...(req.range !== undefined ? { range: req.range } : {}),
        ...(req.auth !== undefined ? { auth: req.auth } : {}),
        ...(req.maxRedirects !== undefined ? { maxRedirects: req.maxRedirects } : {}),
        ...(req.maxBodyBytes !== undefined ? { maxBodyBytes: req.maxBodyBytes } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      });
      nativeRes = abortPromise ? await Promise.race([callPromise, abortPromise]) : await callPromise;
    } catch (err) {
      if (err instanceof MiniPodError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/maxBodyBytes|body exceeds|too large/i.test(msg)) {
        throw new MiniPodError('invalid-argument', msg, { cause: err });
      }
      if (/abort|cancel/i.test(msg)) {
        throw new MiniPodError('cancelled', msg, { cause: err });
      }
      throw new MiniPodError('network', msg || 'Native HTTP request failed', { cause: err });
    }

    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(nativeRes.headers ?? {})) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    let cachedBytes: Uint8Array | null = null;
    const decodeBody = (): Uint8Array => {
      if (cachedBytes !== null) return cachedBytes;
      if (nativeRes.bodyBase64 !== undefined) {
        cachedBytes = decodeBase64(nativeRes.bodyBase64);
      } else if (nativeRes.bodyText !== undefined) {
        cachedBytes = utf8Encoder.encode(nativeRes.bodyText);
      } else {
        cachedBytes = new Uint8Array(0);
      }
      if (req.maxBodyBytes !== undefined && cachedBytes.length > req.maxBodyBytes) {
        throw new MiniPodError(
          'invalid-argument',
          `Response body (${cachedBytes.length} bytes) exceeds maxBodyBytes (${req.maxBodyBytes})`,
        );
      }
      return cachedBytes;
    };

    return {
      status: nativeRes.status,
      headers: lowerHeaders,
      finalUrl: nativeRes.finalUrl || req.url,
      chain: nativeRes.chain ?? [],
      async bytes(): Promise<Uint8Array> {
        return decodeBody();
      },
      async text(): Promise<string> {
        const b = decodeBody();
        return utf8Decoder.decode(b);
      },
    };
  };
}
