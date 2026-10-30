import { MiniPodError } from '../errors';
import {
  COMBINED_SEARCH_TIMEOUT_MS,
  type FeedKey,
  type PodcastSearcher,
  type SearchResult,
} from '../types';
import { feedKey } from './UrlNormalizer';

export interface CombinedSearcherDeps {
  readonly searchers: readonly PodcastSearcher[];
  readonly timeoutMs?: number;
}

function safeDedupeKey(rawFeedUrl: string): FeedKey {
  try {
    return feedKey(rawFeedUrl);
  } catch {
    return rawFeedUrl.trim().toLowerCase();
  }
}

async function runWithTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) {
      controller.abort(outerSignal.reason);
    } else {
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MiniPodError('network', `Search provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Exact port of AntennaPod's `CombinedSearcher.weightSearchResults`:
 *
 * Fans out in parallel to all providers with `combinedWeight > 0`, tolerates individual
 * provider failures (`Promise.allSettled`), deduplicates by scheme-less `feedKey`, and
 * ranks using `((prev + 1 / (pos + 1)) * weight)`.
 */
export function weightSearchResults(
  providerLists: readonly { readonly weight: number; readonly results: readonly SearchResult[] }[],
): SearchResult[] {
  const ranking = new Map<FeedKey, number>();
  const byKey = new Map<FeedKey, SearchResult>();

  for (const { weight, results } of providerLists) {
    if (weight <= 0.00001) continue;
    for (let pos = 0; pos < results.length; pos++) {
      const r = results[pos]!;
      const k = safeDedupeKey(r.feedUrl);
      const existing = byKey.get(k);
      if (!existing) {
        byKey.set(k, r);
      } else if ((!existing.imageUrl && r.imageUrl) || (!existing.author && r.author)) {
        byKey.set(k, {
          ...existing,
          ...(existing.author ? {} : r.author ? { author: r.author } : {}),
          ...(existing.imageUrl ? {} : r.imageUrl ? { imageUrl: r.imageUrl } : {}),
        });
      }

      const prev = ranking.get(k) ?? 0;
      ranking.set(k, (prev + 1 / (pos + 1)) * weight);
    }
  }

  return [...byKey.entries()]
    .sort((a, b) => (ranking.get(b[0]) ?? 0) - (ranking.get(a[0]) ?? 0))
    .map(([, item]) => item);
}

export class CombinedSearcher implements PodcastSearcher {
  readonly id = 'combined' as const;
  readonly displayName = 'All sources';
  readonly combinedWeight = 0.0;

  private readonly searchers: readonly PodcastSearcher[];
  private readonly timeoutMs: number;

  constructor(deps: CombinedSearcherDeps) {
    this.searchers = deps.searchers;
    this.timeoutMs = deps.timeoutMs ?? COMBINED_SEARCH_TIMEOUT_MS;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (signal?.aborted) {
      throw new MiniPodError('cancelled', 'Search cancelled');
    }

    const active = this.searchers.filter(
      (s) => s.id !== 'combined' && s.combinedWeight > 0.00001,
    );
    if (active.length === 0) return [];

    const settled = await Promise.allSettled(
      active.map((provider) =>
        runWithTimeout((sig) => provider.search(trimmed, sig), this.timeoutMs, signal),
      ),
    );

    if (signal?.aborted) {
      throw new MiniPodError('cancelled', 'Search cancelled');
    }

    const fulfilledLists: { weight: number; results: readonly SearchResult[] }[] = [];
    for (let i = 0; i < active.length; i++) {
      const outcome = settled[i]!;
      const provider = active[i]!;
      if (outcome.status === 'fulfilled') {
        fulfilledLists.push({ weight: provider.combinedWeight, results: outcome.value });
      }
    }

    return weightSearchResults(fulfilledLists);
  }
}

export function createCombinedSearcher(deps: CombinedSearcherDeps): PodcastSearcher {
  return new CombinedSearcher(deps);
}
