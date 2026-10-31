/**
 * Minimalist gesture-driven episode row (`v0.1.8`):
 * - Strictly 4 visual elements: `44×44` cover icon, 2-line clamped title, publish date, and remaining time
 * - Zero inline action buttons
 * - Tap / click directly plays (or toggles pause if current)
 * - Long-press (~450ms) / right-click / keyboard (`ContextMenu` / `Shift+F10`) opens viewport-clamped `<ContextMenu>`
 * - Swipe left (`deltaX < -64px`): Play next (`queue.playNext`) + in-place row Undo (no bottom snackbar)
 * - Swipe right (`deltaX > +64px`): Mark played (`progress.markPlayed(key, true)`) & remove + in-place row Undo (no bottom snackbar)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeKey, EpisodeRow as EpisodeRowModel } from '@minipod/core';
import {
  ArtworkImage,
  ContextMenu,
  cx,
  Icon,
  shouldUseImageProxy,
  type IconName,
  type MenuEntry,
} from '../../components/m3';
import { useRowGestures } from '../../hooks/useRowGestures';
import { useHost } from '../../host/HostContext';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar, useSnackbarStore } from '../../stores/snackbar';

type InlineUndoState =
  | { readonly kind: 'play-next' }
  | { readonly kind: 'marked-played'; readonly wasInQueue: boolean };

export interface EpisodeRowProps {
  readonly row: EpisodeRowModel;
  readonly feedTitle?: string | undefined;
  readonly feedImageUrl?: string | undefined;
  readonly allowDownloads: boolean;
  readonly showPodcastInfo?: boolean | undefined;
  readonly onOpenPodcast?: (() => void) | undefined;
  readonly onStartInlineRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onUndoRemove?: ((episodeKey: EpisodeKey) => void) | undefined;
  readonly onSwipeLeftOverride?: (() => void) | undefined;
  readonly swipeLeftHintLabel?: string | undefined;
  readonly swipeLeftHintIcon?: IconName | undefined;
  readonly swipeLeftHintTone?: 'primary' | 'danger' | undefined;
  readonly onChanged: () => void;
}

export function EpisodeRow({
  row,
  feedTitle,
  feedImageUrl,
  allowDownloads,
  onOpenPodcast,
  onStartInlineRemove,
  onRemove,
  onUndoRemove,
  onSwipeLeftOverride,
  swipeLeftHintLabel,
  swipeLeftHintIcon,
  swipeLeftHintTone,
  onChanged,
}: EpisodeRowProps) {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();
  const allowProxy = shouldUseImageProxy(host.info.platform);

  const [ctxPos, setCtxPos] = useState<{ readonly x: number; readonly y: number } | null>(null);
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
  const isPlaying = isCurrent && player.snapshot.playing;
  const isPlayed = progress?.state === 'PLAYED';
  const positionMs = isCurrent ? player.snapshot.positionMs : (progress?.positionMs ?? 0);
  const durationMs =
    (isCurrent ? player.snapshot.durationMs : undefined) ?? progress?.durationMs ?? episode.durationMs;

  const isAudioOnlyVideo = episode.mediaType === 'VIDEO' && !player.engine.capabilities.video;
  const isDownloading = episode.downloadState === 'RUNNING' || episode.downloadState === 'QUEUED';

  const handlePlayToggle = () => {
    if (isCurrent) {
      void player.togglePlayPause();
    } else {
      void player.playEpisode(episode, { feedTitle, feedImageUrl });
    }
  };

  const handlePlayNextWithUndo = async () => {
    await host.queue.playNext(episode.episodeKey);
    onChanged();
    showSnackbar(t('detail.addedPlayNext'), {
      action: {
        label: t('common.undo'),
        run: () => {
          void host.queue.remove(episode.episodeKey).then(onChanged);
        },
      },
    });
  };

  const handleAddQueueWithUndo = async () => {
    await host.queue.add(episode.episodeKey);
    onChanged();
    showSnackbar(t('detail.addedToQueue'), {
      action: {
        label: t('common.undo'),
        run: () => {
          void host.queue.remove(episode.episodeKey).then(onChanged);
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

  const handleDownloadToggle = async () => {
    if (episode.downloadState === 'DONE') {
      await host.episodes.deleteDownload(episode.episodeKey);
    } else if (episode.downloadState === 'NONE' || episode.downloadState === 'FAILED') {
      await host.episodes.download(episode.episodeKey);
    }
    onChanged();
  };

  const handleMarkPlayedAndRemove = async () => {
    const wasInQueue = inQueue;
    onRemove?.(episode.episodeKey);
    await host.progress.markPlayed(episode.episodeKey, true);
    if (wasInQueue) {
      await host.queue.remove(episode.episodeKey);
    }
    onChanged();
    showSnackbar(t('detail.markedPlayedRemovedSnack'), {
      action: {
        label: t('common.undo'),
        run: () => {
          void (async () => {
            await host.progress.markPlayed(episode.episodeKey, false);
            if (wasInQueue) {
              await host.queue.add(episode.episodeKey);
            }
            onUndoRemove?.(episode.episodeKey);
            onChanged();
          })();
        },
      },
    });
  };

  const handleSwipePlayNext = async () => {
    useSnackbarStore.getState().clear();
    clearInlineUndoTimer();
    await host.queue.playNext(episode.episodeKey);
    onChanged();
    setInlineUndo({ kind: 'play-next' });
    inlineUndoTimerRef.current = setTimeout(() => {
      inlineUndoTimerRef.current = null;
      setInlineUndo(null);
    }, 4000);
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

  const menuItems: MenuEntry[] = [
    {
      key: 'play-next',
      label: t('detail.playNext'),
      icon: 'playlistAdd',
      testId: `ep-play-next-${episode.episodeKey}`,
      onSelect: () => {
        void handlePlayNextWithUndo();
      },
    },
    {
      key: 'toggle-queue',
      label: inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue'),
      icon: inQueue ? 'queueMusic' : 'playlistAdd',
      testId: `ep-queue-btn-${episode.episodeKey}`,
      onSelect: () => {
        void handleToggleQueue();
      },
    },
    ...(allowDownloads
      ? [
          {
            key: 'download',
            label:
              episode.downloadState === 'DONE'
                ? t('detail.deleteDownload')
                : isDownloading
                  ? t('detail.downloading')
                  : t('detail.download'),
            icon: (episode.downloadState === 'DONE' ? 'downloaded' : 'download') as
              | 'downloaded'
              | 'download',
            disabled: isDownloading,
            testId: `ep-download-${episode.episodeKey}`,
            onSelect: () => {
              void handleDownloadToggle();
            },
          },
        ]
      : []),
    {
      key: 'mark-played',
      label: isPlayed ? t('detail.markUnplayed') : t('detail.markPlayed'),
      icon: 'check',
      testId: `ep-mark-played-${episode.episodeKey}`,
      onSelect: () => {
        void host.progress.markPlayed(episode.episodeKey, !isPlayed).then(onChanged);
      },
    },
    ...(onOpenPodcast
      ? [
          {
            key: 'open-podcast',
            label: t('detail.goToPodcast'),
            icon: 'podcasts' as const,
            testId: `ep-open-podcast-${episode.episodeKey}`,
            onSelect: () => {
              onOpenPodcast();
            },
          },
        ]
      : []),
    ...(isAudioOnlyVideo && episode.enclosureUrl
      ? [
          {
            key: 'open-video',
            label: t('detail.openInVideoPlayer'),
            icon: 'openExternal' as const,
            testId: `ep-open-video-${episode.episodeKey}`,
            onSelect: () => {
              if (episode.enclosureUrl) {
                void host.files.openExternal(episode.enclosureUrl);
              }
            },
          },
        ]
      : []),
  ];

  const dateStr = formatShortDate(episode.pubDate, locale);
  const remStr =
    !isPlayed && durationMs && positionMs > 0 && durationMs > positionMs
      ? t('detail.timeLeft', { time: formatHumanDuration(durationMs - positionMs) })
      : durationMs
        ? formatHumanDuration(durationMs)
        : '';

  return (
    <>
      {inlineUndo?.kind === 'marked-played' ? (
        <div
          className="m-inline-undo"
          role="status"
          aria-live="polite"
          data-testid={`inline-undo-${episode.episodeKey}`}
        >
          <span className="m-inline-undo__text">{t('detail.markedPlayedRemovedSnack')}</span>
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
              {(dateStr || remStr) && (
                <div className="m-episode-row__meta">
                  {dateStr && <span>{dateStr}</span>}
                  {dateStr && remStr && <span>·</span>}
                  {remStr && <span>{remStr}</span>}
                </div>
              )}
            </div>
          </div>
          {inlineUndo?.kind === 'play-next' && (
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

      <ContextMenu
        open={ctxPos !== null}
        x={ctxPos?.x ?? 0}
        y={ctxPos?.y ?? 0}
        onClose={() => setCtxPos(null)}
        items={menuItems}
        testId="ep-context-menu"
      />
    </>
  );
}
