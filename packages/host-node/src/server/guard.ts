/**
 * Loopback DNS-rebinding, CSRF Origin, and Content-Type guard middleware
 * (`ARCHITECTURE.md §3.2`).
 *
 * The MiniPod Node server listens strictly on `127.0.0.1` with no auth token, so every
 * request must prove it came from a loopback `Host` and (for mutating requests) a
 * loopback `Origin` + expected `Content-Type` (blocking `<form>` / cross-site fetch CSRF).
 */
import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function stripPortFromHost(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    return closeIdx >= 0 ? trimmed.slice(0, closeIdx + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // In-process `app.request('/api/...')` in tests may omit Host
  return LOOPBACK_HOSTS.has(stripPortFromHost(hostHeader));
}

export function isAllowedLoopbackOrigin(
  originHeader: string | undefined,
  extraAllowedOrigins?: ReadonlySet<string>,
): boolean {
  if (!originHeader) return true;
  if (extraAllowedOrigins?.has(originHeader)) return true;
  try {
    const u = new URL(originHeader);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const OPML_CONTENT_TYPES = [
  'application/json',
  'text/xml',
  'application/xml',
  'text/x-opml',
  'text/plain',
];

export interface LoopbackGuardOptions {
  readonly extraAllowedOrigins?: readonly string[];
}

export function createLoopbackGuard(options?: LoopbackGuardOptions): MiddlewareHandler {
  const extraSet = options?.extraAllowedOrigins
    ? new Set(options.extraAllowedOrigins)
    : undefined;

  return async (c, next) => {
    const hostHeader = c.req.header('host');
    if (!isLoopbackHostHeader(hostHeader)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid-argument',
            message: `Rejected non-loopback Host header: ${hostHeader}`,
          },
        },
        403,
      );
    }

    const method = c.req.method.toUpperCase();
    if (MUTATING_METHODS.has(method)) {
      const origin = c.req.header('origin');
      if (!isAllowedLoopbackOrigin(origin, extraSet)) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid-argument',
              message: `Rejected cross-origin request from Origin: ${origin}`,
            },
          },
          403,
        );
      }

      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const contentLength = c.req.header('content-length');
        const transferEncoding = c.req.header('transfer-encoding');
        const hasBody =
          (contentLength !== undefined && contentLength !== '0') ||
          transferEncoding !== undefined;

        if (hasBody) {
          const ct = (c.req.header('content-type') ?? '').toLowerCase();
          const pathname = new URL(c.req.url, 'http://127.0.0.1').pathname;
          const isOpmlImport = method === 'POST' && pathname === '/api/feeds/opml';
          const allowed = isOpmlImport
            ? OPML_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))
            : ct.startsWith('application/json');

          if (!allowed) {
            return c.json(
              {
                ok: false,
                error: {
                  code: 'invalid-argument',
                  message: `Unsupported Content-Type "${ct}" for ${method} ${pathname}`,
                },
              },
              415,
            );
          }
        }
      }
    }

    return next();
  };
}
