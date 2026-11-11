/**
 * Progressive list rendering for long episode lists (Podcast detail / feed preview): mounts the
 * first `pageSize` rows on frame 0 and grows by `pageSize` whenever an `IntersectionObserver`
 * sentinel placed after the last rendered row comes within `rootMargin` of the viewport — so
 * opening a 1,000-episode feed never mounts 1,000 rows at once on iOS / Android WebViews.
 *
 * The limit resets to `pageSize` synchronously (during render) whenever `resetKey` changes.
 * Without `IntersectionObserver` (old WebViews, jsdom) the caller's load-more button is the
 * fallback.
 */
import { useCallback, useEffect, useState } from 'react';

export const PROGRESSIVE_ROOT_MARGIN = '800px 0px';

export interface ProgressiveLimit {
  readonly limit: number;
  readonly hasMore: boolean;
  /** Attach to an (empty) element rendered right after the last visible row. */
  readonly sentinelRef: (el: Element | null) => void;
  readonly loadMore: () => void;
}

export function useProgressiveLimit(
  pageSize: number,
  resetKey: string,
  total: number,
): ProgressiveLimit {
  const [state, setState] = useState({ key: resetKey, limit: pageSize });
  let limit = state.limit;
  if (state.key !== resetKey) {
    limit = pageSize;
    setState({ key: resetKey, limit: pageSize });
  }
  const hasMore = total > limit;

  const loadMore = useCallback(() => {
    setState((prev) => ({ key: prev.key, limit: prev.limit + pageSize }));
  }, [pageSize]);

  const [sentinel, setSentinel] = useState<Element | null>(null);
  const sentinelRef = useCallback((el: Element | null) => {
    setSentinel(el);
  }, []);

  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      { rootMargin: PROGRESSIVE_ROOT_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `limit` re-arms the observer so a sentinel still in range keeps loading pages.
  }, [sentinel, hasMore, limit, loadMore]);

  return { limit, hasMore, sentinelRef, loadMore };
}
