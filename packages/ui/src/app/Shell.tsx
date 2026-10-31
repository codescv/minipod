/**
 * Responsive application shell (`DESIGN.md` §2.2, §4.6, §5):
 * - Desktop (`>= 840px`): Left `NavRail` (`+` FAB, Subscriptions, Queue, Settings) + main stage +
 *   collapsible right `SideSheet` (Chapters / Shownotes) + persistent bottom `DesktopPlayerBar`.
 * - Mobile (`< 840px`): Main stage + docked `MiniPlayer` + 2-tab bottom `NavBar`
 *   (Subscriptions, Queue) + full-height `ExpandedPlayer` `BottomSheet`.
 * - Global keyboard shortcuts (`Space`, `J`/`L`, `←`/`→`, `Shift+←/→`, `[`/`]`, `Q`, `M`, `/`).
 */
import { useEffect } from 'react';
import { useRouteStore, type RootTab } from './routes';
import { Chip, cx, FAB, Icon, SideSheet } from '../components/m3';
import { AddSearch } from '../features/add/AddSearch';
import { FeedPreview } from '../features/add/FeedPreview';
import { LocalFolderDialog } from '../features/add/LocalFolderDialog';
import { OpmlImport } from '../features/add/OpmlImport';
import { ChaptersPanel } from '../features/player/ChaptersPanel';
import { DesktopPlayerBar } from '../features/player/DesktopPlayerBar';
import { ExpandedPlayer } from '../features/player/ExpandedPlayer';
import { MiniPlayer } from '../features/player/MiniPlayer';
import { SleepTimerSheet } from '../features/player/SleepTimerSheet';
import { QueueList } from '../features/queue/QueueList';
import { CloudSyncSetup } from '../features/settings/CloudSyncSetup';
import { SettingsPage } from '../features/settings/SettingsPage';
import { DownloadsPage } from '../features/subscriptions/DownloadsPage';
import { PodcastDetail } from '../features/subscriptions/PodcastDetail';
import { SubscriptionsGrid } from '../features/subscriptions/SubscriptionsGrid';
import { UpdateBanner } from '../features/updater/UpdateBanner';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { useT } from '../i18n';
import { nextSpeedPreset, prevSpeedPreset } from '../player/PlayerEngine';
import { usePlayer } from '../player/usePlayer';

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

export function Shell() {
  const isDesktop = useIsDesktop();
  const t = useT();
  const player = usePlayer();

  const tab = useRouteStore((s) => s.tab);
  const screen = useRouteStore((s) => s.screen);
  const sideSheetOpen = useRouteStore((s) => s.sideSheetOpen);
  const sideSheetTab = useRouteStore((s) => s.sideSheetTab);
  const setTab = useRouteStore((s) => s.setTab);
  const openAdd = useRouteStore((s) => s.openAdd);
  const setSideSheet = useRouteStore((s) => s.setSideSheet);

  // Global keyboard shortcuts (DESIGN.md §4.6 & §5)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableElement(e.target)) return;

      if (e.key === ' ' || e.code === 'Space') {
        if (player.episode) {
          e.preventDefault();
          void player.togglePlayPause();
        }
        return;
      }

      if (e.shiftKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        player.prevChapter();
        return;
      }
      if (e.shiftKey && e.key === 'ArrowRight') {
        e.preventDefault();
        player.nextChapter();
        return;
      }

      if (e.shiftKey && e.key !== '/') return;

      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowLeft':
          if (player.episode) {
            e.preventDefault();
            player.skipBack();
          }
          break;
        case 'l':
        case 'L':
        case 'ArrowRight':
          if (player.episode) {
            e.preventDefault();
            player.skipForward();
          }
          break;
        case '[':
          e.preventDefault();
          player.setSpeed(prevSpeedPreset(player.snapshot.speed));
          break;
        case ']':
          e.preventDefault();
          player.setSpeed(nextSpeedPreset(player.snapshot.speed));
          break;
        case 'q':
        case 'Q':
          e.preventDefault();
          setTab('queue');
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          player.toggleMute();
          break;
        case '/':
          e.preventDefault();
          openAdd();
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openAdd, player, setTab]);

  const renderMainStage = () => {
    switch (screen.kind) {
      case 'podcast-detail':
        return <PodcastDetail feedKey={screen.feedKey} />;
      case 'add':
        return <AddSearch initialInput={screen.initialInput} />;
      case 'feed-preview':
        return (
          <FeedPreview
            url={screen.url}
            preview={screen.preview}
            authChallenge={screen.authChallenge}
            choices={screen.choices}
          />
        );
      case 'cloud-sync':
        return <CloudSyncSetup />;
      case 'downloads':
        return <DownloadsPage />;
      case 'root':
        switch (tab) {
          case 'subscriptions':
            return <SubscriptionsGrid />;
          case 'queue':
            return <QueueList />;
          case 'settings':
            return <SettingsPage />;
        }
    }
  };

  const isNavActive = (target: RootTab): boolean =>
    tab === target && screen.kind !== 'add' && screen.kind !== 'feed-preview';

  const hasMiniPlayer = !isDesktop && Boolean(player.episode);

  return (
    <div
      className={cx(
        'm-shell',
        isDesktop ? 'm-shell--desktop' : 'm-shell--mobile',
        hasMiniPlayer && 'm-shell--has-miniplayer',
      )}
      data-testid="app-shell"
    >
      <div className="m-shell__workspace">
        {isDesktop && (
          <nav className="m-nav-rail" aria-label="Main navigation" data-testid="desktop-nav-rail">
            <div className="m-nav-rail__fab">
              <FAB
                icon="add"
                label={t('nav.add')}
                testId="nav-rail-add-fab"
                onClick={() => openAdd()}
              />
            </div>

            <button
              type="button"
              className={cx('m-nav-item', isNavActive('subscriptions') && 'is-active')}
              aria-current={isNavActive('subscriptions') ? 'page' : undefined}
              data-testid="nav-rail-subscriptions"
              onClick={() => setTab('subscriptions')}
            >
              <span className="m-nav-item__pill">
                <Icon name="podcasts" size={22} />
              </span>
              <span className="m-nav-item__label">{t('nav.subscriptions')}</span>
            </button>

            <button
              type="button"
              className={cx('m-nav-item', isNavActive('queue') && 'is-active')}
              aria-current={isNavActive('queue') ? 'page' : undefined}
              data-testid="nav-rail-queue"
              onClick={() => setTab('queue')}
            >
              <span className="m-nav-item__pill">
                <Icon name="queue" size={22} />
              </span>
              <span className="m-nav-item__label">{t('nav.queue')}</span>
            </button>

            <button
              type="button"
              className={cx('m-nav-item', isNavActive('settings') && 'is-active')}
              aria-current={isNavActive('settings') ? 'page' : undefined}
              data-testid="nav-rail-settings"
              onClick={() => setTab('settings')}
            >
              <span className="m-nav-item__pill">
                <Icon name="settings" size={22} />
              </span>
              <span className="m-nav-item__label">{t('nav.settings')}</span>
            </button>
          </nav>
        )}

        <main className="m-shell__stage">
          <UpdateBanner />
          {renderMainStage()}
        </main>

        {isDesktop && (
          <SideSheet
            open={sideSheetOpen}
            onClose={() => setSideSheet(false)}
            closeLabel={t('common.close')}
            title={
              <div style={{ display: 'flex', gap: 6 }}>
                <Chip
                  selected={sideSheetTab === 'chapters'}
                  testId="sidesheet-tab-chapters"
                  onClick={() => setSideSheet(true, 'chapters')}
                >
                  {player.chapters.length > 0
                    ? t('player.chaptersCount', { count: player.chapters.length })
                    : t('player.chapters')}
                </Chip>
                <Chip
                  selected={sideSheetTab === 'shownotes'}
                  testId="sidesheet-tab-shownotes"
                  onClick={() => setSideSheet(true, 'shownotes')}
                >
                  {t('player.shownotes')}
                </Chip>
              </div>
            }
          >
            <ChaptersPanel tab={sideSheetTab} />
          </SideSheet>
        )}
      </div>

      {isDesktop ? (
        <DesktopPlayerBar />
      ) : (
        <>
          <MiniPlayer />
          <nav className="m-nav-bar" aria-label="Main navigation" data-testid="mobile-nav-bar">
            <button
              type="button"
              className={cx('m-nav-item', isNavActive('subscriptions') && 'is-active')}
              aria-current={isNavActive('subscriptions') ? 'page' : undefined}
              data-testid="nav-bar-subscriptions"
              onClick={() => setTab('subscriptions')}
            >
              <span className="m-nav-item__pill">
                <Icon name="podcasts" size={22} />
              </span>
              <span className="m-nav-item__label">{t('nav.subscriptions')}</span>
            </button>

            <button
              type="button"
              className={cx('m-nav-item', isNavActive('queue') && 'is-active')}
              aria-current={isNavActive('queue') ? 'page' : undefined}
              data-testid="nav-bar-queue"
              onClick={() => setTab('queue')}
            >
              <span className="m-nav-item__pill">
                <Icon name="queue" size={22} />
              </span>
              <span className="m-nav-item__label">{t('nav.queue')}</span>
            </button>
          </nav>
          <ExpandedPlayer />
        </>
      )}

      <SleepTimerSheet />
      <OpmlImport />
      <LocalFolderDialog />
    </div>
  );
}
