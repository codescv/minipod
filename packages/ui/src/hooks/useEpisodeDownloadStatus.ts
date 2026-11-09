/**
 * Live per-episode download status for rows that are not re-fetched on every progress tick
 * (`EpisodeRow` in Podcast detail / timeline / Manage Downloads).
 *
 * - `state`: the latest `download-updated` state for this episode, falling back to the row's
 *   persisted `downloadState` once the parent re-fetches a different value. A user-requested stop
 *   (`markStopped`, see `beginDownloadStop`) reads as `NONE` until the host confirmed it, even if a
 *   parent snapshot fetched mid-stop still says `QUEUED` / `RUNNING`.
 * - `ratio`: last known download ratio (`0..1`) from the shared `HostViewCache`
 *   (`downloadProgressByKey`), so remounts never flash back to `0%`.
 * - `markStopped()`: optimistically flips to `NONE` and starts the stop guard; call
 *   `endDownloadStop(host, episodeKey)` once `deleteDownload` settles.
 */
import { useCallback, useRef, useState } from 'react';
import type { DownloadState, EpisodeKey } from '@minipod/core';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import {
  applyDownloadProgressToViewCache,
  beginDownloadStop,
  getHostViewCache,
  guardStoppedDownloadState,
} from '../stores/view-cache';

interface LiveDownloadState {
  /** Persisted row state when the event arrived; the live state is dropped once it changes. */
  readonly base: DownloadState;
  readonly state: DownloadState;
}

export function useEpisodeDownloadStatus(
  episodeKey: EpisodeKey,
  baseState: DownloadState,
): {
  readonly state: DownloadState;
  readonly ratio: number | undefined;
  readonly markStopped: () => void;
} {
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

  const markStopped = useCallback(() => {
    beginDownloadStop(host, episodeKey);
    setLive({ base: baseRef.current, state: 'NONE' });
  }, [host, episodeKey]);

  const rawState = live !== null && live.base === baseState ? live.state : baseState;
  return {
    state: guardStoppedDownloadState(host, episodeKey, rawState),
    ratio: getHostViewCache(host).downloadProgressByKey.get(episodeKey),
    markStopped,
  };
}
