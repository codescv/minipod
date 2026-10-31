/**
 * Reactive count of downloaded episodes (`downloadState === 'DONE'`) across subscribed feeds
 * so top-right `⋮` menus only display `Manage downloads ({count})` when non-empty.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';

export function useDownloadedCount(): number {
  const host = useHost();
  const [count, setCount] = useState(0);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!host.info.capabilities.downloads) {
      setCount(0);
      return;
    }
    const seq = ++seqRef.current;
    try {
      const feeds = await host.feeds.list();
      const downloadableFeeds = feeds.filter((f) => f.kind !== 'LOCAL');
      if (downloadableFeeds.length === 0) {
        if (seq === seqRef.current) setCount(0);
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
        setCount(counts.reduce((acc, n) => acc + n, 0));
      }
    } catch {
      if (seq === seqRef.current) setCount(0);
    }
  }, [host]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useHostEvents((ev) => {
    if (
      ev.type === 'download-updated' ||
      ev.type === 'episodes-changed' ||
      ev.type === 'feeds-changed' ||
      ev.type === 'progress-changed'
    ) {
      void refresh();
    }
  });

  return count;
}
