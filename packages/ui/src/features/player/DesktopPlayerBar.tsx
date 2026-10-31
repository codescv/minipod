/**
 * Persistent bottom Desktop Player Bar (`>= 840px`, `DESIGN.md` §4.6).
 */
import { useRouteStore } from '../../app/routes';
import { ArtworkImage, Button, Icon, IconButton, shouldUseImageProxy } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatClock, formatRemainingClock, formatSpeed } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';

export function DesktopPlayerBar() {
  const host = useHost();
  const t = useT();
  const player = usePlayer();

  const toggleSideSheet = useRouteStore((s) => s.toggleSideSheet);
  const setSleepTimerSheetOpen = useRouteStore((s) => s.setSleepTimerSheetOpen);

  const episode = player.episode;
  const durationMs = player.snapshot.durationMs ?? episode?.durationMs ?? 0;
  const positionMs = player.snapshot.positionMs;
  const sleepActive = player.sleepTimer.timer.mode !== 'off';
  const showInlineVideo = Boolean(episode?.mediaType === 'VIDEO' && player.engine.capabilities.video);

  return (
    <div style={{ flex: 'none', position: 'relative' }} data-testid="desktop-player-bar">
      {showInlineVideo && (
        <div
          style={{
            padding: '8px 20px',
            background: 'var(--md-sys-color-surface-container-low)',
            borderTop: '1px solid var(--md-sys-color-outline-variant)',
          }}
        >
          <div
            className="m-video-surface"
            style={{ maxWidth: 520, margin: '0 auto' }}
            ref={player.attachVideoSurface}
            data-testid="desktop-video-surface"
          />
        </div>
      )}

      <footer className="m-desktop-bar">
        <div className="m-desktop-bar__meta">
          <ArtworkImage
            src={player.artworkUrl}
            extraFallbackSrc={player.episodeArtworkUrl}
            fallbackSrc={player.fallbackArtworkUrl}
            allowProxyFallback={shouldUseImageProxy(host.info.platform)}
            className="m-desktop-bar__cover"
            title={t('player.shownotes')}
            testId="desktop-cover-btn"
            onClick={() => toggleSideSheet('shownotes')}
            placeholder={
              <button
                type="button"
                className="m-desktop-bar__cover"
                style={{ border: 0, display: 'grid', placeItems: 'center' }}
                aria-label={t('player.shownotes')}
                data-testid="desktop-cover-btn"
                onClick={() => toggleSideSheet('shownotes')}
              >
                <Icon name="podcasts" size={22} />
              </button>
            }
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                font: 'var(--md-sys-typescale-title-small)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              data-testid="desktop-now-playing-title"
            >
              {episode ? episode.title : t('player.nothingPlaying')}
            </div>
            {player.feedTitle && (
              <div
                style={{
                  font: 'var(--md-sys-typescale-label-small)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {player.feedTitle}
              </div>
            )}
          </div>
        </div>

        <div className="m-desktop-bar__center">
          <IconButton
            icon="replay10"
            label={t('player.skipBack')}
            disabled={!episode}
            data-testid="desktop-skip-back-btn"
            onClick={player.skipBack}
          />
          <IconButton
            icon={player.snapshot.playing ? 'pause' : 'play'}
            variant="filled"
            label={player.snapshot.playing ? t('detail.pause') : t('detail.play')}
            disabled={!episode}
            data-testid="desktop-play-pause-btn"
            onClick={() => {
              void player.togglePlayPause();
            }}
          />
          <IconButton
            icon="forward30"
            label={t('player.skipForward')}
            disabled={!episode}
            data-testid="desktop-skip-forward-btn"
            onClick={player.skipForward}
          />

          <span style={{ font: 'var(--md-sys-typescale-label-small)', minWidth: 42, textAlign: 'right' }}>
            {formatClock(positionMs)}
          </span>

          <div className="m-seek-wrap">
            <input
              className="m-seek-slider"
              type="range"
              min={0}
              max={Math.max(durationMs, positionMs, 1000)}
              step={1000}
              disabled={!episode}
              aria-label={t('player.seek')}
              data-testid="desktop-seek-slider"
              value={positionMs}
              onChange={(e) => player.seekTo(Number.parseInt(e.target.value, 10))}
            />
            {durationMs > 0 && player.chapters.length > 0 && (
              <div className="m-seek-ticks">
                {player.chapters.map((ch, idx) => {
                  const leftPct = Math.min(100, Math.max(0, (ch.startMs / durationMs) * 100));
                  return (
                    <span
                      key={`${ch.startMs}-${idx}`}
                      className="m-seek-tick"
                      style={{ left: `${leftPct}%` }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <span
            style={{
              font: 'var(--md-sys-typescale-label-small)',
              color: 'var(--md-sys-color-on-surface-variant)',
              minWidth: 48,
            }}
          >
            {episode ? formatRemainingClock(positionMs, durationMs || undefined) : '--:--'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <IconButton
            icon={player.muted ? 'volumeOff' : 'volumeUp'}
            label={player.muted ? t('player.unmute') : t('player.mute')}
            data-testid="desktop-mute-btn"
            onClick={player.toggleMute}
          />

          <Button
            variant="tonal"
            aria-label={t('player.speed')}
            data-testid="desktop-speed-btn"
            onClick={player.cycleSpeed}
          >
            {formatSpeed(player.snapshot.speed)}
          </Button>

          <Button
            variant={sleepActive ? 'tonal' : 'text'}
            icon="sleep"
            aria-label={t('player.sleepTimer')}
            data-testid="desktop-sleep-btn"
            onClick={() => setSleepTimerSheetOpen(true)}
          >
            {sleepActive && player.sleepTimer.remainingMs !== undefined
              ? formatClock(player.sleepTimer.remainingMs)
              : ''}
          </Button>

          <IconButton
            icon="chapters"
            label={t('player.chapters')}
            data-testid="desktop-chapters-btn"
            onClick={() => toggleSideSheet('chapters')}
          />
        </div>
      </footer>
    </div>
  );
}
