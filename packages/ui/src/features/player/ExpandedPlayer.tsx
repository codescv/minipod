/**
 * Full-height Expanded Player sheet on mobile (`DESIGN.md` §4.6).
 */
import { useRef, useState } from 'react';
import { SPEED_MAX, SPEED_MIN } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import { BottomSheet, Button, Icon, IconButton } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatClock, formatRemainingClock, formatSpeed } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import { ChaptersList, ShownotesView } from './ChaptersPanel';

export function ExpandedPlayer() {
  const host = useHost();
  const t = useT();
  const player = usePlayer();

  const open = useRouteStore((s) => s.expandedPlayerOpen);
  const setOpen = useRouteStore((s) => s.setExpandedPlayerOpen);
  const setSleepTimerSheetOpen = useRouteStore((s) => s.setSleepTimerSheetOpen);

  const [showSpeedSlider, setShowSpeedSlider] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);
  const speedLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedLongTriggeredRef = useRef(false);

  const episode = player.episode;
  const durationMs = player.snapshot.durationMs ?? episode?.durationMs ?? 0;
  const positionMs = player.snapshot.positionMs;
  const isVideoInline = episode?.mediaType === 'VIDEO' && player.engine.capabilities.video;
  const isAudioOnlyVideo = episode?.mediaType === 'VIDEO' && !player.engine.capabilities.video;
  const sleepActive = player.sleepTimer.timer.mode !== 'off';

  return (
    <BottomSheet
      open={open && Boolean(episode)}
      onClose={() => setOpen(false)}
      title={episode?.title ?? t('app.name')}
      fullHeight
      registerBack={false} // `useRouteStore.goBack()` already unwinds `expandedPlayerOpen` in LIFO order
      testId="expanded-player"
    >
      {episode && (
        <div className="m-expanded-player">
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <IconButton
              icon="expandMore"
              label={t('player.collapse')}
              data-testid="expanded-collapse-btn"
              onClick={() => setOpen(false)}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Button
                variant={sleepActive ? 'tonal' : 'text'}
                icon="sleep"
                aria-label={t('player.sleepTimer')}
                data-testid="expanded-sleep-btn"
                onClick={() => setSleepTimerSheetOpen(true)}
              >
                {sleepActive && player.sleepTimer.remainingMs !== undefined
                  ? formatClock(player.sleepTimer.remainingMs)
                  : ''}
              </Button>
              <Button
                variant="tonal"
                aria-label={t('player.speed')}
                data-testid="expanded-speed-btn"
                onPointerDown={() => {
                  speedLongTriggeredRef.current = false;
                  speedLongPressRef.current = setTimeout(() => {
                    speedLongTriggeredRef.current = true;
                    setShowSpeedSlider((v) => !v);
                  }, 450);
                }}
                onPointerUp={() => {
                  if (speedLongPressRef.current) {
                    clearTimeout(speedLongPressRef.current);
                    speedLongPressRef.current = null;
                  }
                }}
                onClick={() => {
                  if (speedLongTriggeredRef.current) {
                    speedLongTriggeredRef.current = false;
                    return;
                  }
                  player.cycleSpeed();
                }}
              >
                {formatSpeed(player.snapshot.speed)}
              </Button>
              <Button
                variant="text"
                aria-label={t('player.speedSlider')}
                data-testid="expanded-speed-slider-toggle"
                onClick={() => setShowSpeedSlider((v) => !v)}
                style={{ padding: '0 8px' }}
              >
                ±
              </Button>
            </div>
          </header>

          {showSpeedSlider && (
            <label
              className="m-field"
              style={{ padding: '8px 12px', borderRadius: 12, background: 'var(--md-sys-color-surface-container)' }}
            >
              <span className="m-field__label">
                {t('player.speedSlider')}: {formatSpeed(player.snapshot.speed)}
              </span>
              <input
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={0.05}
                aria-label={t('player.speedSlider')}
                data-testid="expanded-speed-slider"
                value={player.snapshot.speed}
                onChange={(e) => player.setSpeed(Number.parseFloat(e.target.value))}
              />
            </label>
          )}

          {isVideoInline ? (
            <div
              className="m-video-surface"
              ref={player.attachVideoSurface}
              data-testid="expanded-video-surface"
            />
          ) : (
            <div className="m-expanded-player__artwork-wrap">
              {player.artworkUrl ? (
                <img
                  className="m-expanded-player__artwork"
                  src={player.artworkUrl}
                  alt=""
                  data-testid="expanded-artwork-img"
                />
              ) : (
                <Icon name="podcasts" size={72} />
              )}
            </div>
          )}

          {isAudioOnlyVideo && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10 }}>
              <span className="m-pill-badge">{t('detail.audioOnly')}</span>
              {episode.enclosureUrl && (
                <Button
                  variant="outlined"
                  icon="openExternal"
                  onClick={() => {
                    if (episode.enclosureUrl) void host.files.openExternal(episode.enclosureUrl);
                  }}
                >
                  {t('detail.openInVideoPlayer')}
                </Button>
              )}
            </div>
          )}

          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ font: 'var(--md-sys-typescale-title-medium)' }}>{episode.title}</div>
            {player.feedTitle && (
              <div style={{ font: 'var(--md-sys-typescale-body-medium)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                {player.feedTitle}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="m-seek-wrap">
              <input
                className="m-seek-slider"
                type="range"
                min={0}
                max={Math.max(durationMs, positionMs, 1000)}
                step={1000}
                aria-label={t('player.seek')}
                data-testid="expanded-seek-slider"
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
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                font: 'var(--md-sys-typescale-label-small)',
                color: 'var(--md-sys-color-on-surface-variant)',
              }}
            >
              <span>{formatClock(positionMs)}</span>
              <span>{formatRemainingClock(positionMs, durationMs || undefined)}</span>
            </div>
          </div>

          <div className="m-transport-row">
            <IconButton
              icon="replay10"
              label={t('player.skipBack')}
              iconSize={28}
              data-testid="expanded-skip-back-btn"
              onClick={player.skipBack}
            />
            <IconButton
              icon={player.snapshot.playing ? 'pause' : 'play'}
              variant="filled"
              large
              label={player.snapshot.playing ? t('detail.pause') : t('detail.play')}
              data-testid="expanded-play-pause-btn"
              onClick={() => {
                void player.togglePlayPause();
              }}
            />
            <IconButton
              icon="forward30"
              label={t('player.skipForward')}
              iconSize={28}
              data-testid="expanded-skip-forward-btn"
              onClick={player.skipForward}
            />
          </div>

          {player.chapters.length > 0 && (
            <section style={{ borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 8 }}>
              <button
                type="button"
                className="m-settings-row m-settings-row--clickable"
                data-testid="expanded-chapters-toggle"
                onClick={() => setChaptersOpen((v) => !v)}
              >
                <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
                  {t('player.chaptersCount', { count: player.chapters.length })}
                </span>
                <Icon name={chaptersOpen ? 'expandLess' : 'expandMore'} size={20} />
              </button>
              {chaptersOpen && <ChaptersList />}
            </section>
          )}

          <section style={{ borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 8 }}>
            <button
              type="button"
              className="m-settings-row m-settings-row--clickable"
              data-testid="expanded-shownotes-toggle"
              onClick={() => setNotesOpen((v) => !v)}
            >
              <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
                {t('player.shownotes')}
              </span>
              <Icon name={notesOpen ? 'expandLess' : 'expandMore'} size={20} />
            </button>
            {notesOpen && <ShownotesView />}
          </section>
        </div>
      )}
    </BottomSheet>
  );
}
