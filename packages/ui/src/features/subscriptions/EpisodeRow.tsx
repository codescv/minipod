/**
 * Minimalist gesture-driven episode row (`v0.1.8`):
 * - Strictly 4 visual elements: `44×44` cover icon, 2-line clamped title, publish date, and remaining time
 *   (plus, only while relevant, a `{percent}%` download badge or a `继续下载` pill for FAILED downloads)
 * - Zero inline action buttons
 * - Tap / click directly plays (or toggles pause if current)
 * - Long-press (~450ms) / right-click / keyboard (`ContextMenu` / `Shift+F10`) opens viewport-clamped `<ContextMenu>`
 * - Swipe left (`deltaX < -64px`): Play next (`queue.playNext`) + in-place row Undo (no bottom snackbar)
 * - Swipe right (`deltaX > +64px`): Mark played (`progress.markPlayed(key, true)`) & remove + in-place row Undo (no bottom snackbar)
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeKey, EpisodeRow as EpisodeRowModel } from '@minipod/core';
import {
  ArtworkImage,
  BottomSheet,
  Button,
  ContextMenu,
  cx,
  Icon,
  IconButton,
  shouldUseImageProxy,
  type IconName,
  type MenuEntry,
} from '../../components/m3';
import {
  DetailDownloadStatus,
  DownloadPercentText,
  DownloadProgressRing,
  DownloadWaitingText,
  ResumeDownloadChip,
  inlineRowActionProps,
} from '../../components/DownloadControls';
import { useEpisodeDownloadStatus } from '../../hooks/useEpisodeDownloadStatus';
import { useRowGestures } from '../../hooks/useRowGestures';
import { useHost } from '../../host/HostContext';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate, sanitizeShownotesHtml } from '../../lib/format';
import { usePlayerLivePositionMs, usePlayerState } from '../../player/usePlayer';
import { showSnackbar, useSnackbarStore } from '../../stores/snackbar';
import {
  clearDownloadStop,
  downloadRatioToPercent,
  endDownloadStop,
} from '../../stores/view-cache';

type InlineUndoState =
  | { readonly kind: 'play-next' }
  | { readonly kind: 'marked-played'; readonly wasInQueue: boolean };

export interface EpisodeRowProps {
  readonly row: EpisodeRowModel;
  readonly feedTitle?: string | undefined;
  readonly feedImageUrl?: string | undefined;
  readonly allowDownloads: boolean;
  readonly showPodcastInfo?: boolean | undefined;
  readonly removeWhenQueued?: boolean | undefined;
  readonly onOpenPodcast?: (() => void) | undefined;
  readonly onStartInlineRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onUndoRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onSwipeLeftOverride?: (() => void) | undefined;
  readonly swipeLeftHintLabel?: string | undefined;
  readonly swipeLeftHintIcon?: IconName | undefined;
  readonly swipeLeftHintTone?: 'primary' | 'danger' | undefined;
  /**
   * v0.1.24 Manage Downloads mode: when set, the long-press `ep-context-menu` shows
   * `Delete download` (`ep-delete-download-*`) + `View details` instead of the queue toggle.
   */
  readonly onDeleteDownload?: (() => void) | undefined;
  readonly onChanged: () => void;
}

export const EpisodeRow = memo(function EpisodeRow({
  row,
  feedTitle,
  feedImageUrl,
  allowDownloads,
  removeWhenQueued,
  onOpenPodcast,
  onStartInlineRemove,
  onRemove,
  onUndoRemove,
  onSwipeLeftOverride,
  swipeLeftHintLabel,
  swipeLeftHintIcon,
  swipeLeftHintTone,
  onDeleteDownload,
  onChanged,
}: EpisodeRowProps) {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  // Low-frequency player state: rows never re-render on playback position ticks (only the
  // current episode's row subscribes to the live position for its "time left" label).
  const player = usePlayerState();
  const allowProxy = shouldUseImageProxy(host.info.platform);

  const [ctxPos, setCtxPos] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inlineUndo, setInlineUndo] = useState<InlineUndoState | null>(null);
  const inlineUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInlineUndoTimer = useCallback(() => {
    if (inlineUndoTimerRef.current !== null) {
      clearTimeout(inlineUndoTimerRef.current);
      inlineUndoTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearInlineUndoTimer, [clearInlineUndoTimer]);

  const { episode, progress, inQueue } = row;
  const isCurrent = player.episode?.episodeKey === episode.episodeKey;
  const isPlaying = isCurrent && player.playing;
  const isPlayed = progress?.state === 'PLAYED';
  const livePositionMs = usePlayerLivePositionMs(isCurrent);
  const positionMs = isCurrent ? (livePositionMs ?? 0) : (progress?.positionMs ?? 0);
  const durationMs =
    (isCurrent ? player.durationMs : undefined) ?? progress?.durationMs ?? episode.durationMs;

  const isAudioOnlyVideo = episode.mediaType === 'VIDEO' && !player.engine.capabilities.video;

  const {
    state: downloadState,
    ratio: downloadRatio,
    markStopped: markDownloadStopped,
  } = useEpisodeDownloadStatus(
    episode.episodeKey,
    episode.downloadState,
  );
  const canDownloadEpisode =
    allowDownloads &&
    Boolean(host.info.capabilities.downloads) &&
    !episode.feedKey.startsWith('l_') &&
    Boolean(episode.enclosureUrl) &&
    !episode.enclosureUrl?.startsWith('content://');
  const isDownloading =
    canDownloadEpisode && (downloadState === 'RUNNING' || downloadState === 'QUEUED');
  /** `QUEUED`: waiting for one of the host's 3 concurrent download slots. */
  const isDownloadQueued = isDownloading && downloadState === 'QUEUED';
  const isDownloadFailed = canDownloadEpisode && downloadState === 'FAILED';
  const downloadPercent = downloadRatioToPercent(downloadRatio);
  const stopGenerationRef = useRef(0);

  /** `继续下载`: resumes the failed `.part` (HTTP `Range`); a repeated failure shows `下载失败`. */
  const handleResumeDownload = async () => {
    clearDownloadStop(host, episode.episodeKey);
    const stopGeneration = stopGenerationRef.current;
    try {
      await host.episodes.download(episode.episodeKey);
    } catch {
      // A download the user stopped meanwhile is not a failure.
      if (stopGenerationRef.current !== stopGeneration) return;
      showSnackbar(t('queue.downloadFailed'));
    } finally {
      onChanged();
    }
  };

  /**
   * `停止下载` (also for a `QUEUED` download): flips the row to NONE at once and guards it against
   * stale `download-updated` events / snapshots until the host processed the stop.
   */
  const handleStopDownload = async () => {
    stopGenerationRef.current += 1;
    markDownloadStopped();
    try {
      await host.episodes.deleteDownload(episode.episodeKey);
    } catch {
      // ignore: the next revalidation shows the real state
    } finally {
      endDownloadStop(host, episode.episodeKey);
      onChanged();
    }
  };

  const handlePlayToggle = () => {
    if (isCurrent) {
      void player.togglePlayPause();
    } else {
      if (removeWhenQueued) {
        onRemove?.(episode.episodeKey);
      }
      void player.playEpisode(episode, { feedTitle, feedImageUrl });
    }
  };

  const handleAddQueueWithUndo = async () => {
    if (removeWhenQueued) {
      onRemove?.(episode.episodeKey);
    }
    await host.queue.add(episode.episodeKey);
    onChanged();
    showSnackbar(t('detail.addedToQueue'), {
      action: {
        label: t('common.undo'),
        run: () => {
          void (async () => {
            await host.queue.remove(episode.episodeKey);
            if (removeWhenQueued) {
              onUndoRemove?.(episode.episodeKey);
            }
            onChanged();
          })();
        },
      },
    });
  };

  const handleToggleQueue = async () => {
    if (inQueue) {
      await host.queue.remove(episode.episodeKey);
      onChanged();
    } else {
      await handleAddQueueWithUndo();
    }
  };

  const handleSwipePlayNext = async () => {
    useSnackbarStore.getState().clear();
    clearInlineUndoTimer();
    if (removeWhenQueued) {
      onStartInlineRemove?.(episode.episodeKey);
    }
    setInlineUndo({ kind: 'play-next' });
    inlineUndoTimerRef.current = setTimeout(() => {
      inlineUndoTimerRef.current = null;
      setInlineUndo(null);
      if (removeWhenQueued) {
        onRemove?.(episode.episodeKey);
      }
    }, 4000);
    await host.queue.playNext(episode.episodeKey);
    onChanged();
  };

  const handleSwipeMarkPlayedAndRemove = async () => {
    useSnackbarStore.getState().clear();
    clearInlineUndoTimer();
    const wasInQueue = inQueue;
    onStartInlineRemove?.(episode.episodeKey);
    setInlineUndo({ kind: 'marked-played', wasInQueue });
    inlineUndoTimerRef.current = setTimeout(() => {
      inlineUndoTimerRef.current = null;
      setInlineUndo(null);
      onRemove?.(episode.episodeKey);
    }, 4500);
    await host.progress.markPlayed(episode.episodeKey, true);
    if (wasInQueue) {
      await host.queue.remove(episode.episodeKey);
    }
    onChanged();
  };

  const handleRunInlineUndo = async () => {
    const currentUndo = inlineUndo;
    if (!currentUndo) return;
    clearInlineUndoTimer();
    setInlineUndo(null);
    if (currentUndo.kind === 'play-next') {
      await host.queue.remove(episode.episodeKey);
      onUndoRemove?.(episode.episodeKey);
      onChanged();
    } else {
      await host.progress.markPlayed(episode.episodeKey, false);
      if (currentUndo.wasInQueue) {
        await host.queue.add(episode.episodeKey);
      }
      onUndoRemove?.(episode.episodeKey);
      onChanged();
    }
  };

  const { swipeOffsetX, swipeDirection, swipeArmed, handlers } = useRowGestures({
    onTap: handlePlayToggle,
    onContext: (x, y) => setCtxPos({ x, y }),
    onSwipeLeft: () => {
      if (onSwipeLeftOverride) {
        useSnackbarStore.getState().clear();
        onSwipeLeftOverride();
      } else {
        void handleSwipePlayNext();
      }
    },
    onSwipeRight: () => {
      void handleSwipeMarkPlayedAndRemove();
    },
  });

  const leftHintLabel = swipeLeftHintLabel ?? t('detail.swipeHintPlayNext');
  const leftHintIcon: IconName = swipeLeftHintIcon ?? 'playlistAdd';
  const leftHintTone = swipeLeftHintTone ?? 'primary';

  // Only built while the context menu is open (avoids per-row allocations on every render).
  const buildMenuItems = (): MenuEntry[] => {
    const viewDetailsItem: MenuEntry = {
      key: 'view-details',
      label: t('detail.viewDetails'),
      icon: 'shownotes',
      testId: `ep-view-details-${episode.episodeKey}`,
      onSelect: () => {
        setDetailsOpen(true);
      },
    };
    const menuItems: MenuEntry[] = onDeleteDownload
      ? [
          {
            key: 'delete-download',
            label: t('detail.deleteDownload'),
            icon: 'delete',
            testId: `ep-delete-download-${episode.episodeKey}`,
            onSelect: () => {
              onDeleteDownload();
            },
          },
          viewDetailsItem,
        ]
      : [
          {
            key: 'toggle-queue',
            label: inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue'),
            icon: inQueue ? 'queueMusic' : 'playlistAdd',
            testId: `ep-queue-btn-${episode.episodeKey}`,
            onSelect: () => {
              void handleToggleQueue();
            },
          },
          viewDetailsItem,
        ];
    return menuItems;
  };

  const dateStr = formatShortDate(episode.pubDate, locale);
  const remStr =
    !isPlayed && durationMs && positionMs > 0 && durationMs > positionMs
      ? t('detail.timeLeft', { time: formatHumanDuration(durationMs - positionMs) })
      : durationMs
        ? formatHumanDuration(durationMs)
        : '';
  const shownotesHtml = detailsOpen ? sanitizeShownotesHtml(episode.description) : '';

  return (
    <>
      {inlineUndo?.kind === 'marked-played' ||
      (inlineUndo?.kind === 'play-next' && removeWhenQueued) ? (
        <div
          className="m-inline-undo"
          role="status"
          aria-live="polite"
          data-testid={`inline-undo-${episode.episodeKey}`}
        >
          <span className="m-inline-undo__text">
            {inlineUndo.kind === 'marked-played'
              ? t('detail.markedPlayedRemovedSnack')
              : t('detail.addedPlayNext')}
          </span>
          <button
            type="button"
            className="m-inline-undo__btn"
            data-testid={`inline-undo-btn-${episode.episodeKey}`}
            onClick={() => {
              void handleRunInlineUndo();
            }}
          >
            {t('common.undo')}
          </button>
        </div>
      ) : (
        <div className="m-swipe-container">
          {swipeDirection === 'right' && (
            <div
              aria-hidden="true"
              className={cx('m-swipe-hint', 'm-swipe-hint--right', swipeArmed && 'is-armed')}
              data-testid={`swipe-hint-right-${episode.episodeKey}`}
              data-swipe-armed={swipeArmed ? 'true' : 'false'}
            >
              <Icon name="check" size={18} />
              <span>{t('detail.swipeHintMarkPlayed')}</span>
            </div>
          )}
          {swipeDirection === 'left' && (
            <div
              aria-hidden="true"
              className={cx(
                'm-swipe-hint',
                'm-swipe-hint--left',
                `m-swipe-hint--${leftHintTone}`,
                swipeArmed && 'is-armed',
              )}
              data-testid={`swipe-hint-left-${episode.episodeKey}`}
              data-swipe-armed={swipeArmed ? 'true' : 'false'}
            >
              <Icon name={leftHintIcon} size={18} />
              <span>{leftHintLabel}</span>
            </div>
          )}
          <div
            className={cx(
              'm-episode-row',
              isPlayed && 'is-played',
              isCurrent && 'is-current',
              isPlaying && 'is-playing',
            )}
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-label={episode.title}
            data-testid={`episode-row-${episode.episodeKey}`}
            style={
              swipeOffsetX !== 0
                ? { transform: `translateX(${swipeOffsetX}px)`, transition: 'none' }
                : undefined
            }
            {...handlers}
          >
            <div
              className="m-episode-row__thumb"
              data-testid={`ep-thumb-${episode.episodeKey}`}
            >
              <ArtworkImage
                src={episode.imageUrl}
                fallbackSrc={feedImageUrl}
                allowProxyFallback={allowProxy}
                className="m-episode-row__thumb-img"
                loading="lazy"
                draggable={false}
                placeholder={<Icon name="podcasts" size={20} />}
              />
            </div>

            <div className="m-episode-row__body">
              <div className="m-episode-row__title">{episode.title}</div>
              {(dateStr || remStr || isDownloading || isDownloadFailed) && (
                <div className="m-episode-row__meta">
                  {dateStr && <span>{dateStr}</span>}
                  {dateStr && remStr && <span>·</span>}
                  {remStr && <span>{remStr}</span>}
                  {isDownloading && (
                    <span
                      className={cx(
                        'm-queue-cache-status is-downloading',
                        isDownloadQueued && 'is-queued',
                      )}
                      role="button"
                      tabIndex={0}
                      aria-label={t('detail.stopDownload')}
                      title={`${isDownloadQueued ? t('queue.waiting') : t('queue.cachingProgress', { percent: downloadPercent })} · ${t('detail.stopDownload')}`}
                      data-testid={`ep-download-progress-${episode.episodeKey}`}
                      data-cache-state="downloading"
                      data-download-phase={isDownloadQueued ? 'queued' : 'running'}
                      data-cache-progress={downloadPercent}
                      style={{ cursor: 'pointer' }}
                      {...inlineRowActionProps(() => {
                        void handleStopDownload();
                      })}
                    >
                      {isDownloadQueued ? (
                        <DownloadWaitingText
                          label={t('queue.waiting')}
                          testId={`ep-download-waiting-${episode.episodeKey}`}
                        />
                      ) : (
                        <DownloadPercentText percent={downloadPercent} />
                      )}
                      <DownloadProgressRing
                        ratio={downloadRatio ?? 0}
                        withStop
                        waiting={isDownloadQueued}
                      />
                    </span>
                  )}
                  {isDownloadFailed && (
                    <ResumeDownloadChip
                      label={t('queue.resumeDownload')}
                      ariaLabel={t('detail.resumeDownload')}
                      title={`${t('queue.downloadFailed')} · ${t('detail.resumeDownload')}`}
                      testId={`ep-resume-download-${episode.episodeKey}`}
                      onResume={() => {
                        void handleResumeDownload();
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          {inlineUndo?.kind === 'play-next' && !removeWhenQueued && (
            <div
              className="m-inline-undo m-inline-undo--overlay"
              role="status"
              aria-live="polite"
              data-testid={`inline-undo-${episode.episodeKey}`}
            >
              <span className="m-inline-undo__text">{t('detail.addedPlayNext')}</span>
              <button
                type="button"
                className="m-inline-undo__btn"
                data-testid={`inline-undo-btn-${episode.episodeKey}`}
                onClick={() => {
                  void handleRunInlineUndo();
                }}
              >
                {t('common.undo')}
              </button>
            </div>
          )}
        </div>
      )}

      {ctxPos !== null && (
        <ContextMenu
          open
          x={ctxPos.x}
          y={ctxPos.y}
          onClose={() => setCtxPos(null)}
          items={buildMenuItems()}
          testId="ep-context-menu"
        />
      )}

      {detailsOpen && (
        <BottomSheet
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          title={t('detail.viewDetails')}
          testId="episode-detail-sheet"
        >
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
                data-testid={`ep-detail-close-${episode.episodeKey}`}
                onClick={() => setDetailsOpen(false)}
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
                  src={episode.imageUrl}
                  fallbackSrc={feedImageUrl}
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
                  {episode.title}
                </div>
                {feedTitle && (
                  <div
                    style={{
                      font: 'var(--md-sys-typescale-body-medium)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    {feedTitle}
                  </div>
                )}
                {(dateStr || remStr) && (
                  <div className="m-episode-row__meta">
                    {dateStr && <span>{dateStr}</span>}
                    {dateStr && remStr && <span>·</span>}
                    {remStr && <span>{remStr}</span>}
                  </div>
                )}
                <DetailDownloadStatus
                  state={
                    isDownloadQueued
                      ? 'queued'
                      : isDownloading
                        ? 'downloading'
                        : isDownloadFailed
                          ? 'failed'
                          : null
                  }
                  ratio={downloadRatio ?? 0}
                  downloadingLabel={t('detail.downloadingProgress', { percent: downloadPercent })}
                  queuedLabel={t('detail.downloadWaiting')}
                  failedLabel={t('queue.downloadFailed')}
                  testId={`ep-detail-download-status-${episode.episodeKey}`}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button
                variant="filled"
                icon={isPlaying ? 'pause' : 'play'}
                data-testid={`ep-detail-play-${episode.episodeKey}`}
                onClick={() => {
                  handlePlayToggle();
                }}
              >
                {isPlaying ? t('detail.pause') : t('detail.play')}
              </Button>
              <Button
                variant="tonal"
                icon={inQueue ? 'queueMusic' : 'playlistAdd'}
                data-testid={`ep-detail-queue-${episode.episodeKey}`}
                onClick={() => {
                  void handleToggleQueue();
                }}
              >
                {inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue')}
              </Button>
              {isDownloadFailed && (
                <Button
                  variant="tonal"
                  icon="download"
                  data-testid={`ep-detail-resume-download-${episode.episodeKey}`}
                  onClick={() => {
                    void handleResumeDownload();
                  }}
                >
                  {t('detail.resumeDownload')}
                </Button>
              )}
              {isDownloading && (
                <Button
                  variant="tonal"
                  icon="stop"
                  data-testid={`ep-detail-stop-download-${episode.episodeKey}`}
                  onClick={() => {
                    void handleStopDownload();
                  }}
                >
                  {t('detail.stopDownload')}
                </Button>
              )}
              {onOpenPodcast && (
                <Button
                  variant="outlined"
                  icon="podcasts"
                  data-testid={`ep-open-podcast-${episode.episodeKey}`}
                  onClick={() => {
                    setDetailsOpen(false);
                    onOpenPodcast();
                  }}
                >
                  {t('detail.goToPodcast')}
                </Button>
              )}
              {isAudioOnlyVideo && episode.enclosureUrl && (
                <Button
                  variant="outlined"
                  icon="openExternal"
                  data-testid={`ep-open-video-${episode.episodeKey}`}
                  onClick={() => {
                    if (episode.enclosureUrl) {
                      void host.files.openExternal(episode.enclosureUrl);
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
              {shownotesHtml ? (
                <div
                  className="m-shownotes"
                  data-testid={`ep-detail-shownotes-${episode.episodeKey}`}
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
                  dangerouslySetInnerHTML={{ __html: shownotesHtml }}
                />
              ) : (
                <div
                  className="m-empty"
                  style={{ padding: '20px 12px' }}
                  data-testid={`ep-detail-shownotes-${episode.episodeKey}`}
                >
                  {t('player.noShownotes')}
                </div>
              )}
            </div>
          </div>
        </BottomSheet>
      )}
    </>
  );
});
