/**
 * Subscriptions screen (`DESIGN.md` §4.1 + v0.1.12 enhancements):
 * - Flexible multi-column cover grid (`computeSubscriptionsGridCols`, 4 cols on compact phones like OnePlus 13T, 6–8 cols on desktop, zero unread badges)
 * - Collapsible subscriptions bar when > 2 rows (`MAX_SUBS_COLLAPSED_ROWS = 2`)
 * - Long-press (~450ms) / right-click / keyboard viewport-clamped context menu (no top-right `⋮` button)
 * - Latest Episodes Timeline (`最新单集`) directly below Subscriptions across all subscribed feeds, excluding played, in-progress/playing, and queued episodes
 * - Manual `⟳` refresh + direct top-right Settings button + touch pull-to-refresh + `.opml` / `.xml` drag-and-drop import
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties as ReactCssProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import type { EpisodeKey, EpisodeRow as EpisodeRowModel, Feed, FeedKey } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import {
  ArtworkImage,
  Button,
  ContextMenu,
  FAB,
  Icon,
  IconButton,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { preloadArtworkUrls } from '../../lib/artwork-cache';
import { clearTextSelection } from '../../lib/text-selection';
import { usePlayerState } from '../../player/usePlayer';
import { useListReloadFilter } from '../../hooks/useListReloadFilter';
import { showSnackbar } from '../../stores/snackbar';
import {
  applyDownloadProgressToViewCache,
  applyDownloadStateToViewCache,
  DEFAULT_TIMELINE_LIMIT,
  getHostViewCache,
  recomputeHostTimelineAndDownloads,
  type TimelineEpisodeItem,
} from '../../stores/view-cache';
import { openOpmlImportWithXml } from '../add/OpmlImport';
import { EpisodeRow } from './EpisodeRow';

export const MAX_SUBS_COLLAPSED_ROWS = 2;
export const AUTO_REFRESH_MIN_INTERVAL_MS = 30 * 60_000;
const TIMELINE_PAGE_SIZE = DEFAULT_TIMELINE_LIMIT;
const LONG_PRESS_DELAY_MS = 450;
const LONG_PRESS_MOVE_SLOP_PX = 10;

export function computeSubscriptionsGridCols(
  viewportWidth: number,
  containerWidth?: number,
): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 390;
  const isDesktopViewport = safeViewport >= 840;
  const measuredWidth =
    containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : undefined;

  if (isDesktopViewport) {
    const availWidth =
      measuredWidth ?? Math.min(1120, Math.max(600, safeViewport - 84)) - 56;
    return Math.max(4, Math.min(10, Math.floor((availWidth + 14) / (120 + 14))));
  }

  const availWidth = measuredWidth ?? Math.max(240, safeViewport - 32);
  return Math.max(3, Math.min(8, Math.floor((availWidth + 10) / (74 + 10))));
}

interface ActiveFeedContextMenu {
  readonly feed: Feed;
  readonly x: number;
  readonly y: number;
}

async function copyTextSafe(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // ignore clipboard permission errors in headless environments
  }
}

function useLongPressHandlers({
  onOpen,
  onContext,
}: {
  readonly onOpen: () => void;
  readonly onContext: (x: number, y: number) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const longPressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (typeof e.button === 'number' && e.button > 0) return;
      const hasCoords = Number.isFinite(e.clientX) && Number.isFinite(e.clientY);
      const rect = hasCoords ? null : e.currentTarget.getBoundingClientRect();
      const x = hasCoords ? e.clientX : rect ? rect.left + rect.width / 2 : 0;
      const y = hasCoords ? e.clientY : rect ? rect.top + rect.height / 2 : 0;
      startPosRef.current = { x, y };
      longPressedRef.current = false;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        longPressedRef.current = true;
        // v0.1.25: drop any Android WebView long-press selection before the menu portals in.
        clearTextSelection();
        onContext(x, y);
      }, LONG_PRESS_DELAY_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (timerRef.current === null || !startPosRef.current) return;
      if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_SLOP_PX) {
        clearTimer();
      }
    },
    onPointerUp: () => {
      clearTimer();
    },
    onPointerCancel: () => {
      clearTimer();
      longPressedRef.current = false;
    },
    onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => {
      clearTimer();
      if (longPressedRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }
        e.stopPropagation();
        clearTextSelection();
      }
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      if (longPressedRef.current) {
        longPressedRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onOpen();
    },
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimer();
      clearTextSelection();
      onContext(e.clientX, e.clientY);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onContext(rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen();
      }
    },
  };
}

export function SubscriptionsGrid() {
  const host = useHost();
  const t = useT();
  // Low-frequency player state: never re-render the grid/timeline on playback position ticks.
  const player = usePlayerState();
  const isDesktop = useIsDesktop();
  const allowProxy = shouldUseImageProxy(host.info.platform);
  const activeEpisodeKey = player.episode?.episodeKey;
  const activeEpisodeKeyRef = useRef<EpisodeKey | undefined>(activeEpisodeKey);
  activeEpisodeKeyRef.current = activeEpisodeKey;

  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);
  const openAdd = useRouteStore((s) => s.openAdd);
  const openDownloads = useRouteStore((s) => s.openDownloads);
  const setTab = useRouteStore((s) => s.setTab);

  const [feeds, setFeeds] = useState<readonly Feed[]>(() => getHostViewCache(host).feeds);
  const [timelineItems, setTimelineItems] = useState<readonly TimelineEpisodeItem[]>(
    () => getHostViewCache(host).timelineItems,
  );
  const [downloadedCount, setDownloadedCount] = useState(
    () => getHostViewCache(host).downloadedCount,
  );
  const [subsExpanded, setSubsExpanded] = useState(() => getHostViewCache(host).subsExpanded);
  const [timelineLimit, setTimelineLimit] = useState(() => getHostViewCache(host).timelineLimit);
  const [contextMenu, setContextMenu] = useState<ActiveFeedContextMenu | null>(null);
  const [loading, setLoading] = useState(() => !getHostViewCache(host).timelineLoaded);
  const [refreshing, setRefreshing] = useState(false);
  const [authFailedKeys, setAuthFailedKeys] = useState<ReadonlySet<FeedKey>>(() => new Set());
  const [dragOver, setDragOver] = useState(false);
  const [gridCols, setGridCols] = useState<number>(() =>
    computeSubscriptionsGridCols(typeof window !== 'undefined' ? window.innerWidth : 390),
  );

  const subsGridRef = useRef<HTMLDivElement | null>(null);
  const loadSeqRef = useRef(0);
  const unmountedRef = useRef(false);
  const entryAutoRefreshCheckedRef = useRef(false);
  const refreshingRef = useRef(false);
  const handleRefreshAllRef = useRef<() => Promise<void>>(async () => {});
  const inlineUndoKeysRef = useRef<Set<EpisodeKey>>(new Set());

  useEffect(() => {
    getHostViewCache(host).subsExpanded = subsExpanded;
  }, [host, subsExpanded]);

  useEffect(() => {
    getHostViewCache(host).timelineLimit = timelineLimit;
  }, [host, timelineLimit]);

  useEffect(() => {
    const undoKeys = inlineUndoKeysRef.current;
    return () => {
      if (undoKeys.size > 0) {
        const cache = getHostViewCache(host);
        cache.timelineItems = cache.timelineItems.filter(
          (entry) => !undoKeys.has(entry.row.episode.episodeKey),
        );
        undoKeys.clear();
      }
    };
  }, [host]);

  useEffect(() => {
    if (!activeEpisodeKey) return;
    if (inlineUndoKeysRef.current.has(activeEpisodeKey)) return;
    setTimelineItems((prev) => {
      if (!prev.some((entry) => entry.row.episode.episodeKey === activeEpisodeKey)) {
        return prev;
      }
      const next = prev.filter((entry) => entry.row.episode.episodeKey !== activeEpisodeKey);
      getHostViewCache(host).timelineItems = next;
      return next;
    });
  }, [activeEpisodeKey, host]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateCols = () => {
      const el = subsGridRef.current;
      const rectWidth = el ? el.getBoundingClientRect().width : 0;
      const next = computeSubscriptionsGridCols(
        window.innerWidth,
        rectWidth > 0 ? rectWidth : undefined,
      );
      setGridCols((prev) => (prev === next ? prev : next));
    };
    updateCols();
    window.addEventListener('resize', updateCols);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && subsGridRef.current) {
      observer = new ResizeObserver(() => {
        updateCols();
      });
      observer.observe(subsGridRef.current);
    }
    return () => {
      window.removeEventListener('resize', updateCols);
      observer?.disconnect();
    };
  }, [feeds.length]);

  const loadFeedsAndTimeline = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const viewCache = getHostViewCache(host);
    if (!viewCache.queueLoaded) {
      void host.queue
        .list()
        .then((q) => {
          const c = getHostViewCache(host);
          if (!c.queueLoaded) {
            c.queueRows = q;
            c.queueLoaded = true;
          }
        })
        .catch(() => undefined);
    }
    if (viewCache.syncStatus === null) {
      void host.sync
        .status()
        .then((st) => {
          const c = getHostViewCache(host);
          if (c.syncStatus === null) {
            c.syncStatus = st;
          }
        })
        .catch(() => undefined);
    }

    try {
      const list = await host.feeds.list();
      if (seq !== loadSeqRef.current || unmountedRef.current) return;
      const feedsByKey = new Map<FeedKey, Feed>(list.map((f) => [f.feedKey, f]));
      viewCache.feeds = list;
      viewCache.feedsByKey = feedsByKey;
      viewCache.feedsLoaded = true;
      preloadArtworkUrls(
        list.map((f) => f.imageUrl),
        allowProxy,
      );

      if (!entryAutoRefreshCheckedRef.current) {
        entryAutoRefreshCheckedRef.current = true;
        if (list.length > 0) {
          const now = Date.now();
          const maxFeedRefreshedAt = list.reduce(
            (max, f) => Math.max(max, f.lastRefreshedAt ?? 0),
            0,
          );
          const lastRefreshAt =
            viewCache.lastAutoRefreshAt > 0
              ? viewCache.lastAutoRefreshAt
              : maxFeedRefreshedAt > 0 && now - maxFeedRefreshedAt < AUTO_REFRESH_MIN_INTERVAL_MS
                ? maxFeedRefreshedAt
                : 0;
          if (now - lastRefreshAt >= AUTO_REFRESH_MIN_INTERVAL_MS) {
            viewCache.lastAutoRefreshAt = now;
            void handleRefreshAllRef.current();
          } else if (viewCache.lastAutoRefreshAt === 0 && lastRefreshAt > 0) {
            viewCache.lastAutoRefreshAt = lastRefreshAt;
          }
        }
      }

      if (list.length === 0) {
        viewCache.episodesByFeed.clear();
        viewCache.timelineItems = [];
        viewCache.downloadedCount = 0;
        viewCache.downloadedItems = [];
        viewCache.timelineLoaded = true;
        viewCache.downloadsLoaded = true;
        setFeeds([]);
        setTimelineItems([]);
        setDownloadedCount(0);
        return;
      }

      const [perFeed, latestQueue] = await Promise.all([
        Promise.all(
          list.map(async (feed) => {
            try {
              const page = await host.episodes.list(feed.feedKey, 'all');
              return { feed, items: page.items };
            } catch {
              return { feed, items: [] as readonly EpisodeRowModel[] };
            }
          }),
        ),
        host.queue.list().catch(() => null),
      ]);

      if (seq !== loadSeqRef.current) return;

      if (latestQueue !== null) {
        viewCache.queueRows = latestQueue;
        viewCache.queueLoaded = true;
      }

      const activeFeedKeys = new Set(list.map((f) => f.feedKey));
      for (const existingKey of viewCache.episodesByFeed.keys()) {
        if (!activeFeedKeys.has(existingKey)) {
          viewCache.episodesByFeed.delete(existingKey);
        }
      }
      for (const { feed, items } of perFeed) {
        viewCache.episodesByFeed.set(feed.feedKey, items);
      }

      const derived = recomputeHostTimelineAndDownloads(
        host,
        list,
        viewCache.episodesByFeed,
        inlineUndoKeysRef.current,
        activeEpisodeKeyRef.current,
      );
      viewCache.timelineItems = derived.timelineItems;
      viewCache.downloadedCount = derived.downloadedCount;
      viewCache.downloadedItems = derived.downloadedItems;
      viewCache.timelineLoaded = true;
      viewCache.downloadsLoaded = true;

      setFeeds(list);
      setDownloadedCount(derived.downloadedCount);
      setTimelineItems(derived.timelineItems);
      preloadArtworkUrls(
        derived.timelineItems
          .slice(0, TIMELINE_PAGE_SIZE)
          .map((item) => item.row.episode.imageUrl ?? item.feed.imageUrl),
        allowProxy,
      );
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [allowProxy, host]);

  useEffect(() => {
    unmountedRef.current = false;
    entryAutoRefreshCheckedRef.current = false;
    void loadFeedsAndTimeline();
    return () => {
      unmountedRef.current = true;
    };
  }, [loadFeedsAndTimeline]);

  const shouldReloadList = useListReloadFilter(() => {
    void loadFeedsAndTimeline();
  });

  useHostEvents((ev) => {
    if (ev.type === 'download-updated') {
      if (shouldReloadList(ev)) {
        applyDownloadStateToViewCache(host, ev.episodeKey, ev.state, undefined, ev.progress);
        void loadFeedsAndTimeline();
      } else {
        applyDownloadProgressToViewCache(host, ev.episodeKey, ev.state, ev.progress);
      }
      return;
    }
    if (ev.type === 'queue-changed') {
      void host.queue
        .list()
        .then((q) => {
          const c = getHostViewCache(host);
          c.queueRows = q;
          c.queueLoaded = true;
        })
        .catch(() => undefined);
    }
    if (
      ev.type === 'feeds-changed' ||
      ev.type === 'episodes-changed' ||
      ev.type === 'progress-changed' ||
      ev.type === 'queue-changed'
    ) {
      // Skip the playing episode's 5 s checkpoints (deferred until playback pauses).
      if (shouldReloadList(ev)) void loadFeedsAndTimeline();
    } else if (ev.type === 'feed-refreshed') {
      if (ev.error?.code === 'auth-required') {
        setAuthFailedKeys((prev) => {
          const next = new Set(prev);
          next.add(ev.feedKey);
          return next;
        });
      } else if (!ev.error) {
        setAuthFailedKeys((prev) => {
          if (!prev.has(ev.feedKey)) return prev;
          const next = new Set(prev);
          next.delete(ev.feedKey);
          return next;
        });
      }
    }
  });

  const handleRefreshAll = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    getHostViewCache(host).lastAutoRefreshAt = Date.now();
    setRefreshing(true);
    try {
      await host.feeds.refresh();
      await loadFeedsAndTimeline();
    } finally {
      refreshingRef.current = false;
      if (!unmountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [host, loadFeedsAndTimeline]);
  handleRefreshAllRef.current = handleRefreshAll;

  const handleMarkAllTimelinePlayed = useCallback(async () => {
    if (timelineItems.length === 0) return;
    const viewCache = getHostViewCache(host);
    let maxPubDate = Date.now();
    for (const feedRows of viewCache.episodesByFeed.values()) {
      for (const r of feedRows) {
        if ((r.episode.pubDate ?? 0) > maxPubDate) {
          maxPubDate = r.episode.pubDate ?? 0;
        }
      }
    }
    for (const item of timelineItems) {
      if ((item.row.episode.pubDate ?? 0) > maxPubDate) {
        maxPubDate = item.row.episode.pubDate ?? 0;
      }
    }
    viewCache.timelineClearedCutoffMs = maxPubDate;
    const itemsToMark = [...timelineItems];
    inlineUndoKeysRef.current.clear();
    viewCache.timelineItems = [];
    setTimelineItems([]);
    await Promise.all(
      itemsToMark.map((item) => host.progress.markPlayed(item.row.episode.episodeKey, true)),
    );
    await loadFeedsAndTimeline();
  }, [host, loadFeedsAndTimeline, timelineItems]);

  const handleUnsubscribe = useCallback(
    async (feed: Feed) => {
      await host.feeds.unsubscribe(feed.feedKey);
      await loadFeedsAndTimeline();
      showSnackbar(t('subs.unsubscribedSnack', { title: feed.title ?? feed.url }));
    },
    [host, loadFeedsAndTimeline, t],
  );

  const handleCopyUrl = useCallback(
    async (feed: Feed) => {
      await copyTextSafe(feed.url);
      showSnackbar(t('common.copied'));
    },
    [t],
  );

  const feedMenuItems = (feed: Feed): MenuEntry[] => [
    {
      key: 'copy-url',
      label: t('subs.copyUrl'),
      icon: 'link',
      testId: `subs-copy-url-${feed.feedKey}`,
      onSelect: () => {
        void handleCopyUrl(feed);
      },
    },
    {
      key: 'unsubscribe',
      label: t('subs.unsubscribe'),
      icon: 'delete',
      testId: `subs-unsubscribe-${feed.feedKey}`,
      onSelect: () => {
        void handleUnsubscribe(feed);
      },
    },
  ];

  // Stable row/tile callbacks so memoized `EpisodeRow` / `PodcastTile` skip unchanged items.
  const handleFeedContext = useCallback((feed: Feed, x: number, y: number) => {
    setContextMenu({ feed, x, y });
  }, []);
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
  const handleTimelineStartInlineRemove = useCallback((epKey: EpisodeKey) => {
    inlineUndoKeysRef.current.add(epKey);
  }, []);
  const handleTimelineRemove = useCallback(
    (epKey: EpisodeKey) => {
      inlineUndoKeysRef.current.delete(epKey);
      setTimelineItems((prev) => {
        const next = prev.filter((entry) => entry.row.episode.episodeKey !== epKey);
        getHostViewCache(host).timelineItems = next;
        return next;
      });
    },
    [host],
  );
  const handleTimelineUndoRemove = useCallback((epKey: EpisodeKey) => {
    inlineUndoKeysRef.current.delete(epKey);
  }, []);
  const handleTimelineChanged = useCallback(() => {
    void loadFeedsAndTimeline();
  }, [loadFeedsAndTimeline]);

  const collapseThreshold = gridCols * MAX_SUBS_COLLAPSED_ROWS;
  const canCollapse = feeds.length > collapseThreshold;
  const visibleFeeds = canCollapse && !subsExpanded ? feeds.slice(0, collapseThreshold) : feeds;

  return (
    <div
      className="m-page"
      data-testid="subscriptions-screen"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (!file) return;
        if (/\.(opml|xml)$/i.test(file.name) || file.type.includes('xml')) {
          e.preventDefault();
          void file.text().then((xml) => openOpmlImportWithXml(xml));
        }
      }}
      style={
        dragOver
          ? { outline: '2px dashed var(--md-sys-color-primary)', outlineOffset: -6 }
          : undefined
      }
    >
      <header className="m-appbar">
        <h1 className="m-appbar__title">{t('subs.title')}</h1>
        {downloadedCount > 0 && (
          <IconButton
            icon="downloaded"
            label={t('subs.manageDownloads', { count: downloadedCount })}
            data-testid="subs-manage-downloads"
            onClick={() => openDownloads()}
          />
        )}
        <IconButton
          icon="refresh"
          label={refreshing ? t('subs.refreshing') : t('subs.refreshAll')}
          iconClassName={refreshing ? 'm-spin' : undefined}
          data-testid="subs-refresh-btn"
          onClick={() => {
            void handleRefreshAll();
          }}
        />
        <IconButton
          icon="settings"
          label={t('nav.settings')}
          data-testid="subs-settings-btn"
          onClick={() => setTab('settings')}
        />
      </header>

      {!loading && feeds.length === 0 ? (
        <div className="m-empty" data-testid="subs-empty">
          <Icon name="podcasts" size={48} />
          <div style={{ font: 'var(--md-sys-typescale-title-medium)', color: 'var(--md-sys-color-on-surface)' }}>
            {t('subs.emptyTitle')}
          </div>
          <div>{t('subs.emptyHint')}</div>
          <Button icon="search" onClick={() => openAdd()} data-testid="subs-find-podcasts-btn">
            {t('subs.findPodcasts')}
          </Button>
        </div>
      ) : (
        <>
          <div className="m-subs-section">
            <div
              ref={subsGridRef}
              className="m-subs-grid"
              data-testid="subs-grid"
              data-grid-cols={gridCols}
              style={{ '--subs-grid-cols': String(gridCols) } as ReactCssProperties}
            >
              {visibleFeeds.map((feed) => (
                <PodcastTile
                  key={feed.feedKey}
                  feed={feed}
                  needsAuth={authFailedKeys.has(feed.feedKey)}
                  needsAuthLabel={t('subs.needsAuth')}
                  allowProxy={allowProxy}
                  onOpenFeed={openPodcastDetail}
                  onContextFeed={handleFeedContext}
                />
              ))}
            </div>

            {canCollapse && (
              <div className="m-subs-expand-wrap">
                <button
                  type="button"
                  className="m-subs-expand-btn"
                  aria-expanded={subsExpanded}
                  data-testid="subs-expand-toggle"
                  onClick={() =>
                    setSubsExpanded((v) => {
                      const next = !v;
                      getHostViewCache(host).subsExpanded = next;
                      return next;
                    })
                  }
                >
                  <span>
                    {subsExpanded
                      ? t('subs.collapse')
                      : t('subs.expandAll', { count: feeds.length })}
                  </span>
                  <Icon name={subsExpanded ? 'expandLess' : 'expandMore'} size={18} />
                </button>
              </div>
            )}
          </div>

          {feeds.length > 0 && (
            <section className="m-timeline-section" data-testid="subs-timeline-section">
              <div className="m-timeline-header">
                <h2 className="m-timeline-title">{t('subs.timelineTitle')}</h2>
                {timelineItems.length > 0 && (
                  <span className="m-pill-badge" data-testid="subs-timeline-count">
                    {timelineItems.length}
                  </span>
                )}
                <IconButton
                  icon="check"
                  iconSize={18}
                  label={t('subs.markAllPlayed')}
                  disabled={timelineItems.length === 0}
                  data-testid="subs-mark-all-played-btn"
                  style={{ marginLeft: 'auto', width: 36, height: 36 }}
                  onClick={() => {
                    void handleMarkAllTimelinePlayed();
                  }}
                />
              </div>

              {!loading && timelineItems.length === 0 ? (
                <div className="m-empty" style={{ padding: '24px 12px' }} data-testid="subs-timeline-empty">
                  {t('detail.noEpisodes')}
                </div>
              ) : timelineItems.length > 0 ? (
                <>
                  <div className="m-episode-list" data-testid="subs-timeline-list">
                    {timelineItems.slice(0, timelineLimit).map((item) => (
                      <EpisodeRow
                        key={item.row.episode.episodeKey}
                        row={item.row}
                        feedTitle={item.feed.title ?? item.feed.url}
                        feedImageUrl={item.feed.imageUrl}
                        allowDownloads={item.allowDownloads}
                        showPodcastInfo
                        removeWhenQueued
                        onOpenPodcast={getOpenPodcastCallback(item.feed.feedKey)}
                        onStartInlineRemove={handleTimelineStartInlineRemove}
                        onRemove={handleTimelineRemove}
                        onUndoRemove={handleTimelineUndoRemove}
                        onChanged={handleTimelineChanged}
                      />
                    ))}
                  </div>

                  {timelineItems.length > timelineLimit && (
                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
                      <Button
                        variant="tonal"
                        data-testid="subs-timeline-load-more"
                        onClick={() =>
                          setTimelineLimit((n) => {
                            const next = n + TIMELINE_PAGE_SIZE;
                            getHostViewCache(host).timelineLimit = next;
                            return next;
                          })
                        }
                      >
                        {t('subs.loadMoreTimeline')}
                      </Button>
                    </div>
                  )}
                </>
              ) : null}
            </section>
          )}
        </>
      )}

      {contextMenu !== null && (
        <ContextMenu
          open
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={feedMenuItems(contextMenu.feed)}
          testId="subs-context-menu"
        />
      )}

      {!isDesktop && (
        <FAB
          icon="add"
          label={t('nav.add')}
          floating
          testId="subs-add-fab"
          onClick={() => openAdd()}
        />
      )}
    </div>
  );
}

const PodcastTile = memo(function PodcastTile({
  feed,
  needsAuth,
  needsAuthLabel,
  allowProxy,
  onOpenFeed,
  onContextFeed,
}: {
  readonly feed: Feed;
  readonly needsAuth: boolean;
  readonly needsAuthLabel: string;
  readonly allowProxy: boolean;
  /** Stable (feed-agnostic) callbacks so `memo` skips re-rendering unchanged tiles. */
  readonly onOpenFeed: (feedKey: FeedKey) => void;
  readonly onContextFeed: (feed: Feed, x: number, y: number) => void;
}) {
  const displayTitle = feed.title ?? feed.url;
  const initial = displayTitle.trim().slice(0, 1).toUpperCase() || '?';
  const interactions = useLongPressHandlers({
    onOpen: () => onOpenFeed(feed.feedKey),
    onContext: (x, y) => onContextFeed(feed, x, y),
  });

  return (
    <div
      className="m-podcast-tile"
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      data-testid={`feed-tile-${feed.feedKey}`}
      {...interactions}
    >
      <div className="m-podcast-tile__cover-wrap">
        <ArtworkImage
          src={feed.imageUrl}
          allowProxyFallback={allowProxy}
          alt={displayTitle}
          className="m-podcast-tile__cover"
          loading="lazy"
          draggable={false}
          placeholder={<div className="m-podcast-tile__placeholder">{initial}</div>}
        />
        {needsAuth && (
          <span
            className="m-pill-badge"
            title={needsAuthLabel}
            style={{ position: 'absolute', left: 6, bottom: 6 }}
          >
            <Icon name="lock" size={14} />
          </span>
        )}
      </div>
      <div className="m-podcast-tile__title">{displayTitle}</div>
    </div>
  );
});
