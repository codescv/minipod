import type { HttpBasicCredentials, HttpClient, HttpRequest, HttpResponse, RedirectHop } from '../types';
import { encodeBase64, encodeIso88591 } from '../util/base64';
import { extractUrlCredentials } from '../util/url';

const utf8Encoder = new TextEncoder();

export type BasicAuthCharset = 'ISO-8859-1' | 'UTF-8';

/**
 * Port of AntennaPod's `HttpCredentialEncoder.encode(username, password, charset)`.
 * Returns `"Basic <base64>"`.
 */
export function encodeBasicAuth(
  username: string,
  password: string,
  charset: BasicAuthCharset = 'ISO-8859-1',
): string {
  const raw = `${username}:${password}`;
  const bytes = charset === 'ISO-8859-1' ? encodeIso88591(raw) : utf8Encoder.encode(raw);
  return `Basic ${encodeBase64(bytes)}`;
}

/**
 * Produces the ordered Basic Auth header candidates matching AntennaPod's
 * `BasicAuthorizationInterceptor`: `ISO-8859-1` first, then `UTF-8` if distinct.
 */
export function encodeBasicAuthHeaders(credentials: HttpBasicCredentials): readonly string[] {
  const iso = encodeBasicAuth(credentials.username, credentials.password, 'ISO-8859-1');
  const utf8 = encodeBasicAuth(credentials.username, credentials.password, 'UTF-8');
  return iso === utf8 ? [iso] : [iso, utf8];
}

/**
 * Extracts the `realm="..."` parameter from a `WWW-Authenticate` response header if present.
 */
export function parseWwwAuthenticateRealm(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const quoted = /realm="([^"]*)"/i.exec(headerValue);
  if (quoted) return quoted[1];
  const unquoted = /realm=([^\s,;]+)/i.exec(headerValue);
  return unquoted ? unquoted[1] : undefined;
}

/**
 * Executes an `HttpRequest` with AntennaPod's two-stage Basic Auth challenge-response pipeline:
 * 1. Sends unauthenticated request first (stripping URL `userInfo` if present).
 * 2. On HTTP 401, resolves credentials from URL `userInfo` -> `request.auth` -> `fallbackCredentials`.
 * 3. Retries against `response.finalUrl` (preserving auth across cross-host redirects) with
 *    `ISO-8859-1` first, then `UTF-8` if 401 persists.
 */
export async function fetchWithBasicAuth(
  http: HttpClient,
  request: HttpRequest,
  fallbackCredentials?: HttpBasicCredentials,
): Promise<HttpResponse> {
  const { cleanUrl, credentials: urlCredentials } = extractUrlCredentials(request.url);
  const effectiveCreds = urlCredentials ?? request.auth ?? fallbackCredentials;

  // Strip `auth` on the initial probe if we are driving the retry loop here, OR pass cleanUrl
  // while letting hosts that don't handle `auth` rely on our explicit `Authorization` retry.
  const { auth: _ignoredAuth, ...restReq } = request;
  const initialReq: HttpRequest = { ...restReq, url: cleanUrl };

  const firstResp = await http(initialReq);
  if (firstResp.status !== 401) {
    return firstResp;
  }

  // If caller already supplied an explicit Authorization header and was redirected, re-attach it at finalUrl.
  const existingAuth =
    request.headers?.['Authorization'] ?? request.headers?.['authorization'];
  if (existingAuth && firstResp.finalUrl && firstResp.finalUrl !== cleanUrl) {
    const redirectedResp = await http({
      ...initialReq,
      url: firstResp.finalUrl,
      headers: { ...request.headers, Authorization: existingAuth },
    });
    return mergeRedirectChains(firstResp.chain, redirectedResp);
  }

  if (!effectiveCreds) {
    return firstResp;
  }

  const targetUrl = firstResp.finalUrl || cleanUrl;
  const candidates = encodeBasicAuthHeaders(effectiveCreds);
  let lastResp = firstResp;
  let accumulatedChain: readonly RedirectHop[] = firstResp.chain;

  for (const authHeader of candidates) {
    const retryResp = await http({
      ...initialReq,
      url: targetUrl,
      headers: {
        ...request.headers,
        Authorization: authHeader,
      },
    });
    lastResp = mergeRedirectChains(accumulatedChain, retryResp);
    accumulatedChain = lastResp.chain;
    if (lastResp.status !== 401) {
      return lastResp;
    }
  }

  return lastResp;
}

function mergeRedirectChains(prefix: readonly RedirectHop[], resp: HttpResponse): HttpResponse {
  if (prefix.length === 0) return resp;
  return {
    status: resp.status,
    headers: resp.headers,
    finalUrl: resp.finalUrl,
    chain: [...prefix, ...resp.chain],
    bytes: () => resp.bytes(),
    text: () => resp.text(),
  };
}

export const BasicAuth = {
  encode: encodeBasicAuth,
  encodeHeaders: encodeBasicAuthHeaders,
  parseRealm: parseWwwAuthenticateRealm,
  fetchWithRetry: fetchWithBasicAuth,
} as const;
