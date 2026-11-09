/**
 * v0.1.29 Android user feedback on v0.1.28:
 * - `如果单集下载失败了，显示一个继续下载按钮。` -> a tappable `继续下载` control for FAILED downloads
 *   (Queue row pill, Queue long-press menu, `episode-detail-sheet`, Podcast detail EpisodeRow)
 * - `下载中用百分比来表示进度` -> a visible `{percent}%` while QUEUED / RUNNING (not hover-only)
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Download percentage + 继续下载 (resume failed downloads)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Queue row shows a live `{percent}%` (QUEUED 0% -> 42% -> 88%) that survives tab switches, and tapping it stops the download without playing', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const q = await host.queue.list();
    const secondKey = q[1]!.episode.episodeKey;

    // Start a real (held) download from the row's long-press menu
    const dl = host.holdNextDownload(secondKey);
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    expect(screen.getByTestId(`queue-download-${secondKey}`)).toHaveTextContent('Download episode');
    fireEvent.click(screen.getByTestId(`queue-download-${secondKey}`));

    // QUEUED (waiting for a host download slot) -> visible `Waiting` (no `%` yet), still a stop control
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute(
        'data-cache-state',
        'downloading',
      );
    });
    const badge = () => screen.getByTestId(`queue-cache-status-${secondKey}`);
    expect(badge()).toHaveAttribute('data-download-phase', 'queued');
    expect(screen.getByTestId(`queue-cache-waiting-${secondKey}`)).toHaveTextContent(/^Waiting$/);
    expect(screen.queryByTestId(`queue-cache-percent-${secondKey}`)).not.toBeInTheDocument();
    expect(badge()).toHaveAttribute('data-cache-progress', '0');
    expect(badge()).toHaveAttribute('aria-label', 'Stop download');

    // RUNNING 42% is rendered as visible text inside the clickable badge (tabular digits)
    act(() => dl.progress(0.42));
    expect(badge()).toHaveAttribute('data-download-phase', 'running');
    expect(screen.queryByTestId(`queue-cache-waiting-${secondKey}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^42%$/);
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveClass('m-download-percent');
    expect(badge()).toHaveTextContent('42%');
    expect(badge()).toHaveAttribute('data-cache-progress', '42');
    expect(badge().querySelectorAll('circle')).toHaveLength(2);
    expect(badge().querySelectorAll('rect')).toHaveLength(1);
    // Still zero `<button>` tags inside queue rows
    expect(screen.getByTestId('queue-row-1').querySelectorAll('button')).toHaveLength(0);

    // Queue -> Subscriptions -> Queue keeps 42% on frame 0 (HostViewCache), no flash to 0%
    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    expect(screen.getByTestId('subs-grid')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^42%$/);
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^42%$/);
    });

    // Progress while the Queue screen is unmounted is not lost either
    fireEvent.click(screen.getByTestId('nav-rail-subscriptions'));
    act(() => dl.progress(0.6));
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^60%$/);

    // Live update to 88%
    act(() => dl.progress(0.88));
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^88%$/);

    // The detail sheet shows the same live percentage + a Stop download action
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId(`queue-view-details-${secondKey}`));
    const status = await screen.findByTestId(`ep-detail-download-status-${secondKey}`);
    expect(status).toHaveTextContent('Downloading 88%');
    expect(status).toHaveAttribute('data-download-state', 'downloading');
    expect(screen.getByTestId(`ep-detail-stop-download-${secondKey}`)).toHaveTextContent('Stop download');
    expect(screen.queryByTestId(`ep-detail-resume-download-${secondKey}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`ep-detail-close-${secondKey}`));
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // Tapping the percentage badge stops the download (NONE) without starting playback
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload');
    fireEvent.pointerDown(badge());
    fireEvent.click(badge());
    await waitFor(() => {
      expect(screen.queryByTestId(`queue-cache-status-${secondKey}`)).not.toBeInTheDocument();
    });
    expect(deleteSpy).toHaveBeenCalledWith(secondKey);
    expect(engine.getSnapshot().playing).toBe(false);
    expect((await host.episodes.get(secondKey)).episode.downloadState).toBe('NONE');
  });

  it('FAILED download shows 继续下载 on the Queue row, in the long-press menu and in the detail sheet; tapping it resumes (with %) to DONE without playing, and a repeated failure never leaks an unhandled rejection', async () => {
    const { host, engine } = renderMiniPod({
      width: 390,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-bar-queue'));
    const q = await host.queue.list();
    const secondKey = q[1]!.episode.episodeKey;

    act(() => host.setEpisodeDownloadState(secondKey, 'FAILED'));
    const chip = await screen.findByTestId(`queue-resume-download-${secondKey}`);
    expect(chip).toHaveTextContent('继续下载');
    expect(chip).toHaveAttribute('role', 'button');
    expect(chip).toHaveAttribute('tabindex', '0');
    expect(chip).toHaveAttribute('data-cache-state', 'failed');
    expect(chip).toHaveAttribute('aria-label', '继续下载');
    expect(chip).toHaveClass('m-resume-download-chip');
    expect(screen.getByTestId('queue-row-1').querySelectorAll('button')).toHaveLength(0);
    // Other rows are unaffected
    expect(screen.queryByTestId(`queue-resume-download-${q[2]!.episode.episodeKey}`)).not.toBeInTheDocument();

    // Long-press menu offers 继续下载 instead of 下载单集
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    expect(screen.getByTestId('queue-context-menu').querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    expect(screen.getByTestId(`queue-download-${secondKey}`)).toHaveTextContent('继续下载');
    expect(screen.getByTestId(`queue-download-${secondKey}`)).not.toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });

    // Detail sheet: 下载失败 status + 继续下载 button
    fireEvent.contextMenu(screen.getByTestId('queue-row-1'), { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId(`queue-view-details-${secondKey}`));
    const sheet = await screen.findByTestId('episode-detail-sheet');
    expect(within(sheet).getByTestId(`ep-detail-download-status-${secondKey}`)).toHaveTextContent('下载失败');
    expect(within(sheet).getByTestId(`ep-detail-resume-download-${secondKey}`)).toHaveTextContent('继续下载');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // 1st retry from the row pill fails again -> back to 继续下载 + 下载失败 snackbar, no unhandled rejection
    const downloadSpy = vi.spyOn(host.episodes, 'download');
    const attempt1 = host.holdNextDownload(secondKey);
    fireEvent.pointerDown(screen.getByTestId(`queue-resume-download-${secondKey}`));
    fireEvent.click(screen.getByTestId(`queue-resume-download-${secondKey}`));
    expect(downloadSpy).toHaveBeenCalledWith(secondKey);
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute(
        'data-cache-state',
        'downloading',
      );
    });
    expect(screen.queryByTestId(`queue-resume-download-${secondKey}`)).not.toBeInTheDocument();
    act(() => attempt1.progress(0.3));
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^30%$/);
    act(() => attempt1.fail());
    expect(await screen.findByTestId(`queue-resume-download-${secondKey}`)).toHaveTextContent('继续下载');
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('下载失败');
    expect((await host.episodes.get(secondKey)).episode.downloadState).toBe('FAILED');

    // 2nd retry via keyboard (Enter): QUEUED `等待中` keeps the last known 30% (ring), then
    // resumes and finishes DONE (✓)
    const attempt2 = host.holdNextDownload(secondKey);
    fireEvent.keyDown(screen.getByTestId(`queue-resume-download-${secondKey}`), { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-waiting-${secondKey}`)).toHaveTextContent(/^等待中$/);
    });
    expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute(
      'data-cache-progress',
      '30',
    );
    act(() => attempt2.progress(0.88));
    expect(screen.getByTestId(`queue-cache-percent-${secondKey}`)).toHaveTextContent(/^88%$/);
    act(() => attempt2.finish());
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${secondKey}`)).toHaveAttribute('data-cache-state', 'done');
    });
    expect(screen.queryByTestId(`queue-resume-download-${secondKey}`)).not.toBeInTheDocument();
    expect(downloadSpy).toHaveBeenCalledTimes(2);
    // Never triggered row playback
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.getSnapshot().episodeKey).not.toBe(secondKey);
  });

  it('继续下载 from the Queue detail sheet and the long-press menu calls host.episodes.download and swallows a rejected retry', async () => {
    const { host } = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const q = await host.queue.list();
    const thirdKey = q[2]!.episode.episodeKey;
    act(() => host.setEpisodeDownloadState(thirdKey, 'FAILED'));
    expect(await screen.findByTestId(`queue-resume-download-${thirdKey}`)).toHaveTextContent('Resume');

    // Long-press menu -> Resume download (fails again; caught)
    const retry = host.holdNextDownload(thirdKey);
    fireEvent.contextMenu(screen.getByTestId('queue-row-2'), { clientX: 120, clientY: 220 });
    expect(screen.getByTestId(`queue-download-${thirdKey}`)).toHaveTextContent('Resume download');
    fireEvent.click(screen.getByTestId(`queue-download-${thirdKey}`));
    await waitFor(() => {
      expect(screen.getByTestId(`queue-cache-status-${thirdKey}`)).toHaveAttribute(
        'data-cache-state',
        'downloading',
      );
    });
    act(() => retry.fail());
    expect(await screen.findByTestId(`queue-resume-download-${thirdKey}`)).toBeInTheDocument();
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Download failed');

    // Detail sheet -> Resume download -> live % -> DONE, still live after leaving the queue
    fireEvent.contextMenu(screen.getByTestId('queue-row-2'), { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId(`queue-view-details-${thirdKey}`));
    const resumeBtn = await screen.findByTestId(`ep-detail-resume-download-${thirdKey}`);
    expect(resumeBtn).toHaveTextContent('Resume download');
    fireEvent.click(screen.getByTestId(`ep-detail-queue-${thirdKey}`));
    await waitFor(async () => {
      expect(await host.queue.list()).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId(`ep-detail-queue-${thirdKey}`)).toHaveTextContent('Add to queue');
    });
    const resumed = host.holdNextDownload(thirdKey);
    fireEvent.click(screen.getByTestId(`ep-detail-resume-download-${thirdKey}`));
    act(() => resumed.progress(0.64));
    expect(screen.getByTestId(`ep-detail-download-status-${thirdKey}`)).toHaveTextContent('Downloading 64%');
    expect(screen.queryByTestId(`ep-detail-resume-download-${thirdKey}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`ep-detail-stop-download-${thirdKey}`)).toBeInTheDocument();
    act(() => resumed.finish());
    await waitFor(() => {
      expect(screen.queryByTestId(`ep-detail-download-status-${thirdKey}`)).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId(`ep-detail-resume-download-${thirdKey}`)).not.toBeInTheDocument();
    expect((await host.episodes.get(thirdKey)).episode.downloadState).toBe('DONE');
  });

  it('Podcast detail EpisodeRow shows `{percent}%` while downloading and a 继续下载 pill (+ detail sheet button) when FAILED; NONE/DONE rows stay minimal', async () => {
    const { host, engine } = renderMiniPod({
      width: 1024,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    fireEvent.click(await screen.findByText('Syntax & Signal'));
    expect(screen.getByTestId('podcast-detail-screen')).toBeInTheDocument();
    const rowOf = (re: RegExp): HTMLElement =>
      screen.getByText(re).closest('[data-testid^="episode-row-"]') as HTMLElement;
    const keyOf = (re: RegExp) => rowOf(re).getAttribute('data-testid')!.slice('episode-row-'.length);
    const failedKey = keyOf(/39: SQLite WAL Mode/);
    const runningKey = keyOf(/40: Live Studio Walkthrough/);

    // Baseline: no download controls on NONE / DONE rows
    expect(screen.queryByTestId(`ep-resume-download-${failedKey}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ep-download-progress-${runningKey}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('detail-episode-list').querySelectorAll('.m-resume-download-chip')).toHaveLength(0);

    // RUNNING -> visible percentage
    act(() => host.setEpisodeDownloadState(runningKey, 'RUNNING', 0.42));
    const progress = await screen.findByTestId(`ep-download-progress-${runningKey}`);
    expect(progress).toHaveTextContent('42%');
    expect(progress).toHaveAttribute('data-cache-progress', '42');
    act(() => {
      host.emit({ type: 'download-updated', episodeKey: runningKey, state: 'RUNNING', progress: 0.57 });
    });
    expect(screen.getByTestId(`ep-download-progress-${runningKey}`)).toHaveTextContent('57%');
    // The `%` pill is a stop control (role=button, stop square) that never plays the row
    const pill = screen.getByTestId(`ep-download-progress-${runningKey}`);
    expect(pill).toHaveAttribute('role', 'button');
    expect(pill).toHaveAttribute('aria-label', '停止下载');
    expect(pill.querySelectorAll('rect')).toHaveLength(1);
    expect(rowOf(/40: Live Studio Walkthrough/).querySelectorAll('button')).toHaveLength(0);
    const deleteSpy = vi.spyOn(host.episodes, 'deleteDownload');
    fireEvent.pointerDown(pill);
    fireEvent.click(pill);
    expect(deleteSpy).toHaveBeenCalledWith(runningKey);
    await waitFor(() => {
      expect(screen.queryByTestId(`ep-download-progress-${runningKey}`)).not.toBeInTheDocument();
    });
    expect((await host.episodes.get(runningKey)).episode.downloadState).toBe('NONE');
    expect(engine.getSnapshot().playing).toBe(false);

    // FAILED -> 继续下载 pill in the row meta (no nested <button>)
    act(() => host.setEpisodeDownloadState(failedKey, 'FAILED'));
    const chip = await screen.findByTestId(`ep-resume-download-${failedKey}`);
    expect(chip).toHaveTextContent('继续下载');
    expect(rowOf(/39: SQLite WAL Mode/).querySelectorAll('button')).toHaveLength(0);

    // Detail sheet from the row's long-press menu also offers 继续下载
    fireEvent.contextMenu(rowOf(/39: SQLite WAL Mode/), { clientX: 120, clientY: 220 });
    fireEvent.click(screen.getByTestId(`ep-view-details-${failedKey}`));
    const resumeBtn = await screen.findByTestId(`ep-detail-resume-download-${failedKey}`);
    expect(resumeBtn).toHaveTextContent('继续下载');
    expect(screen.getByTestId(`ep-detail-download-status-${failedKey}`)).toHaveTextContent('下载失败');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('episode-detail-sheet')).not.toBeInTheDocument();
    });

    // Tapping the pill resumes the download without playing the episode
    const downloadSpy = vi.spyOn(host.episodes, 'download');
    fireEvent.pointerDown(screen.getByTestId(`ep-resume-download-${failedKey}`));
    fireEvent.click(screen.getByTestId(`ep-resume-download-${failedKey}`));
    expect(downloadSpy).toHaveBeenCalledWith(failedKey);
    await waitFor(() => {
      expect(screen.queryByTestId(`ep-resume-download-${failedKey}`)).not.toBeInTheDocument();
    });
    expect((await host.episodes.get(failedKey)).episode.downloadState).toBe('DONE');
    expect(engine.getSnapshot().playing).toBe(false);
  });
});
