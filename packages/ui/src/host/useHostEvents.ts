/**
 * Subscribe to `PlatformHost` push events for the lifetime of a component.
 */
import { useEffect, useRef } from 'react';
import type { HostEvent } from '@minipod/core';
import { useHost } from './HostContext';

type EventOf<T extends HostEvent['type']> = Extract<HostEvent, { type: T }>;

export function useHostEvents(listener: (event: HostEvent) => void): void {
  const host = useHost();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => host.subscribe((e) => ref.current(e)), [host]);
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
