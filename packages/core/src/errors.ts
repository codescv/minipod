import type { MiniPodErrorCode, MiniPodErrorShape } from './types';

/**
 * Error type thrown across every MiniPod boundary. Hosts serialise it with
 * `toShape()`; the REST client / Capacitor bridge rebuild it with `fromShape()`
 * so the UI can switch on `error.code` regardless of platform.
 */
export class MiniPodError extends Error implements MiniPodErrorShape {
  readonly code: MiniPodErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: MiniPodErrorCode, message: string, options?: { details?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MiniPodError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
  }

  toShape(): MiniPodErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static fromShape(shape: MiniPodErrorShape): MiniPodError {
    return new MiniPodError(shape.code, shape.message, shape.details === undefined ? undefined : { details: { ...shape.details } });
  }

  /** Narrow any thrown value to a `MiniPodError` (wrapping unknowns as `internal`). */
  static wrap(error: unknown, fallbackCode: MiniPodErrorCode = 'internal'): MiniPodError {
    if (error instanceof MiniPodError) return error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') return new MiniPodError('cancelled', error.message, { cause: error });
      return new MiniPodError(fallbackCode, error.message, { cause: error });
    }
    return new MiniPodError(fallbackCode, String(error));
  }
}

export function isMiniPodError(value: unknown): value is MiniPodError {
  return value instanceof MiniPodError;
}

/** Thrown by `ItunesSearcher.lookupUrl` when Apple's lookup has no `feedUrl` (upstream `FeedUrlNotFoundException`). */
export class FeedUrlNotFoundError extends MiniPodError {
  readonly artistName: string;
  readonly trackName: string;

  constructor(artistName: string, trackName: string) {
    super('feed-not-found', `No feed URL for "${trackName}" by ${artistName}`, { details: { artistName, trackName } });
    this.name = 'FeedUrlNotFoundError';
    this.artistName = artistName;
    this.trackName = trackName;
  }
}
