/**
 * Unified Queue screen (`DESIGN.md` §4.5 + `v0.1.14`):
 * - Header `Queue · N episodes · Xh Ym` + top-right `⋮` menu (`Download all` + `Manage downloads` when non-empty)
 * - Per-row cache status icon right of remaining time (`check` when downloaded, dashed+solid progress circle when downloading)
 * - Zero inline play or `⋮` row buttons:
 *   - Tap / click row directly plays (or pauses if current)
 *   - Long-press (~450ms) / right-click / `ContextMenu` opens `<ContextMenu testId="queue-context-menu">`
 *     (`Move to top` / download / `Remove` / `View details`; v0.1.24 `查看详情` opens `episode-detail-sheet`)
 *   - Swipe-left (`deltaX < -64px`) reveals right-edge `Remove` / `从队列移除` action hint and removes with Undo snackbar
 * - Compact `20×36` drag handle (`queue-handle-*`) with live item-following Pointer/Touch drag-to-reorder
 *   and real-time neighbor slot shifting (plus `Alt+Up/Down` and HTML5 `onDrop` fallback)
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, Fragment } from 'react';
import type { DownloadState, EpisodeKey, Feed, FeedKey, QueueRow } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import {
  ArtworkImage,
  BottomSheet,
  Button,
  ContextMenu,
  cx,
  Icon,
  IconButton,
  Menu,
  nonEmptyUrl,
  preloadArtworkUrls,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
import { useDownloadedCount } from '../../hooks/useDownloadedCount';
import { useRowGestures } from '../../hooks/useRowGestures';
import { clearTextSelection } from '../../lib/text-selection';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate, sanitizeShownotesHtml } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar, useSnackbarStore } from '../../stores/snackbar';
import {
  applyDownloadStateToViewCache,
  beginDownloadStop,
  clearDownloadStop,
  downloadRatioToPercent,
  endDownloadStop,
  getHostViewCache,
  guardStoppedDownloadState,
} from '../../stores/view-cache';
import {
  DetailDownloadStatus,
  DownloadPercentText,
  DownloadProgressRing,
  DownloadWaitingText,
  ResumeDownloadChip,
  inlineRowActionProps,
} from '../../components/DownloadControls';

interface PendingQueueInlineUndo {
  readonly epKey: EpisodeKey;
  readonly title: string;
  readonly idx: number;
  readonly nextNeighborKey: EpisodeKey | null;
}

interface QueueSlotSnapshot {
  readonly idx: number;
  readonly top: number;
  readonly bottom: number;
  readonly midY: number;
  readonly height: number;
}

interface ActiveHandleDrag {
  fromIdx: number;
  targetIdx: number;
  pointerId: number | null;
  startY: number;
  currentY: number;
  dragRowHeight: number;
  minDeltaY: number;
  maxDeltaY: number;
  slots: readonly QueueSlotSnapshot[];
}

export function QueueList() {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();
  const openDownloads = useRouteStore((s) => s.openDownloads);
  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);
  const downloadedCount = useDownloadedCount();
  const allowProxy = shouldUseImageProxy(host.info.platform);

  const [rows, setRows] = useState<readonly QueueRow[]>(() => getHostViewCache(host).queueRows);
  const [feedsByKey, setFeedsByKey] = useState<ReadonlyMap<FeedKey, Feed>>(
    () => getHostViewCache(host).feedsByKey,
  );
  const [loading, setLoading] = useState(() => !getHostViewCache(host).queueLoaded);
  const [downloadProgressByKey, setDownloadProgressByKey] = useState<
    ReadonlyMap<EpisodeKey, number>
  >(() => new Map(getHostViewCache(host).downloadProgressByKey));
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const [dragDeltaY, setDragDeltaY] = useState(0);
  const [dragRowHeight, setDragRowHeight] = useState(64);
  const [activeContextMenu, setActiveContextMenu] = useState<{
    readonly idx: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingQueueInlineUndo | null>(null);
  /** v0.1.24 `查看详情` sheet target; `detailsSnapshot` keeps it functional after queue removal. */
  const [detailsEpisodeKey, setDetailsEpisodeKey] = useState<EpisodeKey | null>(null);
  const [detailsSnapshot, setDetailsSnapshot] = useState<QueueRow | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<ActiveHandleDrag | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `download-updated` events seen while a `loadQueue()` is in flight win over its (older)
   * snapshot, so a slow revalidation never reverts a just-started download (`QUEUED` -> `NONE`).
   */
  const downloadEventSeqRef = useRef(0);
  const lastDownloadEventRef = useRef(
    new Map<EpisodeKey, { readonly seq: number; readonly state: DownloadState }>(),
  );
  /** Per-episode count of user-requested stops (a stopped download rejecting is not a failure). */
  const stopGenerationRef = useRef(new Map<EpisodeKey, number>());

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearUndoTimer, [clearUndoTimer]);

  const loadQueue = useCallback(async () => {
    const startSeq = downloadEventSeqRef.current;
    try {
      const [fetched, fList] = await Promise.all([host.queue.list(), host.feeds.list()]);
      const newerEvents = [...lastDownloadEventRef.current].filter(([, e]) => e.seq > startSeq);
      const now = Date.now();
      const q = fetched.map((r) => {
        const live =
          newerEvents.length === 0
            ? undefined
            : lastDownloadEventRef.current.get(r.episode.episodeKey);
        const snapshotState =
          live && live.seq > startSeq ? live.state : r.episode.downloadState;
        // A snapshot fetched while `停止下载` / `停止全部` is still in flight must not resurrect
        // the stopped QUEUED / RUNNING download.
        const state = guardStoppedDownloadState(host, r.episode.episodeKey, snapshotState, now);
        return state !== r.episode.downloadState
          ? { ...r, episode: { ...r.episode, downloadState: state } }
          : r;
      });
      const map = new Map<FeedKey, Feed>();
      for (const f of fList) {
        map.set(f.feedKey, f);
      }
      const viewCache = getHostViewCache(host);
      viewCache.queueRows = q;
      viewCache.queueLoaded = true;
      viewCache.feeds = fList;
      viewCache.feedsByKey = map;
      viewCache.feedsLoaded = true;
      setRows(q);
      setFeedsByKey(map);
      preloadArtworkUrls(
        [
          ...fList.map((f) => f.imageUrl),
          ...q.map((r) => r.episode.imageUrl ?? r.entry.stub?.imageUrl),
        ],
        shouldUseImageProxy(host.info.platform),
      );
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useHostEvents((ev) => {
    if (ev.type === 'download-updated') {
      downloadEventSeqRef.current += 1;
      lastDownloadEventRef.current.set(ev.episodeKey, {
        seq: downloadEventSeqRef.current,
        state: ev.state,
      });
      // Keep the unmounted screens' SWR slices (Manage Downloads, timeline, per-feed rows) in sync.
      // Also records the progress sample in the shared `downloadProgressByKey` (kept on FAILED,
      // cleared on DONE/NONE) so a remount mid-download never flashes back to `0%`.
      applyDownloadStateToViewCache(host, ev.episodeKey, ev.state, undefined, ev.progress);
      setDownloadProgressByKey(new Map(getHostViewCache(host).downloadProgressByKey));
      // Keep an open `episode-detail-sheet` live even after its episode left the queue.
      setDetailsSnapshot((prev) =>
        prev && prev.episode.episodeKey === ev.episodeKey && prev.episode.downloadState !== ev.state
          ? { ...prev, episode: { ...prev.episode, downloadState: ev.state } }
          : prev,
      );
      setRows((prev) => {
        if (!prev.some((r) => r.episode.episodeKey === ev.episodeKey)) return prev;
        const next = prev.map((r) =>
          r.episode.episodeKey === ev.episodeKey
            ? {
                ...r,
                episode: {
                  ...r.episode,
                  downloadState: ev.state,
                },
              }
            : r,
        );
        getHostViewCache(host).queueRows = next;
        return next;
      });
      if (ev.state === 'DONE' || ev.state === 'NONE' || ev.state === 'FAILED') {
        void loadQueue();
      }
      return;
    }
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
      getHostViewCache(host).queueRows = copy;
      await host.queue.move(moved.episode.episodeKey, beforeKey);
      await loadQueue();
    },
    [host, loadQueue, rows],
  );

  const moveIndexToRef = useRef(moveIndexTo);
  moveIndexToRef.current = moveIndexTo;

  const computeTargetIdx = useCallback(
    (
      clientY: number,
      fallbackIdx: number,
      slots?: readonly QueueSlotSnapshot[],
    ): number => {
      if (!Number.isFinite(clientY)) return fallbackIdx;

      if (slots && slots.some((s) => s.height > 0)) {
        let closestIdx = fallbackIdx;
        let closestDist = Number.POSITIVE_INFINITY;
        for (const s of slots) {
          if (s.height > 0 && clientY >= s.top && clientY <= s.bottom) {
            return s.idx;
          }
          const dist = Math.abs(clientY - s.midY);
          if (dist < closestDist) {
            closestDist = dist;
            closestIdx = s.idx;
          }
        }
        return closestIdx;
      }

      const container = listRef.current;
      if (!container) return fallbackIdx;
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
    },
    [],
  );

  const startHandleDrag = useCallback(
    (idx: number, pointerId: number | null, clientY: number) => {
      if (dragStateRef.current !== null && pointerId === null) {
        return;
      }
      setActiveContextMenu(null);
      const slots: QueueSlotSnapshot[] = [];
      const container = listRef.current;
      if (container) {
        const els = Array.from(container.querySelectorAll<HTMLElement>('[data-queue-idx]'));
        for (const el of els) {
          const elIdx = Number.parseInt(el.dataset.queueIdx ?? '', 10);
          if (!Number.isFinite(elIdx)) continue;
          const rect = el.getBoundingClientRect();
          slots.push({
            idx: elIdx,
            top: rect.top,
            bottom: rect.bottom,
            midY: rect.top + rect.height / 2,
            height: rect.height,
          });
        }
        slots.sort((a, b) => a.idx - b.idx);
      }

      const fromSlot = slots.find((s) => s.idx === idx);
      const firstSlot = slots[0];
      const lastSlot = slots[slots.length - 1];
      const rowH = fromSlot && fromSlot.height > 0 ? Math.round(fromSlot.height) : 64;
      const hasRealBounds = Boolean(fromSlot && firstSlot && lastSlot && fromSlot.height > 0);
      const minDeltaY = hasRealBounds ? firstSlot!.top - fromSlot!.top - 12 : -2000;
      const maxDeltaY = hasRealBounds ? lastSlot!.bottom - fromSlot!.bottom + 12 : 2000;
      const safeStartY =
        Number.isFinite(clientY) && clientY !== 0
          ? clientY
          : (fromSlot?.midY ?? (Number.isFinite(clientY) ? clientY : 0));

      dragStateRef.current = {
        fromIdx: idx,
        targetIdx: idx,
        pointerId,
        startY: safeStartY,
        currentY: safeStartY,
        dragRowHeight: rowH,
        minDeltaY,
        maxDeltaY,
        slots,
      };
      setDraggingIdx(idx);
      setDropTargetIdx(idx);
      setDragDeltaY(0);
      setDragRowHeight(rowH);
    },
    [],
  );

  const updateHandleDrag = useCallback(
    (pointerId: number | null, clientY: number) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (st.pointerId !== null && pointerId !== null && st.pointerId !== pointerId) return;

      if (Number.isFinite(clientY)) {
        st.currentY = clientY;
        const rawDelta = clientY - st.startY;
        const clampedDelta = Math.max(st.minDeltaY, Math.min(st.maxDeltaY, rawDelta));
        setDragDeltaY(clampedDelta);
      }

      const nextTarget = computeTargetIdx(clientY, st.targetIdx, st.slots);
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
          ? computeTargetIdx(clientY, st.targetIdx, st.slots)
          : st.targetIdx;

      setDraggingIdx(null);
      setDropTargetIdx(null);
      setDragDeltaY(0);

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

  const handleSwipeRemoveWithInlineUndo = useCallback(
    async (idx: number) => {
      const target = rows[idx];
      if (!target) return;
      useSnackbarStore.getState().clear();
      clearUndoTimer();
      const nextNeighborKey: EpisodeKey | null = rows[idx + 1]?.episode.episodeKey ?? null;
      setPendingUndo({
        epKey: target.episode.episodeKey,
        title: target.episode.title,
        idx,
        nextNeighborKey,
      });
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        setPendingUndo(null);
      }, 4500);
      await host.queue.remove(target.episode.episodeKey);
      await loadQueue();
    },
    [clearUndoTimer, host, loadQueue, rows],
  );

  const handleRunInlineUndo = useCallback(async () => {
    const current = pendingUndo;
    if (!current) return;
    clearUndoTimer();
    setPendingUndo(null);
    await host.queue.add(current.epKey);
    if (current.nextNeighborKey !== null) {
      await host.queue.move(current.epKey, current.nextNeighborKey);
    }
    await loadQueue();
  }, [clearUndoTimer, host, loadQueue, pendingUndo]);

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

  const canDownload = Boolean(host.info.capabilities.downloads);
  const downloadableRows = canDownload
    ? rows.filter(
        (r) =>
          !r.episode.feedKey.startsWith('l_') &&
          Boolean(r.episode.enclosureUrl ?? r.entry.stub?.enclosureUrl) &&
          (r.episode.downloadState === 'NONE' || r.episode.downloadState === 'FAILED'),
      )
    : [];

  /**
   * `下载全部`: dispatches every NONE / FAILED downloadable row at once (never sequentially). The
   * hosts run at most 3 transfers concurrently (`RUNNING`) and hold the rest as `QUEUED`, promoting
   * them as slots free up; each `download()` promise settles when its own transfer ends.
   */
  const handleDownloadAll = useCallback(async () => {
    if (!canDownload || downloadableRows.length === 0) return;
    const keys = downloadableRows.map((r) => r.episode.episodeKey);
    for (const key of keys) clearDownloadStop(host, key);
    await Promise.allSettled(keys.map((key) => host.episodes.download(key)));
    await loadQueue().catch(() => undefined);
  }, [canDownload, downloadableRows, host, loadQueue]);

  const downloadingRows = canDownload
    ? rows.filter(
        (r) => r.episode.downloadState === 'RUNNING' || r.episode.downloadState === 'QUEUED',
      )
    : [];

  /**
   * Optimistically flips the given episodes to `downloadState: 'NONE'`, clears their progress and
   * starts a stop guard (`beginDownloadStop`; pair with `endDownloadStop`) so stale events /
   * snapshots from before the host processed the stop cannot revert them.
   */
  const markDownloadsStopped = useCallback(
    (keySet: ReadonlySet<EpisodeKey>) => {
      for (const key of keySet) {
        // Wins over any `loadQueue()` already in flight (it must not revert the row to RUNNING).
        downloadEventSeqRef.current += 1;
        lastDownloadEventRef.current.set(key, { seq: downloadEventSeqRef.current, state: 'NONE' });
        stopGenerationRef.current.set(key, (stopGenerationRef.current.get(key) ?? 0) + 1);
        beginDownloadStop(host, key);
      }
      setDetailsSnapshot((prev) =>
        prev && keySet.has(prev.episode.episodeKey)
          ? { ...prev, episode: { ...prev.episode, downloadState: 'NONE' as const } }
          : prev,
      );
      setDownloadProgressByKey((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const key of keySet) {
          if (next.delete(key)) changed = true;
        }
        return changed ? next : prev;
      });
      setRows((prev) => {
        if (!prev.some((r) => keySet.has(r.episode.episodeKey))) return prev;
        const next = prev.map((r) =>
          keySet.has(r.episode.episodeKey)
            ? { ...r, episode: { ...r.episode, downloadState: 'NONE' as const } }
            : r,
        );
        getHostViewCache(host).queueRows = next;
        return next;
      });
    },
    [host],
  );

  const handleStopDownload = useCallback(
    async (epKey: EpisodeKey) => {
      markDownloadsStopped(new Set([epKey]));
      try {
        await host.episodes.deleteDownload(epKey);
      } catch {
        // ignore: the revalidation below shows the real state
      } finally {
        endDownloadStop(host, epKey);
        await loadQueue().catch(() => undefined);
      }
    },
    [host, loadQueue, markDownloadsStopped],
  );

  /**
   * `继续下载` / `Download episode`: (re)starts the download (hosts resume a failed `.part` via HTTP
   * `Range`). `download()` rejects when the transfer fails again: surface `下载失败` instead of
   * leaking an unhandled rejection; the row falls back to `FAILED` with its `继续下载` pill.
   */
  const handleResumeDownload = useCallback(
    async (epKey: EpisodeKey) => {
      clearDownloadStop(host, epKey);
      const stopGeneration = stopGenerationRef.current.get(epKey) ?? 0;
      try {
        await host.episodes.download(epKey);
      } catch {
        // A download the user stopped meanwhile (`停止下载` / `停止全部`) is not a failure.
        if ((stopGenerationRef.current.get(epKey) ?? 0) !== stopGeneration) return;
        showSnackbar(t('queue.downloadFailed'));
      } finally {
        await loadQueue().catch(() => undefined);
      }
    },
    [host, loadQueue, t],
  );

  /**
   * `停止全部`: stops every `RUNNING` and `QUEUED` download at once. Rows flip to NONE immediately
   * and stay there: guarded against late `download-updated` events (e.g. a QUEUED -> RUNNING
   * promotion when a slot frees up, or an auto-retry) and stale `loadQueue()` snapshots until the
   * host confirms. Uses the host's atomic `cancelAllDownloads` (queued items never start) when
   * available; otherwise cancels every QUEUED download BEFORE any RUNNING one, so a freed running
   * slot never promotes (and opens a connection for) an item that is about to be stopped.
   */
  const handleStopAllDownloads = useCallback(async () => {
    if (!canDownload || downloadingRows.length === 0) return;
    const queuedKeys: EpisodeKey[] = [];
    const runningKeys: EpisodeKey[] = [];
    for (const r of downloadingRows) {
      (r.episode.downloadState === 'QUEUED' ? queuedKeys : runningKeys).push(r.episode.episodeKey);
    }
    const keySet = new Set([...queuedKeys, ...runningKeys]);
    markDownloadsStopped(keySet);
    let stopped = false;
    if (host.episodes.cancelAllDownloads) {
      try {
        await host.episodes.cancelAllDownloads();
        stopped = true;
      } catch {
        // Older host (e.g. desktop server without the route): per-episode fallback below.
      }
    }
    if (!stopped) {
      const deleteAll = (keys: readonly EpisodeKey[]) =>
        Promise.allSettled(keys.map((key) => host.episodes.deleteDownload(key)));
      await deleteAll(queuedKeys);
      await deleteAll(runningKeys);
    }
    for (const key of keySet) endDownloadStop(host, key);
    await loadQueue().catch(() => undefined);
  }, [canDownload, downloadingRows, host, loadQueue, markDownloadsStopped]);

  const headerMenuItems: MenuEntry[] = [
    {
      key: 'download-all',
      label: t('queue.downloadAll'),
      icon: 'download',
      disabled: downloadableRows.length === 0,
      testId: 'queue-download-all',
      onSelect: () => {
        void handleDownloadAll();
      },
    },
    ...(downloadingRows.length > 0
      ? [
          {
            key: 'stop-all',
            label: t('queue.stopAll'),
            icon: 'stop' as const,
            testId: 'queue-stop-all',
            onSelect: () => {
              void handleStopAllDownloads();
            },
          },
        ]
      : []),
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
  ];

  const contextTargetRow = activeContextMenu ? rows[activeContextMenu.idx] : undefined;
  const contextMenuItems: MenuEntry[] =
    activeContextMenu && contextTargetRow
      ? (() => {
          const idx = activeContextMenu.idx;
          const epKey = contextTargetRow.episode.episodeKey;
          const dlState = contextTargetRow.episode.downloadState;
          const downloadItem: MenuEntry =
            dlState === 'DONE'
              ? {
                  key: 'download',
                  label: t('detail.deleteDownload'),
                  icon: 'downloaded',
                  disabled: !canDownload,
                  testId: `queue-download-${epKey}`,
                  onSelect: () => {
                    void host.episodes
                      .deleteDownload(epKey)
                      .catch(() => undefined)
                      .then(() => loadQueue());
                  },
                }
              : dlState === 'RUNNING' || dlState === 'QUEUED'
                ? {
                    key: 'download',
                    label: t('detail.stopDownload'),
                    icon: 'stop',
                    disabled: !canDownload,
                    testId: `queue-download-${epKey}`,
                    onSelect: () => {
                      void handleStopDownload(epKey);
                    },
                  }
                : {
                    key: 'download',
                    label:
                      dlState === 'FAILED' ? t('detail.resumeDownload') : t('detail.download'),
                    icon: 'download',
                    disabled:
                      !canDownload ||
                      contextTargetRow.episode.feedKey.startsWith('l_') ||
                      !Boolean(
                        contextTargetRow.episode.enclosureUrl ??
                          contextTargetRow.entry.stub?.enclosureUrl,
                      ),
                    testId: `queue-download-${epKey}`,
                    onSelect: () => {
                      void handleResumeDownload(epKey);
                    },
                  };
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
            downloadItem,
            {
              key: 'remove',
              label: t('queue.remove'),
              icon: 'delete',
              testId: `queue-remove-${epKey}`,
              onSelect: () => {
                void handleRemoveWithUndo(idx);
              },
            },
            {
              key: 'view-details',
              label: t('detail.viewDetails'),
              icon: 'shownotes',
              testId: `queue-view-details-${epKey}`,
              onSelect: () => {
                setDetailsSnapshot(contextTargetRow);
                setDetailsEpisodeKey(epKey);
              },
            },
          ];
        })()
      : [];

  const closeDetails = useCallback(() => {
    setDetailsEpisodeKey(null);
    setDetailsSnapshot(null);
  }, []);

  // Prefer the live queue row (fresh progress / download state); fall back to the snapshot taken
  // when the sheet opened so the sheet stays functional if the episode leaves the queue meanwhile.
  const detailsLiveRow =
    detailsEpisodeKey !== null
      ? rows.find((r) => r.episode.episodeKey === detailsEpisodeKey)
      : undefined;
  const detailsRow =
    detailsLiveRow ??
    (detailsSnapshot && detailsSnapshot.episode.episodeKey === detailsEpisodeKey
      ? detailsSnapshot
      : undefined);
  const detailsSheet = (() => {
    if (!detailsRow) return null;
    const episode = detailsRow.episode;
    const epKey = episode.episodeKey;
    const inQueue = detailsLiveRow !== undefined;
    const feed = feedsByKey.get(episode.feedKey);
    const podcastName = detailsRow.entry.stub?.feedTitle ?? feed?.title ?? '';
    const primaryCoverUrl =
      nonEmptyUrl(episode.imageUrl) ?? nonEmptyUrl(detailsRow.entry.stub?.imageUrl);
    const feedCoverUrl = nonEmptyUrl(feed?.imageUrl) ?? nonEmptyUrl(detailsRow.entry.stub?.imageUrl);
    const isCurrent = player.episode?.episodeKey === epKey;
    const isPlaying = isCurrent && player.snapshot.playing;
    const dur =
      (isCurrent ? player.snapshot.durationMs : undefined) ??
      detailsRow.progress?.durationMs ??
      episode.durationMs ??
      detailsRow.entry.stub?.durationMs;
    const pos = isCurrent
      ? player.snapshot.positionMs
      : detailsRow.progress?.state === 'IN_PROGRESS'
        ? detailsRow.progress.positionMs
        : 0;
    const dateStr = formatShortDate(episode.pubDate ?? detailsRow.entry.stub?.pubDate, locale);
    const remStr =
      dur && pos > 0 && dur > pos
        ? t('detail.timeLeft', { time: formatHumanDuration(dur - pos) })
        : dur
          ? formatHumanDuration(dur)
          : '';
    const isAudioOnlyVideo = episode.mediaType === 'VIDEO' && !player.engine.capabilities.video;
    const shownotesHtml = sanitizeShownotesHtml(episode.description);
    const canDownloadEpisode =
      canDownload &&
      !episode.feedKey.startsWith('l_') &&
      Boolean(episode.enclosureUrl ?? detailsRow.entry.stub?.enclosureUrl);
    const isDownloading =
      canDownloadEpisode &&
      (episode.downloadState === 'RUNNING' || episode.downloadState === 'QUEUED');
    const isDownloadQueued = isDownloading && episode.downloadState === 'QUEUED';
    const isDownloadFailed = canDownloadEpisode && episode.downloadState === 'FAILED';
    const downloadRatio = downloadProgressByKey.get(epKey) ?? 0;
    return {
      isDownloading,
      isDownloadQueued,
      isDownloadFailed,
      downloadRatio,
      downloadPercent: downloadRatioToPercent(downloadRatio),
      episode,
      epKey,
      inQueue,
      feed,
      podcastName,
      primaryCoverUrl,
      feedCoverUrl,
      isCurrent,
      isPlaying,
      dateStr,
      remStr,
      isAudioOnlyVideo,
      shownotesHtml,
    };
  })();

  const handleDetailsPlayToggle = () => {
    if (!detailsSheet) return;
    if (detailsSheet.isCurrent) {
      void player.togglePlayPause();
    } else {
      void player.playEpisode(detailsSheet.episode, {
        feedTitle: detailsSheet.podcastName,
        feedImageUrl: detailsSheet.feedCoverUrl,
      });
    }
  };

  const handleDetailsToggleQueue = async () => {
    if (!detailsSheet) return;
    if (detailsSheet.inQueue) {
      await host.queue.remove(detailsSheet.epKey);
    } else {
      await host.queue.add(detailsSheet.epKey);
    }
    await loadQueue();
  };

  return (
    <div className="m-page" data-testid="queue-screen">
      <header className="m-appbar">
        <h1 className="m-appbar__title" data-testid="queue-header-title">
          {headerText}
        </h1>
        {downloadingRows.length > 0 && (
          <Button
            variant="text"
            icon="stop"
            data-testid="queue-stop-all-btn"
            onClick={() => {
              void handleStopAllDownloads();
            }}
          >
            {t('queue.stopAll')}
          </Button>
        )}
        <Menu label={t('common.more')} items={headerMenuItems} testId="queue-overflow-btn" />
      </header>

      {!loading && rows.length === 0 && !pendingUndo ? (
        <div className="m-empty" data-testid="queue-empty">
          <Icon name="queue" size={44} />
          <div>{t('queue.empty')}</div>
        </div>
      ) : rows.length > 0 || pendingUndo ? (
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
            const rawProgress = downloadProgressByKey.get(epKey);
            const cachingLabel = t('queue.cachingProgress', {
              percent: downloadRatioToPercent(rawProgress),
            });
            const canResumeDownload =
              canDownload &&
              !r.episode.feedKey.startsWith('l_') &&
              Boolean(r.episode.enclosureUrl ?? r.entry.stub?.enclosureUrl);

            return (
              <Fragment key={epKey}>
                {pendingUndo && pendingUndo.idx === idx && (
                  <div
                    className="m-inline-undo"
                    role="status"
                    aria-live="polite"
                    data-testid={`inline-undo-${pendingUndo.epKey}`}
                    data-queue-undo-idx={pendingUndo.idx}
                  >
                    <span className="m-inline-undo__text">
                      {t('queue.removedSnack', { title: pendingUndo.title })}
                    </span>
                    <button
                      type="button"
                      className="m-inline-undo__btn"
                      data-testid={`inline-undo-btn-${pendingUndo.epKey}`}
                      onClick={() => {
                        void handleRunInlineUndo();
                      }}
                    >
                      {t('common.undo')}
                    </button>
                  </div>
                )}
                <QueueRowItem
                  row={r}
                  idx={idx}
                  primaryCoverUrl={primaryCoverUrl}
                  feedCoverUrl={feedCoverUrl}
                  allowProxy={allowProxy}
                  dateStr={dateStr}
                  remStr={remStr}
                  downloadProgress={rawProgress}
                  cachedLabel={t('queue.cached')}
                  cachingLabel={cachingLabel}
                  waitingLabel={t('queue.waiting')}
                  stopDownloadLabel={t('detail.stopDownload')}
                  onStopDownload={() => {
                    void handleStopDownload(epKey);
                  }}
                  canResumeDownload={canResumeDownload}
                  resumeDownloadLabel={t('queue.resumeDownload')}
                  resumeDownloadAriaLabel={t('detail.resumeDownload')}
                  downloadFailedLabel={t('queue.downloadFailed')}
                  onResumeDownload={() => {
                    void handleResumeDownload(epKey);
                  }}
                  isCurrent={isCurrent}
                  isPlaying={isPlaying}
                  draggingIdx={draggingIdx}
                  dropTargetIdx={dropTargetIdx}
                  dragDeltaY={dragDeltaY}
                  dragRowHeight={dragRowHeight}
                  dragHandleLabel={`${t('queue.dragHandle')} ${r.episode.title}`}
                  dragHandleTitle={t('queue.dragHandle')}
                  swipeLeftHintLabel={t('queue.swipeHintRemove')}
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
                  onContext={(x, y) => {
                    clearTextSelection();
                    setActiveContextMenu({ idx, x, y });
                  }}
                  onSwipeLeftRemove={() => {
                    void handleSwipeRemoveWithInlineUndo(idx);
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
              </Fragment>
            );
          })}
          {pendingUndo && pendingUndo.idx >= rows.length && (
            <div
              className="m-inline-undo"
              role="status"
              aria-live="polite"
              data-testid={`inline-undo-${pendingUndo.epKey}`}
              data-queue-undo-idx={pendingUndo.idx}
            >
              <span className="m-inline-undo__text">
                {t('queue.removedSnack', { title: pendingUndo.title })}
              </span>
              <button
                type="button"
                className="m-inline-undo__btn"
                data-testid={`inline-undo-btn-${pendingUndo.epKey}`}
                onClick={() => {
                  void handleRunInlineUndo();
                }}
              >
                {t('common.undo')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <ContextMenu
        open={activeContextMenu !== null && contextMenuItems.length > 0}
        x={activeContextMenu?.x ?? 0}
        y={activeContextMenu?.y ?? 0}
        onClose={() => setActiveContextMenu(null)}
        items={contextMenuItems}
        testId="queue-context-menu"
      />

      <BottomSheet
        open={detailsEpisodeKey !== null}
        onClose={closeDetails}
        title={t('detail.viewDetails')}
        testId="episode-detail-sheet"
      >
        {detailsSheet && (
          <div
            style={{
              padding: '16px 20px calc(24px + var(--m-safe-bottom))',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, font: 'var(--md-sys-typescale-title-medium)' }}>
                {t('detail.viewDetails')}
              </h2>
              <IconButton
                icon="close"
                label={t('common.close')}
                data-testid={`ep-detail-close-${detailsSheet.epKey}`}
                onClick={closeDetails}
              />
            </div>

            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 'var(--md-sys-shape-corner-medium)',
                  overflow: 'hidden',
                  background: 'var(--md-sys-color-surface-container-high)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                  display: 'grid',
                  placeItems: 'center',
                  flex: 'none',
                }}
              >
                <ArtworkImage
                  src={detailsSheet.primaryCoverUrl}
                  fallbackSrc={detailsSheet.feedCoverUrl}
                  allowProxyFallback={allowProxy}
                  style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }}
                  placeholder={<Icon name="podcasts" size={28} />}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{
                    font: 'var(--md-sys-typescale-title-medium)',
                    color: 'var(--md-sys-color-on-surface)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {detailsSheet.episode.title}
                </div>
                {detailsSheet.podcastName && (
                  <div
                    style={{
                      font: 'var(--md-sys-typescale-body-medium)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    {detailsSheet.podcastName}
                  </div>
                )}
                {(detailsSheet.dateStr || detailsSheet.remStr) && (
                  <div className="m-episode-row__meta">
                    {detailsSheet.dateStr && <span>{detailsSheet.dateStr}</span>}
                    {detailsSheet.dateStr && detailsSheet.remStr && <span>·</span>}
                    {detailsSheet.remStr && <span>{detailsSheet.remStr}</span>}
                  </div>
                )}
                <DetailDownloadStatus
                  state={
                    detailsSheet.isDownloadQueued
                      ? 'queued'
                      : detailsSheet.isDownloading
                        ? 'downloading'
                        : detailsSheet.isDownloadFailed
                        ? 'failed'
                        : null
                  }
                  ratio={detailsSheet.downloadRatio}
                  downloadingLabel={t('detail.downloadingProgress', {
                    percent: detailsSheet.downloadPercent,
                  })}
                  queuedLabel={t('detail.downloadWaiting')}
                  failedLabel={t('queue.downloadFailed')}
                  testId={`ep-detail-download-status-${detailsSheet.epKey}`}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button
                variant="filled"
                icon={detailsSheet.isPlaying ? 'pause' : 'play'}
                data-testid={`ep-detail-play-${detailsSheet.epKey}`}
                onClick={() => {
                  handleDetailsPlayToggle();
                }}
              >
                {detailsSheet.isPlaying ? t('detail.pause') : t('detail.play')}
              </Button>
              <Button
                variant="tonal"
                icon={detailsSheet.inQueue ? 'queueMusic' : 'playlistAdd'}
                data-testid={`ep-detail-queue-${detailsSheet.epKey}`}
                onClick={() => {
                  void handleDetailsToggleQueue();
                }}
              >
                {detailsSheet.inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue')}
              </Button>
              {detailsSheet.isDownloadFailed && (
                <Button
                  variant="tonal"
                  icon="download"
                  data-testid={`ep-detail-resume-download-${detailsSheet.epKey}`}
                  onClick={() => {
                    void handleResumeDownload(detailsSheet.epKey);
                  }}
                >
                  {t('detail.resumeDownload')}
                </Button>
              )}
              {detailsSheet.isDownloading && (
                <Button
                  variant="tonal"
                  icon="stop"
                  data-testid={`ep-detail-stop-download-${detailsSheet.epKey}`}
                  onClick={() => {
                    void handleStopDownload(detailsSheet.epKey);
                  }}
                >
                  {t('detail.stopDownload')}
                </Button>
              )}
              {detailsSheet.feed && (
                <Button
                  variant="outlined"
                  icon="podcasts"
                  data-testid={`ep-open-podcast-${detailsSheet.epKey}`}
                  onClick={() => {
                    const feedKey = detailsSheet.episode.feedKey;
                    closeDetails();
                    openPodcastDetail(feedKey);
                  }}
                >
                  {t('detail.goToPodcast')}
                </Button>
              )}
              {detailsSheet.isAudioOnlyVideo && detailsSheet.episode.enclosureUrl && (
                <Button
                  variant="outlined"
                  icon="openExternal"
                  data-testid={`ep-open-video-${detailsSheet.epKey}`}
                  onClick={() => {
                    if (detailsSheet.episode.enclosureUrl) {
                      void host.files.openExternal(detailsSheet.episode.enclosureUrl);
                    }
                  }}
                >
                  {t('detail.openInVideoPlayer')}
                </Button>
              )}
            </div>

            <div
              style={{
                borderTop: '1px solid var(--md-sys-color-outline-variant)',
                paddingTop: 12,
              }}
            >
              {detailsSheet.shownotesHtml ? (
                <div
                  className="m-shownotes"
                  data-testid={`ep-detail-shownotes-${detailsSheet.epKey}`}
                  onClick={(e) => {
                    const target = (e.target as HTMLElement | null)?.closest?.('a');
                    if (target && host.info.capabilities.openExternal) {
                      const href = target.getAttribute('href');
                      if (href && /^https?:\/\//i.test(href)) {
                        e.preventDefault();
                        void host.files.openExternal(href);
                      }
                    }
                  }}
                  // Safe: `sanitizeShownotesHtml` strips scripts/styles/iframes/handlers and whitelists benign tags
                  dangerouslySetInnerHTML={{ __html: detailsSheet.shownotesHtml }}
                />
              ) : (
                <div
                  className="m-empty"
                  style={{ padding: '20px 12px' }}
                  data-testid={`ep-detail-shownotes-${detailsSheet.epKey}`}
                >
                  {t('player.noShownotes')}
                </div>
              )}
            </div>
          </div>
        )}
      </BottomSheet>
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
  downloadProgress,
  cachedLabel,
  cachingLabel,
  waitingLabel,
  stopDownloadLabel,
  onStopDownload,
  canResumeDownload,
  resumeDownloadLabel,
  resumeDownloadAriaLabel,
  downloadFailedLabel,
  onResumeDownload,
  isCurrent,
  isPlaying,
  draggingIdx,
  dropTargetIdx,
  dragDeltaY,
  dragRowHeight,
  dragHandleLabel,
  dragHandleTitle,
  swipeLeftHintLabel,
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
  readonly downloadProgress?: number | undefined;
  readonly cachedLabel: string;
  readonly cachingLabel: string;
  /** `等待中` label shown instead of `{percent}%` while `QUEUED` (waiting for a download slot). */
  readonly waitingLabel: string;
  readonly stopDownloadLabel: string;
  readonly onStopDownload: () => void;
  readonly canResumeDownload: boolean;
  readonly resumeDownloadLabel: string;
  readonly resumeDownloadAriaLabel: string;
  readonly downloadFailedLabel: string;
  readonly onResumeDownload: () => void;
  readonly isCurrent: boolean;
  readonly isPlaying: boolean;
  readonly draggingIdx: number | null;
  readonly dropTargetIdx: number | null;
  readonly dragDeltaY: number;
  readonly dragRowHeight: number;
  readonly dragHandleLabel: string;
  readonly dragHandleTitle: string;
  readonly swipeLeftHintLabel: string;
  readonly onPlay: () => void;
  readonly onContext: (x: number, y: number) => void;
  readonly onSwipeLeftRemove: () => void;
  readonly onMoveIndex: (from: number, to: number) => void;
  readonly onSetDragging: (idx: number | null) => void;
  readonly onSetDropTarget: (idx: number | null) => void;
  readonly onStartHandleDrag: (idx: number, pointerId: number | null, clientY: number) => void;
  readonly onUpdateHandleDrag: (pointerId: number | null, clientY: number) => void;
  readonly onFinishHandleDrag: (
    pointerId: number | null,
    clientY: number | undefined,
    cancelled: boolean,
  ) => void;
}) {
  const epKey = row.episode.episodeKey;
  const { swipeOffsetX, swipeDirection, swipeArmed, handlers } = useRowGestures({
    onTap: onPlay,
    onContext,
    onSwipeLeft: onSwipeLeftRemove,
  });

  const isDragging = draggingIdx === idx;
  const isAnyDragging = draggingIdx !== null;
  const isDropTarget = dropTargetIdx === idx && draggingIdx !== null && draggingIdx !== idx;
  const dlState = row.episode.downloadState;
  const isCacheDone = dlState === 'DONE';
  const isCacheDownloading = dlState === 'RUNNING' || dlState === 'QUEUED';
  const isCacheQueued = dlState === 'QUEUED';
  const isCacheFailed = dlState === 'FAILED' && canResumeDownload;
  const progressRatio = Math.max(0, Math.min(1, downloadProgress ?? 0));
  const progressPercent = downloadRatioToPercent(progressRatio);

  let shiftY = 0;
  if (
    draggingIdx !== null &&
    dropTargetIdx !== null &&
    idx !== draggingIdx &&
    draggingIdx !== dropTargetIdx
  ) {
    if (draggingIdx < dropTargetIdx && idx > draggingIdx && idx <= dropTargetIdx) {
      shiftY = -dragRowHeight;
    } else if (draggingIdx > dropTargetIdx && idx >= dropTargetIdx && idx < draggingIdx) {
      shiftY = dragRowHeight;
    }
  }

  const roundedDragDeltaY = isDragging ? Math.round(dragDeltaY) : 0;

  let rowStyle: CSSProperties | undefined;
  if (isDragging) {
    rowStyle = {
      transform: `translate3d(0, ${roundedDragDeltaY}px, 0) scale(1.015)`,
      opacity: 1,
      zIndex: 30,
      position: 'relative',
      boxShadow: 'var(--md-sys-elevation-3)',
      background: 'var(--md-sys-color-surface-container-high)',
      transition: 'box-shadow 120ms ease, background-color 120ms ease',
    };
  } else if (isAnyDragging) {
    rowStyle = {
      transform: `translate3d(0, ${shiftY}px, 0)`,
      zIndex: 1,
      position: 'relative',
      transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)',
    };
  } else if (swipeOffsetX !== 0) {
    rowStyle = {
      transform: `translateX(${swipeOffsetX}px)`,
      transition: 'none',
    };
  }

  return (
    <div
      className={cx(
        'm-swipe-container',
        isAnyDragging && 'is-drag-active',
        isDragging && 'is-dragging-container',
      )}
      style={
        isDragging
          ? { overflow: 'visible', zIndex: 30 }
          : isAnyDragging
            ? { overflow: 'visible', zIndex: 1 }
            : undefined
      }
    >
      {swipeDirection === 'left' && !isAnyDragging && (
        <div
          aria-hidden="true"
          className={cx(
            'm-swipe-hint',
            'm-swipe-hint--left',
            'm-swipe-hint--danger',
            swipeArmed && 'is-armed',
          )}
          data-testid={`swipe-hint-left-${epKey}`}
          data-swipe-armed={swipeArmed ? 'true' : 'false'}
        >
          <Icon name="delete" size={18} />
          <span>{swipeLeftHintLabel}</span>
        </div>
      )}

      <div
        className={cx(
          'm-queue-row',
          isCurrent && 'is-current',
          isPlaying && 'is-playing',
          isDragging && 'is-dragging',
          isDropTarget && 'is-drop-target',
          shiftY !== 0 && 'is-shifted',
        )}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-label={row.episode.title}
        data-testid={`queue-row-${idx}`}
        data-queue-idx={idx}
        data-episode-key={epKey}
        data-drag-offset-y={roundedDragDeltaY}
        data-shift-y={shiftY}
        style={rowStyle}
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
            onStartHandleDrag(idx, e.pointerId, e.clientY);
          }}
          onPointerMove={(e) => {
            e.stopPropagation();
            onUpdateHandleDrag(e.pointerId, e.clientY);
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            try {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            } catch {
              // ignore
            }
            onFinishHandleDrag(e.pointerId, e.clientY, false);
          }}
          onPointerCancel={(e) => {
            e.stopPropagation();
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
              const touch = e.touches[0];
              onStartHandleDrag(idx, null, touch?.clientY ?? 0);
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
          onTouchCancel={(e) => {
            e.stopPropagation();
            onFinishHandleDrag(null, undefined, true);
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
          {(dateStr || remStr || isCacheDone || isCacheDownloading || isCacheFailed) && (
            <div className="m-episode-row__meta">
              {dateStr && <span>{dateStr}</span>}
              {dateStr && remStr && <span>·</span>}
              {remStr && <span>{remStr}</span>}
              {isCacheDone && (
                <span
                  className="m-queue-cache-status is-done"
                  role="img"
                  aria-label={cachedLabel}
                  title={cachedLabel}
                  data-testid={`queue-cache-status-${epKey}`}
                  data-cache-state="done"
                >
                  <Icon name="check" size={14} />
                </span>
              )}
              {isCacheDownloading && (
                <span
                  className={cx(
                    'm-queue-cache-status is-downloading',
                    isCacheQueued && 'is-queued',
                  )}
                  role="button"
                  tabIndex={0}
                  aria-label={stopDownloadLabel}
                  title={`${isCacheQueued ? waitingLabel : cachingLabel} · ${stopDownloadLabel}`}
                  data-testid={`queue-cache-status-${epKey}`}
                  data-cache-state="downloading"
                  data-download-phase={isCacheQueued ? 'queued' : 'running'}
                  data-cache-progress={progressPercent}
                  style={{ cursor: 'pointer' }}
                  {...inlineRowActionProps(onStopDownload)}
                >
                  {isCacheQueued ? (
                    <DownloadWaitingText
                      label={waitingLabel}
                      testId={`queue-cache-waiting-${epKey}`}
                    />
                  ) : (
                    <DownloadPercentText
                      percent={progressPercent}
                      testId={`queue-cache-percent-${epKey}`}
                    />
                  )}
                  <DownloadProgressRing ratio={progressRatio} withStop waiting={isCacheQueued} />
                </span>
              )}
              {isCacheFailed && (
                <ResumeDownloadChip
                  label={resumeDownloadLabel}
                  ariaLabel={resumeDownloadAriaLabel}
                  title={`${downloadFailedLabel} · ${resumeDownloadAriaLabel}`}
                  testId={`queue-resume-download-${epKey}`}
                  onResume={onResumeDownload}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
