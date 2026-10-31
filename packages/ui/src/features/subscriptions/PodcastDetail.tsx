/**
 * Podcast Detail screen (`DESIGN.md` §4.3 + `v0.1.5`):
 * - Header (`←`, title, `⋮` Manage downloads when non-empty / Refresh / Visit website / Set credentials / Copy URL / Unsubscribe)
 * - Hero (cover, author, 3-line expandable description)
 * - Strictly 3 filter chips: `All` / `Unplayed` / `Downloaded`
 * - Gesture-driven `EpisodeRow` items + immediate swipe-right dismiss (with Undo) + RFC 5005 *Load older episodes*
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EpisodeFilter,
  EpisodeKey,
  EpisodeRow as EpisodeRowModel,
  Feed,
  FeedKey,
} from '@minipod/core';
import { dispatchBackNavigation } from '../../app/back';
import { useRouteStore } from '../../app/routes';
import {
  ArtworkImage,
  Button,
  Chip,
  cx,
  Dialog,
  Icon,
  IconButton,
  Menu,
  preloadArtworkUrls,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useDownloadedCount } from '../../hooks/useDownloadedCount';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { stripHtmlToText } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar } from '../../stores/snackbar';
import {
  filterCachedEpisodeRows,
  getHostViewCache,
  recomputeHostTimelineAndDownloads,
  type EpisodeSortOrder,
} from '../../stores/view-cache';
import { EpisodeRow } from './EpisodeRow';

export function PodcastDetail({ feedKey }: { readonly feedKey: FeedKey }) {
  const host = useHost();
  const t = useT();
  const player = usePlayer();
  const openDownloads = useRouteStore((s) => s.openDownloads);
  const downloadedCount = useDownloadedCount();
  const activeEpisodeKeyRef = useRef<EpisodeKey | undefined>(player.episode?.episodeKey);
  activeEpisodeKeyRef.current = player.episode?.episodeKey;

  const [feed, setFeed] = useState<Feed | null>(
    () => getHostViewCache(host).feedsByKey.get(feedKey) ?? null,
  );
  const [allRows, setAllRows] = useState<readonly EpisodeRowModel[]>(
    () => getHostViewCache(host).episodesByFeed.get(feedKey) ?? [],
  );
  const [filter, setFilter] = useState<EpisodeFilter>('all');
  const [sortOrder, setSortOrder] = useState<EpisodeSortOrder>(
    () => getHostViewCache(host).feedSortOrder.get(feedKey) ?? 'desc',
  );
  const [rows, setRows] = useState<readonly EpisodeRowModel[]>(
    () => getHostViewCache(host).episodesByFeed.get(feedKey) ?? [],
  );
  const [loading, setLoading] = useState<boolean>(
    () => !getHostViewCache(host).episodesByFeed.has(feedKey),
  );
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<EpisodeKey>>(() => new Set());
  const [descExpanded, setDescExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [credsDialogOpen, setCredsDialogOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const inlineUndoKeysRef = useRef<Set<EpisodeKey>>(new Set());
  const prevFeedKeyRef = useRef(feedKey);

  if (prevFeedKeyRef.current !== feedKey) {
    prevFeedKeyRef.current = feedKey;
    const viewCache = getHostViewCache(host);
    const cachedAll = viewCache.episodesByFeed.get(feedKey) ?? [];
    inlineUndoKeysRef.current.clear();
    setFeed(viewCache.feedsByKey.get(feedKey) ?? null);
    setSortOrder(viewCache.feedSortOrder.get(feedKey) ?? 'desc');
    setAllRows(cachedAll);
    setRows(filterCachedEpisodeRows(cachedAll, filter, inlineUndoKeysRef.current));
    setDismissedKeys(new Set());
    setLoading(!viewCache.episodesByFeed.has(feedKey));
  }

  useEffect(() => {
    inlineUndoKeysRef.current.clear();
    setDismissedKeys(new Set());
  }, [feedKey, filter]);

  const handleSelectFilter = useCallback(
    (nextFilter: EpisodeFilter) => {
      if (nextFilter === filter) return;
      inlineUndoKeysRef.current.clear();
      setDismissedKeys(new Set());
      setFilter(nextFilter);
      const cachedAll = getHostViewCache(host).episodesByFeed.get(feedKey) ?? allRows;
      setRows(filterCachedEpisodeRows(cachedAll, nextFilter, inlineUndoKeysRef.current));
    },
    [allRows, feedKey, filter, host],
  );

  const reload = useCallback(async () => {
    try {
      const fetchFilter: EpisodeFilter =
        filter === 'unplayed' && inlineUndoKeysRef.current.size > 0 ? 'all' : filter;
      const [loadedFeed, page, latestQueue] = await Promise.all([
        host.feeds.get(feedKey),
        host.episodes.list(feedKey, fetchFilter),
        host.queue.list().catch(() => null),
      ]);
      const viewCache = getHostViewCache(host);
      if (latestQueue !== null) {
        viewCache.queueRows = latestQueue;
        viewCache.queueLoaded = true;
      }
      const nextFeedsByKey = new Map(viewCache.feedsByKey);
      nextFeedsByKey.set(feedKey, loadedFeed);
      viewCache.feedsByKey = nextFeedsByKey;
      if (viewCache.feeds.some((f) => f.feedKey === feedKey)) {
        viewCache.feeds = viewCache.feeds.map((f) => (f.feedKey === feedKey ? loadedFeed : f));
      }

      if (fetchFilter === 'all') {
        viewCache.episodesByFeed.set(feedKey, page.items);
        setAllRows(page.items);
        if (viewCache.feedsLoaded) {
          const derived = recomputeHostTimelineAndDownloads(
            host,
            viewCache.feeds,
            viewCache.episodesByFeed,
            undefined,
            activeEpisodeKeyRef.current,
          );
          viewCache.timelineItems = derived.timelineItems;
          viewCache.downloadedCount = derived.downloadedCount;
          viewCache.downloadedItems = derived.downloadedItems;
        }
      } else {
        const existingAll = viewCache.episodesByFeed.get(feedKey);
        if (existingAll) {
          const updatedByKey = new Map(page.items.map((r) => [r.episode.episodeKey, r]));
          const mergedAll = existingAll.map((r) => updatedByKey.get(r.episode.episodeKey) ?? r);
          viewCache.episodesByFeed.set(feedKey, mergedAll);
          setAllRows(mergedAll);
        }
        void host.episodes
          .list(feedKey, 'all')
          .then((allPage) => {
            const c = getHostViewCache(host);
            c.episodesByFeed.set(feedKey, allPage.items);
            setAllRows(allPage.items);
            if (c.feedsLoaded) {
              const derived = recomputeHostTimelineAndDownloads(
                host,
                c.feeds,
                c.episodesByFeed,
                undefined,
                activeEpisodeKeyRef.current,
              );
              c.timelineItems = derived.timelineItems;
              c.downloadedCount = derived.downloadedCount;
              c.downloadedItems = derived.downloadedItems;
            }
          })
          .catch(() => undefined);
      }

      const nextRows =
        filter === 'unplayed' && fetchFilter === 'all'
          ? page.items.filter(
              (r) =>
                r.progress?.state !== 'PLAYED' ||
                inlineUndoKeysRef.current.has(r.episode.episodeKey),
            )
          : page.items;
      setFeed(loadedFeed);
      setRows(nextRows);
      setLoading(false);
      preloadArtworkUrls(
        [
          loadedFeed.imageUrl,
          ...page.items.slice(0, 24).map((item) => item.episode.imageUrl),
        ],
        shouldUseImageProxy(host.info.platform),
      );
    } catch {
      // ignore if unsubscribed mid-flight
      setLoading(false);
    }
  }, [feedKey, filter, host]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useHostEvents((ev) => {
    if (
      ev.type === 'feeds-changed' ||
      (ev.type === 'episodes-changed' && ev.feedKey === feedKey) ||
      ev.type === 'progress-changed' ||
      ev.type === 'queue-changed' ||
      ev.type === 'download-updated'
    ) {
      void reload();
    }
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await host.feeds.refresh(feedKey);
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const handleLoadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      await host.feeds.loadOlder(feedKey);
      await reload();
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleUnsubscribe = async () => {
    const title = feed?.title ?? feed?.url ?? '';
    await host.feeds.unsubscribe(feedKey);
    showSnackbar(t('subs.unsubscribedSnack', { title }));
    dispatchBackNavigation();
  };

  const handleSaveCredentials = async () => {
    const creds = username.trim() ? { username: username.trim(), password } : null;
    await host.feeds.setCredentials(feedKey, creds);
    setCredsDialogOpen(false);
    await handleRefresh();
  };

  const plainDesc = stripHtmlToText(feed?.description);
  const allowDownloads = Boolean(host.info.capabilities.downloads && feed?.kind !== 'LOCAL');
  const filteredVisibleRows = rows.filter((r) => !dismissedKeys.has(r.episode.episodeKey));
  const visibleRows =
    sortOrder === 'asc' ? [...filteredVisibleRows].reverse() : filteredVisibleRows;

  const menuItems: MenuEntry[] = [
    ...(downloadedCount > 0
      ? [
          {
            key: 'manage-downloads',
            label: t('subs.manageDownloads', { count: downloadedCount }),
            icon: 'downloaded' as const,
            testId: 'detail-manage-downloads',
            onSelect: () => openDownloads(),
          },
        ]
      : []),
    {
      key: 'refresh',
      label: t('common.refresh'),
      icon: 'refresh',
      disabled: refreshing,
      testId: 'detail-menu-refresh',
      onSelect: () => {
        void handleRefresh();
      },
    },
    ...(feed?.link
      ? [
          {
            key: 'website',
            label: t('detail.visitWebsite'),
            icon: 'openExternal' as const,
            testId: 'detail-menu-website',
            onSelect: () => {
              if (feed.link) void host.files.openExternal(feed.link);
            },
          },
        ]
      : []),
    ...(feed?.kind === 'RSS'
      ? [
          {
            key: 'credentials',
            label: t('detail.setCredentials'),
            icon: 'lock' as const,
            testId: 'detail-menu-credentials',
            onSelect: () => setCredsDialogOpen(true),
          },
        ]
      : []),
    {
      key: 'copy-url',
      label: t('subs.copyUrl'),
      icon: 'link',
      testId: 'detail-menu-copy-url',
      onSelect: () => {
        if (feed) {
          void navigator.clipboard?.writeText?.(feed.url).catch(() => undefined);
          showSnackbar(t('common.copied'));
        }
      },
    },
    {
      key: 'unsubscribe',
      label: t('subs.unsubscribe'),
      icon: 'delete',
      testId: 'detail-menu-unsubscribe',
      onSelect: () => {
        void handleUnsubscribe();
      },
    },
  ];

  return (
    <div className="m-page" data-testid="podcast-detail-screen">
      <header className="m-appbar">
        <IconButton
          icon="back"
          label={t('common.back')}
          data-testid="detail-back-btn"
          onClick={() => dispatchBackNavigation()}
        />
        <h1 className="m-appbar__title">{feed?.title ?? ''}</h1>
        <Menu label={t('common.more')} items={menuItems} testId="detail-overflow-btn" />
      </header>

      {feed && (
        <section className="m-feed-hero">
          <ArtworkImage
            src={feed.imageUrl}
            allowProxyFallback={shouldUseImageProxy(host.info.platform)}
            className="m-feed-hero__cover"
            placeholder={
              <div className="m-feed-hero__cover" style={{ display: 'grid', placeItems: 'center' }}>
                <Icon name="podcasts" size={32} />
              </div>
            }
          />
          <div className="m-feed-hero__info">
            <div style={{ font: 'var(--md-sys-typescale-title-medium)' }}>{feed.title ?? feed.url}</div>
            {feed.author && <div className="m-feed-hero__author">{feed.author}</div>}
            {plainDesc && (
              <div>
                <p
                  className={cx('m-feed-hero__desc', !descExpanded && 'is-clamped')}
                  onClick={() => setDescExpanded((v) => !v)}
                  style={{ cursor: 'pointer' }}
                >
                  {plainDesc}
                </p>
                {plainDesc.length > 140 && (
                  <button
                    type="button"
                    className="m-btn m-btn--text"
                    style={{ minHeight: 28, padding: '0 4px' }}
                    onClick={() => setDescExpanded((v) => !v)}
                  >
                    {descExpanded ? t('detail.collapseDesc') : t('detail.expandDesc')}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <div className="m-chips" role="tablist" aria-label="Episode filter">
        <Chip
          selected={filter === 'all'}
          testId="filter-chip-all"
          onClick={() => handleSelectFilter('all')}
        >
          {t('detail.filterAll')}
        </Chip>
        <Chip
          selected={filter === 'unplayed'}
          testId="filter-chip-unplayed"
          onClick={() => handleSelectFilter('unplayed')}
        >
          {t('detail.filterUnplayed')}
        </Chip>
        <Chip
          selected={filter === 'downloaded'}
          testId="filter-chip-downloaded"
          onClick={() => handleSelectFilter('downloaded')}
        >
          {t('detail.filterDownloaded')}
        </Chip>
        <IconButton
          icon={sortOrder === 'desc' ? 'sortDesc' : 'sortAsc'}
          label={sortOrder === 'desc' ? t('detail.sortDescLabel') : t('detail.sortAscLabel')}
          data-testid="detail-sort-order-btn"
          data-sort-order={sortOrder}
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            setSortOrder((prev) => {
              const next: EpisodeSortOrder = prev === 'desc' ? 'asc' : 'desc';
              getHostViewCache(host).feedSortOrder.set(feedKey, next);
              return next;
            });
          }}
        />
      </div>

      {!loading && visibleRows.length === 0 ? (
        <div className="m-empty" data-testid="detail-empty">
          {t('detail.noEpisodes')}
        </div>
      ) : visibleRows.length > 0 ? (
        <div className="m-episode-list" data-testid="detail-episode-list">
          {visibleRows.map((r) => (
            <EpisodeRow
              key={r.episode.episodeKey}
              row={r}
              feedTitle={feed?.title}
              feedImageUrl={feed?.imageUrl}
              allowDownloads={allowDownloads}
              onStartInlineRemove={(epKey) => {
                inlineUndoKeysRef.current.add(epKey);
              }}
              onRemove={(epKey) => {
                inlineUndoKeysRef.current.delete(epKey);
                setDismissedKeys((prev) => {
                  const next = new Set(prev);
                  next.add(epKey);
                  return next;
                });
              }}
              onUndoRemove={(epKey) => {
                inlineUndoKeysRef.current.delete(epKey);
                setDismissedKeys((prev) => {
                  if (!prev.has(epKey)) return prev;
                  const next = new Set(prev);
                  next.delete(epKey);
                  return next;
                });
              }}
              onChanged={() => {
                void reload();
              }}
            />
          ))}
        </div>
      ) : null}

      {feed?.nextPageUrl && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <Button
            variant="tonal"
            disabled={loadingOlder}
            data-testid="detail-load-older-btn"
            onClick={() => {
              void handleLoadOlder();
            }}
          >
            {loadingOlder ? t('detail.loadingOlder') : t('detail.loadOlder')}
          </Button>
        </div>
      )}

      <Dialog
        open={credsDialogOpen}
        onClose={() => setCredsDialogOpen(false)}
        title={t('detail.setCredentials')}
        testId="detail-credentials-dialog"
        actions={
          <>
            <Button variant="text" onClick={() => setCredsDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void handleSaveCredentials();
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--md-sys-color-on-surface-variant)' }}>
          {t('preview.authHint')}
        </p>
        <label className="m-field">
          <span className="m-field__label">{t('preview.username')}</span>
          <input
            className="m-field__input"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="m-field">
          <span className="m-field__label">{t('preview.password')}</span>
          <input
            className="m-field__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
