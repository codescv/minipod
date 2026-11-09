/**
 * Subscribe to `PlatformHost` push events for the lifetime of a component.
 *
 * `download-updated` events made stale by a user-requested stop (`停止下载` / `停止全部`, see
 * `beginDownloadStop`) are dropped here, so no screen / SWR slice reverts a stopped download to
 * `QUEUED` / `RUNNING` because of a progress tick or auto-retry emitted before the host processed
 * the cancellation.
 */
import { useEffect, useRef } from 'react';
import type { HostEvent } from '@minipod/core';
import { isStaleDownloadEvent } from '../stores/view-cache';
import { useHost } from './HostContext';

type EventOf<T extends HostEvent['type']> = Extract<HostEvent, { type: T }>;

export function useHostEvents(listener: (event: HostEvent) => void): void {
  const host = useHost();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(
    () =>
      host.subscribe((e) => {
        if (e.type === 'download-updated' && isStaleDownloadEvent(host, e.episodeKey, e.state)) {
          return;
        }
        ref.current(e);
      }),
    [host],
  );
}

export function useHostEvent<T extends HostEvent['type']>(
  type: T,
  listener: (event: EventOf<T>) => void,
): void {
  useHostEvents((e) => {
    if (e.type === type) {
      listener(e as EventOf<T>);
    }
  });
}
