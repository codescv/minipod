/**
 * LIFO back-navigation stack (`window.__minipodHandleBack`), unwinding:
 *   dialogs / menus -> secondary sheets -> expanded player / side sheet -> detail / preview / add / sync -> root tab -> false.
 */
import { useEffect, useRef } from 'react';
import { useRouteStore } from './routes';

declare global {
  interface Window {
    __minipodHandleBack?: () => boolean;
  }
}

export type BackInterceptor = () => boolean;

const interceptors: BackInterceptor[] = [];

export function registerBackInterceptor(fn: BackInterceptor): () => void {
  interceptors.push(fn);
  return () => {
    const idx = interceptors.lastIndexOf(fn);
    if (idx >= 0) interceptors.splice(idx, 1);
  };
}

export function useBackInterceptor(fn: BackInterceptor, enabled = true): void {
  const fnRef = useRef<BackInterceptor>(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return registerBackInterceptor(() => fnRef.current());
  }, [enabled]);
}

export function dispatchBackNavigation(): boolean {
  // 1. LIFO dialogs, menus, secondary modals/sheets
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const fn = interceptors[i];
    if (fn && fn()) {
      return true;
    }
  }

  // 2. Expanded player / side sheet / route stack -> root
  return useRouteStore.getState().goBack();
}

export function installGlobalBackHandler(): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (): boolean => dispatchBackNavigation();
  window.__minipodHandleBack = handler;

  const onDocBack = (e: Event): void => {
    if (handler()) {
      e.preventDefault();
    }
  };

  const onPopState = (): void => {
    if (handler()) {
      try {
        window.history.pushState({ minipod: true }, '');
      } catch {
        // ignore in restricted environments
      }
    }
  };

  try {
    window.history.replaceState({ minipod: true }, '');
  } catch {
    // ignore
  }

  document.addEventListener('backbutton', onDocBack);
  window.addEventListener('popstate', onPopState);

  return () => {
    if (window.__minipodHandleBack === handler) {
      delete window.__minipodHandleBack;
    }
    document.removeEventListener('backbutton', onDocBack);
    window.removeEventListener('popstate', onPopState);
  };
}
