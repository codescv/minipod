/**
 * Typed Hono REST routes implementing all `PlatformHost` endpoints (`ARCHITECTURE.md §3.2`),
 * plus binary chapter `APIC` slice and local-folder cover image endpoints.
 */
import {
  MiniPodError,
  type AppSettings,
  type EpisodeFilter,
  type HttpBasicCredentials,
  type LocalFolderRef,
  type PlatformHost,
  type ProgressSave,
  type SourceId,
  type SyncProviderSecret,
  type SyncSettings,
} from '@minipod/core';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MediaProxy } from '../../net/range-proxy';
import { statusForErrorCode, type ApiResponse } from '../../shared/wire';

async function readJsonBody<T>(c: Context): Promise<T> {
  try {
    const text = await c.req.text();
    if (!text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    throw new MiniPodError('invalid-argument', 'Malformed JSON request body', { cause: err });
  }
}

async function handleApi<T>(c: Context, fn: () => Promise<T>): Promise<Response> {
  try {
    const data = await fn();
    const payload: ApiResponse<T> = { ok: true, data };
    return c.json(payload, 200);
  } catch (err) {
    const wrapped = MiniPodError.wrap(err, 'internal');
    const status = statusForErrorCode(wrapped.code) as ContentfulStatusCode;
    const payload: ApiResponse<never> = { ok: false, error: wrapped.toShape() };
    return c.json(payload, status);
  }
}

export function createApiRoutes(host: PlatformHost, mediaProxy: MediaProxy): Hono {
  const api = new Hono();

  // Host info
  api.get('/info', (c) => handleApi(c, async () => host.info));

  // CORS / Hotlink / Mixed-Content artwork image proxy (`GET|HEAD /api/image-proxy?url=<encoded>`)
  api.on(['GET', 'HEAD'], '/image-proxy', (c) => {
    const rawUrl = c.req.query('url');
    const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
    return mediaProxy.handleImageProxy({
      url: rawUrl,
      method,
      signal: c.req.raw.signal,
    });
  });

  // Feeds — register all static subpaths BEFORE `/:feedKey`
  api.get('/feeds', (c) => handleApi(c, () => host.feeds.list()));

  api.post('/feeds/preview', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ url?: string; credentials?: HttpBasicCredentials }>(c);
      if (typeof body.url !== 'string' || !body.url.trim()) {
        throw new MiniPodError('invalid-url', 'Missing "url" field');
      }
      return host.feeds.preview(body.url, body.credentials);
    }),
  );

  api.post('/feeds/subscribe', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ previewIdOrUrl?: string; url?: string }>(c);
      const target = body.previewIdOrUrl ?? body.url;
      if (typeof target !== 'string' || !target.trim()) {
        throw new MiniPodError('invalid-argument', 'Missing "previewIdOrUrl"');
      }
      return host.feeds.subscribe(target);
    }),
  );

  api.post('/feeds/refresh', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ feedKey?: string }>(c);
      await host.feeds.refresh(body.feedKey);
      return null;
    }),
  );

  api.post('/feeds/local-folder', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ folder?: LocalFolderRef; ref?: string; displayName?: string }>(c);
      const folder =
        body.folder ??
        (body.ref
          ? { ref: body.ref, displayName: body.displayName ?? body.ref }
          : undefined);
      if (!folder || typeof folder.ref !== 'string' || !folder.ref.trim()) {
        throw new MiniPodError('invalid-argument', 'Missing local folder reference');
      }
      return host.feeds.addLocalFolder(folder);
    }),
  );

  // Supports both raw `text/xml` / `application/xml` body AND JSON `{ xml: string }` (`ARCHITECTURE.md §3.2`)
  api.post('/feeds/opml', (c) =>
    handleApi(c, async () => {
      const ct = (c.req.header('content-type') ?? '').toLowerCase();
      let xml: string;
      if (ct.startsWith('application/json')) {
        const body = await readJsonBody<{ xml?: string }>(c);
        if (typeof body.xml !== 'string') {
          throw new MiniPodError('invalid-argument', 'Missing "xml" field');
        }
        xml = body.xml;
      } else {
        xml = await c.req.text();
      }
      return host.feeds.importOpml(xml);
    }),
  );

  api.get('/feeds/opml', (c) =>
    handleApi(c, async () => {
      const xml = await host.feeds.exportOpml();
      return { xml };
    }),
  );

  api.post('/feeds/subscribe-many', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ urls?: readonly string[] }>(c);
      if (!Array.isArray(body.urls)) {
        throw new MiniPodError('invalid-argument', 'Expected "urls" string array');
      }
      return host.feeds.subscribeMany(body.urls);
    }),
  );

  // Binary cover art for local-folder feeds
  api.on(['GET', 'HEAD'], '/feeds/:feedKey/cover', (c) => {
    const feedKey = c.req.param('feedKey');
    const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
    return mediaProxy.handleFeedCover(feedKey, method);
  });

  api.post('/feeds/:feedKey/refresh', (c) =>
    handleApi(c, async () => {
      await host.feeds.refresh(c.req.param('feedKey'));
      return null;
    }),
  );

  api.post('/feeds/:feedKey/load-older', (c) =>
    handleApi(c, async () => {
      const added = await host.feeds.loadOlder(c.req.param('feedKey'));
      return { added };
    }),
  );

  api.put('/feeds/:feedKey/credentials', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ credentials?: HttpBasicCredentials | null }>(c);
      await host.feeds.setCredentials(c.req.param('feedKey'), body.credentials ?? null);
      return null;
    }),
  );

  api.get('/feeds/:feedKey', (c) =>
    handleApi(c, () => host.feeds.get(c.req.param('feedKey'))),
  );

  api.delete('/feeds/:feedKey', (c) =>
    handleApi(c, async () => {
      await host.feeds.unsubscribe(c.req.param('feedKey'));
      return null;
    }),
  );

  // Search
  api.get('/search/sources', (c) => handleApi(c, () => host.search.sources()));

  api.get('/search/query', (c) =>
    handleApi(c, () => {
      const text = c.req.query('text') ?? '';
      const source = (c.req.query('source') as SourceId | undefined) || undefined;
      return host.search.query(text, source, c.req.raw.signal);
    }),
  );

  api.get('/search/top-charts', (c) =>
    handleApi(c, () => {
      const country = c.req.query('country') ?? '99';
      return host.search.topCharts(country, c.req.raw.signal);
    }),
  );

  api.post('/search/resolve', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ input?: string; credentials?: HttpBasicCredentials }>(c);
      if (typeof body.input !== 'string') {
        throw new MiniPodError('invalid-url', 'Missing "input" string');
      }
      return host.search.resolveUrl(body.input, body.credentials);
    }),
  );

  api.get('/search/countries', (c) => handleApi(c, () => host.search.countries()));

  // Episodes
  api.get('/episodes', (c) =>
    handleApi(c, () => {
      const feedKey = c.req.query('feedKey');
      if (!feedKey) {
        throw new MiniPodError('invalid-argument', 'Missing "feedKey" query parameter');
      }
      const filterRaw = c.req.query('filter');
      const filter: EpisodeFilter =
        filterRaw === 'unplayed' || filterRaw === 'downloaded' ? filterRaw : 'all';
      const cursor = c.req.query('cursor') || undefined;
      return host.episodes.list(feedKey, filter, cursor);
    }),
  );

  api.post('/episodes/:episodeKey/download', (c) =>
    handleApi(c, async () => {
      await host.episodes.download(c.req.param('episodeKey'));
      return null;
    }),
  );

  api.delete('/episodes/:episodeKey/download', (c) =>
    handleApi(c, async () => {
      await host.episodes.deleteDownload(c.req.param('episodeKey'));
      return null;
    }),
  );

  api.get('/episodes/:episodeKey/chapters', (c) =>
    handleApi(c, () => {
      const force = c.req.query('forceRefresh') === '1' || c.req.query('forceRefresh') === 'true';
      return host.episodes.chapters(c.req.param('episodeKey'), force);
    }),
  );

  // Binary chapter `APIC` slice endpoint (`ARCHITECTURE.md §4.4`)
  api.on(['GET', 'HEAD'], '/episodes/:episodeKey/chapters/:index/image', (c) => {
    const episodeKey = c.req.param('episodeKey');
    const idx = Number.parseInt(c.req.param('index'), 10);
    const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
    return mediaProxy.handleChapterImage({
      episodeKey,
      chapterIndex: idx,
      method,
      signal: c.req.raw.signal,
    });
  });

  // JSON helper for `EpisodesApi.chapterImage`
  api.get('/episodes/:episodeKey/chapters/:index/image-url', (c) =>
    handleApi(c, async () => {
      const idx = Number.parseInt(c.req.param('index'), 10);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new MiniPodError('invalid-argument', 'Invalid chapter index');
      }
      const url = await host.episodes.chapterImage(c.req.param('episodeKey'), idx);
      return { url: url ?? null };
    }),
  );

  api.get('/episodes/:episodeKey/share', (c) =>
    handleApi(c, () => host.episodes.share(c.req.param('episodeKey'))),
  );

  api.get('/episodes/:episodeKey', (c) =>
    handleApi(c, () => host.episodes.get(c.req.param('episodeKey'))),
  );

  // Queue
  api.get('/queue', (c) => handleApi(c, () => host.queue.list()));

  api.post('/queue/add', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ episodeKey?: string }>(c);
      if (!body.episodeKey) throw new MiniPodError('invalid-argument', 'Missing "episodeKey"');
      await host.queue.add(body.episodeKey);
      return null;
    }),
  );

  api.post('/queue/play-next', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ episodeKey?: string }>(c);
      if (!body.episodeKey) throw new MiniPodError('invalid-argument', 'Missing "episodeKey"');
      await host.queue.playNext(body.episodeKey);
      return null;
    }),
  );

  api.post('/queue/move', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ episodeKey?: string; beforeKey?: string | null }>(c);
      if (!body.episodeKey) throw new MiniPodError('invalid-argument', 'Missing "episodeKey"');
      await host.queue.move(body.episodeKey, body.beforeKey ?? null);
      return null;
    }),
  );

  api.post('/queue/clear', (c) =>
    handleApi(c, async () => {
      await host.queue.clear();
      return null;
    }),
  );

  api.delete('/queue/:episodeKey', (c) =>
    handleApi(c, async () => {
      await host.queue.remove(c.req.param('episodeKey'));
      return null;
    }),
  );

  // Progress
  api.post('/progress/save', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<ProgressSave>(c);
      if (!body.episodeKey || typeof body.positionMs !== 'number' || !body.state) {
        throw new MiniPodError('invalid-argument', 'Invalid ProgressSave payload');
      }
      await host.progress.save(body);
      return null;
    }),
  );

  api.post('/progress/mark-played', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ episodeKey?: string; played?: boolean }>(c);
      if (!body.episodeKey || typeof body.played !== 'boolean') {
        throw new MiniPodError('invalid-argument', 'Invalid mark-played payload');
      }
      await host.progress.markPlayed(body.episodeKey, body.played);
      return null;
    }),
  );

  api.get('/progress/:episodeKey', (c) =>
    handleApi(c, async () => {
      const record = await host.progress.get(c.req.param('episodeKey'));
      return { record: record ?? null };
    }),
  );

  // Playback
  api.get('/playback/source/:episodeKey', (c) =>
    handleApi(c, () => host.playback.sourceFor(c.req.param('episodeKey'))),
  );

  api.get('/playback/queue-sources', (c) =>
    handleApi(c, () => host.playback.queueSources()),
  );

  // Sync
  api.get('/sync/status', (c) => handleApi(c, () => host.sync.status()));

  api.post('/sync/configure', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ settings?: SyncSettings; secret?: SyncProviderSecret }>(c);
      if (!body.settings) {
        throw new MiniPodError('invalid-argument', 'Missing "settings" in sync configure');
      }
      return host.sync.configure(body.settings, body.secret);
    }),
  );

  api.post('/sync/authorize', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ provider?: 'drive-appdata' | 'drive-file' }>(c);
      if (body.provider !== 'drive-appdata' && body.provider !== 'drive-file') {
        throw new MiniPodError('invalid-argument', 'Invalid Drive provider');
      }
      await host.sync.authorize(body.provider);
      return null;
    }),
  );

  api.post('/sync/now', (c) => handleApi(c, () => host.sync.syncNow()));

  api.post('/sync/disconnect', (c) =>
    handleApi(c, async () => {
      await host.sync.disconnect();
      return null;
    }),
  );

  api.post('/sync/reset-remote', (c) =>
    handleApi(c, async () => {
      await host.sync.resetRemote();
      return null;
    }),
  );

  api.post('/sync/undo-resume', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ episodeKey?: string; positionMs?: number }>(c);
      if (!body.episodeKey || typeof body.positionMs !== 'number') {
        throw new MiniPodError('invalid-argument', 'Invalid undo-resume payload');
      }
      await host.sync.undoResume(body.episodeKey, body.positionMs);
      return null;
    }),
  );

  // Files
  api.get('/files/list-directory', (c) =>
    handleApi(c, async () => {
      if (!host.files.listDirectory) {
        throw new MiniPodError('unsupported', 'listDirectory is not supported');
      }
      const pathParam = c.req.query('path') || undefined;
      return host.files.listDirectory(pathParam);
    }),
  );

  api.post('/files/open-external', (c) =>
    handleApi(c, async () => {
      const body = await readJsonBody<{ url?: string }>(c);
      if (!body.url) {
        throw new MiniPodError('invalid-argument', 'Missing "url"');
      }
      await host.files.openExternal(body.url);
      return null;
    }),
  );

  // Settings
  api.get('/settings', (c) => handleApi(c, () => host.settings.get()));

  api.patch('/settings', (c) =>
    handleApi(c, async () => {
      const patch = await readJsonBody<Partial<AppSettings>>(c);
      return host.settings.update(patch);
    }),
  );

  // In-App Auto-Updater (`codescv/minipod` GitHub Releases)
  api.post('/update/check', (c) =>
    handleApi(c, async () => {
      if (!host.updater) {
        throw new MiniPodError('unsupported', 'Updater is not configured on this host');
      }
      const body = await readJsonBody<{ currentVersion?: string }>(c).catch(
        (): { currentVersion?: string } => ({}),
      );
      return host.updater.check(
        body.currentVersion ? { currentVersion: body.currentVersion } : undefined,
      );
    }),
  );

  api.post('/update/apply', (c) =>
    handleApi(c, async () => {
      if (!host.updater) {
        throw new MiniPodError('unsupported', 'Updater is not configured on this host');
      }
      const body = await readJsonBody<{ force?: boolean }>(c).catch(
        (): { force?: boolean } => ({}),
      );
      return host.updater.apply(body.force !== undefined ? { force: body.force } : undefined);
    }),
  );

  return api;
}
