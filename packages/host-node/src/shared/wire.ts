/**
 * JSON wire envelope and HTTP status mapping shared by `host-node` server & browser client.
 */
import type { MiniPodErrorCode, MiniPodErrorShape } from '@minipod/core';

export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: MiniPodErrorShape };

export function statusForErrorCode(code: MiniPodErrorCode): number {
  switch (code) {
    case 'invalid-url':
    case 'invalid-argument':
      return 400;
    case 'auth-required':
    case 'sync-auth':
      return 401;
    case 'feed-not-found':
    case 'not-found':
      return 404;
    case 'sync-conflict':
      return 409;
    case 'unsupported-feed':
    case 'sync-schema':
      return 422;
    case 'cancelled':
      return 499;
    case 'unsupported':
      return 501;
    case 'network':
      return 502;
    case 'internal':
      return 500;
  }
}
