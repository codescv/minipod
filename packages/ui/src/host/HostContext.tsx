/**
 * React context delivering the `PlatformHost` to every UI component.
 * Components MUST access the host solely via `useHost()` (ARCHITECTURE.md §5.0).
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformHost } from '@minipod/core';

const HostContext = createContext<PlatformHost | null>(null);

export function HostProvider({
  host,
  children,
}: {
  readonly host: PlatformHost;
  readonly children: ReactNode;
}) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): PlatformHost {
  const host = useContext(HostContext);
  if (!host) {
    throw new Error('useHost() called outside <HostProvider>');
  }
  return host;
}

export function useOptionalHost(): PlatformHost | null {
  return useContext(HostContext);
}
