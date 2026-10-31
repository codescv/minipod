/**
 * UI Layer-1 Artwork Cache (`v0.1.6`):
 * - Retains live `HTMLImageElement` instances in an in-memory LRU pool (`MAX_PINNED_IMAGES = 400`)
 *   so Blink / Android WebView's decoded bitmap cache (`MemoryCache`) never evicts podcast or
 *   episode covers when React unmounts a screen during navigation.
 * - Remembers the resolved candidate index per `candidatesKey` so `<ArtworkImage>` immediately
 *   renders the known-good URL (e.g. `/api/image-proxy?url=...` fallback) on remount without
 *   retrying failed primary URLs.
 * - Provides background `preloadArtworkUrls` so channel & episode covers are warmed ahead of scroll.
 */

const MAX_PINNED_IMAGES = 400;
const MAX_RESOLVED_CANDIDATES = 1000;

const loadedArtworkUrls = new Set<string>();
const pinnedImagePool = new Map<string, HTMLImageElement>();
const resolvedCandidateIndexMap = new Map<string, number>();
const inFlightPreloads = new Set<string>();

function touchPinnedImage(url: string, img: HTMLImageElement): void {
  if (pinnedImagePool.has(url)) {
    pinnedImagePool.delete(url);
  }
  pinnedImagePool.set(url, img);
  while (pinnedImagePool.size > MAX_PINNED_IMAGES) {
    const oldestKey = pinnedImagePool.keys().next().value;
    if (oldestKey === undefined) break;
    pinnedImagePool.delete(oldestKey);
  }
}

export function pinLoadedArtwork(url: string | null | undefined): void {
  const clean = url?.trim();
  if (!clean) return;
  loadedArtworkUrls.add(clean);

  const existing = pinnedImagePool.get(clean);
  if (existing) {
    touchPinnedImage(clean, existing);
    return;
  }

  if (typeof Image !== 'undefined') {
    try {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = clean;
      touchPinnedImage(clean, img);
    } catch {
      // ignore in environments without Image constructor support
    }
  }
}

export function isArtworkLoaded(url: string | null | undefined): boolean {
  if (!url) return false;
  const clean = url.trim();
  return clean.length > 0 && loadedArtworkUrls.has(clean);
}

export function rememberResolvedCandidate(candidatesKey: string, index: number): void {
  if (!candidatesKey || index < 0) return;
  if (resolvedCandidateIndexMap.has(candidatesKey)) {
    resolvedCandidateIndexMap.delete(candidatesKey);
  }
  resolvedCandidateIndexMap.set(candidatesKey, index);
  while (resolvedCandidateIndexMap.size > MAX_RESOLVED_CANDIDATES) {
    const oldest = resolvedCandidateIndexMap.keys().next().value;
    if (oldest === undefined) break;
    resolvedCandidateIndexMap.delete(oldest);
  }
}

export function getRememberedCandidateIndex(candidatesKey: string): number | undefined {
  if (!candidatesKey) return undefined;
  const val = resolvedCandidateIndexMap.get(candidatesKey);
  if (val !== undefined) {
    // Refresh LRU order
    resolvedCandidateIndexMap.delete(candidatesKey);
    resolvedCandidateIndexMap.set(candidatesKey, val);
  }
  return val;
}

export function preloadArtworkUrls(
  urls: Iterable<string | null | undefined>,
  allowProxyFallback = false,
): void {
  if (typeof Image === 'undefined') return;
  for (const raw of urls) {
    const clean = raw?.trim();
    if (!clean) continue;
    if (loadedArtworkUrls.has(clean) || inFlightPreloads.has(clean)) continue;

    inFlightPreloads.add(clean);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        inFlightPreloads.delete(clean);
        loadedArtworkUrls.add(clean);
        touchPinnedImage(clean, img);
      };
      img.onerror = () => {
        inFlightPreloads.delete(clean);
        if (allowProxyFallback && /^https?:\/\//i.test(clean)) {
          const proxied = `/api/image-proxy?url=${encodeURIComponent(clean)}`;
          if (!loadedArtworkUrls.has(proxied) && !inFlightPreloads.has(proxied)) {
            preloadArtworkUrls([proxied], false);
          }
        }
      };
      img.src = clean;
    } catch {
      inFlightPreloads.delete(clean);
    }
  }
}

export function getPinnedArtworkCount(): number {
  return pinnedImagePool.size;
}

export function clearArtworkCacheForTests(): void {
  loadedArtworkUrls.clear();
  pinnedImagePool.clear();
  resolvedCandidateIndexMap.clear();
  inFlightPreloads.clear();
}
