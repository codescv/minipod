/**
 * Feed refresher & Atom RFC 5005 pagination loader (`ARCHITECTURE.md §4.1.3`, `§4.2`, `§6.1`).
 *
 * - Supports conditional GET (`If-None-Match` / `If-Modified-Since` -> `304 Not Modified`).
 * - Applies permanent redirect updates (`301`/`308`, `http->https`, `<itunes:new-feed-url>`)
 *   via `RedirectRecorder.analyse` + `FeedsRepository.recordPermanentMove`.
 * - Rescans `LOCAL` folder feeds, removing deleted files while preserving `progress`.
 * - Schedules optional background refreshes (`backgroundRefreshHours`).
 */
import {
  decodeFeedBytes,
  detectFeedType,
  extractUrlCredentials,
  fetchWithBasicAuth,
  HybridLogicalClock,
  LOCAL_FOLDER_URL_PREFIX,
  MiniPodError,
  parseFeed,
  prepareUrl,
  RedirectRecorder,
  type DeviceId,
  type EpisodeKey,
  type FeedKey,
  type HostEvent,
  type HttpBasicCredentials,
  type HttpClient,
} from '@minipod/core';
import type { Database } from '../db/sqlite';
import { transaction } from '../db/sqlite';
import { EpisodesRepository, type EpisodeDbRow } from '../db/repositories/episodes';
import { FeedsRepository, type FeedDbRow } from '../db/repositories/feeds';
import { scanLocalFolder, type ExistingLocalEpisodeHint } from './local-folder';

export interface FeedRefresherDeps {
  readonly db: Database;
  readonly http: HttpClient;
  readonly hlc: HybridLogicalClock;
  readonly userAgent: string;
  readonly getDeviceId: () => DeviceId;
  readonly getCredentials: (feedKey: FeedKey) => HttpBasicCredentials | undefined;
  readonly getCurrentPlayingEpisodeKey?: () => EpisodeKey | undefined;
  readonly emit: (event: HostEvent) => void;
  readonly onFeedMoved?: () => void;
}

const MAX_CONCURRENT_REFRESHES = 4;

export class FeedRefresher {
  private readonly db: Database;
  private readonly http: HttpClient;
  private readonly hlc: HybridLogicalClock;
  private readonly feedsRepo: FeedsRepository;
  private readonly episodesRepo: EpisodesRepository;
  private readonly deps: FeedRefresherDeps;
  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inflightByFeed = new Map<FeedKey, Promise<void>>();

  constructor(deps: FeedRefresherDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.http = deps.http;
    this.hlc = deps.hlc;
    this.feedsRepo = new FeedsRepository(deps.db);
    this.episodesRepo = new EpisodesRepository(deps.db);
  }

  configureBackgroundRefresh(hours: 0 | 1 | 3 | 6 | 12 | 24): void {
    if (this.bgTimer !== null) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    if (hours <= 0) return;
    const intervalMs = hours * 60 * 60_000;
    this.bgTimer = setInterval(() => {
      void this.refreshAll().catch(() => undefined);
    }, intervalMs);
    this.bgTimer.unref?.();
  }

  dispose(): void {
    if (this.bgTimer !== null) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
  }

  async refresh(feedKey?: FeedKey): Promise<void> {
    if (feedKey !== undefined) {
      await this.refreshOne(feedKey, true);
      return;
    }
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    const subscribed = this.feedsRepo.listSubscribed();
    if (subscribed.length === 0) return;

    const queue = [...subscribed];
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_REFRESHES, queue.length) },
      async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          await this.refreshOne(next.feedKey, false);
        }
      },
    );
    await Promise.all(workers);
  }

  private async refreshOne(feedKey: FeedKey, rethrowError: boolean): Promise<void> {
    const inflight = this.inflightByFeed.get(feedKey);
    if (inflight) {
      return inflight;
    }

    const task = this.executeRefreshOne(feedKey, rethrowError).finally(() => {
      this.inflightByFeed.delete(feedKey);
    });
    this.inflightByFeed.set(feedKey, task);
    return task;
  }

  private async executeRefreshOne(feedKey: FeedKey, rethrowError: boolean): Promise<void> {
    const row = this.feedsRepo.getRaw(feedKey);
    if (!row) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }

    try {
      if (row.kind === 'LOCAL' || row.url.startsWith(LOCAL_FOLDER_URL_PREFIX)) {
        this.refreshLocalFolderRow(row);
        this.deps.emit({ type: 'episodes-changed', feedKey });
        this.deps.emit({ type: 'feeds-changed' });
        this.deps.emit({ type: 'feed-refreshed', feedKey });
        return;
      }

      await this.refreshRssRow(row);
    } catch (err) {
      const wrapped = MiniPodError.wrap(err, 'network');
      this.deps.emit({
        type: 'feed-refreshed',
        feedKey,
        error: wrapped.toShape(),
      });
      if (rethrowError) {
        throw wrapped;
      }
    }
  }

  private refreshLocalFolderRow(row: FeedDbRow): void {
    const folderPath = row.url.startsWith(LOCAL_FOLDER_URL_PREFIX)
      ? row.url.slice(LOCAL_FOLDER_URL_PREFIX.length)
      : row.url;

    const existingEpRows = this.db
      .prepare('SELECT * FROM episodes WHERE feed_id = ?')
      .all(row.id) as unknown as EpisodeDbRow[];

    const existingHints = new Map<string, ExistingLocalEpisodeHint>();
    for (const epRow of existingEpRows) {
      existingHints.set(epRow.identity, {
        identity: epRow.identity,
        mtimeMs: epRow.local_mtime_ms,
        size: epRow.enclosure_size,
        episode: {
          identity: epRow.identity,
          guid: epRow.identity,
          title: epRow.title,
          mediaType: epRow.media_type,
          ...(epRow.description !== null ? { description: epRow.description } : {}),
          ...(epRow.enclosure_url !== null ? { enclosureUrl: epRow.enclosure_url } : {}),
          ...(epRow.enclosure_mime !== null ? { enclosureMime: epRow.enclosure_mime } : {}),
          ...(epRow.enclosure_size !== null ? { enclosureSize: epRow.enclosure_size } : {}),
          ...(epRow.pub_date !== null ? { pubDate: epRow.pub_date } : {}),
          ...(epRow.duration_ms !== null ? { durationMs: epRow.duration_ms } : {}),
        },
      });
    }

    const scanned = scanLocalFolder(folderPath, {
      displayName: row.title ?? undefined,
      existingByIdentity: existingHints,
    });

    transaction(this.db, () => {
      this.feedsRepo.upsertParsedFeed({
        feedKey: row.feed_key,
        kind: 'LOCAL',
        url: scanned.feedUrl,
        subscribed: row.subscribed !== 0,
        parsed: scanned.parsed,
        hlc: this.hlc,
        nowWallMs: Date.now(),
        localCoverPath: scanned.localCoverSpec,
        overrideImageUrl: scanned.localCoverSpec
          ? `/api/feeds/${encodeURIComponent(row.feed_key)}/cover`
          : undefined,
        localMtimeByIdentity: scanned.mtimeByIdentity,
        markSyncDirty: false,
      });

      // Remove episodes whose files disappeared from disk (unless currently playing)
      const playingKey = this.deps.getCurrentPlayingEpisodeKey?.();
      for (const epRow of existingEpRows) {
        if (!scanned.presentIdentities.has(epRow.identity) && epRow.episode_key !== playingKey) {
          this.db.prepare('DELETE FROM queue WHERE episode_key = ?').run(epRow.episode_key);
          this.db.prepare('DELETE FROM episodes WHERE id = ?').run(epRow.id);
        }
      }
    });
  }

  private async refreshRssRow(row: FeedDbRow): Promise<void> {
    const fetchUrl = row.moved_to || row.url;
    const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(fetchUrl);
    const creds = inlineCreds ?? this.deps.getCredentials(row.feed_key);

    const conditionalHeaders: Record<string, string> = {
      Accept:
        'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      'User-Agent': this.deps.userAgent,
    };
    if (row.etag) {
      conditionalHeaders['If-None-Match'] = row.etag;
    }
    if (row.last_modified) {
      conditionalHeaders['If-Modified-Since'] = row.last_modified;
    }

    const resp = await fetchWithBasicAuth(
      this.http,
      {
        url: cleanUrl,
        method: 'GET',
        headers: conditionalHeaders,
      },
      creds,
    );

    const nowMs = Date.now();

    if (resp.status === 304) {
      this.feedsRepo.updateConditionalHeaders(row.feed_key, {
        etag: resp.headers['etag'],
        lastModified: resp.headers['last-modified'],
        refreshedAt: nowMs,
      });
      this.deps.emit({ type: 'feed-refreshed', feedKey: row.feed_key });
      return;
    }

    if (resp.status === 401) {
      throw new MiniPodError('auth-required', `Authentication required for ${cleanUrl}`, {
        details: { url: resp.finalUrl || cleanUrl },
      });
    }
    if (resp.status === 404 || resp.status === 410) {
      throw new MiniPodError(
        'feed-not-found',
        `Feed returned HTTP ${resp.status} at ${resp.finalUrl || cleanUrl}`,
        { details: { status: resp.status } },
      );
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `Feed refresh failed with HTTP ${resp.status}`, {
        details: { status: resp.status },
      });
    }

    const finalUrl = resp.finalUrl || cleanUrl;
    const xmlText = decodeFeedBytes(await resp.bytes(), resp.headers['content-type']);
    detectFeedType(xmlText);
    const parsed = parseFeed(xmlText, { baseUrl: finalUrl });

    // Check permanent redirect (301/308/http->https or <itunes:new-feed-url>)
    let newPermUrl: string | undefined = RedirectRecorder.analyse(resp.chain)?.to;
    if (parsed.redirectUrl) {
      const candidate = prepareUrl(parsed.redirectUrl, finalUrl);
      if (candidate !== cleanUrl) {
        newPermUrl = candidate;
      }
    }

    let targetFeedKey = row.feed_key;
    let moved = false;
    if (newPermUrl && newPermUrl !== fetchUrl) {
      targetFeedKey = this.feedsRepo.recordPermanentMove(
        row.feed_key,
        newPermUrl,
        this.hlc,
        this.deps.getDeviceId(),
      );
      moved = true;
    }

    const effectiveUrl = newPermUrl ?? fetchUrl;
    this.feedsRepo.upsertParsedFeed({
      feedKey: targetFeedKey,
      kind: 'RSS',
      url: effectiveUrl,
      subscribed: row.subscribed !== 0,
      parsed,
      hlc: this.hlc,
      nowWallMs: nowMs,
      etag: resp.headers['etag'],
      lastModified: resp.headers['last-modified'],
      ...(newPermUrl ? { movedTo: newPermUrl } : {}),
      ...(moved ? { markSyncDirty: true } : {}),
    });

    if (moved) {
      this.deps.onFeedMoved?.();
    }

    this.deps.emit({ type: 'episodes-changed', feedKey: targetFeedKey });
    this.deps.emit({ type: 'feeds-changed' });
    this.deps.emit({ type: 'feed-refreshed', feedKey: targetFeedKey });
  }

  /**
   * Loads the next RFC 5005 `<link rel="next">` archive page for a feed (`FeedsApi.loadOlder`).
   */
  async loadOlder(feedKey: FeedKey): Promise<number> {
    const row = this.feedsRepo.getRaw(feedKey);
    if (!row) {
      throw new MiniPodError('not-found', `Feed not found: ${feedKey}`);
    }
    if (!row.next_page_url) {
      return 0;
    }

    const creds = this.deps.getCredentials(feedKey);
    const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(row.next_page_url);
    const resp = await fetchWithBasicAuth(
      this.http,
      {
        url: cleanUrl,
        method: 'GET',
        headers: {
          Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9',
          'User-Agent': this.deps.userAgent,
        },
      },
      inlineCreds ?? creds,
    );

    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `Failed to load older episodes (HTTP ${resp.status})`);
    }

    const finalUrl = resp.finalUrl || cleanUrl;
    const xmlText = decodeFeedBytes(await resp.bytes(), resp.headers['content-type']);
    detectFeedType(xmlText);
    const parsed = parseFeed(xmlText, { baseUrl: finalUrl });

    const added = this.episodesRepo.upsertParsedEpisodes(row.id, feedKey, parsed.episodes, {
      fallbackImageUrl: row.image_url?.trim() || parsed.imageUrl?.trim(),
    });

    const nextUrl =
      parsed.nextPageUrl && parsed.nextPageUrl !== row.next_page_url
        ? parsed.nextPageUrl
        : undefined;
    this.feedsRepo.updateNextPageUrl(feedKey, nextUrl);

    if (added > 0) {
      this.deps.emit({ type: 'episodes-changed', feedKey });
    }
    this.deps.emit({ type: 'feeds-changed' });
    return added;
  }
}
