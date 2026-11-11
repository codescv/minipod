/**
 * Sleep Timer sheet (`DESIGN.md` §4.6):
 * `15 / 30 / 45 / 60 min`, `End of episode`, `End of chapter`, `Off`.
 */
import { useRouteStore } from '../../app/routes';
import { BottomSheet, cx, IconButton } from '../../components/m3';
import { useT } from '../../i18n';
import { formatClock } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';

const MINUTE_PRESETS = [
  { minutes: 15, key: 'sleep.min15' as const },
  { minutes: 30, key: 'sleep.min30' as const },
  { minutes: 45, key: 'sleep.min45' as const },
  { minutes: 60, key: 'sleep.min60' as const },
];

export function SleepTimerSheet() {
  const open = useRouteStore((s) => s.sleepTimerSheetOpen);
  // Avoid subscribing to `usePlayer()` ticks while the sleep timer sheet is closed.
  if (!open) return null;
  return <SleepTimerSheetContent />;
}

function SleepTimerSheetContent() {
  const t = useT();
  const player = usePlayer();

  const setOpen = useRouteStore((s) => s.setSleepTimerSheetOpen);

  const active = player.sleepTimer.timer;
  const remainingMs = player.sleepTimer.remainingMs;
  const hasChapters = player.chapters.length > 0;

  return (
    <BottomSheet
      open
      onClose={() => setOpen(false)}
      title={t('sleep.title')}
      testId="sleep-timer-sheet"
    >
      <div style={{ padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, font: 'var(--md-sys-typescale-title-medium)' }}>
            {t('sleep.title')}
          </h2>
          {active.mode !== 'off' && remainingMs !== undefined && (
            <span className="m-pill-badge" data-testid="sleep-remaining-badge">
              {t('sleep.activeRemaining', { time: formatClock(remainingMs) })}
            </span>
          )}
          <IconButton icon="close" label={t('common.close')} onClick={() => setOpen(false)} />
        </div>

        {MINUTE_PRESETS.map((preset) => {
          const selected = active.mode === 'minutes' && active.minutes === preset.minutes;
          return (
            <button
              key={preset.minutes}
              type="button"
              className={cx('m-chapter-item', selected && 'is-active')}
              data-testid={`sleep-opt-${preset.minutes}`}
              onClick={() => {
                player.setSleepTimer({ mode: 'minutes', minutes: preset.minutes });
                setOpen(false);
              }}
            >
              {t(preset.key)}
            </button>
          );
        })}

        <button
          type="button"
          className={cx('m-chapter-item', active.mode === 'endOfEpisode' && 'is-active')}
          data-testid="sleep-opt-episode"
          onClick={() => {
            player.setSleepTimer({ mode: 'endOfEpisode' });
            setOpen(false);
          }}
        >
          {t('sleep.endOfEpisode')}
        </button>

        {hasChapters && (
          <button
            type="button"
            className={cx('m-chapter-item', active.mode === 'endOfChapter' && 'is-active')}
            data-testid="sleep-opt-chapter"
            onClick={() => {
              player.setSleepTimerEndOfChapter();
              setOpen(false);
            }}
          >
            {t('sleep.endOfChapter')}
          </button>
        )}

        <button
          type="button"
          className={cx('m-chapter-item', active.mode === 'off' && 'is-active')}
          data-testid="sleep-opt-off"
          onClick={() => {
            player.setSleepTimer({ mode: 'off' });
            setOpen(false);
          }}
        >
          {t('sleep.off')}
        </button>
      </div>
    </BottomSheet>
  );
}
