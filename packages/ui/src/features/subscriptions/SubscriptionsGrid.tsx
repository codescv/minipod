/**
 * Subscriptions screen (`DESIGN.md` §4.1):
 * - 3-col mobile / 6-col desktop cover grid + list toggle (zero unread badges)
 * - Manual `⟳` refresh + touch pull-to-refresh
 * - `.opml` / `.xml` drag-and-drop import
 * - Per-feed `⋮` / long-press / right-click Unsubscribe & Copy URL
 * - Empty state with *Find podcasts* CTA + floating `+` FAB on mobile
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Feed, FeedKey } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import { Button, FAB, Icon, IconButton, Menu, type MenuEntry } from '../../components/m3';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { openOpmlImportWithXml } from '../add/OpmlImport';

async function copyTextSafe(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // ignore clipboard permission errors in headless environments
  }
}

export function SubscriptionsGrid() {
  const host = useHost();
  const t = useT();
  const isDesktop = useIsDesktop();

  const layout = useSettingsStore((s) => s.settings.subscriptionsLayout);
  const updateSettings = useSettingsStore((s) => s.update);

  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);
  const openAdd = useRouteStore((s) => s.openAdd);
  const setTab = useRouteStore((s) => s.setTab);

  const [feeds, setFeeds] = useState<readonly Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authFailedKeys, setAuthFailedKeys] = useState<ReadonlySet<FeedKey>>(() => new Set());
  const [dragOver, setDragOver] = useState(false);

  const pullStartYRef = useRef<number | null>(null);

  const loadFeeds = useCallback(async () => {
    try {
      const list = await host.feeds.list();
      setFeeds(list);
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    void loadFeeds();
  }, [loadFeeds]);

  useHostEvents((ev) => {
    if (ev.type === 'feeds-changed') {
      void loadFeeds();
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
      await loadFeeds();
    } finally {
      setRefreshing(false);
    }
  }, [host, loadFeeds, refreshing]);

  const handleToggleLayout = useCallback(() => {
    const next = layout === 'grid' ? 'list' : 'grid';
    void updateSettings(host, { subscriptionsLayout: next });
  }, [host, layout, updateSettings]);

  const handleUnsubscribe = useCallback(
    async (feed: Feed) => {
      await host.feeds.unsubscribe(feed.feedKey);
      await loadFeeds();
      showSnackbar(t('subs.unsubscribedSnack', { title: feed.title ?? feed.url }));
    },
    [host, loadFeeds, t],
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
      testId: `feed-copy-url-${feed.feedKey}`,
      onSelect: () => {
        void handleCopyUrl(feed);
      },
    },
    {
      key: 'unsubscribe',
      label: t('subs.unsubscribe'),
      icon: 'delete',
      testId: `feed-unsubscribe-${feed.feedKey}`,
      onSelect: () => {
        void handleUnsubscribe(feed);
      },
    },
  ];

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
      ) : layout === 'grid' ? (
        <div className="m-subs-grid" data-testid="subs-grid">
          {feeds.map((feed) => (
            <PodcastTile
              key={feed.feedKey}
              feed={feed}
              needsAuth={authFailedKeys.has(feed.feedKey)}
              menuItems={feedMenuItems(feed)}
              moreLabel={t('common.more')}
              needsAuthLabel={t('subs.needsAuth')}
              onOpen={() => openPodcastDetail(feed.feedKey)}
            />
          ))}
        </div>
      ) : (
        <div className="m-subs-list" data-testid="subs-list">
          {feeds.map((feed) => {
            const displayTitle = feed.title ?? feed.url;
            return (
              <div
                key={feed.feedKey}
                className="m-result-row"
                role="button"
                tabIndex={0}
                data-testid={`feed-list-item-${feed.feedKey}`}
                onClick={() => openPodcastDetail(feed.feedKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPodcastDetail(feed.feedKey);
                  }
                }}
              >
                {feed.imageUrl ? (
                  <img className="m-result-row__cover" src={feed.imageUrl} alt="" loading="lazy" />
                ) : (
                  <div className="m-result-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
                    <Icon name="podcasts" size={24} />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: 'var(--md-sys-typescale-title-small)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayTitle}
                  </div>
                  {feed.author && (
                    <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                      {feed.author}
                    </div>
                  )}
                </div>
                {authFailedKeys.has(feed.feedKey) && (
                  <span className="m-pill-badge" title={t('subs.needsAuth')}>
                    <Icon name="lock" size={14} />
                  </span>
                )}
                <Menu
                  label={`${t('common.more')} ${displayTitle}`}
                  items={feedMenuItems(feed)}
                  testId={`feed-menu-${feed.feedKey}`}
                />
              </div>
            );
          })}
        </div>
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

function PodcastTile({
  feed,
  needsAuth,
  menuItems,
  moreLabel,
  needsAuthLabel,
  onOpen,
}: {
  readonly feed: Feed;
  readonly needsAuth: boolean;
  readonly menuItems: readonly MenuEntry[];
  readonly moreLabel: string;
  readonly needsAuthLabel: string;
  readonly onOpen: () => void;
}) {
  const displayTitle = feed.title ?? feed.url;
  const initial = displayTitle.trim().slice(0, 1).toUpperCase() || '?';

  return (
    <div
      className="m-podcast-tile"
      role="button"
      tabIndex={0}
      data-testid={`feed-tile-${feed.feedKey}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="m-podcast-tile__cover-wrap">
        {feed.imageUrl ? (
          <img className="m-podcast-tile__cover" src={feed.imageUrl} alt={displayTitle} loading="lazy" />
        ) : (
          <div className="m-podcast-tile__placeholder">{initial}</div>
        )}
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
      <div className="m-podcast-tile__menu" onClick={(e) => e.stopPropagation()}>
        <Menu
          label={`${moreLabel} ${displayTitle}`}
          items={menuItems}
          testId={`feed-menu-${feed.feedKey}`}
        />
      </div>
    </div>
  );
}
