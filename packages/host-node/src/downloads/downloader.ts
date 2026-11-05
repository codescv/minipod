/**
 * Desktop manual per-episode downloader (`ARCHITECTURE.md §3.2`, `DESIGN.md §4.7`).
 *
 * - Downloads enclosures into `${dataDir}/downloads/${episodeKey}.${ext}` via `.part`
 *   temporary file with HTTP `Range` resume when a `.part` file exists.
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

export interface EpisodeDownloaderDeps {
  readonly db: Database;
  readonly downloadsDir: string;
  readonly userAgent: string;
  readonly fetchImpl?: typeof fetch;
  readonly getCredentials: (feedKey: FeedKey) => HttpBasicCredentials | undefined;
  readonly emit: (event: HostEvent) => void;
}

export class EpisodeDownloader {
  private readonly episodesRepo: EpisodesRepository;
  private readonly downloadsDir: string;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;
  private readonly deps: EpisodeDownloaderDeps;
  private readonly activeDownloads = new Map<
    EpisodeKey,
    { readonly controller: AbortController; readonly promise: Promise<void> }
  >();

  constructor(deps: EpisodeDownloaderDeps) {
    this.deps = deps;
    this.episodesRepo = new EpisodesRepository(deps.db);
    this.downloadsDir = deps.downloadsDir;
    this.userAgent = deps.userAgent;
    this.fetchFn = deps.fetchImpl ?? globalThis.fetch;
  }

  dispose(): void {
    for (const [, active] of this.activeDownloads) {
      active.controller.abort();
    }
    this.activeDownloads.clear();
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
    const stale = rows.map((r) => r.episode_key).filter((k) => !this.activeDownloads.has(k));
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

  async download(episodeKey: EpisodeKey): Promise<void> {
    const existingActive = this.activeDownloads.get(episodeKey);
    if (existingActive) {
      return existingActive.promise;
    }

    const row = this.episodesRepo.getRawByKey(episodeKey);
    if (!row) {
      throw new MiniPodError('not-found', `Episode not found: ${episodeKey}`);
    }
    if (row.feed_key.startsWith('l_')) {
      // Local folder episodes are already local files on disk
      return;
    }
    if (row.download_state === 'DONE' && row.download_path && existsSync(row.download_path)) {
      return;
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

    const controller = new AbortController();
    const promise = this.runDownload({
      episodeKey,
      feedKey: row.feed_key,
      enclosureUrl: row.enclosure_url,
      declaredSize: row.enclosure_size ?? undefined,
      destPath,
      partPath,
      signal: controller.signal,
    }).finally(() => {
      this.activeDownloads.delete(episodeKey);
    });

    this.activeDownloads.set(episodeKey, { controller, promise });
    return promise;
  }

  private async runDownload(params: {
    readonly episodeKey: EpisodeKey;
    readonly feedKey: FeedKey;
    readonly enclosureUrl: string;
    readonly declaredSize?: number | undefined;
    readonly destPath: string;
    readonly partPath: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    try {
      let resumeBytes = partialFileSize(params.partPath);
      this.episodesRepo.setDownloadState(params.episodeKey, 'RUNNING', null);
      this.deps.emit({
        type: 'download-updated',
        episodeKey: params.episodeKey,
        state: 'RUNNING',
        // Resuming: the real resumed fraction is emitted as soon as the server answers `206`.
        ...(resumeBytes > 0 ? {} : { progress: 0 }),
      });

      const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(params.enclosureUrl);
      const creds = inlineCreds ?? this.deps.getCredentials(params.feedKey);

      const resp = await this.fetchWithRedirectsAndAuth(
        cleanUrl,
        creds,
        resumeBytes,
        params.signal,
      );

      if (resp.status === 416 && resumeBytes > 0) {
        await resp.body?.cancel().catch(() => undefined);
        rmSync(params.partPath, { force: true });
        return this.runDownload(params);
      }

      if (resp.status < 200 || resp.status >= 300) {
        await resp.body?.cancel().catch(() => undefined);
        throw new MiniPodError('network', `Enclosure download failed (HTTP ${resp.status})`);
      }

      const appending = resp.status === 206 && resumeBytes > 0;
      if (!appending && resumeBytes > 0) {
        resumeBytes = 0;
      }

      const contentLenHeader = resp.headers.get('content-length');
      const contentLen = contentLenHeader ? Number.parseInt(contentLenHeader, 10) : Number.NaN;
      const rangeTotal = appending ? parseContentRangeTotal(resp.headers.get('content-range')) : undefined;
      const totalExpected =
        rangeTotal ??
        (Number.isFinite(contentLen) && contentLen > 0 ? resumeBytes + contentLen : params.declaredSize);

      const ws = createWriteStream(params.partPath, { flags: appending ? 'a' : 'w' });
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
          episodeKey: params.episodeKey,
          state: 'RUNNING',
          ...(resumedProgress !== undefined ? { progress: resumedProgress } : {}),
        });
      }

      try {
        if (resp.body) {
          const reader = resp.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            await new Promise<void>((resolve, reject) => {
              ws.write(value, (err) => (err ? reject(err) : resolve()));
            });
            written += value.byteLength;

            const now = Date.now();
            if (now - lastEmitAt >= EVENT_COALESCE_MS) {
              lastEmitAt = now;
              const progress = progressOf(written);
              this.deps.emit({
                type: 'download-updated',
                episodeKey: params.episodeKey,
                state: 'RUNNING',
                ...(progress !== undefined ? { progress } : {}),
              });
            }
          }
        }

        await new Promise<void>((resolve, reject) => {
          ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      } catch (streamErr) {
        ws.destroy();
        throw streamErr;
      }

      renameSync(params.partPath, params.destPath);
      this.episodesRepo.setDownloadState(params.episodeKey, 'DONE', params.destPath);
      this.deps.emit({
        type: 'download-updated',
        episodeKey: params.episodeKey,
        state: 'DONE',
        progress: 1,
      });
      this.deps.emit({ type: 'episodes-changed', feedKey: params.feedKey });
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      if (wrapped.code === 'cancelled') {
        this.episodesRepo.setDownloadState(params.episodeKey, 'NONE', null);
        this.deps.emit({ type: 'download-updated', episodeKey: params.episodeKey, state: 'NONE' });
        return;
      }
      this.episodesRepo.setDownloadState(params.episodeKey, 'FAILED', null);
      this.deps.emit({
        type: 'download-updated',
        episodeKey: params.episodeKey,
        state: 'FAILED',
        error: wrapped.toShape(),
      });
      throw wrapped;
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
        await resp.body?.cancel().catch(() => undefined);
        const extracted = extractUrlCredentials(new URL(loc, currentUrl).toString());
        if (extracted.credentials) {
          currentAuth = encodeBasicAuthHeaders(extracted.credentials)[0];
        } else if (!authHeader) {
          currentAuth = undefined;
        }
        currentUrl = extracted.cleanUrl;
      }
      throw new MiniPodError('network', 'Too many redirects downloading enclosure');
    };

    let res = await follow(startUrl);
    if (res.response.status === 401 && credentials) {
      const challengeUrl = res.finalUrl || startUrl;
      for (const candidate of encodeBasicAuthHeaders(credentials)) {
        await res.response.body?.cancel().catch(() => undefined);
        res = await follow(challengeUrl, candidate);
        if (res.response.status !== 401) break;
      }
    }
    return res.response;
  }

  async deleteDownload(episodeKey: EpisodeKey): Promise<void> {
    const active = this.activeDownloads.get(episodeKey);
    if (active) {
      active.controller.abort();
      await active.promise.catch(() => undefined);
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
    if (active || row.enclosure_url) {
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
