/**
 * Live per-episode download status for rows that are not re-fetched on every progress tick
 * (`EpisodeRow` in Podcast detail / timeline / Manage Downloads).
 *
 * - `state`: the latest `download-updated` state for this episode, falling back to the row's
 *   persisted `downloadState` once the parent re-fetches a different value.
 * - `ratio`: last known download ratio (`0..1`) from the shared `HostViewCache`
 *   (`downloadProgressByKey`), so remounts never flash back to `0%`.
 */
import { useRef, useState } from 'react';
import type { DownloadState, EpisodeKey } from '@minipod/core';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { applyDownloadProgressToViewCache, getHostViewCache } from '../stores/view-cache';

interface LiveDownloadState {
  /** Persisted row state when the event arrived; the live state is dropped once it changes. */
  readonly base: DownloadState;
  readonly state: DownloadState;
}

export function useEpisodeDownloadStatus(
  episodeKey: EpisodeKey,
  baseState: DownloadState,
): { readonly state: DownloadState; readonly ratio: number | undefined } {
  const host = useHost();
  const baseRef = useRef(baseState);
  baseRef.current = baseState;
  const [live, setLive] = useState<LiveDownloadState | null>(null);

  useHostEvents((ev) => {
    if (ev.type !== 'download-updated' || ev.episodeKey !== episodeKey) return;
    applyDownloadProgressToViewCache(host, ev.episodeKey, ev.state, ev.progress);
    // A fresh object on every sample re-renders progress-only ticks (same state, new ratio).
    setLive({ base: baseRef.current, state: ev.state });
  });

  return {
    state: live !== null && live.base === baseState ? live.state : baseState,
    ratio: getHostViewCache(host).downloadProgressByKey.get(episodeKey),
  };
}
