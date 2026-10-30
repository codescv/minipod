/**
 * Episode row (`DESIGN.md` §4.3):
 * - Date · human duration · `✓` played · `Audio only` badge for video on audio-only engines
 * - Linear progress bar + remaining time when `IN_PROGRESS`
 * - Swipe-right to add to queue + Undo snackbar
 * - `▶/⏸` play button (long-press / context-menu -> Play next)
 * - `⬇` manual download / delete toggle
 * - `⋮` overflow: Play next, Add/Remove queue, Mark played/unplayed, Share link, Open in video player
 */
import { useRef } from 'react';
import type { EpisodeRow as EpisodeRowModel } from '@minipod/core';
import { cx, Icon, IconButton, Menu, type MenuEntry } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar } from '../../stores/snackbar';

export interface EpisodeRowProps {
  readonly row: EpisodeRowModel;
  readonly feedTitle?: string | undefined;
  readonly feedImageUrl?: string | undefined;
  readonly allowDownloads: boolean;
  readonly onChanged: () => void;
}

export function EpisodeRow({
  row,
  feedTitle,
  feedImageUrl,
  allowDownloads,
  onChanged,
}: EpisodeRowProps) {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();

  const { episode, progress, inQueue } = row;
  const isCurrent = player.episode?.episodeKey === episode.episodeKey;
  const isPlaying = isCurrent && player.snapshot.playing;
  const isPlayed = progress?.state === 'PLAYED';
  const positionMs = isCurrent ? player.snapshot.positionMs : (progress?.positionMs ?? 0);
  const durationMs =
    (isCurrent ? player.snapshot.durationMs : undefined) ?? progress?.durationMs ?? episode.durationMs;
  const showProgress = !isPlayed && positionMs > 0;
  const pct =
    durationMs && durationMs > 0 ? Math.min(100, Math.round((positionMs / durationMs) * 100)) : 0;
  const remainingText =
    durationMs && durationMs > positionMs
      ? formatHumanDuration(durationMs - positionMs)
      : '';
  const isAudioOnlyVideo = episode.mediaType === 'VIDEO' && !player.engine.capabilities.video;

  const swipeStartXRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  const handlePlayToggle = () => {
    if (isCurrent) {
      void player.togglePlayPause();
    } else {
      void player.playEpisode(episode, { feedTitle, feedImageUrl });
    }
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

  const handlePlayNext = async () => {
    await host.queue.playNext(episode.episodeKey);
    onChanged();
    showSnackbar(t('detail.addedPlayNext'));
  };

  const handleDownloadToggle = async () => {
    if (episode.downloadState === 'DONE') {
      await host.episodes.deleteDownload(episode.episodeKey);
    } else if (episode.downloadState === 'NONE' || episode.downloadState === 'FAILED') {
      await host.episodes.download(episode.episodeKey);
    }
    onChanged();
  };

  const handleShare = async () => {
    const shared = await host.episodes.share(episode.episodeKey);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shared.url);
      }
    } catch {
      // ignore
    }
    showSnackbar(t('common.copied'));
  };

  const menuItems: MenuEntry[] = [
    {
      key: 'play-next',
      label: t('detail.playNext'),
      icon: 'play',
      testId: `ep-play-next-${episode.episodeKey}`,
      onSelect: () => {
        void handlePlayNext();
      },
    },
    {
      key: 'toggle-queue',
      label: inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue'),
      icon: inQueue ? 'delete' : 'queue',
      testId: `ep-queue-toggle-${episode.episodeKey}`,
      onSelect: () => {
        if (inQueue) {
          void host.queue.remove(episode.episodeKey).then(onChanged);
        } else {
          void handleAddQueueWithUndo();
        }
      },
    },
    {
      key: 'mark-played',
      label: isPlayed ? t('detail.markUnplayed') : t('detail.markPlayed'),
      icon: 'check',
      testId: `ep-mark-played-${episode.episodeKey}`,
      onSelect: () => {
        void host.progress.markPlayed(episode.episodeKey, !isPlayed).then(onChanged);
      },
    },
    {
      key: 'share',
      label: t('detail.shareLink'),
      icon: 'share',
      testId: `ep-share-${episode.episodeKey}`,
      onSelect: () => {
        void handleShare();
      },
    },
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
  const durStr = formatHumanDuration(durationMs);

  return (
    <div
      className={cx('m-episode-row', isPlayed && 'is-played')}
      data-testid={`episode-row-${episode.episodeKey}`}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        if (touch) swipeStartXRef.current = touch.clientX;
      }}
      onTouchEnd={(e) => {
        const startX = swipeStartXRef.current;
        swipeStartXRef.current = null;
        const touch = e.changedTouches[0];
        if (startX !== null && touch && touch.clientX - startX > 64) {
          void handleAddQueueWithUndo();
        }
      }}
    >
      <div
        className="m-episode-row__body"
        role="button"
        tabIndex={0}
        onClick={handlePlayToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handlePlayToggle();
          }
        }}
      >
        <div className="m-episode-row__meta">
          {dateStr && <span>{dateStr}</span>}
          {dateStr && durStr && <span>·</span>}
          {durStr && <span>{durStr}</span>}
          {isPlayed && (
            <span title={t('detail.played')} data-testid={`ep-played-badge-${episode.episodeKey}`}>
              ✓
            </span>
          )}
          {isAudioOnlyVideo && (
            <span className="m-pill-badge" data-testid={`ep-audio-only-${episode.episodeKey}`}>
              {t('detail.audioOnly')}
            </span>
          )}
        </div>
        <div className="m-episode-row__title">{episode.title}</div>
        {showProgress && (
          <div className="m-episode-row__progress-row" data-testid={`ep-progress-${episode.episodeKey}`}>
            <div className="m-progress-track">
              <div className="m-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            {remainingText && (
              <span style={{ font: 'var(--md-sys-typescale-label-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                {t('detail.timeLeft', { time: remainingText })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="m-episode-row__actions">
        <IconButton
          icon={isPlaying ? 'pause' : 'play'}
          variant={isPlaying ? 'filled' : 'tonal'}
          label={`${isPlaying ? t('detail.pause') : t('detail.play')} ${episode.title}`}
          data-testid={`ep-play-${episode.episodeKey}`}
          onPointerDown={() => {
            longPressedRef.current = false;
            longPressTimerRef.current = setTimeout(() => {
              longPressedRef.current = true;
              void handlePlayNext();
            }, 500);
          }}
          onPointerUp={() => {
            if (longPressTimerRef.current) {
              clearTimeout(longPressTimerRef.current);
              longPressTimerRef.current = null;
            }
          }}
          onPointerCancel={() => {
            if (longPressTimerRef.current) {
              clearTimeout(longPressTimerRef.current);
              longPressTimerRef.current = null;
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (longPressedRef.current) {
              longPressedRef.current = false;
              return;
            }
            handlePlayToggle();
          }}
        />

        {allowDownloads && (
          <IconButton
            icon={episode.downloadState === 'DONE' ? 'downloaded' : 'download'}
            label={
              episode.downloadState === 'DONE'
                ? t('detail.deleteDownload')
                : episode.downloadState === 'RUNNING' || episode.downloadState === 'QUEUED'
                  ? t('detail.downloading')
                  : t('detail.download')
            }
            disabled={episode.downloadState === 'RUNNING' || episode.downloadState === 'QUEUED'}
            data-testid={`ep-download-${episode.episodeKey}`}
            onClick={(e) => {
              e.stopPropagation();
              void handleDownloadToggle();
            }}
          />
        )}

        <Menu
          label={`${t('common.more')} ${episode.title}`}
          items={menuItems}
          testId={`ep-menu-${episode.episodeKey}`}
        />
      </div>
    </div>
  );
}
