/**
 * Manage Downloads screen (`管理下载` / `Manage downloads`):
 * - Opened from top-right `⋮` menu (`subs-manage-downloads` / `detail-manage-downloads` / `queue-manage-downloads`)
 *   when >= 1 downloaded episode exists across subscribed feeds.
 * - Supports single-episode delete (via long-press `ep-context-menu` `Delete download` /
 *   `ep-delete-download-*`, which replaces the queue toggle here, or swipe-left) and `Delete all`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeKey, FeedKey } from '@minipod/core';
import { dispatchBackNavigation } from '../../app/back';
import { useRouteStore } from '../../app/routes';
import { Button, Icon, IconButton } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useListReloadFilter } from '../../hooks/useListReloadFilter';
import { useT } from '../../i18n';
import {
  applyDownloadProgressToViewCache,
  applyDownloadStateToViewCache,
  getHostViewCache,
  type DownloadedEpisodeItem,
} from '../../stores/view-cache';
import { EpisodeRow } from './EpisodeRow';

export function DownloadsPage() {
  const host = useHost();
  const t = useT();
  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);

  const [items, setItems] = useState<readonly DownloadedEpisodeItem[]>(
    () => getHostViewCache(host).downloadedItems,
  );
  const [loading, setLoading] = useState(
    () => !getHostViewCache(host).downloadsLoaded && !getHostViewCache(host).timelineLoaded,
  );
  const [deletingAll, setDeletingAll] = useState(false);
  const seqRef = useRef(0);

  const loadDownloads = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      if (!host.info.capabilities.downloads) {
        if (seq === seqRef.current) {
          const viewCache = getHostViewCache(host);
          viewCache.downloadedItems = [];
          viewCache.downloadedCount = 0;
          viewCache.downloadsLoaded = true;
          setItems([]);
        }
        return;
      }
      const feeds = (await host.feeds.list()).filter((f) => f.kind !== 'LOCAL');
      if (feeds.length === 0) {
        if (seq === seqRef.current) {
          const viewCache = getHostViewCache(host);
          viewCache.downloadedItems = [];
          viewCache.downloadedCount = 0;
          viewCache.downloadsLoaded = true;
          setItems([]);
        }
        return;
      }

      const perFeed = await Promise.all(
        feeds.map(async (feed) => {
          try {
            const page = await host.episodes.list(feed.feedKey, 'downloaded');
            return page.items
              .filter((row) => row.episode.downloadState === 'DONE')
              .map((row): DownloadedEpisodeItem => ({ row, feed }));
          } catch {
            return [] as readonly DownloadedEpisodeItem[];
          }
        }),
      );

      if (seq !== seqRef.current) return;
      const merged = perFeed.flat().sort((a, b) => {
        const pubDiff = (b.row.episode.pubDate ?? 0) - (a.row.episode.pubDate ?? 0);
        if (pubDiff !== 0) return pubDiff;
        return a.row.episode.episodeKey.localeCompare(b.row.episode.episodeKey);
      });
      const viewCache = getHostViewCache(host);
      viewCache.downloadedItems = merged;
      viewCache.downloadedCount = merged.length;
      viewCache.downloadsLoaded = true;
      setItems(merged);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
      }
    }
  }, [host]);

  useEffect(() => {
    void loadDownloads();
  }, [loadDownloads]);

  const shouldReloadList = useListReloadFilter(() => {
    void loadDownloads();
  });

  useHostEvents((ev) => {
    if (ev.type === 'download-updated') {
      if (ev.state !== 'DONE') {
        // Drop a deleted/cancelled download from the list immediately (before revalidation).
        setItems((prev) => {
          const next = prev.filter((item) => item.row.episode.episodeKey !== ev.episodeKey);
          return next.length === prev.length ? prev : next;
        });
      }
      if (shouldReloadList(ev)) {
        applyDownloadStateToViewCache(host, ev.episodeKey, ev.state, undefined, ev.progress);
        void loadDownloads();
      } else {
        applyDownloadProgressToViewCache(host, ev.episodeKey, ev.state, ev.progress);
      }
      return;
    }
    if (
      ev.type === 'episodes-changed' ||
      ev.type === 'feeds-changed' ||
      ev.type === 'progress-changed' ||
      ev.type === 'queue-changed'
    ) {
      // Skip the playing episode's 5 s checkpoints.
      if (shouldReloadList(ev)) void loadDownloads();
    }
  });

  // Stable row callbacks so memoized `EpisodeRow`s skip re-rendering unchanged items.
  const openPodcastCallbacksRef = useRef(new Map<FeedKey, () => void>());
  const getOpenPodcastCallback = (feedKey: FeedKey): (() => void) => {
    const cache = openPodcastCallbacksRef.current;
    let cb = cache.get(feedKey);
    if (!cb) {
      cb = () => openPodcastDetail(feedKey);
      cache.set(feedKey, cb);
    }
    return cb;
  };
  const deleteCallbacksRef = useRef(new Map<EpisodeKey, () => void>());
  const loadDownloadsRef = useRef(loadDownloads);
  loadDownloadsRef.current = loadDownloads;
  const getDeleteCallback = (episodeKey: EpisodeKey): (() => void) => {
    const cache = deleteCallbacksRef.current;
    let cb = cache.get(episodeKey);
    if (!cb) {
      cb = () => {
        void host.episodes.deleteDownload(episodeKey).then(() => loadDownloadsRef.current());
      };
      cache.set(episodeKey, cb);
    }
    return cb;
  };
  const handleRowChanged = useCallback(() => {
    void loadDownloadsRef.current();
  }, []);

  const handleDeleteAll = async () => {
    if (items.length === 0 || deletingAll) return;
    setDeletingAll(true);
    try {
      await Promise.all(
        items.map((item) => host.episodes.deleteDownload(item.row.episode.episodeKey)),
      );
      await loadDownloads();
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <div className="m-page" data-testid="downloads-screen">
      <header className="m-appbar">
        <IconButton
          icon="back"
          label={t('common.back')}
          data-testid="downloads-back-btn"
          onClick={() => dispatchBackNavigation()}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 className="m-appbar__title" style={{ flex: '0 1 auto' }} data-testid="downloads-header-title">
            {t('downloads.title')}
          </h1>
          {items.length > 0 && (
            <span className="m-pill-badge" data-testid="downloads-count">
              {items.length}
            </span>
          )}
        </div>
        <Button
          variant="text"
          icon="delete"
          disabled={items.length === 0 || deletingAll}
          data-testid="downloads-delete-all-btn"
          onClick={() => {
            void handleDeleteAll();
          }}
        >
          {t('downloads.deleteAll')}
        </Button>
      </header>

      {!loading && items.length === 0 ? (
        <div className="m-empty" data-testid="downloads-empty">
          <Icon name="downloaded" size={44} />
          <div>{t('downloads.empty')}</div>
        </div>
      ) : (
        <div className="m-episode-list" data-testid="downloads-list">
          {items.map((item) => (
            <EpisodeRow
              key={item.row.episode.episodeKey}
              row={item.row}
              feedTitle={item.feed.title ?? item.feed.url}
              feedImageUrl={item.feed.imageUrl}
              allowDownloads
              onOpenPodcast={getOpenPodcastCallback(item.feed.feedKey)}
              swipeLeftHintLabel={t('detail.deleteDownload')}
              swipeLeftHintIcon="delete"
              swipeLeftHintTone="danger"
              onSwipeLeftOverride={getDeleteCallback(item.row.episode.episodeKey)}
              onDeleteDownload={getDeleteCallback(item.row.episode.episodeKey)}
              onChanged={handleRowChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}
