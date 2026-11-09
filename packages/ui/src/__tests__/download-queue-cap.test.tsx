/**
 * Download queue capped at 3 concurrent transfers (feedback 4daa0030): the hosts run at most 3
 * downloads (`RUNNING`) and hold the rest as `QUEUED`, promoting them as slots free up (and
 * auto-retrying while staying `RUNNING`).
 *
 * - `下载全部` dispatches every downloadable row at once -> 3 RUNNING (`{percent}%`) + the rest
 *   QUEUED (`Waiting` / `等待中`, still a tappable stop control)
 * - QUEUED -> RUNNING promotion / DONE are reflected live
 * - `停止全部` cancels RUNNING + QUEUED together and is never reverted by a stale promotion /
 *   progress tick or a `loadQueue()` snapshot fetched while `deleteDownload` was in flight
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeKey } from '@minipod/core';
import type { MockPlatformHost } from '../index';
import { getHostViewCache } from '../stores/view-cache';
import { renderMiniPod } from './test-helpers';

const MAX_CONCURRENT = 3;

/**
 * Fake host download scheduler: at most `cap` RUNNING, the rest QUEUED (FIFO promotion).
 * `atomicCancelAll: false` simulates a host without `episodes.cancelAllDownloads` (fallback path:
 * per-episode `deleteDownload`, where cancelling a RUNNING one promotes the next QUEUED one).
 */
function installCappedDownloads(
  host: MockPlatformHost,
  { cap = MAX_CONCURRENT, atomicCancelAll = true }: { cap?: number; atomicCancelAll?: boolean } = {},
) {
  const running: EpisodeKey[] = [];
  const waiting: EpisodeKey[] = [];
  /** Every slot start (initial or promotion), in order. */
  const started: EpisodeKey[] = [];
  const inflight = new Map<EpisodeKey, { resolve: () => void; reject: (e: Error) => void }>();
  let deleteGate: Promise<void> | null = null;

  const removeFrom = (list: EpisodeKey[], key: EpisodeKey): boolean => {
    const idx = list.indexOf(key);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  };
  const start = (key: EpisodeKey) => {
    running.push(key);
    started.push(key);
    host.setEpisodeDownloadState(key, 'RUNNING');
  };
  const promote = () => {
    while (running.length < cap && waiting.length > 0) start(waiting.shift()!);
  };

  const download = vi.spyOn(host.episodes, 'download').mockImplementation(
    (key) =>
      new Promise<void>((resolve, reject) => {
        inflight.set(key, { resolve, reject });
        if (running.length < cap) {
          start(key);
        } else {
          waiting.push(key);
          host.setEpisodeDownloadState(key, 'QUEUED');
        }
      }),
  );
  const deleteDownload = vi
    .spyOn(host.episodes, 'deleteDownload')
    .mockImplementation(async (key) => {
      if (deleteGate) await deleteGate;
      const wasRunning = removeFrom(running, key);
      removeFrom(waiting, key);
      host.setEpisodeDownloadState(key, 'NONE', 0);
      inflight.get(key)?.reject(new Error('cancelled'));
      inflight.delete(key);
      if (wasRunning) promote();
    });
  const cancel = (key: EpisodeKey) => {
    host.setEpisodeDownloadState(key, 'NONE', 0);
    inflight.get(key)?.reject(new Error('cancelled'));
    inflight.delete(key);
  };
  let cancelAll: ReturnType<typeof vi.fn<() => Promise<void>>> | undefined;
  if (atomicCancelAll) {
    // Atomic: drain the QUEUED ones first, then cancel the RUNNING ones; nothing is promoted.
    cancelAll = vi.fn<() => Promise<void>>(async () => {
      if (deleteGate) await deleteGate;
      for (const key of waiting.splice(0)) cancel(key);
      for (const key of running.splice(0)) cancel(key);
    });
    host.episodes.cancelAllDownloads = cancelAll;
  } else {
    delete (host.episodes as { cancelAllDownloads?: unknown }).cancelAllDownloads;
  }

  return {
    download,
    deleteDownload,
    cancelAll,
    started: () => [...started],
    running: () => [...running],
    waiting: () => [...waiting],
    progress: (key: EpisodeKey, ratio: number) => host.setEpisodeDownloadState(key, 'RUNNING', ratio),
    finish: (key: EpisodeKey) => {
      removeFrom(running, key);
      host.setEpisodeDownloadState(key, 'DONE', 1);
      inflight.get(key)?.resolve();
      inflight.delete(key);
      promote();
    },
    /** Holds every `deleteDownload` until the returned release function is called. */
    holdDeletes: (): (() => void) => {
      let release: () => void = () => undefined;
      deleteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        deleteGate = null;
        release();
      };
    },
  };
}

/** Enqueues downloadable NONE episodes until the queue holds `target` of them. */
async function fillQueueWithDownloadable(host: MockPlatformHost, target: number): Promise<EpisodeKey[]> {
  const isDownloadable = (ep: { feedKey: string; enclosureUrl?: string | undefined }) =>
    !ep.feedKey.startsWith('l_') && Boolean(ep.enclosureUrl);
  const queued = await host.queue.list();
  const keys = queued
    .filter((r) => isDownloadable(r.episode) && r.episode.downloadState === 'NONE')
    .map((r) => r.episode.episodeKey);
  const inQueue = new Set(queued.map((r) => r.episode.episodeKey));
  for (const feed of await host.feeds.list()) {
    if (keys.length >= target) break;
    const page = await host.episodes.list(feed.feedKey, 'all');
    for (const row of page.items) {
      if (keys.length >= target) break;
      const ep = row.episode;
      if (inQueue.has(ep.episodeKey) || !isDownloadable(ep) || ep.downloadState !== 'NONE') continue;
      await host.queue.add(ep.episodeKey);
      inQueue.add(ep.episodeKey);
      keys.push(ep.episodeKey);
    }
  }
  expect(keys.length).toBeGreaterThanOrEqual(target);
  return keys;
}

const badgeOf = (key: EpisodeKey) => screen.queryByTestId(`queue-cache-status-${key}`);

const flush = async (ms = 20) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe('Download queue capped at 3 concurrent (QUEUED waiting state)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('`下载全部` starts 6 downloads at once -> 3 RUNNING + 3 QUEUED (`Waiting`), promotes on finish, and `停止全部` cancels RUNNING + QUEUED without being reverted', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    const keys = await fillQueueWithDownloadable(host, 6);
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    await waitFor(async () => {
      expect(screen.getAllByTestId(/^queue-row-\d+$/).length).toBe((await host.queue.list()).length);
    });
    const capped = installCappedDownloads(host, { atomicCancelAll: false });

    // `下载全部` dispatches every downloadable row concurrently (not one after another)
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    fireEvent.click(screen.getByTestId('queue-download-all'));
    expect(capped.download).toHaveBeenCalledTimes(keys.length);
    for (const key of keys) expect(capped.download).toHaveBeenCalledWith(key);
    expect(capped.running()).toEqual(keys.slice(0, 3));
    expect(capped.waiting()).toEqual(keys.slice(3));

    // 3 RUNNING (`0%`) + 3 QUEUED (`Waiting`, dimmed spinning ring) — all tappable stop controls
    await waitFor(() => {
      for (const key of keys) {
        expect(badgeOf(key)).toHaveAttribute('data-cache-state', 'downloading');
      }
    });
    for (const key of keys.slice(0, 3)) {
      expect(badgeOf(key)).toHaveAttribute('data-download-phase', 'running');
      expect(screen.getByTestId(`queue-cache-percent-${key}`)).toHaveTextContent(/^0%$/);
      expect(screen.queryByTestId(`queue-cache-waiting-${key}`)).not.toBeInTheDocument();
    }
    for (const key of keys.slice(3)) {
      const badge = badgeOf(key)!;
      expect(badge).toHaveAttribute('data-download-phase', 'queued');
      expect(badge).toHaveClass('is-queued');
      expect(badge).toHaveAttribute('role', 'button');
      expect(badge).toHaveAttribute('aria-label', 'Stop download');
      expect(badge.querySelector('svg')).toHaveAttribute('data-ring-waiting', 'true');
      expect(badge.querySelectorAll('rect')).toHaveLength(1);
      expect(screen.getByTestId(`queue-cache-waiting-${key}`)).toHaveTextContent(/^Waiting$/);
      expect(screen.queryByTestId(`queue-cache-percent-${key}`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('queue-stop-all-btn')).toBeInTheDocument();

    // Progress on a RUNNING row; a progress-less auto-retry sample keeps the %
    act(() => capped.progress(keys[0]!, 0.5));
    expect(screen.getByTestId(`queue-cache-percent-${keys[0]}`)).toHaveTextContent(/^50%$/);
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: keys[0]!, state: 'RUNNING' });
    });
    expect(screen.getByTestId(`queue-cache-percent-${keys[0]}`)).toHaveTextContent(/^50%$/);

    // keys[0] finishes -> DONE ✓, and the first QUEUED row (keys[3]) is promoted to RUNNING
    act(() => capped.finish(keys[0]!));
    await waitFor(() => {
      expect(badgeOf(keys[0]!)).toHaveAttribute('data-cache-state', 'done');
    });
    expect(capped.running()).toEqual([keys[1], keys[2], keys[3]]);
    await waitFor(() => {
      expect(badgeOf(keys[3]!)).toHaveAttribute('data-download-phase', 'running');
    });
    act(() => capped.progress(keys[3]!, 0.25));
    expect(screen.getByTestId(`queue-cache-percent-${keys[3]}`)).toHaveTextContent(/^25%$/);
    expect(badgeOf(keys[4]!)).toHaveAttribute('data-download-phase', 'queued');

    // Tapping a QUEUED row's `Waiting` badge stops just that download (without playing)
    fireEvent.pointerDown(badgeOf(keys[5]!)!);
    fireEvent.click(badgeOf(keys[5]!)!);
    await waitFor(() => {
      expect(badgeOf(keys[5]!)).not.toBeInTheDocument();
    });
    expect(capped.deleteDownload).toHaveBeenCalledWith(keys[5]);
    expect(capped.waiting()).toEqual([keys[4]]);
    expect(engine.getSnapshot().playing).toBe(false);
    expect((await host.episodes.get(keys[5]!)).episode.downloadState).toBe('NONE');
    capped.deleteDownload.mockClear();

    // `停止全部` while the host is slow to process the cancellations (host without
    // `cancelAllDownloads`: per-episode fallback, every QUEUED one cancelled BEFORE any RUNNING one)
    const stopped = [keys[1]!, keys[2]!, keys[3]!, keys[4]!];
    const startedBeforeStop = capped.started().length;
    const releaseDeletes = capped.holdDeletes();
    fireEvent.click(screen.getByTestId('queue-stop-all-btn'));
    // Optimistic: every RUNNING + QUEUED row is back to NONE at once
    for (const key of stopped) expect(badgeOf(key)).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    // Only the QUEUED keys[4] is being cancelled until it settles; RUNNING ones wait for it
    expect(capped.deleteDownload.mock.calls.map(([k]) => k)).toEqual([keys[4]]);

    // Stale events from before the host processed the stop (progress tick, auto-retry, QUEUED ->
    // RUNNING promotion) and a stale `loadQueue()` snapshot (host still RUNNING / QUEUED) never
    // revert the rows
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: keys[1]!, state: 'RUNNING', progress: 0.9 });
      host.emit({ type: 'download-updated', episodeKey: keys[2]!, state: 'RUNNING' });
      host.emit({ type: 'download-updated', episodeKey: keys[4]!, state: 'RUNNING', progress: 0 });
    });
    for (const key of stopped) expect(badgeOf(key)).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    expect(getHostViewCache(host).downloadProgressByKey.has(keys[1]!)).toBe(false);
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: keys[3]!, state: 'FAILED' });
      host.emit({ type: 'queue-changed' });
    });
    await flush();
    expect((await host.episodes.get(keys[1]!)).episode.downloadState).toBe('RUNNING');
    for (const key of stopped) expect(badgeOf(key)).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`queue-resume-download-${keys[3]}`)).not.toBeInTheDocument();

    // The host processes the cancellations: QUEUED keys[4] first, then the RUNNING ones, so a
    // freed slot never promotes (starts) a download that is being stopped
    await act(async () => {
      releaseDeletes();
      await Promise.resolve();
    });
    await waitFor(async () => {
      for (const key of stopped) {
        expect((await host.episodes.get(key)).episode.downloadState).toBe('NONE');
      }
    });
    await flush();
    expect(capped.deleteDownload.mock.calls.map(([k]) => k)).toEqual([keys[4], keys[1], keys[2], keys[3]]);
    expect(capped.started().length).toBe(startedBeforeStop);
    expect(capped.running()).toEqual([]);
    expect(capped.waiting()).toEqual([]);
    for (const key of [...stopped, keys[5]!]) {
      expect(badgeOf(key)).not.toBeInTheDocument();
      expect(getHostViewCache(host).downloadProgressByKey.has(key)).toBe(false);
    }
    expect(badgeOf(keys[0]!)).toHaveAttribute('data-cache-state', 'done');
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    // A cancelled download is not a failure: no `下载失败` snackbar, no `继续下载` pills
    expect(screen.queryByTestId('snackbar')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.m-resume-download-chip')).toHaveLength(0);
    expect(engine.getSnapshot().playing).toBe(false);

    // Every row can be downloaded again right away (the stop guard is lifted on restart)
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    expect(screen.getByTestId('queue-download-all')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('queue-download-all'));
    await waitFor(() => {
      for (const key of keys.slice(1)) {
        expect(badgeOf(key)).toHaveAttribute('data-cache-state', 'downloading');
      }
    });
    expect(keys.slice(1).filter((k) => badgeOf(k)?.dataset.downloadPhase === 'running')).toHaveLength(3);
    expect(keys.slice(1).filter((k) => badgeOf(k)?.dataset.downloadPhase === 'queued')).toHaveLength(2);
  });

  it('`停止全部` uses the host\'s atomic `cancelAllDownloads` when available: one call, no per-episode deletes, nothing promoted', async () => {
    const { host } = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    const keys = await fillQueueWithDownloadable(host, 6);
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    await waitFor(async () => {
      expect(screen.getAllByTestId(/^queue-row-\d+$/).length).toBe((await host.queue.list()).length);
    });
    const capped = installCappedDownloads(host);
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    fireEvent.click(screen.getByTestId('queue-download-all'));
    expect(capped.running()).toEqual(keys.slice(0, 3));
    expect(capped.waiting()).toEqual(keys.slice(3));
    await waitFor(() => {
      expect(screen.getByTestId('queue-stop-all-btn')).toBeInTheDocument();
    });

    const releaseDeletes = capped.holdDeletes();
    fireEvent.click(screen.getByTestId('queue-stop-all-btn'));
    for (const key of keys) expect(badgeOf(key)).not.toBeInTheDocument();
    expect(capped.cancelAll).toHaveBeenCalledTimes(1);
    // Stale promotion while the host processes the stop: still guarded
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: keys[3]!, state: 'RUNNING', progress: 0 });
    });
    expect(badgeOf(keys[3]!)).not.toBeInTheDocument();
    await act(async () => {
      releaseDeletes();
      await Promise.resolve();
    });
    await waitFor(async () => {
      for (const key of keys) {
        expect((await host.episodes.get(key)).episode.downloadState).toBe('NONE');
      }
    });
    await flush();
    expect(capped.cancelAll).toHaveBeenCalledTimes(1);
    expect(capped.deleteDownload).not.toHaveBeenCalled();
    expect(capped.started()).toEqual(keys.slice(0, 3));
    expect(capped.running()).toEqual([]);
    expect(capped.waiting()).toEqual([]);
    for (const key of keys) expect(badgeOf(key)).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-stop-all-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('snackbar')).not.toBeInTheDocument();
  });

  it('Podcast detail EpisodeRow shows a cancellable `等待中` badge (and `等待下载` in the detail sheet) while QUEUED; stopping it is not reverted by a stale promotion', async () => {
    const { host, engine } = renderMiniPod({
      width: 1024,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const row = screen.getByText(/40: Live Studio Walkthrough/).closest('[data-testid^="episode-row-"]') as HTMLElement;
    const key = row.getAttribute('data-testid')!.slice('episode-row-'.length);

    // QUEUED after a partial `.part` (42%) -> `等待中`, keeps 42% for the ring
    act(() => host.setEpisodeDownloadState(key, 'RUNNING', 0.42));
    act(() => host.setEpisodeDownloadState(key, 'QUEUED'));
    const pill = await screen.findByTestId(`ep-download-progress-${key}`);
    await waitFor(() => {
      expect(pill).toHaveAttribute('data-download-phase', 'queued');
    });
    expect(screen.getByTestId(`ep-download-waiting-${key}`)).toHaveTextContent('等待中');
    expect(pill).toHaveAttribute('data-cache-progress', '42');
    expect(pill).toHaveAttribute('aria-label', '停止下载');
    expect(pill).toHaveClass('is-queued');

    // Detail sheet: `等待下载` status + stop action
    fireEvent.contextMenu(row, { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId(`ep-view-details-${key}`));
    const status = await screen.findByTestId(`ep-detail-download-status-${key}`);
    expect(status).toHaveAttribute('data-download-state', 'queued');
    expect(status).toHaveTextContent('等待下载');
    expect(screen.getByTestId(`ep-detail-stop-download-${key}`)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // Promotion to RUNNING shows the % again (kept from the `.part`)
    act(() => host.setEpisodeDownloadState(key, 'RUNNING'));
    expect(screen.getByTestId(`ep-download-progress-${key}`)).toHaveAttribute('data-download-phase', 'running');
    expect(screen.getByTestId(`ep-download-progress-${key}`)).toHaveTextContent('42%');
    act(() => host.setEpisodeDownloadState(key, 'QUEUED'));

    // Tap to stop while the host is slow: a stale promotion during the stop is ignored
    let releaseDelete: () => void = () => undefined;
    const original = host.episodes.deleteDownload.bind(host.episodes);
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload').mockImplementation(async (k) => {
      await new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      await original(k);
    });
    fireEvent.pointerDown(screen.getByTestId(`ep-download-progress-${key}`));
    fireEvent.click(screen.getByTestId(`ep-download-progress-${key}`));
    expect(deleteSpy).toHaveBeenCalledWith(key);
    expect(screen.queryByTestId(`ep-download-progress-${key}`)).not.toBeInTheDocument();
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: key, state: 'RUNNING', progress: 0.5 });
    });
    expect(screen.queryByTestId(`ep-download-progress-${key}`)).not.toBeInTheDocument();
    await act(async () => {
      releaseDelete();
      await Promise.resolve();
    });
    await waitFor(async () => {
      expect((await host.episodes.get(key)).episode.downloadState).toBe('NONE');
    });
    await flush();
    expect(screen.queryByTestId(`ep-download-progress-${key}`)).not.toBeInTheDocument();
    expect(engine.getSnapshot().playing).toBe(false);
  });
});
