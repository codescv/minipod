/**
 * Desktop manual per-episode downloader (`ARCHITECTURE.md §3.2`, `DESIGN.md §4.7`).
 *
 * - Downloads enclosures into `${dataDir}/downloads/${episodeKey}.${ext}` via `.part`
 *   temporary file with HTTP `Range` resume when a `.part` file exists.
 * - Bounded FIFO queue: at most `MAX_CONCURRENT_DOWNLOADS` (3) transfers in flight; the rest
 *   wait as `QUEUED` and are promoted when a slot frees (DONE / FAILED / cancelled).
 * - Auto retry of transient failures (network / timeouts / 408 / 429 / 5xx) with exponential
 *   backoff + jitter and `Retry-After`, resuming from the kept `.part` (`retry-policy.ts`).
 * - Coalesces `download-updated` events to `<= 2/s` per episode.
 * - Supports `deleteDownload` and `deleteDownloadWhenPlayed` cleanup.
 */
import {
  encodeBasicAuthHeaders,
  extractUrlCredentials,
  inferMediaMimeType,
  MiniPodError,
  type EpisodeKey,
  type FeedKey,
  type HostEvent,
  type HttpBasicCredentials,
} from '@minipod/core';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/sqlite';
import { EpisodesRepository } from '../db/repositories/episodes';
import {
  abortReason,
  backoffDelayMs,
  DownloadAttemptError,
  httpStatusError,
  isRetryableDownloadError,
  raceAbort,
  resolveRetryOptions,
  type DownloadRetryOptions,
  type ResolvedDownloadRetryOptions,
} from './retry-policy';

export type { DownloadRetryOptions } from './retry-policy';

const EVENT_COALESCE_MS = 500; // <= 2 updates / sec
const STREAM_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function chooseExtension(enclosureUrl: string, mime: string | undefined): string {
  const effectiveMime = inferMediaMimeType(mime, enclosureUrl);
  if (effectiveMime && MIME_TO_EXT[effectiveMime]) {
    return MIME_TO_EXT[effectiveMime]!;
  }
  const clean = enclosureUrl.split(/[?#]/)[0] ?? '';
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(clean);
  if (m) {
    return m[1]!.toLowerCase();
  }
  return 'mp3';
}

/** Size of a leftover `.part` file (0 when absent/unreadable). */
function partialFileSize(partPath: string): number {
  if (!existsSync(partPath)) return 0;
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
}

/** Parses the complete length from `Content-Range: bytes <start>-<end>/<total>`. */
function parseContentRangeTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const m = /\/\s*(\d+)\s*$/.exec(header);
  if (!m) return undefined;
  const total = Number.parseInt(m[1]!, 10);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** Restart-offset parsed from `Content-Range: bytes <start>-<end>/<total>`. */
function parseContentRangeStart(header: string | null): number | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s+(\d+)\s*-/i.exec(header);
  if (!m) return undefined;
  const start = Number.parseInt(m[1]!, 10);
  return Number.isFinite(start) ? start : undefined;
}

const noop = (): undefined => undefined;

/** Same `scheme://host:port` (default ports normalised), like `MiniPodPlugin.sameOriginHostPort`. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = new URL(a).origin;
    return origin !== 'null' && origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Abort reason used when an attempt receives no bytes for `stallTimeoutMs`. */
class StallTimeoutError extends Error {
  constructor(ms: number) {
    super(`Enclosure download stalled (no data for ${Math.round(ms / 1000)}s)`);
    this.name = 'TimeoutError';
  }
}

/** Max simultaneous enclosure transfers; further `download()` calls wait FIFO as `QUEUED`. */
export const MAX_CONCURRENT_DOWNLOADS = 3;
/** Default per-attempt stall timeout: abort (and retry) when no bytes arrive for this long. */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

export interface EpisodeDownloaderDeps {
  readonly db: Database;
  readonly downloadsDir: string;
  readonly userAgent: string;
  readonly fetchImpl?: typeof fetch;
  readonly getCredentials: (feedKey: FeedKey) => HttpBasicCredentials | undefined;
  readonly emit: (event: HostEvent) => void;
  /** Concurrent transfer slots (default {@link MAX_CONCURRENT_DOWNLOADS}). */
  readonly maxConcurrent?: number;
  /** Auto-retry tuning (backoff, caps, injectable sleep / random for tests). */
  readonly retry?: DownloadRetryOptions;
  /** Per-attempt no-data timeout in ms (default {@link DEFAULT_STALL_TIMEOUT_MS}; `0` disables). */
  readonly stallTimeoutMs?: number;
}

interface DownloadTask {
  readonly episodeKey: EpisodeKey;
  readonly feedKey: FeedKey;
  readonly enclosureUrl: string;
  readonly declaredSize?: number | undefined;
  readonly destPath: string;
  readonly partPath: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: MiniPodError) => void;
  state: 'QUEUED' | 'RUNNING';
}

export class EpisodeDownloader {
  private readonly episodesRepo: EpisodesRepository;
  private readonly downloadsDir: string;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;
  private readonly deps: EpisodeDownloaderDeps;
  private readonly maxConcurrent: number;
  private readonly retry: ResolvedDownloadRetryOptions;
  private readonly stallTimeoutMs: number;
  /** Every live task (QUEUED or RUNNING), keyed by episode for dedupe / cancellation. */
  private readonly tasks = new Map<EpisodeKey, DownloadTask>();
  /** FIFO of QUEUED tasks waiting for a slot. */
  private readonly waiting: DownloadTask[] = [];
  private running = 0;
  private disposed = false;

  constructor(deps: EpisodeDownloaderDeps) {
    this.deps = deps;
    this.episodesRepo = new EpisodesRepository(deps.db);
    this.downloadsDir = deps.downloadsDir;
    this.userAgent = deps.userAgent;
    this.fetchFn = deps.fetchImpl ?? globalThis.fetch;
    this.maxConcurrent = Math.max(1, Math.floor(deps.maxConcurrent ?? MAX_CONCURRENT_DOWNLOADS));
    this.retry = resolveRetryOptions(deps.retry);
    this.stallTimeoutMs = Math.max(0, deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
  }

  /**
   * Host shutdown: drops QUEUED items (→ `NONE`, zero fetches) and aborts RUNNING transfers
   * immediately. RUNNING rows and their `.part` bytes are intentionally left untouched (the
   * database is closed right after this), so the next launch's `failStaleInFlightDownloads`
   * offers `继续下载` / `Resume download` instead of losing the partial file.
   */
  dispose(): void {
    this.disposed = true;
    for (const task of this.waiting.splice(0)) {
      this.cancelQueuedTask(task);
    }
    for (const task of this.tasks.values()) {
      task.controller.abort();
    }
  }

  /**
   * Queue `停止全部`: stops every QUEUED and RUNNING download (QUEUED ones are dropped first so
   * none of them is ever promoted / fetched), removes their `.part` files, settles each to `NONE`
   * and emits `episodes-changed` once per affected feed. Returns the affected episode keys.
   */
  async cancelAll(): Promise<EpisodeKey[]> {
    const queued = this.waiting.splice(0);
    for (const task of queued) {
      this.cancelQueuedTask(task);
      rmSync(task.partPath, { force: true });
    }
    const running = [...this.tasks.values()];
    for (const task of running) {
      task.controller.abort();
    }
    await Promise.all(running.map((t) => t.promise.catch(noop)));
    for (const task of running) {
      rmSync(task.partPath, { force: true });
    }
    const affected = [...queued, ...running];
    for (const feedKey of new Set(affected.map((t) => t.feedKey))) {
      this.deps.emit({ type: 'episodes-changed', feedKey });
    }
    return affected.map((t) => t.episodeKey);
  }

  /** Current in-memory queue (for diagnostics / tests). */
  getQueueSnapshot(): { readonly running: EpisodeKey[]; readonly queued: EpisodeKey[] } {
    return {
      running: [...this.tasks.values()].filter((t) => t.state === 'RUNNING').map((t) => t.episodeKey),
      queued: this.waiting.map((t) => t.episodeKey),
    };
  }

  /**
   * Startup reconciliation: a `QUEUED` / `RUNNING` row with no in-memory task was interrupted
   * (process killed / crashed mid-download). Flip it to `FAILED` (keeping its `.part` bytes) so
   * the UI offers `继续下载` / `Resume download` instead of a stuck progress ring.
   * Returns the affected episode keys.
   */
  failStaleInFlightDownloads(): EpisodeKey[] {
    const rows = this.deps.db
      .prepare("SELECT episode_key FROM episodes WHERE download_state IN ('QUEUED', 'RUNNING')")
      .all() as Array<{ episode_key: EpisodeKey }>;
    const stale = rows.map((r) => r.episode_key).filter((k) => !this.tasks.has(k));
    for (const key of stale) {
      this.episodesRepo.setDownloadState(key, 'FAILED', null);
    }
    return stale;
  }

  deleteFilesByPaths(paths: readonly string[]): void {
    for (const p of paths) {
      if (!p) continue;
      try {
        rmSync(p, { force: true });
        rmSync(`${p}.part`, { force: true });
      } catch {
        // ignore missing file
      }
    }
  }

  /**
   * Queues a download (FIFO, at most `maxConcurrent` in flight). Calling it again for an episode
   * that is already QUEUED / RUNNING returns the same promise. Resolves on `DONE` or cancellation;
   * rejects with a `MiniPodError` once the download is `FAILED` (after automatic retries).
   */
  download(episodeKey: EpisodeKey): Promise<void> {
    const existing = this.tasks.get(episodeKey);
    if (existing) {
      return existing.promise;
    }
    try {
      return this.enqueue(episodeKey);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private enqueue(episodeKey: EpisodeKey): Promise<void> {
    const row = this.episodesRepo.getRawByKey(episodeKey);
    if (!row) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    if (row.feed_key.startsWith('l_')) {
      // Local folder episodes are already local files on disk
      return Promise.resolve();
    }
    if (row.download_state === 'DONE' && row.download_path && existsSync(row.download_path)) {
      return Promise.resolve();
    }
    if (!row.enclosure_url || !/^https?:\/\//i.test(row.enclosure_url)) {
      throw new MiniPodError('invalid-argument', 'Episode has no downloadable enclosure URL');
    }

    mkdirSync(this.downloadsDir, { recursive: true });
    const ext = chooseExtension(row.enclosure_url, row.enclosure_mime ?? undefined);
    const destPath = join(this.downloadsDir, `${episodeKey}.${ext}`);
    const partPath = `${destPath}.part`;

    this.episodesRepo.setDownloadState(episodeKey, 'QUEUED', null);
    // A leftover `.part` (failed / interrupted download) resumes via HTTP `Range`: omit
    // `progress: 0` so the UI keeps its last known percentage instead of flashing back to 0%.
    const hasPartial = partialFileSize(partPath) > 0;
    this.deps.emit({
      type: 'download-updated',
      episodeKey,
      state: 'QUEUED',
      ...(hasPartial ? {} : { progress: 0 }),
    });

    let resolve!: () => void;
    let reject!: (err: MiniPodError) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: DownloadTask = {
      episodeKey,
      feedKey: row.feed_key,
      enclosureUrl: row.enclosure_url,
      declaredSize: row.enclosure_size ?? undefined,
      destPath,
      partPath,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      state: 'QUEUED',
    };
    this.tasks.set(episodeKey, task);
    this.waiting.push(task);
    this.pump();
    return promise;
  }

  /** Promotes QUEUED tasks (FIFO) into free slots. */
  private pump(): void {
    while (this.running < this.maxConcurrent && this.waiting.length > 0) {
      this.startTask(this.waiting.shift()!);
    }
  }

  private startTask(task: DownloadTask): void {
    task.state = 'RUNNING';
    this.running += 1;
    // Free the slot (and promote the next item) before settling the caller's promise, so a
    // caller that immediately re-requests the same episode gets a fresh task.
    void this.runDownload(task).then(
      () => {
        this.finishTask(task);
        task.resolve();
      },
      (err: unknown) => {
        this.finishTask(task);
        task.reject(MiniPodError.wrap(err, 'network'));
      },
    );
  }

  private finishTask(task: DownloadTask): void {
    this.running -= 1;
    if (this.tasks.get(task.episodeKey) === task) {
      this.tasks.delete(task.episodeKey);
    }
    if (!this.disposed) {
      this.pump();
    }
  }

  /** Removes a QUEUED (never started) task: zero fetches, state `NONE`, promise resolves. */
  private cancelQueuedTask(task: DownloadTask): void {
    const idx = this.waiting.indexOf(task);
    if (idx >= 0) this.waiting.splice(idx, 1);
    if (this.tasks.get(task.episodeKey) === task) {
      this.tasks.delete(task.episodeKey);
    }
    task.controller.abort();
    this.episodesRepo.setDownloadState(task.episodeKey, 'NONE', null);
    this.deps.emit({ type: 'download-updated', episodeKey: task.episodeKey, state: 'NONE' });
    task.resolve();
  }

  private async runDownload(task: DownloadTask): Promise<void> {
    const { episodeKey, feedKey } = task;
    const signal = task.controller.signal;
    try {
      const resumeBytes = partialFileSize(task.partPath);
      this.episodesRepo.setDownloadState(episodeKey, 'RUNNING', null);
      this.deps.emit({
        type: 'download-updated',
        episodeKey,
        state: 'RUNNING',
        // Resuming: the real resumed fraction is emitted as soon as the server answers `206`.
        ...(resumeBytes > 0 ? {} : { progress: 0 }),
      });

      const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(task.enclosureUrl);
      const creds = inlineCreds ?? this.deps.getCredentials(feedKey);

      // Transient failures stay RUNNING (keeping progress + `.part`) and retry with backoff,
      // resuming via `Range`. Only an exhausted budget / permanent error surfaces as FAILED.
      let consecutiveFailures = 0;
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw abortReason(signal);
        const progress = { bytes: 0 };
        try {
          await this.runAttempt(task, cleanUrl, creds, progress);
          break;
        } catch (err) {
          if (signal.aborted || !isRetryableDownloadError(err)) throw err;
          if (progress.bytes >= this.retry.progressResetBytes) {
            consecutiveFailures = 0; // real progress: this is a new stall point
          }
          consecutiveFailures += 1;
          if (consecutiveFailures > this.retry.maxRetries || attempt >= this.retry.maxTotalAttempts) {
            throw err;
          }
          const retryAfterMs = err instanceof DownloadAttemptError ? err.retryAfterMs : undefined;
          const backoffMs = backoffDelayMs(consecutiveFailures, this.retry);
          // `Retry-After` never shortens the backoff (`Retry-After: 0` / a past HTTP-date must not
          // spin at 0ms) and is capped (matches `DownloadRetryPolicy.java`).
          const delayMs =
            retryAfterMs !== undefined
              ? Math.min(Math.max(retryAfterMs, backoffMs), this.retry.retryAfterCapMs)
              : backoffMs;
          await raceAbort(this.retry.sleep(delayMs, signal), signal);
        }
      }

      renameSync(task.partPath, task.destPath);
      this.episodesRepo.setDownloadState(episodeKey, 'DONE', task.destPath);
      this.deps.emit({
        type: 'download-updated',
        episodeKey,
        state: 'DONE',
        progress: 1,
      });
      this.deps.emit({ type: 'episodes-changed', feedKey });
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      if (signal.aborted || wrapped.code === 'cancelled') {
        if (this.disposed && signal.aborted) {
          // Shutdown: leave the row RUNNING (+ `.part`) for next-launch reconciliation.
          return;
        }
        this.episodesRepo.setDownloadState(episodeKey, 'NONE', null);
        this.deps.emit({ type: 'download-updated', episodeKey, state: 'NONE' });
        return;
      }
      this.episodesRepo.setDownloadState(episodeKey, 'FAILED', null);
      this.deps.emit({
        type: 'download-updated',
        episodeKey,
        state: 'FAILED',
        error: wrapped.toShape(),
      });
      throw wrapped;
    }
  }

  /** One transfer attempt with its own abort scope (task cancellation + stall timeout). */
  private async runAttempt(
    task: DownloadTask,
    url: string,
    creds: HttpBasicCredentials | undefined,
    progress: { bytes: number },
  ): Promise<void> {
    const parent = task.controller.signal;
    const attemptCtl = new AbortController();
    const onParentAbort = (): void => attemptCtl.abort(abortReason(parent));
    if (parent.aborted) onParentAbort();
    else parent.addEventListener('abort', onParentAbort, { once: true });

    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      if (this.stallTimeoutMs <= 0) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => attemptCtl.abort(new StallTimeoutError(this.stallTimeoutMs)),
        this.stallTimeoutMs,
      );
      stallTimer.unref?.();
    };

    try {
      touch();
      await this.transfer(task, url, creds, attemptCtl.signal, touch, progress);
    } catch (err) {
      const reason: unknown = attemptCtl.signal.reason;
      if (!parent.aborted && attemptCtl.signal.aborted && reason instanceof StallTimeoutError) {
        throw new DownloadAttemptError(reason.message, { retryable: true, cause: reason });
      }
      throw err;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      parent.removeEventListener('abort', onParentAbort);
    }
  }

  private async transfer(
    task: DownloadTask,
    url: string,
    creds: HttpBasicCredentials | undefined,
    signal: AbortSignal,
    touch: () => void,
    progress: { bytes: number },
  ): Promise<void> {
    const rangeStartOf = (r: Response): number | undefined =>
      r.status === 206 ? parseContentRangeStart(r.headers.get('content-range')) : undefined;

    let resumeBytes = partialFileSize(task.partPath);
    let resp = await raceAbort(this.fetchWithRedirectsAndAuth(url, creds, resumeBytes, signal), signal);
    let rangeStart = rangeStartOf(resp);

    // The server can no longer satisfy our `.part` offset (416, or a 206 for some other non-zero
    // offset): drop the stale bytes and restart from 0.
    if (
      resumeBytes > 0 &&
      (resp.status === 416 ||
        (resp.status === 206 && rangeStart !== undefined && rangeStart !== 0 && rangeStart !== resumeBytes))
    ) {
      await resp.body?.cancel().catch(noop);
      rmSync(task.partPath, { force: true });
      resumeBytes = 0;
      resp = await raceAbort(this.fetchWithRedirectsAndAuth(url, creds, 0, signal), signal);
      rangeStart = rangeStartOf(resp);
    }

    if (resp.status < 200 || resp.status >= 300) {
      await resp.body?.cancel().catch(noop);
      throw httpStatusError(resp.status, resp.headers);
    }
    touch();

    // `200` (Range ignored) or a `206` starting at 0 rewrites the file from scratch.
    const appending = resp.status === 206 && resumeBytes > 0 && (rangeStart === undefined || rangeStart === resumeBytes);
    if (!appending) {
      resumeBytes = 0;
    }

    const contentLenHeader = resp.headers.get('content-length');
    const contentLen = contentLenHeader ? Number.parseInt(contentLenHeader, 10) : Number.NaN;
    const rangeTotal =
      resp.status === 206 && (appending || rangeStart === 0)
        ? parseContentRangeTotal(resp.headers.get('content-range'))
        : undefined;
    // Exact size promised by the HTTP response itself (never the approximate RSS `length`). A
    // `Content-Encoding` makes `Content-Length` describe the encoded bytes, so skip it then.
    const encoding = resp.headers.get('content-encoding')?.trim().toLowerCase();
    const httpExpectedTotal =
      encoding && encoding !== 'identity'
        ? undefined
        : (rangeTotal ?? (Number.isFinite(contentLen) && contentLen > 0 ? resumeBytes + contentLen : undefined));
    const totalExpected = httpExpectedTotal ?? task.declaredSize;

    const ws = createWriteStream(task.partPath, { flags: appending ? 'a' : 'w' });
    let wsError: Error | undefined;
    ws.on('error', (e) => {
      wsError ??= e;
    });
    let written = resumeBytes;
    let lastEmitAt = 0;

    // Immediate snapshot of the resumed fraction (e.g. `42%`) instead of restarting at `0%`.
    const progressOf = (bytes: number): number | undefined =>
      totalExpected && totalExpected > 0 ? Math.min(0.99, bytes / totalExpected) : undefined;
    if (appending) {
      lastEmitAt = Date.now();
      const resumedProgress = progressOf(written);
      this.deps.emit({
        type: 'download-updated',
        episodeKey: task.episodeKey,
        state: 'RUNNING',
        ...(resumedProgress !== undefined ? { progress: resumedProgress } : {}),
      });
    }

    const reader = resp.body?.getReader();
    try {
      if (reader) {
        for (;;) {
          const { done, value } = await raceAbort(reader.read(), signal);
          if (done) break;
          touch();
          if (!value || value.byteLength === 0) continue;

          await new Promise<void>((resolve, reject) => {
            ws.write(value, (err) => (err ? reject(wsError ?? err) : resolve()));
          });
          written += value.byteLength;
          progress.bytes += value.byteLength;

          const now = Date.now();
          if (now - lastEmitAt >= EVENT_COALESCE_MS) {
            lastEmitAt = now;
            const p = progressOf(written);
            this.deps.emit({
              type: 'download-updated',
              episodeKey: task.episodeKey,
              state: 'RUNNING',
              ...(p !== undefined ? { progress: p } : {}),
            });
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        ws.end((err?: Error | null) => (err ? reject(wsError ?? err) : resolve()));
      });
      if (wsError) throw wsError;
    } catch (streamErr) {
      reader?.cancel().catch(noop);
      ws.destroy();
      throw streamErr;
    }

    // The body ended before the size the server promised (`Content-Range` total or
    // `Content-Length`): never rename a truncated `.part` to DONE. Keep it and retry, resuming via
    // `Range` (matches `DownloadTransfer.java`).
    if (httpExpectedTotal !== undefined && written < httpExpectedTotal) {
      throw new DownloadAttemptError(
        `Premature end of stream (${written} of ${httpExpectedTotal} bytes)`,
        { retryable: true },
      );
    }
  }

  private async fetchWithRedirectsAndAuth(
    startUrl: string,
    credentials: HttpBasicCredentials | undefined,
    resumeBytes: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const follow = async (
      url: string,
      authHeader?: string,
    ): Promise<{ readonly response: Response; readonly finalUrl: string }> => {
      let currentUrl = url;
      let currentAuth = authHeader;
      for (let hop = 0; hop <= 10; hop++) {
        const headers: Record<string, string> = { 'User-Agent': this.userAgent };
        if (resumeBytes > 0) {
          headers['Range'] = `bytes=${resumeBytes}-`;
        }
        if (currentAuth) {
          headers['Authorization'] = currentAuth;
        }
        const resp = await this.fetchFn(currentUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal,
        });
        if (!STREAM_REDIRECT_STATUSES.has(resp.status)) {
          return { response: resp, finalUrl: currentUrl };
        }
        const loc = resp.headers.get('location');
        if (!loc) return { response: resp, finalUrl: currentUrl };
        await resp.body?.cancel().catch(noop);
        const extracted = extractUrlCredentials(new URL(loc, currentUrl).toString());
        if (extracted.credentials) {
          currentAuth = encodeBasicAuthHeaders(extracted.credentials)[0];
        } else if (!authHeader || !sameOrigin(currentUrl, extracted.cleanUrl)) {
          // Never forward `Authorization` to another scheme://host:port (CDN / S3 pre-signed URL):
          // it leaks the feed credentials and breaks signed URLs (`HTTP 400 InvalidArgument`).
          currentAuth = undefined;
        }
        currentUrl = extracted.cleanUrl;
      }
      throw new DownloadAttemptError('Too many redirects downloading enclosure', { retryable: false });
    };

    let res = await follow(startUrl);
    if (res.response.status === 401 && credentials) {
      const challengeUrl = res.finalUrl || startUrl;
      for (const candidate of encodeBasicAuthHeaders(credentials)) {
        await res.response.body?.cancel().catch(noop);
        res = await follow(challengeUrl, candidate);
        if (res.response.status !== 401) break;
      }
    }
    return res.response;
  }

  async deleteDownload(episodeKey: EpisodeKey): Promise<void> {
    const task = this.tasks.get(episodeKey);
    if (task) {
      if (task.state === 'QUEUED') {
        this.cancelQueuedTask(task);
      } else {
        task.controller.abort();
        await task.promise.catch(noop);
      }
    }

    const row = this.episodesRepo.getRawByKey(episodeKey);
    if (!row) return;
    if (row.feed_key.startsWith('l_')) {
      // Never delete a user's source media file in a Local Folder!
      return;
    }

    if (row.download_path) {
      this.deleteFilesByPaths([row.download_path]);
    }
    if (task || row.enclosure_url) {
      // An in-flight (or interrupted) download has `download_path = NULL` in SQLite, so also
      // clean up the deterministic destination + `.part` temp file left behind by the abort.
      const ext = chooseExtension(row.enclosure_url ?? '', row.enclosure_mime ?? undefined);
      const destPath = join(this.downloadsDir, `${episodeKey}.${ext}`);
      this.deleteFilesByPaths([destPath]);
    }
    this.episodesRepo.setDownloadState(episodeKey, 'NONE', null);
    this.deps.emit({ type: 'download-updated', episodeKey, state: 'NONE' });
    this.deps.emit({ type: 'episodes-changed', feedKey: row.feed_key });
  }
}
