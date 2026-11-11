/**
 * Decides whether a list screen (`SubscriptionsGrid`, `PodcastDetail`, `DownloadsPage`,
 * `QueueList`) must re-query IndexedDB for a host event, so scrolling stays smooth during
 * downloads and playback on iOS + Android:
 *
 * - `download-updated` progress-only samples (`RUNNING -> RUNNING`, ~2–6/s per download) are
 *   ignored at the list level: the downloading row updates its own `%` badge through
 *   `useEpisodeDownloadStatus`. Real state transitions (`QUEUED`, first `RUNNING`, `DONE`,
 *   `FAILED`, `NONE`) still reload.
 * - `progress-changed` 5 s checkpoints of the episode that is currently playing (no `fromSync`)
 *   are ignored; one deferred reload runs as soon as playback pauses/stops or the current episode
 *   changes, so the list always converges (e.g. completion state). Sync events, events while
 *   paused and events for any other episode (Mark played / Undo, finished episode) reload at once.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { DownloadState, EpisodeKey, HostEvent } from '@minipod/core';
import { useOptionalPlayerState } from '../player/usePlayer';

export type ListReloadFilter = (event: HostEvent) => boolean;

export function useListReloadFilter(reload: () => void): ListReloadFilter {
  // Optional: outside `<PlayerProvider>` only the download filtering applies.
  const player = useOptionalPlayerState();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const currentKey = player?.episode?.episodeKey;
  const playing = player?.playing ?? false;
  const engine = player?.engine;
  const liveRef = useRef({ engine, currentKey, playing });
  liveRef.current = { engine, currentKey, playing };

  const downloadStatesRef = useRef(new Map<EpisodeKey, DownloadState>());
  const pendingCheckpointRef = useRef(false);

  useEffect(() => {
    if (!pendingCheckpointRef.current) return;
    if (playing && currentKey !== undefined) return;
    pendingCheckpointRef.current = false;
    reloadRef.current();
  }, [playing, currentKey]);

  // Episode switched while still playing (auto-advance): flush a skipped checkpoint once.
  const lastKeyRef = useRef(currentKey);
  useEffect(() => {
    if (lastKeyRef.current === currentKey) return;
    lastKeyRef.current = currentKey;
    if (pendingCheckpointRef.current) {
      pendingCheckpointRef.current = false;
      reloadRef.current();
    }
  }, [currentKey]);

  return useCallback<ListReloadFilter>((ev) => {
    if (ev.type === 'download-updated') {
      const states = downloadStatesRef.current;
      const prev = states.get(ev.episodeKey);
      if (ev.state === 'NONE' || ev.state === 'DONE') {
        states.delete(ev.episodeKey);
      } else {
        states.set(ev.episodeKey, ev.state);
      }
      return !(prev === 'RUNNING' && ev.state === 'RUNNING');
    }
    if (ev.type === 'progress-changed') {
      if (ev.fromSync) return true;
      const live = liveRef.current;
      if (live.currentKey === undefined || ev.episodeKey !== live.currentKey) return true;
      let enginePlaying = live.playing;
      try {
        const snap = live.engine?.getSnapshot();
        if (snap) {
          enginePlaying = snap.playing && (snap.episodeKey ?? live.currentKey) === ev.episodeKey;
        }
      } catch {
        // fall back to the React state
      }
      if (live.playing && enginePlaying) {
        pendingCheckpointRef.current = true;
        return false;
      }
      return true;
    }
    return true;
  }, []);
}
