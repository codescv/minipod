/**
 * Typed JSON HTTP client for the browser side of `@minipod/host-node`.
 * Reconstructs `MiniPodError` instances across the wire via `MiniPodError.fromShape`.
 */
import { MiniPodError } from '@minipod/core';
import type { RouteHttpMethod } from '../shared/routes';
import type { ApiResponse } from '../shared/wire';

export interface RestClientConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RequestCallOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly rawXmlBody?: string;
  readonly keepalive?: boolean;
  readonly signal?: AbortSignal;
}

export class RestJsonClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(config?: RestClientConfig) {
    this.baseUrl = (config?.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchFn = config?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  resolveUrl(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const full = `${this.baseUrl}${cleanPath}`;
    if (!query) return full;

    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        sp.set(k, String(v));
      }
    }
    const qs = sp.toString();
    return qs ? `${full}?${qs}` : full;
  }

  async request<TRes>(
    method: RouteHttpMethod,
    path: string,
    options?: RequestCallOptions,
  ): Promise<TRes> {
    const url = this.resolveUrl(path, options?.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    let bodyInit: string | undefined;
    if (options?.rawXmlBody !== undefined) {
      headers['Content-Type'] = 'text/xml; charset=utf-8';
      bodyInit = options.rawXmlBody;
    } else if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(options.body);
    }

    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method,
        headers,
        ...(bodyInit !== undefined ? { body: bodyInit } : {}),
        ...(options?.keepalive ? { keepalive: true } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new MiniPodError('cancelled', err.message, { cause: err });
      }
      throw new MiniPodError('network', err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }

    let envelope: ApiResponse<TRes>;
    try {
      envelope = (await resp.json()) as ApiResponse<TRes>;
    } catch (err) {
      throw new MiniPodError(
        'network',
        `Unexpected non-JSON response (HTTP ${resp.status}) from ${method} ${path}`,
        { cause: err },
      );
    }

    if (!envelope.ok) {
      throw MiniPodError.fromShape(envelope.error);
    }

    return envelope.data;
  }
}
