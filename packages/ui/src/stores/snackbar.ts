/**
 * Minimalist M3 Snackbar queue store (supports Undo actions for Queue remove,
 * Swipe-to-queue, and Cross-device Resume Undo).
 */
import { create } from 'zustand';

export type SnackbarTone = 'info' | 'warning' | 'error';

export interface SnackbarAction {
  readonly label: string;
  readonly run: () => void;
}

export interface SnackbarItem {
  readonly id: number;
  readonly text: string;
  readonly tone: SnackbarTone;
  readonly action?: SnackbarAction | undefined;
  readonly durationMs?: number | undefined;
}

interface SnackbarState {
  readonly queue: readonly SnackbarItem[];
  push(text: string, options?: { readonly tone?: SnackbarTone; readonly action?: SnackbarAction; readonly durationMs?: number }): number;
  dismiss(id: number): void;
  clear(): void;
}

let nextSnackId = 1;

export const useSnackbarStore = create<SnackbarState>()((set) => ({
  queue: [],
  push: (text, options) => {
    const id = nextSnackId++;
    const item: SnackbarItem = {
      id,
      text,
      tone: options?.tone ?? 'info',
      ...(options?.action ? { action: options.action } : {}),
      ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    };
    set((s) => ({
      // Replace head when an action snackbar arrives so Undo is immediately visible
      queue: options?.action ? [item, ...s.queue.slice(0, 2)] : [...s.queue, item],
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ queue: s.queue.filter((x) => x.id !== id) })),
  clear: () => set({ queue: [] }),
}));

export function showSnackbar(
  text: string,
  options?: { readonly tone?: SnackbarTone; readonly action?: SnackbarAction; readonly durationMs?: number },
): number {
  return useSnackbarStore.getState().push(text, options);
}
