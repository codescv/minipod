/**
 * Merged Chapters list & sanitized Shownotes panel (`DESIGN.md` §4.6).
 */
import { cx, Icon, IconButton } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatClock, sanitizeShownotesHtml } from '../../lib/format';
import { usePlayer } from '../../player/usePlayer';
import type { SidePanelTab } from '../../app/routes';

export function ChaptersList() {
  const host = useHost();
  const t = useT();
  const player = usePlayer();
  const { chapters, activeChapterIndex } = player;

  if (chapters.length === 0) {
    return (
      <div className="m-empty" style={{ padding: '24px 12px' }} data-testid="chapters-empty">
        {t('player.noChapters')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="chapters-list">
      {chapters.map((ch, idx) => {
        const isActive = idx === activeChapterIndex;
        const title = ch.title || t('player.chapterFallback', { index: idx + 1 });
        return (
          <div key={`${ch.startMs}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={cx('m-chapter-item', isActive && 'is-active')}
              aria-current={isActive ? 'true' : undefined}
              data-testid={`chapter-item-${idx}`}
              onClick={() => player.seekTo(ch.startMs)}
            >
              <span
                style={{
                  fontFamily: 'var(--md-ref-typeface-mono)',
                  fontSize: 12,
                  minWidth: 46,
                  opacity: 0.85,
                }}
              >
                {formatClock(ch.startMs)}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</span>
              <span className="m-pill-badge">{ch.source}</span>
            </button>
            {ch.link && (
              <IconButton
                icon="openExternal"
                label={title}
                onClick={() => {
                  if (ch.link) void host.files.openExternal(ch.link);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ShownotesView() {
  const host = useHost();
  const t = useT();
  const player = usePlayer();

  const html = sanitizeShownotesHtml(player.episode?.description);
  if (!html) {
    return (
      <div className="m-empty" style={{ padding: '24px 12px' }} data-testid="shownotes-empty">
        {t('player.noShownotes')}
      </div>
    );
  }

  return (
    <div
      className="m-shownotes"
      data-testid="shownotes-content"
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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function ChaptersPanel({ tab }: { readonly tab: SidePanelTab }) {
  const player = usePlayer();
  const t = useT();

  if (!player.episode) {
    return (
      <div className="m-empty">
        <Icon name="podcasts" size={36} />
        <div>{t('player.nothingPlaying')}</div>
      </div>
    );
  }

  return tab === 'chapters' ? <ChaptersList /> : <ShownotesView />;
}
