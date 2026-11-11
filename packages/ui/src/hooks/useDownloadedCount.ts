/**
 * Reactive count of downloaded episodes (`downloadState === 'DONE'`) across subscribed feeds
 * so top-right `⋮` menus only display `Manage downloads ({count})` when non-empty.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useListReloadFilter } from './useListReloadFilter';
import { applyDownloadStateToViewCache, getHostViewCache } from '../stores/view-cache';

export function useDownloadedCount(): number {
  const host = useHost();
  const [count, setCount] = useState(() => getHostViewCache(host).downloadedCount);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!host.info.capabilities.downloads) {
      getHostViewCache(host).downloadedCount = 0;
      setCount(0);
      return;
    }
    const seq = ++seqRef.current;
    try {
      const feeds = await host.feeds.list();
      const downloadableFeeds = feeds.filter((f) => f.kind !== 'LOCAL');
      if (downloadableFeeds.length === 0) {
        if (seq === seqRef.current) {
          getHostViewCache(host).downloadedCount = 0;
          setCount(0);
        }
        return;
      }
      const counts = await Promise.all(
        downloadableFeeds.map(async (f) => {
          try {
            const page = await host.episodes.list(f.feedKey, 'downloaded');
            return page.items.filter((r) => r.episode.downloadState === 'DONE').length;
          } catch {
            return 0;
          }
        }),
      );
      if (seq === seqRef.current) {
        const total = counts.reduce((acc, n) => acc + n, 0);
        getHostViewCache(host).downloadedCount = total;
        setCount(total);
      }
    } catch {
      if (seq === seqRef.current) {
        getHostViewCache(host).downloadedCount = 0;
        setCount(0);
      }
    }
  }, [host]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Skip RUNNING progress samples and the playing episode's 5 s checkpoints (neither changes the
  // downloaded count) instead of re-listing every feed several times per second.
  const shouldRefresh = useListReloadFilter(() => {
    void refresh();
  });

  useHostEvents((ev) => {
    if (ev.type === 'download-updated') {
      applyDownloadStateToViewCache(host, ev.episodeKey, ev.state, undefined, ev.progress);
      if (ev.state !== 'DONE') {
        setCount(getHostViewCache(host).downloadedCount);
      }
    }
    if (
      ev.type === 'download-updated' ||
      ev.type === 'episodes-changed' ||
      ev.type === 'feeds-changed' ||
      ev.type === 'progress-changed'
    ) {
      if (shouldRefresh(ev)) void refresh();
    }
  });

  return count;
}
