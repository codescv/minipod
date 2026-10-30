/**
 * Docked mobile MiniPlayer bar (`DESIGN.md` §4.6).
 */
import { useRouteStore } from '../../app/routes';
import { Icon, IconButton } from '../../components/m3';
import { useT } from '../../i18n';
import { formatClock } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';

export function MiniPlayer() {
  const t = useT();
  const player = usePlayer();
  const setExpandedPlayerOpen = useRouteStore((s) => s.setExpandedPlayerOpen);

  if (!player.episode) return null;

  const { positionMs, durationMs, playing } = player.snapshot;
  const total = durationMs ?? player.episode.durationMs ?? 0;
  const pct = total > 0 ? Math.min(100, (positionMs / total) * 100) : 0;

  return (
    <div
      className="m-mini-player"
      role="button"
      tabIndex={0}
      aria-label={t('player.expand')}
      data-testid="mini-player"
      onClick={() => setExpandedPlayerOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpandedPlayerOpen(true);
        }
      }}
    >
      {player.artworkUrl ? (
        <img className="m-mini-player__cover" src={player.artworkUrl} alt="" />
      ) : (
        <div className="m-mini-player__cover" style={{ display: 'grid', placeItems: 'center' }}>
          <Icon name="podcasts" size={20} />
        </div>
      )}

      <div className="m-mini-player__info">
        <div className="m-mini-player__title">{player.episode.title}</div>
        <div className="m-mini-player__time">
          {formatClock(positionMs)}
          {total > 0 ? ` / ${formatClock(total)}` : ''}
        </div>
      </div>

      <IconButton
        icon={playing ? 'pause' : 'play'}
        variant="filled"
        label={playing ? t('detail.pause') : t('detail.play')}
        data-testid="mini-player-play-btn"
        onClick={(e) => {
          e.stopPropagation();
          void player.togglePlayPause();
        }}
      />

      <div className="m-mini-player__bar">
        <div className="m-mini-player__bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
