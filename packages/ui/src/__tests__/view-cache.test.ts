import { describe, expect, it } from 'vitest';
import type { Episode, EpisodeRow, Feed, QueueRow } from '@minipod/core';
import { createMockPlatformHost } from '../index';
import {
  applyDownloadStateToViewCache,
  beginDownloadStop,
  clearDownloadStop,
  DOWNLOAD_STOP_GRACE_MS,
  downloadRatioToPercent,
  endDownloadStop,
  getHostViewCache,
  guardStoppedDownloadState,
  isDownloadStopGuarded,
  isStaleDownloadEvent,
  recomputeHostTimelineAndDownloads,
} from '../stores/view-cache';

function ep(feedKey: string, key: string, downloaded: boolean): Episode {
  return {
    episodeKey: key,
    feedKey,
    identity: key,
    title: key,
    mediaType: 'AUDIO',
    pubDate: 1_760_000_000_000,
    downloadState: downloaded ? 'DONE' : 'NONE',
    ...(downloaded ? { downloadPath: `/files/downloads/${key}.mp3` } : {}),
  } as Episode;
}

describe('applyDownloadStateToViewCache (b1d6d66b)', () => {
  it('drops a deleted download from every SWR slice so Manage Downloads is never re-polluted', () => {
    const host = createMockPlatformHost();
    const cache = getHostViewCache(host);
    const feedA = { feedKey: 'f_a', kind: 'RSS', title: 'A' } as unknown as Feed;
    const feedB = { feedKey: 'f_b', kind: 'RSS', title: 'B' } as unknown as Feed;
    const played = ep('f_a', 'e_played', true);
    const other = ep('f_b', 'e_other', true);
    const rowPlayed: EpisodeRow = { episode: played, inQueue: true };
    const rowOther: EpisodeRow = { episode: other, inQueue: false };

    cache.episodesByFeed.set('f_a', [rowPlayed]);
    cache.episodesByFeed.set('f_b', [rowOther]);
    cache.queueRows = [{ entry: { episodeKey: 'e_played' }, episode: played } as unknown as QueueRow];
    cache.timelineItems = [{ row: rowPlayed, feed: feedA, allowDownloads: true }];
    cache.downloadedItems = [
      { row: rowPlayed, feed: feedA },
      { row: rowOther, feed: feedB },
    ];
    cache.downloadedCount = 2;
    const untouchedFeedB = cache.episodesByFeed.get('f_b');

    applyDownloadStateToViewCache(host, 'e_played', 'NONE');

    const patched = cache.episodesByFeed.get('f_a')![0]!.episode;
    expect(patched.downloadState).toBe('NONE');
    expect(patched.downloadPath).toBeUndefined();
    expect(cache.episodesByFeed.get('f_b')).toBe(untouchedFeedB); // identity preserved
    expect(cache.queueRows[0]!.episode).toMatchObject({ downloadState: 'NONE' });
    expect(cache.queueRows[0]!.episode.downloadPath).toBeUndefined();
    expect(cache.timelineItems[0]!.row.episode.downloadState).toBe('NONE');
    expect(cache.downloadedItems.map((i) => i.row.episode.episodeKey)).toEqual(['e_other']);
    expect(cache.downloadedCount).toBe(1);

    // Recomputing across all cached feeds (PodcastDetail) no longer re-adds the deleted download
    const recomputed = recomputeHostTimelineAndDownloads(host, [feedA, feedB], cache.episodesByFeed);
    expect(recomputed.downloadedItems.map((i) => i.row.episode.episodeKey)).toEqual(['e_other']);

    // Idempotent: a second listener applying the same event changes nothing
    const before = cache.downloadedItems;
    applyDownloadStateToViewCache(host, 'e_played', 'NONE');
    expect(cache.downloadedItems).toBe(before);

    // DONE re-download updates rows (and path) without touching the list membership
    applyDownloadStateToViewCache(host, 'e_played', 'DONE', '/files/downloads/e_played.mp3');
    expect(cache.episodesByFeed.get('f_a')![0]!.episode).toMatchObject({
      downloadState: 'DONE',
      downloadPath: '/files/downloads/e_played.mp3',
    });
  });
});

describe('downloadProgressByKey (v0.1.29 `下载中用百分比来表示进度`)', () => {
  it('keeps the last ratio across QUEUED/RUNNING/FAILED (resume), clears it on DONE/NONE, and clamps', () => {
    const host = createMockPlatformHost();
    const progress = getHostViewCache(host).downloadProgressByKey;

    applyDownloadStateToViewCache(host, 'e_1', 'QUEUED');
    expect(progress.get('e_1')).toBe(0);
    applyDownloadStateToViewCache(host, 'e_1', 'RUNNING', undefined, 0.42);
    expect(progress.get('e_1')).toBe(0.42);
    // Progress-less samples (other listeners / QUEUED on resume) keep the last known ratio
    applyDownloadStateToViewCache(host, 'e_1', 'RUNNING');
    expect(progress.get('e_1')).toBe(0.42);
    applyDownloadStateToViewCache(host, 'e_1', 'FAILED');
    expect(progress.get('e_1')).toBe(0.42);
    applyDownloadStateToViewCache(host, 'e_1', 'QUEUED');
    expect(progress.get('e_1')).toBe(0.42);
    applyDownloadStateToViewCache(host, 'e_1', 'RUNNING', undefined, 1.7);
    expect(progress.get('e_1')).toBe(1);
    applyDownloadStateToViewCache(host, 'e_1', 'DONE', undefined, 1);
    expect(progress.has('e_1')).toBe(false);

    applyDownloadStateToViewCache(host, 'e_2', 'RUNNING', undefined, -0.5);
    expect(progress.get('e_2')).toBe(0);
    applyDownloadStateToViewCache(host, 'e_2', 'NONE');
    expect(progress.has('e_2')).toBe(false);

    expect(downloadRatioToPercent(undefined)).toBe(0);
    expect(downloadRatioToPercent(Number.NaN)).toBe(0);
    expect(downloadRatioToPercent(0.094)).toBe(9);
    expect(downloadRatioToPercent(0.426)).toBe(43);
    expect(downloadRatioToPercent(1.2)).toBe(100);
  });
});

describe('downloadProgressByKey with the 3-concurrent download queue (4daa0030)', () => {
  it('QUEUED -> RUNNING -> DONE: waiting rows seed 0%, promotion and progress-less retries keep the %, DONE clears', () => {
    const host = createMockPlatformHost();
    const progress = getHostViewCache(host).downloadProgressByKey;

    // Brand-new download held by the host's 3-slot cap
    applyDownloadStateToViewCache(host, 'e_q', 'QUEUED', undefined, 0);
    expect(progress.get('e_q')).toBe(0);
    // Promoted to RUNNING without a sample yet
    applyDownloadStateToViewCache(host, 'e_q', 'RUNNING');
    expect(progress.get('e_q')).toBe(0);
    applyDownloadStateToViewCache(host, 'e_q', 'RUNNING', undefined, 0.35);
    expect(progress.get('e_q')).toBe(0.35);
    // Host auto-retry stays RUNNING and emits no progress -> keeps 35%
    applyDownloadStateToViewCache(host, 'e_q', 'RUNNING');
    expect(progress.get('e_q')).toBe(0.35);
    applyDownloadStateToViewCache(host, 'e_q', 'RUNNING', undefined, 0.8);
    expect(progress.get('e_q')).toBe(0.8);
    applyDownloadStateToViewCache(host, 'e_q', 'DONE', '/files/downloads/e_q.mp3', 1);
    expect(progress.has('e_q')).toBe(false);
  });

  it('QUEUED after a partial `.part` keeps the prior % (also for a `progress: 0` QUEUED sample); FAILED keeps it, NONE clears', () => {
    const host = createMockPlatformHost();
    const progress = getHostViewCache(host).downloadProgressByKey;

    applyDownloadStateToViewCache(host, 'e_p', 'RUNNING', undefined, 0.42);
    applyDownloadStateToViewCache(host, 'e_p', 'FAILED');
    expect(progress.get('e_p')).toBe(0.42);
    // Resume re-enters the queue: QUEUED with no / zero progress must not wipe the `.part` ratio
    applyDownloadStateToViewCache(host, 'e_p', 'QUEUED');
    expect(progress.get('e_p')).toBe(0.42);
    applyDownloadStateToViewCache(host, 'e_p', 'QUEUED', undefined, 0);
    expect(progress.get('e_p')).toBe(0.42);
    // A host that knows the resume offset while QUEUED may report it
    applyDownloadStateToViewCache(host, 'e_p', 'QUEUED', undefined, 0.45);
    expect(progress.get('e_p')).toBe(0.45);
    // RUNNING samples are authoritative (e.g. a server without Range restarts from 0)
    applyDownloadStateToViewCache(host, 'e_p', 'RUNNING', undefined, 0.1);
    expect(progress.get('e_p')).toBe(0.1);
    applyDownloadStateToViewCache(host, 'e_p', 'FAILED', undefined, 0);
    expect(progress.get('e_p')).toBe(0.1);
    applyDownloadStateToViewCache(host, 'e_p', 'NONE', undefined, 0);
    expect(progress.has('e_p')).toBe(false);
    // NONE -> QUEUED again starts from 0
    applyDownloadStateToViewCache(host, 'e_p', 'QUEUED');
    expect(progress.get('e_p')).toBe(0);
  });
});

describe('download stop guard (`停止下载` / `停止全部` vs late events, 4daa0030)', () => {
  function seedQueueRow(host: ReturnType<typeof createMockPlatformHost>, key: string) {
    const cache = getHostViewCache(host);
    cache.queueRows = [
      {
        entry: { episodeKey: key },
        episode: { ...ep('f_a', key, false), downloadState: 'RUNNING' },
      } as unknown as QueueRow,
    ];
    cache.downloadProgressByKey.set(key, 0.6);
  }

  it('flips to NONE at once and drops every non-NONE event while deleteDownload is in flight; the host NONE + settle lifts it', () => {
    const host = createMockPlatformHost();
    const cache = getHostViewCache(host);
    seedQueueRow(host, 'e_s');

    beginDownloadStop(host, 'e_s');
    expect(cache.queueRows[0]!.episode.downloadState).toBe('NONE');
    expect(cache.downloadProgressByKey.has('e_s')).toBe(false);
    expect(isDownloadStopGuarded(host, 'e_s')).toBe(true);

    // Late events from before the stop: progress tick, auto-retry, QUEUED -> RUNNING promotion,
    // a re-QUEUED, a cancellation surfaced as FAILED, a racing DONE
    for (const state of ['RUNNING', 'QUEUED', 'FAILED', 'DONE'] as const) {
      expect(isStaleDownloadEvent(host, 'e_s', state)).toBe(true);
    }
    // Stale list snapshots read as NONE
    expect(guardStoppedDownloadState(host, 'e_s', 'RUNNING')).toBe('NONE');
    expect(guardStoppedDownloadState(host, 'e_s', 'QUEUED')).toBe('NONE');
    // Unrelated episodes are untouched
    expect(isStaleDownloadEvent(host, 'e_other', 'RUNNING')).toBe(false);
    expect(guardStoppedDownloadState(host, 'e_other', 'QUEUED')).toBe('QUEUED');

    // Host confirms while the call is still in flight: NONE passes, guard stays until settled
    expect(isStaleDownloadEvent(host, 'e_s', 'NONE')).toBe(false);
    expect(isStaleDownloadEvent(host, 'e_s', 'RUNNING')).toBe(true);
    endDownloadStop(host, 'e_s');
    expect(isDownloadStopGuarded(host, 'e_s')).toBe(false);
    expect(cache.downloadStopGuards.size).toBe(0);
    expect(isStaleDownloadEvent(host, 'e_s', 'QUEUED')).toBe(false);
    expect(guardStoppedDownloadState(host, 'e_s', 'RUNNING')).toBe('RUNNING');
  });

  it('without a host NONE confirmation, guards RUNNING/FAILED/DONE for the grace window after settling; a fresh QUEUED or an explicit restart lifts it', () => {
    const host = createMockPlatformHost();
    const t0 = 1_000_000;

    beginDownloadStop(host, 'e_g');
    endDownloadStop(host, 'e_g', t0);
    expect(isDownloadStopGuarded(host, 'e_g', t0 + 10)).toBe(true);
    expect(isStaleDownloadEvent(host, 'e_g', 'RUNNING', t0 + 10)).toBe(true);
    expect(isStaleDownloadEvent(host, 'e_g', 'FAILED', t0 + 10)).toBe(true);
    expect(guardStoppedDownloadState(host, 'e_g', 'RUNNING', t0 + 10)).toBe('NONE');
    // Grace window elapsed -> trust the host again
    expect(isStaleDownloadEvent(host, 'e_g', 'RUNNING', t0 + DOWNLOAD_STOP_GRACE_MS)).toBe(false);
    expect(getHostViewCache(host).downloadStopGuards.has('e_g')).toBe(false);

    // A QUEUED after settling can only come from a fresh download() -> accepted
    beginDownloadStop(host, 'e_g');
    endDownloadStop(host, 'e_g', t0);
    expect(isStaleDownloadEvent(host, 'e_g', 'QUEUED', t0 + 10)).toBe(false);
    expect(isStaleDownloadEvent(host, 'e_g', 'RUNNING', t0 + 20)).toBe(false);

    // Explicit restart (`继续下载` / `下载全部`) drops the guard immediately
    beginDownloadStop(host, 'e_g');
    clearDownloadStop(host, 'e_g');
    expect(isStaleDownloadEvent(host, 'e_g', 'RUNNING')).toBe(false);

    // Overlapping stops: guarded until the last deleteDownload settles
    beginDownloadStop(host, 'e_g');
    beginDownloadStop(host, 'e_g');
    expect(isStaleDownloadEvent(host, 'e_g', 'NONE')).toBe(false);
    endDownloadStop(host, 'e_g');
    expect(isStaleDownloadEvent(host, 'e_g', 'RUNNING')).toBe(true);
    endDownloadStop(host, 'e_g');
    expect(isDownloadStopGuarded(host, 'e_g')).toBe(false);
  });
});
