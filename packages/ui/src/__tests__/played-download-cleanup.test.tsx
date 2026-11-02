import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMiniPod } from './test-helpers';

/**
 * Regression for b1d6d66b ("队列中播放完成后没有自动删除下载，在管理下载中还存在"):
 * a trailing paused `state` after `ended` (native `media-state` emitted by `PlaybackService`
 * right after `media-ended`, with a position well before the RSS-declared duration) must never
 * overwrite PLAYED with IN_PROGRESS, and the finished episode's download must be deleted.
 */
describe('Played queue episode download cleanup', () => {
  async function playDownloadedEpisode() {
    const ctx = renderMiniPod({ width: 1024 });
    const { host, engine } = ctx;
    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const epRows = await screen.findAllByTestId(/^episode-row-/);
    fireEvent.click(epRows[0]!);
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));
    const key = engine.getSnapshot().episodeKey!;
    await act(async () => {
      await host.episodes.download(key);
    });
    expect((await host.episodes.get(key)).episode.downloadState).toBe('DONE');
    expect((await host.queue.list()).some((r) => r.episode.episodeKey === key)).toBe(true);
    return { ...ctx, key };
  }

  function savesAfterLastPlayed(
    saves: readonly { episodeKey: string; state: string }[],
    key: string,
  ) {
    const mine = saves.filter((s) => s.episodeKey === key);
    const lastPlayed = mine.map((s) => s.state).lastIndexOf('PLAYED');
    expect(lastPlayed).toBeGreaterThanOrEqual(0);
    return mine.slice(lastPlayed + 1);
  }

  it('ignores the trailing paused state after `ended` and deletes the download + dequeues', async () => {
    const { host, engine, key } = await playDownloadedEpisode();
    const durationMs = engine.getSnapshot().durationMs ?? 1_800_000;
    const earlyEndMs = Math.max(1, durationMs - 100_000); // stream ended ~100 s before RSS duration

    act(() => {
      engine.emitPosition(earlyEndMs);
    });
    // Legacy native ordering: `ended` arrives while the UI snapshot is still `playing: true`...
    act(() => {
      engine.emitEvent({ type: 'ended', episodeKey: key });
    });
    // ...followed by PlaybackService's trailing `media-state` (paused at the early end position).
    act(() => {
      engine.emitRawState({
        ...engine.getSnapshot(),
        episodeKey: key,
        playing: false,
        buffering: false,
        positionMs: earlyEndMs,
      });
    });

    await waitFor(async () => {
      expect((await host.progress.get(key))?.state).toBe('PLAYED');
      expect((await host.episodes.get(key)).episode.downloadState).toBe('NONE');
    });
    expect(savesAfterLastPlayed(host.progressSaves, key)).toEqual([]);
    expect((await host.queue.list()).some((r) => r.episode.episodeKey === key)).toBe(false);
  });

  it('marks the finished episode PLAYED on a completed nativeAdvanced (deletes download, dequeues)', async () => {
    const { host, engine, key } = await playDownloadedEpisode();
    const next = (await host.queue.list()).find((r) => r.episode.episodeKey !== key);
    const toKey = next?.episode.episodeKey ?? 'e_unknown';

    act(() => {
      engine.emitEvent({ type: 'nativeAdvanced', from: key, to: toKey, completed: true });
    });

    await waitFor(async () => {
      expect((await host.progress.get(key))?.state).toBe('PLAYED');
      expect((await host.episodes.get(key)).episode.downloadState).toBe('NONE');
    });
    expect((await host.queue.list()).some((r) => r.episode.episodeKey === key)).toBe(false);
  });

  it('does not mark a skipped episode played on an inferred (non-completed) nativeAdvanced', async () => {
    const { host, engine, key } = await playDownloadedEpisode();
    act(() => {
      engine.emitEvent({ type: 'nativeAdvanced', from: key, to: 'e_other' });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(host.progressSaves.some((s) => s.episodeKey === key && s.state === 'PLAYED')).toBe(false);
    expect((await host.episodes.get(key)).episode.downloadState).toBe('DONE');
  });
});
