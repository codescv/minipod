/**
 * Zustand navigation & overlay state for MiniPod (ARCHITECTURE.md §2.1, §5.3).
 */
import { create } from 'zustand';
import type { DiscoveredFeedLink, FeedKey, FeedPreview } from '@minipod/core';

export type RootTab = 'subscriptions' | 'queue' | 'settings';

export type ScreenRoute =
  | { readonly kind: 'root' }
  | { readonly kind: 'podcast-detail'; readonly feedKey: FeedKey }
  | { readonly kind: 'add'; readonly initialInput?: string | undefined }
  | {
      readonly kind: 'feed-preview';
      readonly url: string;
      readonly preview?: FeedPreview | undefined;
      readonly authChallenge?: { readonly url: string; readonly realm?: string | undefined } | undefined;
      readonly choices?: { readonly pageUrl: string; readonly items: readonly DiscoveredFeedLink[] } | undefined;
    }
  | { readonly kind: 'cloud-sync' }
  | { readonly kind: 'downloads' };

export type SidePanelTab = 'chapters' | 'shownotes';

export interface RouteSnapshot {
  readonly tab: RootTab;
  readonly screen: ScreenRoute;
}

export interface RouteStoreState {
  readonly tab: RootTab;
  readonly screen: ScreenRoute;
  readonly history: readonly RouteSnapshot[];
  readonly expandedPlayerOpen: boolean;
  readonly sideSheetOpen: boolean;
  readonly sideSheetTab: SidePanelTab;
  readonly sleepTimerSheetOpen: boolean;
  readonly opmlImportOpen: boolean;
  readonly localFolderOpen: boolean;

  setTab(tab: RootTab): void;
  openPodcastDetail(feedKey: FeedKey): void;
  openAdd(initialInput?: string): void;
  openFeedPreview(params: Omit<Extract<ScreenRoute, { kind: 'feed-preview' }>, 'kind'>): void;
  replaceFeedPreview(params: Omit<Extract<ScreenRoute, { kind: 'feed-preview' }>, 'kind'>): void;
  openCloudSync(): void;
  openDownloads(): void;
  setExpandedPlayerOpen(open: boolean): void;
  setSideSheet(open: boolean, tab?: SidePanelTab): void;
  toggleSideSheet(tab?: SidePanelTab): void;
  setSleepTimerSheetOpen(open: boolean): void;
  setOpmlImportOpen(open: boolean): void;
  setLocalFolderOpen(open: boolean): void;
  goBack(): boolean;
  reset(): void;
}

const MAX_HISTORY = 32;

function pushHistory(
  history: readonly RouteSnapshot[],
  current: RouteSnapshot,
): readonly RouteSnapshot[] {
  const next = [...history, current];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

const initialState = {
  tab: 'subscriptions' as RootTab,
  screen: { kind: 'root' } as ScreenRoute,
  history: [] as readonly RouteSnapshot[],
  expandedPlayerOpen: false,
  sideSheetOpen: false,
  sideSheetTab: 'chapters' as SidePanelTab,
  sleepTimerSheetOpen: false,
  opmlImportOpen: false,
  localFolderOpen: false,
};

export const useRouteStore = create<RouteStoreState>()((set, get) => ({
  ...initialState,

  setTab: (tab) =>
    set((s) => {
      if (s.tab === tab && s.screen.kind === 'root') return s;
      return {
        tab,
        screen: { kind: 'root' },
        history: pushHistory(s.history, { tab: s.tab, screen: s.screen }),
      };
    }),

  openPodcastDetail: (feedKey) =>
    set((s) => ({
      screen: { kind: 'podcast-detail', feedKey },
      history:
        s.screen.kind === 'feed-preview'
          ? s.history // subscribing from preview replaces preview in back stack
          : pushHistory(s.history, { tab: s.tab, screen: s.screen }),
    })),

  openAdd: (initialInput) =>
    set((s) => ({
      screen: { kind: 'add', ...(initialInput !== undefined ? { initialInput } : {}) },
      history:
        s.screen.kind === 'add'
          ? s.history
          : pushHistory(s.history, { tab: s.tab, screen: s.screen }),
    })),

  openFeedPreview: (params) =>
    set((s) => ({
      screen: { kind: 'feed-preview', ...params },
      history: pushHistory(s.history, { tab: s.tab, screen: s.screen }),
    })),

  replaceFeedPreview: (params) =>
    set(() => ({
      screen: { kind: 'feed-preview', ...params },
    })),

  openCloudSync: () =>
    set((s) => ({
      screen: { kind: 'cloud-sync' },
      history: pushHistory(s.history, { tab: s.tab, screen: s.screen }),
    })),

  openDownloads: () =>
    set((s) => ({
      screen: { kind: 'downloads' },
      history:
        s.screen.kind === 'downloads'
          ? s.history
          : pushHistory(s.history, { tab: s.tab, screen: s.screen }),
    })),

  setExpandedPlayerOpen: (expandedPlayerOpen) => set({ expandedPlayerOpen }),

  setSideSheet: (sideSheetOpen, tab) =>
    set((s) => ({
      sideSheetOpen,
      sideSheetTab: tab ?? s.sideSheetTab,
    })),

  toggleSideSheet: (tab) =>
    set((s) => {
      if (!s.sideSheetOpen) {
        return { sideSheetOpen: true, sideSheetTab: tab ?? s.sideSheetTab };
      }
      if (tab && s.sideSheetTab !== tab) {
        return { sideSheetOpen: true, sideSheetTab: tab };
      }
      return { sideSheetOpen: false };
    }),

  setSleepTimerSheetOpen: (sleepTimerSheetOpen) => set({ sleepTimerSheetOpen }),
  setOpmlImportOpen: (opmlImportOpen) => set({ opmlImportOpen }),
  setLocalFolderOpen: (localFolderOpen) => set({ localFolderOpen }),

  goBack: () => {
    const s = get();
    if (s.sleepTimerSheetOpen) {
      set({ sleepTimerSheetOpen: false });
      return true;
    }
    if (s.opmlImportOpen) {
      set({ opmlImportOpen: false });
      return true;
    }
    if (s.localFolderOpen) {
      set({ localFolderOpen: false });
      return true;
    }
    if (s.expandedPlayerOpen) {
      set({ expandedPlayerOpen: false });
      return true;
    }
    if (s.sideSheetOpen) {
      set({ sideSheetOpen: false });
      return true;
    }
    if (s.history.length > 0) {
      const prev = s.history[s.history.length - 1]!;
      set({
        tab: prev.tab,
        screen: prev.screen,
        history: s.history.slice(0, -1),
      });
      return true;
    }
    if (s.screen.kind !== 'root') {
      set({ screen: { kind: 'root' } });
      return true;
    }
    if (s.tab !== 'subscriptions') {
      set({ tab: 'subscriptions' });
      return true;
    }
    return false;
  },

  reset: () => set(initialState),
}));
