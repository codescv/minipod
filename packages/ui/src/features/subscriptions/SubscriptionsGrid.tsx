/**
 * Subscriptions screen (`DESIGN.md` §4.1 + v0.1.3 enhancements):
 * - 3-col mobile / 6-col desktop cover grid + list toggle (zero unread badges)
 * - Collapsible subscriptions bar when > 6 feeds in grid mode (or > 4 in list mode)
 * - Long-press (~450ms) / right-click / keyboard viewport-clamped context menu (no top-right `⋮` button)
 * - Latest Episodes Timeline (`最新单集`) directly below Subscriptions across all subscribed feeds
 * - Manual `⟳` refresh + touch pull-to-refresh + `.opml` / `.xml` drag-and-drop import
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import type { EpisodeRow as EpisodeRowModel, Feed, FeedKey } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import {
  ArtworkImage,
  Button,
  ContextMenu,
  FAB,
  Icon,
  IconButton,
  Menu,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { openOpmlImportWithXml } from '../add/OpmlImport';
import { EpisodeRow } from './EpisodeRow';

const GRID_COLLAPSE_THRESHOLD = 6;
const LIST_COLLAPSE_THRESHOLD = 4;
const TIMELINE_PAGE_SIZE = 30;
const LONG_PRESS_DELAY_MS = 450;
const LONG_PRESS_MOVE_SLOP_PX = 10;

interface TimelineEpisodeItem {
  readonly row: EpisodeRowModel;
  readonly feed: Feed;
  readonly allowDownloads: boolean;
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
  const isDesktop = useIsDesktop();
  const allowProxy = shouldUseImageProxy(host.info.platform);

  const layout = useSettingsStore((s) => s.settings.subscriptionsLayout);
  const updateSettings = useSettingsStore((s) => s.update);

  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);
  const openAdd = useRouteStore((s) => s.openAdd);
  const setTab = useRouteStore((s) => s.setTab);

  const [feeds, setFeeds] = useState<readonly Feed[]>([]);
  const [timelineItems, setTimelineItems] = useState<readonly TimelineEpisodeItem[]>([]);
  const [subsExpanded, setSubsExpanded] = useState(false);
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_PAGE_SIZE);
  const [contextMenu, setContextMenu] = useState<ActiveFeedContextMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authFailedKeys, setAuthFailedKeys] = useState<ReadonlySet<FeedKey>>(() => new Set());
  const [dragOver, setDragOver] = useState(false);

  const pullStartYRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);

  const loadFeedsAndTimeline = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const list = await host.feeds.list();
      if (seq !== loadSeqRef.current) return;
      setFeeds(list);

      if (list.length === 0) {
        setTimelineItems([]);
        return;
      }

      const perFeed = await Promise.all(
        list.map(async (feed) => {
          try {
            const page = await host.episodes.list(feed.feedKey, 'all');
            const allowDownloads = Boolean(host.info.capabilities.downloads && feed.kind !== 'LOCAL');
            return page.items.map(
              (row): TimelineEpisodeItem => ({
                row,
                feed,
                allowDownloads,
              }),
            );
          } catch {
            return [] as readonly TimelineEpisodeItem[];
          }
        }),
      );

      if (seq !== loadSeqRef.current) return;
      const merged = perFeed.flat().sort((a, b) => {
        const pubDiff = (b.row.episode.pubDate ?? 0) - (a.row.episode.pubDate ?? 0);
        if (pubDiff !== 0) return pubDiff;
        return a.row.episode.episodeKey.localeCompare(b.row.episode.episodeKey);
      });
      setTimelineItems(merged);
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [host]);

  useEffect(() => {
    void loadFeedsAndTimeline();
  }, [loadFeedsAndTimeline]);

  useHostEvents((ev) => {
    if (
      ev.type === 'feeds-changed' ||
      ev.type === 'episodes-changed' ||
      ev.type === 'progress-changed' ||
      ev.type === 'queue-changed' ||
      ev.type === 'download-updated'
    ) {
      void loadFeedsAndTimeline();
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
    if (refreshing) return;
    setRefreshing(true);
    try {
      await host.feeds.refresh();
      await loadFeedsAndTimeline();
    } finally {
      setRefreshing(false);
    }
  }, [host, loadFeedsAndTimeline, refreshing]);

  const handleToggleLayout = useCallback(() => {
    const next = layout === 'grid' ? 'list' : 'grid';
    void updateSettings(host, { subscriptionsLayout: next });
  }, [host, layout, updateSettings]);

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

  const appBarMenuItems: MenuEntry[] = [
    {
      key: 'toggle-layout',
      label: layout === 'grid' ? t('subs.viewGrid') : t('subs.viewList'),
      icon: layout === 'grid' ? 'list' : 'grid',
      testId: 'subs-toggle-layout',
      onSelect: handleToggleLayout,
    },
    ...(!isDesktop
      ? [
          {
            key: 'mobile-settings',
            label: t('nav.settings'),
            icon: 'settings' as const,
            testId: 'subs-mobile-settings',
            onSelect: () => setTab('settings'),
          },
        ]
      : []),
  ];

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

  const collapseThreshold = layout === 'grid' ? GRID_COLLAPSE_THRESHOLD : LIST_COLLAPSE_THRESHOLD;
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
      onTouchStart={(e) => {
        const touch = e.touches[0];
        if (touch && window.scrollY <= 0) {
          pullStartYRef.current = touch.clientY;
        }
      }}
      onTouchEnd={(e) => {
        const startY = pullStartYRef.current;
        pullStartYRef.current = null;
        const touch = e.changedTouches[0];
        if (startY !== null && touch && touch.clientY - startY > 80) {
          void handleRefreshAll();
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
        <IconButton
          icon="refresh"
          label={refreshing ? t('subs.refreshing') : t('subs.refreshAll')}
          iconClassName={refreshing ? 'm-spin' : undefined}
          data-testid="subs-refresh-btn"
          onClick={() => {
            void handleRefreshAll();
          }}
        />
        <Menu label={t('common.more')} items={appBarMenuItems} testId="subs-overflow-btn" />
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
            {layout === 'grid' ? (
              <div className="m-subs-grid" data-testid="subs-grid">
                {visibleFeeds.map((feed) => (
                  <PodcastTile
                    key={feed.feedKey}
                    feed={feed}
                    needsAuth={authFailedKeys.has(feed.feedKey)}
                    needsAuthLabel={t('subs.needsAuth')}
                    allowProxy={allowProxy}
                    onOpen={() => openPodcastDetail(feed.feedKey)}
                    onContext={(x, y) => setContextMenu({ feed, x, y })}
                  />
                ))}
              </div>
            ) : (
              <div className="m-subs-list" data-testid="subs-list">
                {visibleFeeds.map((feed) => (
                  <SubscriptionListItem
                    key={feed.feedKey}
                    feed={feed}
                    needsAuth={authFailedKeys.has(feed.feedKey)}
                    needsAuthLabel={t('subs.needsAuth')}
                    allowProxy={allowProxy}
                    onOpen={() => openPodcastDetail(feed.feedKey)}
                    onContext={(x, y) => setContextMenu({ feed, x, y })}
                  />
                ))}
              </div>
            )}

            {canCollapse && (
              <div className="m-subs-expand-wrap">
                <button
                  type="button"
                  className="m-subs-expand-btn"
                  aria-expanded={subsExpanded}
                  data-testid="subs-expand-toggle"
                  onClick={() => setSubsExpanded((v) => !v)}
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
              </div>

              {timelineItems.length === 0 ? (
                <div className="m-empty" style={{ padding: '24px 12px' }} data-testid="subs-timeline-empty">
                  {t('detail.noEpisodes')}
                </div>
              ) : (
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
                        onOpenPodcast={() => openPodcastDetail(item.feed.feedKey)}
                        onChanged={() => {
                          void loadFeedsAndTimeline();
                        }}
                      />
                    ))}
                  </div>

                  {timelineItems.length > timelineLimit && (
                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
                      <Button
                        variant="tonal"
                        data-testid="subs-timeline-load-more"
                        onClick={() => setTimelineLimit((n) => n + TIMELINE_PAGE_SIZE)}
                      >
                        {t('subs.loadMoreTimeline')}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}

      <ContextMenu
        open={contextMenu !== null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={() => setContextMenu(null)}
        items={contextMenu ? feedMenuItems(contextMenu.feed) : []}
        testId="subs-context-menu"
      />

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

function PodcastTile({
  feed,
  needsAuth,
  needsAuthLabel,
  allowProxy,
  onOpen,
  onContext,
}: {
  readonly feed: Feed;
  readonly needsAuth: boolean;
  readonly needsAuthLabel: string;
  readonly allowProxy: boolean;
  readonly onOpen: () => void;
  readonly onContext: (x: number, y: number) => void;
}) {
  const displayTitle = feed.title ?? feed.url;
  const initial = displayTitle.trim().slice(0, 1).toUpperCase() || '?';
  const interactions = useLongPressHandlers({ onOpen, onContext });

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
}

function SubscriptionListItem({
  feed,
  needsAuth,
  needsAuthLabel,
  allowProxy,
  onOpen,
  onContext,
}: {
  readonly feed: Feed;
  readonly needsAuth: boolean;
  readonly needsAuthLabel: string;
  readonly allowProxy: boolean;
  readonly onOpen: () => void;
  readonly onContext: (x: number, y: number) => void;
}) {
  const displayTitle = feed.title ?? feed.url;
  const interactions = useLongPressHandlers({ onOpen, onContext });

  return (
    <div
      className="m-result-row"
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      data-testid={`feed-list-item-${feed.feedKey}`}
      {...interactions}
    >
      <ArtworkImage
        src={feed.imageUrl}
        allowProxyFallback={allowProxy}
        className="m-result-row__cover"
        loading="lazy"
        draggable={false}
        placeholder={
          <div className="m-result-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
            <Icon name="podcasts" size={24} />
          </div>
        }
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            font: 'var(--md-sys-typescale-title-small)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayTitle}
        </div>
        {feed.author && (
          <div
            style={{
              font: 'var(--md-sys-typescale-body-small)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            {feed.author}
          </div>
        )}
      </div>
      {needsAuth && (
        <span className="m-pill-badge" title={needsAuthLabel}>
          <Icon name="lock" size={14} />
        </span>
      )}
    </div>
  );
}
