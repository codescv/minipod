/**
 * Central React playback context (`PlayerProvider` + `usePlayer`) bridging
 * `PlayerEngine`, `PlatformHost` (`progress`, `queue`, `episodes`, `playback`, `sync`),
 * 5s local progress recording, completion + queue auto-advance, chapter images,
 * and cross-device `"Resumed from <device> at XX:XX — Undo"` snackbar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  LOCAL_PROGRESS_INTERVAL_MS,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  type Chapter,
  type Episode,
  type FeedPreview,
  type MediaSource,
  type ParsedEpisode,
  type PlayerEngine,
  type PlayerSnapshot,
  type SleepTimer,
  type SleepTimerState,
} from '@minipod/core';
import { nonEmptyUrl } from '../components/m3';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useT } from '../i18n';
import { formatClock } from '../lib/format';
import { deriveEpisodeKey } from '../lib/identity';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
import { HtmlAudioEngine } from './HtmlAudioEngine';
import {
  clampSpeed,
  computeResumePositionMs,
  findActiveChapterIndex,
  isEpisodeNearEnd,
  nextSpeedPreset,
} from './PlayerEngine';

export interface PlayEpisodeOptions {
  readonly feedTitle?: string | undefined;
  readonly feedImageUrl?: string | undefined;
  readonly inlineChapters?: readonly Chapter[] | undefined;
  readonly startAtZero?: boolean | undefined;
}

export interface PlayerContextValue {
  readonly engine: PlayerEngine;
  readonly episode: Episode | null;
  readonly feedTitle: string;
  readonly artworkUrl: string | undefined;
  readonly episodeArtworkUrl: string | undefined;
  readonly fallbackArtworkUrl: string | undefined;
  readonly snapshot: PlayerSnapshot;
  readonly sleepTimer: SleepTimerState;
  readonly muted: boolean;
  readonly chapters: readonly Chapter[];
  readonly activeChapterIndex: number;
  playEpisode(episode: Episode, options?: PlayEpisodeOptions): Promise<void>;
  playPreviewEpisode(preview: FeedPreview, parsed: ParsedEpisode): Promise<void>;
  togglePlayPause(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seekTo(ms: number): void;
  skipBack(): void;
  skipForward(): void;
  cycleSpeed(): void;
  setSpeed(speed: number): void;
  setSleepTimer(timer: SleepTimer): void;
  setSleepTimerEndOfChapter(): void;
  toggleMute(): void;
  prevChapter(): void;
  nextChapter(): void;
  attachVideoSurface(el: HTMLElement | null): void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({
  engine,
  children,
}: {
  readonly engine: PlayerEngine;
  readonly children: ReactNode;
}) {
  const host = useHost();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  const configuredSpeed = useSettingsStore((s) => s.settings.playbackSpeed);
  const updateSettings = useSettingsStore((s) => s.update);

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [feedTitle, setFeedTitle] = useState('');
  const [episodeImageUrl, setEpisodeImageUrl] = useState<string | undefined>(undefined);
  const [feedImageUrl, setFeedImageUrl] = useState<string | undefined>(undefined);
  const [chapterArtworkUrl, setChapterArtworkUrl] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => engine.getSnapshot());
  const [sleepTimer, setSleepTimerState] = useState<SleepTimerState>({ timer: { mode: 'off' } });
  const [muted, setMuted] = useState(false);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);

  const episodeRef = useRef<Episode | null>(null);
  episodeRef.current = episode;
  const snapshotRef = useRef<PlayerSnapshot>(snapshot);
  snapshotRef.current = snapshot;
  const sleepTimerRef = useRef<SleepTimerState>(sleepTimer);
  sleepTimerRef.current = sleepTimer;
  const lastSavedAtRef = useRef(0);
  const suppressAutoAdvanceForKeyRef = useRef<string | null>(null);

  const syncNativeQueue = useCallback(async () => {
    if (!engine.capabilities.nativeQueue || !engine.setQueue) return;
    try {
      const items = await host.playback.queueSources();
      engine.setQueue(items);
    } catch {
      // ignore
    }
  }, [engine, host]);

  const saveProgressSafe = useCallback(
    (params: {
      readonly episodeKey: string;
      readonly positionMs: number;
      readonly durationMs?: number | undefined;
      readonly state: 'IN_PROGRESS' | 'PLAYED';
      readonly flush?: boolean | undefined;
    }) => {
      lastSavedAtRef.current = Date.now();
      void host.progress
        .save({
          episodeKey: params.episodeKey,
          positionMs: Math.max(0, Math.floor(params.positionMs)),
          state: params.state,
          ...(params.durationMs !== undefined ? { durationMs: Math.floor(params.durationMs) } : {}),
          ...(params.flush ? { flush: true } : {}),
        })
        .catch(() => undefined);
    },
    [host],
  );

  const playEpisode = useCallback(
    async (target: Episode, options?: PlayEpisodeOptions): Promise<void> => {
      // Save current episode progress before switching
      const prevEp = episodeRef.current;
      const prevSnap = snapshotRef.current;
      if (prevEp && prevEp.episodeKey !== target.episodeKey && prevSnap.positionMs > 0) {
        saveProgressSafe({
          episodeKey: prevEp.episodeKey,
          positionMs: prevSnap.positionMs,
          durationMs: prevSnap.durationMs ?? prevEp.durationMs,
          state: 'IN_PROGRESS',
        });
      }

      // Ensure episode is at head of queue if not already queued (DESIGN.md §4.5)
      try {
        const currentQueue = await host.queue.list();
        const alreadyQueued = currentQueue.some((r) => r.episode.episodeKey === target.episodeKey);
        if (!alreadyQueued) {
          const prevHeadKey = currentQueue[0]?.episode.episodeKey;
          await host.queue.add(target.episodeKey);
          if (prevHeadKey && prevHeadKey !== target.episodeKey) {
            await host.queue.move(target.episodeKey, prevHeadKey);
          }
        }
      } catch {
        // Preview episode whose feed stub was not materialized in DB yet can still stream directly
      }

      // Resolve feed metadata whenever feedTitle or feedImageUrl is missing/empty
      let resolvedFeedTitle = nonEmptyUrl(options?.feedTitle) ?? '';
      let resolvedFeedImage = nonEmptyUrl(options?.feedImageUrl);
      if (!resolvedFeedTitle || !resolvedFeedImage) {
        try {
          const feed = await host.feeds.get(target.feedKey);
          resolvedFeedTitle = resolvedFeedTitle || nonEmptyUrl(feed.title) || '';
          resolvedFeedImage = resolvedFeedImage ?? nonEmptyUrl(feed.imageUrl);
        } catch {
          // ignore for unpersisted preview stubs
        }
      }

      // Compute resume point (3s rewind for IN_PROGRESS)
      let startMs = 0;
      if (!options?.startAtZero) {
        try {
          const existingProg = await host.progress.get(target.episodeKey);
          startMs = computeResumePositionMs(existingProg);
        } catch {
          startMs = 0;
        }
      }

      // Resolve media source from host (with enclosure fallback for preview stubs)
      let source: MediaSource;
      try {
        source = await host.playback.sourceFor(target.episodeKey);
      } catch (err) {
        if (target.enclosureUrl) {
          source = {
            kind: 'url',
            url: target.enclosureUrl,
            ...(target.enclosureMime ? { mime: target.enclosureMime } : {}),
          };
        } else {
          throw err;
        }
      }

      const speed = clampSpeed(useSettingsStore.getState().settings.playbackSpeed || 1.0);
      const epImage = nonEmptyUrl(target.imageUrl);
      const artwork = epImage ?? resolvedFeedImage;

      episodeRef.current = target;
      setEpisode(target);
      setFeedTitle(resolvedFeedTitle);
      setEpisodeImageUrl(epImage);
      setFeedImageUrl(resolvedFeedImage);
      setChapterArtworkUrl(undefined);
      setChapters(options?.inlineChapters ?? []);
      suppressAutoAdvanceForKeyRef.current = null;

      await engine.load({
        episodeKey: target.episodeKey,
        source,
        startMs,
        speed,
        mediaType: target.mediaType,
        metadata: {
          title: target.title,
          ...(resolvedFeedTitle ? { artist: resolvedFeedTitle, album: resolvedFeedTitle } : {}),
          ...(artwork ? { artworkUrl: artwork } : {}),
          ...(target.durationMs !== undefined ? { durationMs: target.durationMs } : {}),
        },
      });
      await engine.play();
      lastSavedAtRef.current = Date.now();

      // Load merged chapters asynchronously
      void host.episodes
        .chapters(target.episodeKey)
        .then((loaded) => {
          if (episodeRef.current?.episodeKey === target.episodeKey && loaded.length > 0) {
            setChapters(loaded);
          }
        })
        .catch(() => undefined);

      void syncNativeQueue();
    },
    [engine, host, saveProgressSafe, syncNativeQueue],
  );

  const playEpisodeRef = useRef(playEpisode);
  playEpisodeRef.current = playEpisode;

  const playPreviewEpisode = useCallback(
    async (preview: FeedPreview, parsed: ParsedEpisode): Promise<void> => {
      const epKey = deriveEpisodeKey(preview.feedKey, parsed.identity);
      const parsedEpImage = nonEmptyUrl(parsed.imageUrl);
      const previewFeedImage = nonEmptyUrl(preview.parsed.imageUrl);
      let epToPlay: Episode | undefined;
      try {
        const row = await host.episodes.get(epKey);
        epToPlay =
          !nonEmptyUrl(row.episode.imageUrl) && parsedEpImage
            ? { ...row.episode, imageUrl: parsedEpImage }
            : row.episode;
      } catch {
        epToPlay = {
          episodeKey: epKey,
          feedKey: preview.feedKey,
          identity: parsed.identity,
          isStub: true,
          title: parsed.title,
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          ...(parsed.link !== undefined ? { link: parsed.link } : {}),
          ...(parsedEpImage !== undefined
            ? { imageUrl: parsedEpImage }
            : previewFeedImage !== undefined
              ? { imageUrl: previewFeedImage }
              : {}),
          ...(parsed.pubDate !== undefined ? { pubDate: parsed.pubDate } : {}),
          ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
          ...(parsed.enclosureUrl !== undefined ? { enclosureUrl: parsed.enclosureUrl } : {}),
          ...(parsed.enclosureMime !== undefined ? { enclosureMime: parsed.enclosureMime } : {}),
          ...(parsed.enclosureSize !== undefined ? { enclosureSize: parsed.enclosureSize } : {}),
          mediaType: parsed.mediaType,
          ...(parsed.chaptersUrl !== undefined ? { chaptersUrl: parsed.chaptersUrl } : {}),
          ...(parsed.chaptersType !== undefined ? { chaptersType: parsed.chaptersType } : {}),
          ...(parsed.transcriptUrl !== undefined ? { transcriptUrl: parsed.transcriptUrl } : {}),
          ...(parsed.transcriptType !== undefined ? { transcriptType: parsed.transcriptType } : {}),
          downloadState: 'NONE',
        };
      }
      await playEpisode(epToPlay, {
        feedTitle: nonEmptyUrl(preview.parsed.title) ?? preview.url,
        feedImageUrl: previewFeedImage,
        inlineChapters: parsed.chapters,
      });
    },
    [host, playEpisode],
  );

  // Sync speed when settings load/change
  useEffect(() => {
    const clamped = clampSpeed(configuredSpeed);
    if (Math.abs(engine.getSnapshot().speed - clamped) >= 0.01) {
      engine.setSpeed(clamped);
    }
  }, [configuredSpeed, engine]);

  // Subscribe to PlayerEngine events
  useEffect(() => {
    return engine.subscribe((ev) => {
      if (ev.type === 'state') {
        const prev = snapshotRef.current;
        setSnapshot(ev.snapshot);

        // Save immediately on transition from playing -> paused
        if (prev.playing && !ev.snapshot.playing && ev.snapshot.episodeKey) {
          const dur = ev.snapshot.durationMs ?? episodeRef.current?.durationMs;
          const completed = isEpisodeNearEnd(ev.snapshot.positionMs, dur);
          const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
          saveProgressSafe({
            episodeKey: ev.snapshot.episodeKey,
            positionMs: completed ? 0 : ev.snapshot.positionMs,
            durationMs: dur,
            state: completed ? 'PLAYED' : 'IN_PROGRESS',
            flush: isHidden,
          });
        }
      } else if (ev.type === 'position') {
        setSnapshot((s) => ({
          ...s,
          episodeKey: ev.episodeKey,
          positionMs: ev.positionMs,
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        }));
        const now = Date.now();
        if (now - lastSavedAtRef.current >= LOCAL_PROGRESS_INTERVAL_MS) {
          saveProgressSafe({
            episodeKey: ev.episodeKey,
            positionMs: ev.positionMs,
            durationMs: ev.durationMs ?? episodeRef.current?.durationMs,
            state: 'IN_PROGRESS',
          });
        }
      } else if (ev.type === 'sleepTimer') {
        setSleepTimerState(ev.state);
      } else if (ev.type === 'ended') {
        const dur = snapshotRef.current.durationMs ?? episodeRef.current?.durationMs;
        const sleepWasEndOfEp = sleepTimerRef.current.timer.mode === 'endOfEpisode';
        const htmlConsumedSleep =
          engine instanceof HtmlAudioEngine ? engine.consumeSleepExpired() : false;
        const suppressAdvance =
          sleepWasEndOfEp ||
          htmlConsumedSleep ||
          suppressAutoAdvanceForKeyRef.current === ev.episodeKey;

        // Mark completed (host also auto-removes from queue & deletes download if configured)
        void host.progress
          .save({
            episodeKey: ev.episodeKey,
            positionMs: 0,
            state: 'PLAYED',
            ...(dur !== undefined ? { durationMs: dur } : {}),
          })
          .then(async () => {
            if (suppressAdvance) {
              setSleepTimerState({ timer: { mode: 'off' } });
              return;
            }
            const remainingQueue = await host.queue.list();
            const nextRow = remainingQueue.find((r) => r.episode.episodeKey !== ev.episodeKey);
            if (nextRow) {
              const stubTitle = nonEmptyUrl(nextRow.entry.stub?.feedTitle);
              const stubImage = nonEmptyUrl(nextRow.entry.stub?.imageUrl);
              let nextFeedTitle = stubTitle;
              let nextFeedImage: string | undefined;
              try {
                const feed = await host.feeds.get(nextRow.episode.feedKey);
                nextFeedTitle = nextFeedTitle ?? nonEmptyUrl(feed.title);
                nextFeedImage = nonEmptyUrl(feed.imageUrl) ?? stubImage;
              } catch {
                nextFeedImage = stubImage;
              }
              await playEpisodeRef.current(nextRow.episode, {
                feedTitle: nextFeedTitle,
                feedImageUrl: nextFeedImage,
              });
            }
          })
          .catch(() => undefined);
      } else if (ev.type === 'nativeAdvanced') {
        void (async () => {
          try {
            const [row, qList] = await Promise.all([
              host.episodes.get(ev.to),
              host.queue.list().catch(() => [] as const),
            ]);
            const qMatch = qList.find((q) => q.episode.episodeKey === ev.to);
            const stub = qMatch?.entry.stub;
            let nextFeedTitle = nonEmptyUrl(stub?.feedTitle);
            let nextFeedImage: string | undefined;
            try {
              const feed = await host.feeds.get(row.episode.feedKey);
              nextFeedTitle = nextFeedTitle ?? nonEmptyUrl(feed.title);
              nextFeedImage = nonEmptyUrl(feed.imageUrl) ?? nonEmptyUrl(stub?.imageUrl);
            } catch {
              nextFeedImage = nonEmptyUrl(stub?.imageUrl);
            }
            const epImage = nonEmptyUrl(row.episode.imageUrl);
            episodeRef.current = row.episode;
            setEpisode(row.episode);
            setFeedTitle(nextFeedTitle ?? '');
            setEpisodeImageUrl(epImage);
            setFeedImageUrl(nextFeedImage);
            setChapterArtworkUrl(undefined);
            const chs = await host.episodes.chapters(ev.to).catch(() => []);
            if (episodeRef.current?.episodeKey === ev.to) {
              setChapters(chs);
            }
          } catch {
            // ignore
          }
        })();
      }
    });
  }, [engine, host, saveProgressSafe]);

  // Flush progress on `pagehide` / hidden visibility change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPageHide = () => {
      const snap = engine.getSnapshot();
      if (snap.episodeKey && snap.positionMs > 0) {
        saveProgressSafe({
          episodeKey: snap.episodeKey,
          positionMs: snap.positionMs,
          durationMs: snap.durationMs ?? episodeRef.current?.durationMs,
          state: 'IN_PROGRESS',
          flush: true,
        });
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [engine, saveProgressSafe]);

  // Listen to HostEvents: queue sync for native engines + Cross-Device Resume Undo snackbar!
  useHostEvents((event) => {
    if (event.type === 'queue-changed') {
      void syncNativeQueue();
    } else if (event.type === 'progress-changed' && event.fromSync) {
      const curEp = episodeRef.current;
      if (!curEp || curEp.episodeKey !== event.episodeKey) return;

      const { deviceName, positionMs: remotePosMs, state: remoteState } = event.fromSync;
      if (remoteState === 'PLAYED') {
        // ARCHITECTURE.md §7.6: do not stop playback; suppress auto-advance for this item
        suppressAutoAdvanceForKeyRef.current = event.episodeKey;
        return;
      }

      const previousPositionMs = engine.getSnapshot().positionMs;
      engine.seekTo(remotePosMs);
      const timeLabel = formatClock(remotePosMs);
      showSnackbar(
        tRef.current('player.resumedFrom', { device: deviceName, time: timeLabel }),
        {
          action: {
            label: tRef.current('common.undo'),
            run: () => {
              engine.seekTo(previousPositionMs);
              void host.sync.undoResume(event.episodeKey, previousPositionMs).catch(() => undefined);
            },
          },
          durationMs: 8000,
        },
      );
    }
  });

  const activeChapterIndex = useMemo(
    () => findActiveChapterIndex(chapters, snapshot.positionMs),
    [chapters, snapshot.positionMs],
  );

  // Resolve chapter-specific image when active chapter changes (DESIGN.md §4.6)
  useEffect(() => {
    const curEp = episode;
    if (!curEp || activeChapterIndex < 0) {
      setChapterArtworkUrl(undefined);
      return;
    }
    const ch = chapters[activeChapterIndex];
    if (!ch || (!ch.imageUrl && !ch.embeddedImage)) {
      setChapterArtworkUrl(undefined);
      return;
    }
    let alive = true;
    void host.episodes
      .chapterImage(curEp.episodeKey, activeChapterIndex)
      .then((url) => {
        if (alive) setChapterArtworkUrl(nonEmptyUrl(url) ?? nonEmptyUrl(ch.imageUrl));
      })
      .catch(() => {
        if (alive) setChapterArtworkUrl(nonEmptyUrl(ch.imageUrl));
      });
    return () => {
      alive = false;
    };
  }, [episode, activeChapterIndex, chapters, host]);

  const togglePlayPause = useCallback(async () => {
    if (!episodeRef.current) return;
    if (engine.getSnapshot().playing) {
      engine.pause();
    } else {
      await engine.play();
    }
  }, [engine]);

  const play = useCallback(async () => {
    if (!episodeRef.current) return;
    await engine.play();
  }, [engine]);

  const pause = useCallback(() => {
    engine.pause();
  }, [engine]);

  const seekTo = useCallback(
    (ms: number) => {
      engine.seekTo(ms);
      const snap = engine.getSnapshot();
      if (snap.episodeKey) {
        saveProgressSafe({
          episodeKey: snap.episodeKey,
          positionMs: snap.positionMs,
          durationMs: snap.durationMs ?? episodeRef.current?.durationMs,
          state: 'IN_PROGRESS',
        });
      }
    },
    [engine, saveProgressSafe],
  );

  const skipBack = useCallback(() => {
    seekTo(engine.getSnapshot().positionMs - SKIP_BACK_MS);
  }, [engine, seekTo]);

  const skipForward = useCallback(() => {
    seekTo(engine.getSnapshot().positionMs + SKIP_FORWARD_MS);
  }, [engine, seekTo]);

  const setSpeed = useCallback(
    (next: number) => {
      const clamped = clampSpeed(next);
      engine.setSpeed(clamped);
      void updateSettings(host, { playbackSpeed: clamped }).catch(() => undefined);
    },
    [engine, host, updateSettings],
  );

  const cycleSpeed = useCallback(() => {
    setSpeed(nextSpeedPreset(engine.getSnapshot().speed));
  }, [engine, setSpeed]);

  const setSleepTimer = useCallback(
    (timer: SleepTimer) => {
      engine.setSleepTimer(timer);
      setSleepTimerState((prev) => ({
        timer,
        ...(timer.mode === 'minutes' ? { remainingMs: timer.minutes * 60_000 } : prev.remainingMs !== undefined ? { remainingMs: prev.remainingMs } : {}),
      }));
    },
    [engine],
  );

  const setSleepTimerEndOfChapter = useCallback(() => {
    if (chapters.length === 0) return;
    const idx = activeChapterIndex >= 0 ? activeChapterIndex : 0;
    const nextCh = chapters[idx + 1];
    const chapterEndMs =
      nextCh?.startMs ?? snapshotRef.current.durationMs ?? episodeRef.current?.durationMs ?? 0;
    if (chapterEndMs > 0) {
      setSleepTimer({ mode: 'endOfChapter', chapterEndMs });
    }
  }, [chapters, activeChapterIndex, setSleepTimer]);

  const toggleMute = useCallback(() => {
    if (engine instanceof HtmlAudioEngine) {
      setMuted(engine.toggleMute());
    } else {
      setMuted((m) => !m);
    }
  }, [engine]);

  const prevChapter = useCallback(() => {
    if (chapters.length === 0) {
      skipBack();
      return;
    }
    const idx = activeChapterIndex >= 0 ? activeChapterIndex : 0;
    const currentCh = chapters[idx];
    if (currentCh && snapshotRef.current.positionMs - currentCh.startMs > 3000) {
      seekTo(currentCh.startMs);
    } else if (idx > 0) {
      seekTo(chapters[idx - 1]!.startMs);
    } else {
      seekTo(0);
    }
  }, [chapters, activeChapterIndex, seekTo, skipBack]);

  const nextChapter = useCallback(() => {
    if (chapters.length === 0) {
      skipForward();
      return;
    }
    const idx = activeChapterIndex >= 0 ? activeChapterIndex : 0;
    if (idx + 1 < chapters.length) {
      seekTo(chapters[idx + 1]!.startMs);
    }
  }, [chapters, activeChapterIndex, seekTo, skipForward]);

  useEffect(() => {
    if (engine instanceof HtmlAudioEngine) {
      engine.setTrackHandlers({ onNext: nextChapter, onPrev: prevChapter });
    }
  }, [engine, nextChapter, prevChapter]);

  const attachVideoSurface = useCallback(
    (el: HTMLElement | null) => {
      if (engine instanceof HtmlAudioEngine) {
        engine.attachVideoSurface(el);
      } else if (el && engine.attachVideoSurface) {
        engine.attachVideoSurface(el);
      }
    },
    [engine],
  );

  const primaryArtworkUrl =
    nonEmptyUrl(chapterArtworkUrl) ?? nonEmptyUrl(episodeImageUrl) ?? nonEmptyUrl(feedImageUrl);
  const resolvedEpisodeArtworkUrl = nonEmptyUrl(episodeImageUrl);
  const resolvedFallbackArtworkUrl = nonEmptyUrl(feedImageUrl);

  const value = useMemo<PlayerContextValue>(
    () => ({
      engine,
      episode,
      feedTitle,
      artworkUrl: primaryArtworkUrl,
      episodeArtworkUrl: resolvedEpisodeArtworkUrl,
      fallbackArtworkUrl: resolvedFallbackArtworkUrl,
      snapshot,
      sleepTimer,
      muted,
      chapters,
      activeChapterIndex,
      playEpisode,
      playPreviewEpisode,
      togglePlayPause,
      play,
      pause,
      seekTo,
      skipBack,
      skipForward,
      cycleSpeed,
      setSpeed,
      setSleepTimer,
      setSleepTimerEndOfChapter,
      toggleMute,
      prevChapter,
      nextChapter,
      attachVideoSurface,
    }),
    [
      engine,
      episode,
      feedTitle,
      primaryArtworkUrl,
      resolvedEpisodeArtworkUrl,
      resolvedFallbackArtworkUrl,
      snapshot,
      sleepTimer,
      muted,
      chapters,
      activeChapterIndex,
      playEpisode,
      playPreviewEpisode,
      togglePlayPause,
      play,
      pause,
      seekTo,
      skipBack,
      skipForward,
      cycleSpeed,
      setSpeed,
      setSleepTimer,
      setSleepTimerEndOfChapter,
      toggleMute,
      prevChapter,
      nextChapter,
      attachVideoSurface,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer() called outside <PlayerProvider>');
  }
  return ctx;
}
