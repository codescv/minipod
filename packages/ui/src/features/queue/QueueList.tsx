/**
 * Unified Queue screen (`DESIGN.md` §4.5 + `v0.1.5`):
 * - Header `Queue · N episodes · Xh Ym` + `⋮` (*Manage downloads* when non-empty, *Clear queue*, *Refresh*)
 * - Zero inline play or `⋮` row buttons:
 *   - Tap / click row directly plays (or pauses if current)
 *   - Long-press (~450ms) / right-click / `ContextMenu` opens `<ContextMenu testId="queue-context-menu">`
 *   - Swipe-left (`deltaX < -64px`) removes from queue with Undo snackbar restoring original slot
 * - Compact `20×36` drag handle (`queue-handle-*`) with working Pointer Events + Touch drag-to-reorder
 *   (plus `Alt+Up/Down` and HTML5 `onDrop` fallback)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeKey, Feed, FeedKey, QueueRow } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import {
  ArtworkImage,
  ContextMenu,
  cx,
  Icon,
  Menu,
  nonEmptyUrl,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useDownloadedCount } from '../../hooks/useDownloadedCount';
import { useRowGestures } from '../../hooks/useRowGestures';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar } from '../../stores/snackbar';

interface ActiveHandleDrag {
  fromIdx: number;
  targetIdx: number;
  pointerId: number | null;
}

export function QueueList() {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();
  const openDownloads = useRouteStore((s) => s.openDownloads);
  const downloadedCount = useDownloadedCount();
  const allowProxy = shouldUseImageProxy(host.info.platform);

  const [rows, setRows] = useState<readonly QueueRow[]>([]);
  const [feedsByKey, setFeedsByKey] = useState<ReadonlyMap<FeedKey, Feed>>(() => new Map());
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<{
    readonly idx: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<ActiveHandleDrag | null>(null);

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

  const moveIndexToRef = useRef(moveIndexTo);
  moveIndexToRef.current = moveIndexTo;

  const computeTargetIdx = useCallback((clientY: number, fallbackIdx: number): number => {
    const container = listRef.current;
    if (!container || !Number.isFinite(clientY)) return fallbackIdx;
    const els = Array.from(container.querySelectorAll<HTMLElement>('[data-queue-idx]'));
    if (els.length === 0) return fallbackIdx;

    let anyNonZeroHeight = false;
    let closestIdx = fallbackIdx;
    let closestDist = Number.POSITIVE_INFINITY;

    for (const el of els) {
      const idx = Number.parseInt(el.dataset.queueIdx ?? '', 10);
      if (!Number.isFinite(idx)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0) {
        anyNonZeroHeight = true;
      }
      if (rect.height > 0 && clientY >= rect.top && clientY <= rect.bottom) {
        return idx;
      }
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - midY);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = idx;
      }
    }

    return anyNonZeroHeight ? closestIdx : fallbackIdx;
  }, []);

  const startHandleDrag = useCallback((idx: number, pointerId: number | null) => {
    setActiveContextMenu(null);
    dragStateRef.current = { fromIdx: idx, targetIdx: idx, pointerId };
    setDraggingIdx(idx);
    setDropTargetIdx(idx);
  }, []);

  const updateHandleDrag = useCallback(
    (pointerId: number | null, clientY: number) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (st.pointerId !== null && pointerId !== null && st.pointerId !== pointerId) return;
      const nextTarget = computeTargetIdx(clientY, st.targetIdx);
      if (nextTarget !== st.targetIdx) {
        st.targetIdx = nextTarget;
        setDropTargetIdx(nextTarget);
      }
    },
    [computeTargetIdx],
  );

  const finishHandleDrag = useCallback(
    (pointerId: number | null, clientY: number | undefined, cancelled: boolean) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (st.pointerId !== null && pointerId !== null && st.pointerId !== pointerId) return;
      dragStateRef.current = null;

      const finalTarget =
        !cancelled && clientY !== undefined && Number.isFinite(clientY)
          ? computeTargetIdx(clientY, st.targetIdx)
          : st.targetIdx;

      setDraggingIdx(null);
      setDropTargetIdx(null);

      if (!cancelled && st.fromIdx !== finalTarget) {
        void moveIndexToRef.current(st.fromIdx, finalTarget);
      }
    },
    [computeTargetIdx],
  );

  useEffect(() => {
    const onWinPointerMove = (ev: PointerEvent) => {
      if (!dragStateRef.current) return;
      updateHandleDrag(ev.pointerId, ev.clientY);
    };
    const onWinPointerUp = (ev: PointerEvent) => {
      if (!dragStateRef.current) return;
      finishHandleDrag(ev.pointerId, ev.clientY, false);
    };
    const onWinPointerCancel = (ev: PointerEvent) => {
      if (!dragStateRef.current) return;
      finishHandleDrag(ev.pointerId, undefined, true);
    };

    window.addEventListener('pointermove', onWinPointerMove);
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onWinPointerMove);
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerCancel);
    };
  }, [finishHandleDrag, updateHandleDrag]);

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

  const handleMarkPlayedAndRemoveWithUndo = useCallback(
    async (idx: number) => {
      const target = rows[idx];
      if (!target) return;
      const epKey = target.episode.episodeKey;
      const nextNeighborKey: EpisodeKey | null = rows[idx + 1]?.episode.episodeKey ?? null;
      await host.progress.markPlayed(epKey, true);
      await host.queue.remove(epKey);
      await loadQueue();

      showSnackbar(t('detail.markedPlayedRemovedSnack'), {
        action: {
          label: t('common.undo'),
          run: () => {
            void (async () => {
              await host.progress.markPlayed(epKey, false);
              await host.queue.add(epKey);
              if (nextNeighborKey !== null) {
                await host.queue.move(epKey, nextNeighborKey);
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
    ...(downloadedCount > 0
      ? [
          {
            key: 'manage-downloads',
            label: t('subs.manageDownloads', { count: downloadedCount }),
            icon: 'downloaded' as const,
            testId: 'queue-manage-downloads',
            onSelect: () => openDownloads(),
          },
        ]
      : []),
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

  const contextTargetRow = activeContextMenu ? rows[activeContextMenu.idx] : undefined;
  const contextMenuItems: MenuEntry[] =
    activeContextMenu && contextTargetRow
      ? (() => {
          const idx = activeContextMenu.idx;
          const epKey = contextTargetRow.episode.episodeKey;
          return [
            {
              key: 'move-top',
              label: t('queue.moveToTop'),
              icon: 'expandLess',
              disabled: idx === 0,
              testId: `queue-move-top-${epKey}`,
              onSelect: () => {
                void moveIndexTo(idx, 0);
              },
            },
            {
              key: 'move-up',
              label: t('queue.moveUp'),
              icon: 'expandLess',
              disabled: idx === 0,
              testId: `queue-move-up-${epKey}`,
              onSelect: () => {
                void moveIndexTo(idx, idx - 1);
              },
            },
            {
              key: 'move-down',
              label: t('queue.moveDown'),
              icon: 'expandMore',
              disabled: idx === rows.length - 1,
              testId: `queue-move-down-${epKey}`,
              onSelect: () => {
                void moveIndexTo(idx, idx + 1);
              },
            },
            {
              key: 'mark-played',
              label: t('queue.markPlayedAndRemove'),
              icon: 'check',
              testId: `queue-mark-played-${epKey}`,
              onSelect: () => {
                void handleMarkPlayedAndRemoveWithUndo(idx);
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
        })()
      : [];

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
        <div ref={listRef} style={{ display: 'flex', flexDirection: 'column' }} data-testid="queue-list">
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
            const dur =
              (isCurrent ? player.snapshot.durationMs : undefined) ??
              r.progress?.durationMs ??
              r.episode.durationMs ??
              r.entry.stub?.durationMs;
            const pos = isCurrent
              ? player.snapshot.positionMs
              : r.progress?.state === 'IN_PROGRESS'
                ? r.progress.positionMs
                : 0;
            const pubDate = r.episode.pubDate ?? r.entry.stub?.pubDate;
            const dateStr = formatShortDate(pubDate, locale);
            const remStr =
              dur && pos > 0 && dur > pos
                ? t('detail.timeLeft', { time: formatHumanDuration(dur - pos) })
                : dur
                  ? formatHumanDuration(dur)
                  : '';

            return (
              <QueueRowItem
                key={epKey}
                row={r}
                idx={idx}
                primaryCoverUrl={primaryCoverUrl}
                feedCoverUrl={feedCoverUrl}
                allowProxy={allowProxy}
                dateStr={dateStr}
                remStr={remStr}
                isCurrent={isCurrent}
                isPlaying={isPlaying}
                draggingIdx={draggingIdx}
                dropTargetIdx={dropTargetIdx}
                dragHandleLabel={`${t('queue.dragHandle')} ${r.episode.title}`}
                dragHandleTitle={t('queue.dragHandle')}
                onPlay={() => {
                  if (isCurrent) {
                    void player.togglePlayPause();
                  } else {
                    void player.playEpisode(r.episode, {
                      feedTitle: podcastName,
                      feedImageUrl: feedCoverUrl,
                    });
                  }
                }}
                onContext={(x, y) => setActiveContextMenu({ idx, x, y })}
                onSwipeLeftRemove={() => {
                  void handleRemoveWithUndo(idx);
                }}
                onMoveIndex={(from, to) => {
                  void moveIndexTo(from, to);
                }}
                onSetDragging={setDraggingIdx}
                onSetDropTarget={setDropTargetIdx}
                onStartHandleDrag={startHandleDrag}
                onUpdateHandleDrag={updateHandleDrag}
                onFinishHandleDrag={finishHandleDrag}
              />
            );
          })}
        </div>
      )}

      <ContextMenu
        open={activeContextMenu !== null && contextMenuItems.length > 0}
        x={activeContextMenu?.x ?? 0}
        y={activeContextMenu?.y ?? 0}
        onClose={() => setActiveContextMenu(null)}
        items={contextMenuItems}
        testId="queue-context-menu"
      />
    </div>
  );
}

function QueueRowItem({
  row,
  idx,
  primaryCoverUrl,
  feedCoverUrl,
  allowProxy,
  dateStr,
  remStr,
  isCurrent,
  isPlaying,
  draggingIdx,
  dropTargetIdx,
  dragHandleLabel,
  dragHandleTitle,
  onPlay,
  onContext,
  onSwipeLeftRemove,
  onMoveIndex,
  onSetDragging,
  onSetDropTarget,
  onStartHandleDrag,
  onUpdateHandleDrag,
  onFinishHandleDrag,
}: {
  readonly row: QueueRow;
  readonly idx: number;
  readonly primaryCoverUrl?: string | undefined;
  readonly feedCoverUrl?: string | undefined;
  readonly allowProxy: boolean;
  readonly dateStr: string;
  readonly remStr: string;
  readonly isCurrent: boolean;
  readonly isPlaying: boolean;
  readonly draggingIdx: number | null;
  readonly dropTargetIdx: number | null;
  readonly dragHandleLabel: string;
  readonly dragHandleTitle: string;
  readonly onPlay: () => void;
  readonly onContext: (x: number, y: number) => void;
  readonly onSwipeLeftRemove: () => void;
  readonly onMoveIndex: (from: number, to: number) => void;
  readonly onSetDragging: (idx: number | null) => void;
  readonly onSetDropTarget: (idx: number | null) => void;
  readonly onStartHandleDrag: (idx: number, pointerId: number | null) => void;
  readonly onUpdateHandleDrag: (pointerId: number | null, clientY: number) => void;
  readonly onFinishHandleDrag: (
    pointerId: number | null,
    clientY: number | undefined,
    cancelled: boolean,
  ) => void;
}) {
  const epKey = row.episode.episodeKey;
  const { swipeOffsetX, handlers } = useRowGestures({
    onTap: onPlay,
    onContext,
    onSwipeLeft: onSwipeLeftRemove,
  });

  const isDragging = draggingIdx === idx;
  const isDropTarget = dropTargetIdx === idx && draggingIdx !== null && draggingIdx !== idx;
  const dropBelow = isDropTarget && draggingIdx !== null && idx > draggingIdx;

  return (
    <div
      className={cx(
        'm-queue-row',
        isCurrent && 'is-current',
        isPlaying && 'is-playing',
        isDragging && 'is-dragging',
        isDropTarget && 'is-drop-target',
        dropBelow && 'is-drop-target-below',
      )}
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={row.episode.title}
      data-testid={`queue-row-${idx}`}
      data-queue-idx={idx}
      data-episode-key={epKey}
      style={
        swipeOffsetX !== 0
          ? { transform: `translateX(${swipeOffsetX}px)`, transition: 'none' }
          : undefined
      }
      onDragStart={(e) => {
        onSetDragging(idx);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onSetDropTarget(idx);
      }}
      onDragEnd={() => {
        onSetDragging(null);
        onSetDropTarget(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const rawFrom = e.dataTransfer.getData('text/plain');
        const from = draggingIdx ?? Number.parseInt(rawFrom, 10);
        onSetDragging(null);
        onSetDropTarget(null);
        if (Number.isFinite(from)) {
          onMoveIndex(from, idx);
        }
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onTouchStart={handlers.onTouchStart}
      onTouchMove={handlers.onTouchMove}
      onTouchEnd={handlers.onTouchEnd}
      onTouchCancel={handlers.onTouchCancel}
      onClick={handlers.onClick}
      onContextMenu={handlers.onContextMenu}
      onKeyDown={(e) => {
        if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          onMoveIndex(idx, idx - 1);
          return;
        }
        if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          onMoveIndex(idx, idx + 1);
          return;
        }
        handlers.onKeyDown(e);
      }}
    >
      <div
        className="m-queue-row__handle"
        aria-label={dragHandleLabel}
        title={dragHandleTitle}
        data-testid={`queue-handle-${epKey}`}
        onPointerDown={(e) => {
          if (typeof e.button === 'number' && e.button > 0) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // ignore in non-capturing test environments
          }
          onStartHandleDrag(idx, e.pointerId);
        }}
        onPointerMove={(e) => {
          onUpdateHandleDrag(e.pointerId, e.clientY);
        }}
        onPointerUp={(e) => {
          try {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
          } catch {
            // ignore
          }
          onFinishHandleDrag(e.pointerId, e.clientY, false);
        }}
        onPointerCancel={(e) => {
          try {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
          } catch {
            // ignore
          }
          onFinishHandleDrag(e.pointerId, undefined, true);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          if (draggingIdx === null) {
            onStartHandleDrag(idx, null);
          }
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
          const touch = e.touches[0];
          if (touch) {
            onUpdateHandleDrag(null, touch.clientY);
          }
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          const touch = e.changedTouches[0];
          onFinishHandleDrag(null, touch?.clientY, false);
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Icon name="drag" size={16} />
      </div>

      <ArtworkImage
        src={primaryCoverUrl}
        fallbackSrc={feedCoverUrl}
        allowProxyFallback={allowProxy}
        className="m-queue-row__cover"
        loading="lazy"
        draggable={false}
        placeholder={
          <div className="m-queue-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
            <Icon name="podcasts" size={20} />
          </div>
        }
      />

      <div className="m-episode-row__body">
        <div className="m-episode-row__title">{row.episode.title}</div>
        {(dateStr || remStr) && (
          <div className="m-episode-row__meta">
            {dateStr && <span>{dateStr}</span>}
            {dateStr && remStr && <span>·</span>}
            {remStr && <span>{remStr}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
