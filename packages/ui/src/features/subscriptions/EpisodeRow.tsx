/**
 * Episode row (`DESIGN.md` §4.3):
 * - Optional podcast cover thumbnail + clickable podcast title in timeline mode (`showPodcastInfo`)
 * - Date · human duration · `✓` played · downloaded indicator · `Audio only` badge
 * - Linear progress bar + remaining time when `IN_PROGRESS`
 * - Swipe-right to toggle queue + Undo snackbar
 * - Inline actions: `▶/⏸` play/pause, inline Add/Remove Queue (`ep-queue-btn-*`), and `⋮` overflow
 *   (`Download / Delete download`, `Mark played / unplayed`, and `Open in video player` when needed)
 */
import { useRef } from 'react';
import type { EpisodeRow as EpisodeRowModel } from '@minipod/core';
import {
  ArtworkImage,
  cx,
  Icon,
  IconButton,
  Menu,
  shouldUseImageProxy,
  type MenuEntry,
} from '../../components/m3';
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
  readonly showPodcastInfo?: boolean | undefined;
  readonly onOpenPodcast?: (() => void) | undefined;
  readonly onChanged: () => void;
}

export function EpisodeRow({
  row,
  feedTitle,
  feedImageUrl,
  allowDownloads,
  showPodcastInfo = false,
  onOpenPodcast,
  onChanged,
}: EpisodeRowProps) {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();
  const allowProxy = shouldUseImageProxy(host.info.platform);

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
  const isDownloading = episode.downloadState === 'RUNNING' || episode.downloadState === 'QUEUED';

  const swipeStartXRef = useRef<number | null>(null);

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

  const menuItems: MenuEntry[] = [
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
            icon: (episode.downloadState === 'DONE' ? 'downloaded' : 'download') as 'downloaded' | 'download',
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
          void handleToggleQueue();
        }
      }}
    >
      {showPodcastInfo && (
        <button
          type="button"
          className="m-episode-row__podcast-thumb"
          aria-label={feedTitle || episode.title}
          title={feedTitle || episode.title}
          data-testid={`ep-podcast-thumb-${episode.episodeKey}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenPodcast?.();
          }}
        >
          <ArtworkImage
            src={episode.imageUrl}
            fallbackSrc={feedImageUrl}
            allowProxyFallback={allowProxy}
            className="m-episode-row__thumb-img"
            loading="lazy"
            draggable={false}
            placeholder={<Icon name="podcasts" size={18} />}
          />
        </button>
      )}

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
          {showPodcastInfo && feedTitle && (
            <button
              type="button"
              className="m-episode-row__podcast-link"
              data-testid={`ep-podcast-link-${episode.episodeKey}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPodcast?.();
              }}
            >
              {dateStr || durStr ? `${feedTitle} ·` : `${feedTitle} ›`}
            </button>
          )}
          {dateStr && <span>{dateStr}</span>}
          {dateStr && durStr && <span>·</span>}
          {durStr && <span>{durStr}</span>}
          {isPlayed && (
            <span title={t('detail.played')} data-testid={`ep-played-badge-${episode.episodeKey}`}>
              ✓
            </span>
          )}
          {episode.downloadState === 'DONE' && (
            <span
              title={t('detail.filterDownloaded')}
              data-testid={`ep-downloaded-badge-${episode.episodeKey}`}
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--md-sys-color-primary)' }}
            >
              <Icon name="downloaded" size={14} />
            </span>
          )}
          {isDownloading && (
            <span className="m-pill-badge" data-testid={`ep-downloading-badge-${episode.episodeKey}`}>
              {t('detail.downloading')}
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
          onClick={(e) => {
            e.stopPropagation();
            handlePlayToggle();
          }}
        />

        <IconButton
          icon={inQueue ? 'queueMusic' : 'playlistAdd'}
          variant={inQueue ? 'tonal' : 'standard'}
          label={`${inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue')} ${episode.title}`}
          data-testid={`ep-queue-btn-${episode.episodeKey}`}
          onClick={(e) => {
            e.stopPropagation();
            void handleToggleQueue();
          }}
        />

        <Menu
          label={`${t('common.more')} ${episode.title}`}
          items={menuItems}
          testId={`ep-menu-${episode.episodeKey}`}
        />
      </div>
    </div>
  );
}
