/**
 * Unified Queue screen (`DESIGN.md` §4.5):
 * - Header `Queue · N episodes · Xh Ym` + `⋮` *Clear queue*
 * - Drag-to-reorder via `≡` handle (HTML5 DnD + `Alt+Up/Down` + menu *Move to top / up / down*)
 * - Swipe or menu *Remove* with Undo snackbar restoring original queue slot
 * - `▶/⏸` play button + empty state
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeKey, Feed, FeedKey, QueueRow } from '@minipod/core';
import {
  ArtworkImage,
  cx,
  Icon,
  IconButton,
  Menu,
  nonEmptyUrl,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { formatHumanDuration } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar } from '../../stores/snackbar';

export function QueueList() {
  const host = useHost();
  const t = useT();
  const player = usePlayer();

  const [rows, setRows] = useState<readonly QueueRow[]>([]);
  const [feedsByKey, setFeedsByKey] = useState<ReadonlyMap<FeedKey, Feed>>(() => new Map());
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);

  const swipeStartXRef = useRef<number | null>(null);

  const loadQueue = useCallback(async () => {
    const [q, fList] = await Promise.all([host.queue.list(), host.feeds.list()]);
    setRows(q);
    const map = new Map<FeedKey, Feed>();
    for (const f of fList) {
      map.set(f.feedKey, f);
    }
    setFeedsByKey(map);
  }, [host]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useHostEvents((ev) => {
    if (
      ev.type === 'queue-changed' ||
      ev.type === 'progress-changed' ||
      ev.type === 'feeds-changed'
    ) {
      void loadQueue();
    }
  });

  const moveIndexTo = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (fromIdx < 0 || fromIdx >= rows.length) return;
      const clampedTo = Math.max(0, Math.min(rows.length - 1, toIdx));
      if (fromIdx === clampedTo) return;

      const copy = [...rows];
      const [moved] = copy.splice(fromIdx, 1);
      if (!moved) return;
      copy.splice(clampedTo, 0, moved);
      const afterItem = copy[clampedTo + 1];
      const beforeKey: EpisodeKey | null = afterItem ? afterItem.episode.episodeKey : null;

      setRows(copy);
      await host.queue.move(moved.episode.episodeKey, beforeKey);
      await loadQueue();
    },
    [host, loadQueue, rows],
  );

  const handleRemoveWithUndo = useCallback(
    async (idx: number) => {
      const target = rows[idx];
      if (!target) return;
      const nextNeighborKey: EpisodeKey | null = rows[idx + 1]?.episode.episodeKey ?? null;
      await host.queue.remove(target.episode.episodeKey);
      await loadQueue();

      showSnackbar(t('queue.removedSnack', { title: target.episode.title }), {
        action: {
          label: t('common.undo'),
          run: () => {
            void (async () => {
              await host.queue.add(target.episode.episodeKey);
              if (nextNeighborKey !== null) {
                await host.queue.move(target.episode.episodeKey, nextNeighborKey);
              }
              await loadQueue();
            })();
          },
        },
      });
    },
    [host, loadQueue, rows, t],
  );

  const totalRemainingMs = rows.reduce((acc, r) => {
    const dur = r.progress?.durationMs ?? r.episode.durationMs ?? r.entry.stub?.durationMs ?? 0;
    const pos = r.progress?.state === 'IN_PROGRESS' ? r.progress.positionMs : 0;
    return acc + Math.max(0, dur - pos);
  }, 0);

  const durationLabel = formatHumanDuration(totalRemainingMs);
  const headerText =
    rows.length === 0
      ? t('queue.title')
      : durationLabel
        ? t('queue.headerMeta', { count: rows.length, duration: durationLabel })
        : t('queue.headerCountOnly', { count: rows.length });

  const appBarMenu: MenuEntry[] = [
    {
      key: 'clear-queue',
      label: t('queue.clear'),
      icon: 'delete',
      disabled: rows.length === 0,
      testId: 'queue-clear-btn',
      onSelect: () => {
        void host.queue.clear().then(loadQueue);
      },
    },
    {
      key: 'refresh-queue',
      label: t('common.refresh'),
      icon: 'refresh',
      testId: 'queue-refresh-btn',
      onSelect: () => {
        void loadQueue();
      },
    },
  ];

  return (
    <div className="m-page" data-testid="queue-screen">
      <header className="m-appbar">
        <h1 className="m-appbar__title" data-testid="queue-header-title">
          {headerText}
        </h1>
        <Menu label={t('common.more')} items={appBarMenu} testId="queue-overflow-btn" />
      </header>

      {rows.length === 0 ? (
        <div className="m-empty" data-testid="queue-empty">
          <Icon name="queue" size={44} />
          <div>{t('queue.empty')}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="queue-list">
          {rows.map((r, idx) => {
            const epKey = r.episode.episodeKey;
            const feed = feedsByKey.get(r.episode.feedKey);
            const podcastName = r.entry.stub?.feedTitle ?? feed?.title ?? '';
            const primaryCoverUrl =
              nonEmptyUrl(r.episode.imageUrl) ?? nonEmptyUrl(r.entry.stub?.imageUrl);
            const feedCoverUrl =
              nonEmptyUrl(feed?.imageUrl) ?? nonEmptyUrl(r.entry.stub?.imageUrl);
            const isCurrent = player.episode?.episodeKey === epKey;
            const isPlaying = isCurrent && player.snapshot.playing;
            const dur = r.progress?.durationMs ?? r.episode.durationMs ?? r.entry.stub?.durationMs;
            const pos = isCurrent
              ? player.snapshot.positionMs
              : r.progress?.state === 'IN_PROGRESS'
                ? r.progress.positionMs
                : 0;
            const remStr =
              dur && pos > 0 && dur > pos
                ? t('detail.timeLeft', { time: formatHumanDuration(dur - pos) })
                : formatHumanDuration(dur);

            const rowMenu: MenuEntry[] = [
              {
                key: 'move-top',
                label: t('queue.moveToTop'),
                disabled: idx === 0,
                testId: `queue-move-top-${epKey}`,
                onSelect: () => {
                  void moveIndexTo(idx, 0);
                },
              },
              {
                key: 'move-up',
                label: t('queue.moveUp'),
                disabled: idx === 0,
                testId: `queue-move-up-${epKey}`,
                onSelect: () => {
                  void moveIndexTo(idx, idx - 1);
                },
              },
              {
                key: 'move-down',
                label: t('queue.moveDown'),
                disabled: idx === rows.length - 1,
                testId: `queue-move-down-${epKey}`,
                onSelect: () => {
                  void moveIndexTo(idx, idx + 1);
                },
              },
              {
                key: 'remove',
                label: t('queue.remove'),
                icon: 'delete',
                testId: `queue-remove-${epKey}`,
                onSelect: () => {
                  void handleRemoveWithUndo(idx);
                },
              },
            ];

            return (
              <div
                key={epKey}
                draggable
                className={cx(
                  'm-queue-row',
                  draggingIdx === idx && 'is-dragging',
                  dropTargetIdx === idx && draggingIdx !== idx && 'is-drop-target',
                )}
                data-testid={`queue-row-${idx}`}
                data-episode-key={epKey}
                onDragStart={(e) => {
                  setDraggingIdx(idx);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(idx));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTargetIdx(idx);
                }}
                onDragEnd={() => {
                  setDraggingIdx(null);
                  setDropTargetIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const rawFrom = e.dataTransfer.getData('text/plain');
                  const from = draggingIdx ?? Number.parseInt(rawFrom, 10);
                  setDraggingIdx(null);
                  setDropTargetIdx(null);
                  if (Number.isFinite(from)) {
                    void moveIndexTo(from, idx);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === 'ArrowUp') {
                    e.preventDefault();
                    void moveIndexTo(idx, idx - 1);
                  } else if (e.altKey && e.key === 'ArrowDown') {
                    e.preventDefault();
                    void moveIndexTo(idx, idx + 1);
                  }
                }}
                onTouchStart={(e) => {
                  const touch = e.touches[0];
                  if (touch) swipeStartXRef.current = touch.clientX;
                }}
                onTouchEnd={(e) => {
                  const startX = swipeStartXRef.current;
                  swipeStartXRef.current = null;
                  const touch = e.changedTouches[0];
                  if (startX !== null && touch && Math.abs(touch.clientX - startX) > 64) {
                    void handleRemoveWithUndo(idx);
                  }
                }}
              >
                <button
                  type="button"
                  className="m-queue-row__handle"
                  aria-label={`${t('queue.dragHandle')} ${r.episode.title}`}
                  title={t('queue.dragHandle')}
                  data-testid={`queue-handle-${epKey}`}
                >
                  <Icon name="drag" size={20} />
                </button>

                <ArtworkImage
                  src={primaryCoverUrl}
                  fallbackSrc={feedCoverUrl}
                  allowProxyFallback={shouldUseImageProxy(host.info.platform)}
                  className="m-queue-row__cover"
                  loading="lazy"
                  placeholder={
                    <div className="m-queue-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
                      <Icon name="podcasts" size={20} />
                    </div>
                  }
                />

                <div
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => {
                    if (isCurrent) {
                      void player.togglePlayPause();
                    } else {
                      void player.playEpisode(r.episode, {
                        feedTitle: podcastName,
                        feedImageUrl: feedCoverUrl,
                      });
                    }
                  }}
                >
                  <div style={{ font: 'var(--md-sys-typescale-title-small)', overflowWrap: 'anywhere' }}>
                    {r.episode.title}
                  </div>
                  <div
                    style={{
                      font: 'var(--md-sys-typescale-label-medium)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    {podcastName && <span>{podcastName}</span>}
                    {podcastName && remStr && <span>·</span>}
                    {remStr && <span>{remStr}</span>}
                  </div>
                </div>

                <IconButton
                  icon={isPlaying ? 'pause' : 'play'}
                  variant={isPlaying ? 'filled' : 'tonal'}
                  label={`${isPlaying ? t('detail.pause') : t('detail.play')} ${r.episode.title}`}
                  data-testid={`queue-play-${epKey}`}
                  onClick={() => {
                    if (isCurrent) {
                      void player.togglePlayPause();
                    } else {
                      void player.playEpisode(r.episode, {
                        feedTitle: podcastName,
                        feedImageUrl: feedCoverUrl,
                      });
                    }
                  }}
                />

                <Menu
                  label={`${t('common.more')} ${r.episode.title}`}
                  items={rowMenu}
                  testId={`queue-menu-${epKey}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
