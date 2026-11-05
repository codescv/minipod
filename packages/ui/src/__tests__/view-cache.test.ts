import { describe, expect, it } from 'vitest';
import type { Episode, EpisodeRow, Feed, QueueRow } from '@minipod/core';
import { createMockPlatformHost } from '../index';
import {
  applyDownloadStateToViewCache,
  downloadRatioToPercent,
  getHostViewCache,
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
