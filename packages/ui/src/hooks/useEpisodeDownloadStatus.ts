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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadState, EpisodeKey, HostEvent, PlatformHost } from '@minipod/core';
import { useHost } from '../host/HostContext';
import {
  applyDownloadProgressToViewCache,
  beginDownloadStop,
  getHostViewCache,
  guardStoppedDownloadState,
  isStaleDownloadEvent,
} from '../stores/view-cache';

type DownloadUpdatedEvent = Extract<HostEvent, { type: 'download-updated' }>;
type DownloadListener = (ev: DownloadUpdatedEvent) => void;

interface DownloadEventHub {
  readonly byKey: Map<EpisodeKey, Set<DownloadListener>>;
  unsubscribe: (() => void) | null;
}

/**
 * One shared `host.subscribe` per `PlatformHost` for all mounted rows: each `download-updated`
 * event is dispatched in O(1) to the listeners of `ev.episodeKey` only (instead of every mounted
 * row running its own host listener on every host event).
 */
const downloadHubs = new WeakMap<PlatformHost, DownloadEventHub>();

function subscribeEpisodeDownload(
  host: PlatformHost,
  episodeKey: EpisodeKey,
  listener: DownloadListener,
): () => void {
  let hub = downloadHubs.get(host);
  if (!hub) {
    hub = { byKey: new Map(), unsubscribe: null };
    downloadHubs.set(host, hub);
  }
  const h = hub;
  if (h.unsubscribe === null) {
    h.unsubscribe = host.subscribe((ev) => {
      if (ev.type !== 'download-updated') return;
      const set = h.byKey.get(ev.episodeKey);
      if (!set || set.size === 0) return;
      if (isStaleDownloadEvent(host, ev.episodeKey, ev.state)) return;
      applyDownloadProgressToViewCache(host, ev.episodeKey, ev.state, ev.progress);
      for (const l of [...set]) l(ev);
    });
  }
  let set = h.byKey.get(episodeKey);
  if (!set) {
    set = new Set();
    h.byKey.set(episodeKey, set);
  }
  set.add(listener);
  return () => {
    const cur = h.byKey.get(episodeKey);
    if (cur) {
      cur.delete(listener);
      if (cur.size === 0) h.byKey.delete(episodeKey);
    }
    if (h.byKey.size === 0 && h.unsubscribe !== null) {
      const unsub = h.unsubscribe;
      h.unsubscribe = null;
      unsub();
    }
  };
}

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

  useEffect(
    () =>
      subscribeEpisodeDownload(host, episodeKey, (ev) => {
        // A fresh object on every sample re-renders progress-only ticks (same state, new ratio).
        setLive({ base: baseRef.current, state: ev.state });
      }),
    [host, episodeKey],
  );

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
