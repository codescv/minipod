/**
 * Auto-retry policy for the desktop episode downloader (`downloader.ts`).
 *
 * - Classifies attempt failures as transient (network / DNS / TLS / connect errors, timeouts,
 *   mid-stream resets, HTTP 408/429/500/502/503/504) vs. permanent (other HTTP 4xx, invalid URL,
 *   local filesystem errors such as `ENOSPC` / `EACCES`, cancellation).
 * - Computes exponential backoff with jitter (~1.5s, ~4s, ~10s) and honours `Retry-After`.
 * - Provides an `AbortSignal`-aware sleep so cancelling a download interrupts its backoff.
 */
import { MiniPodError } from '@minipod/core';

/** Retry tuning knobs (all optional; injectable so tests run without real sleeps). */
export interface DownloadRetryOptions {
  /** Max consecutive retries per stall point (default 3). */
  readonly maxRetries?: number;
  /** Base backoff per consecutive failure; the last entry repeats (default `[1500, 4000, 10000]`). */
  readonly delaysMs?: readonly number[];
  /** Hard cap on attempts per `download()` call, including the first (default 10). */
  readonly maxTotalAttempts?: number;
  /** An attempt that wrote at least this many bytes resets the consecutive-failure counter (default 256 KiB). */
  readonly progressResetBytes?: number;
  /** Upper bound for a server-provided `Retry-After` delay (default 30s). */
  readonly retryAfterCapMs?: number;
  /** Jitter ratio applied to backoff delays: `delay * (1 ± ratio)` (default 0.2). */
  readonly jitterRatio?: number;
  /** Random source in `[0, 1)` for jitter (default `Math.random`). */
  readonly random?: () => number;
  /** Backoff sleep; must reject when `signal` aborts (default: `abortableSleep`). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type ResolvedDownloadRetryOptions = Required<DownloadRetryOptions>;

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1500, 4000, 10_000];

export function resolveRetryOptions(opts: DownloadRetryOptions | undefined): ResolvedDownloadRetryOptions {
  const delays = opts?.delaysMs && opts.delaysMs.length > 0 ? opts.delaysMs : DEFAULT_RETRY_DELAYS_MS;
  return {
    maxRetries: Math.max(0, opts?.maxRetries ?? 3),
    delaysMs: delays,
    maxTotalAttempts: Math.max(1, opts?.maxTotalAttempts ?? 10),
    progressResetBytes: opts?.progressResetBytes ?? 256 * 1024,
    retryAfterCapMs: opts?.retryAfterCapMs ?? 30_000,
    jitterRatio: opts?.jitterRatio ?? 0.2,
    random: opts?.random ?? Math.random,
    sleep: opts?.sleep ?? abortableSleep,
  };
}

/** `signal.reason`, or a standard `AbortError` when the reason is not an `Error`. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleeps `ms`, rejecting with the abort reason as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Races `promise` against `signal` so a hung upstream (or sleep) can never outlive an abort. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Statuses worth retrying (`408`, `429`, `5xx` gateway / availability errors). */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A download attempt failure carrying an explicit retry decision (HTTP status errors, redirect
 * loops, stall timeouts). Still a `MiniPodError` so the final `FAILED` event serialises as before.
 */
export class DownloadAttemptError extends MiniPodError {
  readonly retryable: boolean;
  readonly status?: number;
  /** Server-requested delay (`Retry-After`), already parsed to milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(
      'network',
      message,
      options.status === undefined
        ? options.cause === undefined
          ? undefined
          : { cause: options.cause }
        : { details: { status: options.status }, ...(options.cause === undefined ? {} : { cause: options.cause }) },
    );
    this.name = 'DownloadAttemptError';
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** Builds the error for a non-2xx enclosure response (parsing `Retry-After` on 429 / 503). */
export function httpStatusError(status: number, headers: Headers, nowMs: number = Date.now()): DownloadAttemptError {
  const retryAfterMs =
    status === 429 || status === 503 ? parseRetryAfterMs(headers.get('retry-after'), nowMs) : undefined;
  return new DownloadAttemptError(`Enclosure download failed (HTTP ${status})`, {
    retryable: RETRYABLE_HTTP_STATUSES.has(status),
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds from `nowMs`. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number.parseFloat(trimmed);
    return Number.isFinite(secs) ? Math.max(0, Math.round(secs * 1000)) : undefined;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Local filesystem / path problems: retrying will not help. */
const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
  'ENOENT',
  'EEXIST',
  'ENAMETOOLONG',
  'EBADF',
  'EMFILE',
  'ENFILE',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);

const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EPROTO',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_HTTP2_STREAM_ERROR',
]);

function isTransientCode(code: string): boolean {
  return (
    TRANSIENT_ERROR_CODES.has(code) ||
    code.startsWith('UND_ERR_') ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.includes('CERT')
  );
}

/**
 * Whether an attempt failure is transient. Cancellation must be detected by the caller (via its
 * own `AbortSignal`) before calling this; an `AbortError` seen here is treated as permanent.
 */
export function isRetryableDownloadError(err: unknown): boolean {
  if (err instanceof DownloadAttemptError) return err.retryable;
  // Walk the `cause` chain: Node's fetch throws `TypeError('fetch failed')` with the real
  // `ECONNRESET` / `ENOTFOUND` / `UND_ERR_*` error as its cause.
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') {
        if (PERMANENT_ERROR_CODES.has(code)) return false;
        if (isTransientCode(code)) return true;
      }
      const name = (current as { name?: unknown }).name;
      if (name === 'AbortError') return false;
      if (name === 'TimeoutError') return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  if (err instanceof MiniPodError) {
    return err.code === 'network';
  }
  // Unknown errors (fetch `TypeError`s, stream resets without a code, …) are assumed transient;
  // the retry budget bounds the cost of being wrong.
  return true;
}

/** Backoff for the `failureCount`-th consecutive failure (1-based), with jitter. */
export function backoffDelayMs(failureCount: number, opts: ResolvedDownloadRetryOptions): number {
  const delays = opts.delaysMs;
  const base = delays[Math.min(Math.max(failureCount, 1), delays.length) - 1] ?? 0;
  const factor = 1 + opts.jitterRatio * (2 * opts.random() - 1);
  return Math.max(0, Math.round(base * factor));
}
