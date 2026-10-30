import type { Chapter } from '../types';

const ALIGNMENT_TOLERANCE_MS = 1_000;

function hasText(val: string | undefined): boolean {
  return Boolean(val && val.trim().length > 0);
}

function hasImage(ch: Chapter): boolean {
  return hasText(ch.imageUrl) || ch.embeddedImage !== undefined;
}

/**
 * Port of AntennaPod's `ChapterMerger.score`:
 * `Σ(hasTitle + hasLink + hasImage)`
 */
export function scoreChapterList(chapters: readonly Chapter[]): number {
  let score = 0;
  for (const ch of chapters) {
    if (hasText(ch.title)) score += 1;
    if (hasText(ch.link)) score += 1;
    if (hasImage(ch)) score += 1;
  }
  return score;
}

function normalizeAndSort(list: readonly Chapter[] | null | undefined): Chapter[] {
  if (!list || list.length === 0) return [];
  const valid = list.filter((c) => Number.isFinite(c.startMs) && c.startMs >= 0);
  if (valid.length === 0) return [];
  return [...valid].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Exact port of AntennaPod's `ChapterMerger.merge(chapters1, chapters2)`:
 * 1. Sort both lists by `startMs` ascending; if either is empty, return the other.
 * 2. If counts differ, return whichever list has more chapters.
 * 3. If counts match and every pair satisfies `|start2[i] - start1[i]| <= 1000` ms,
 *    positionally merge into `chapters2`, filling missing `title`/`link`/`image` from `chapters1`.
 * 4. Otherwise cancel the merge and return whichever list has the higher quality score
 *    (`score(chapters1) > score(chapters2) ? chapters1 : chapters2`).
 */
export function mergeChapters(
  chapters1: readonly Chapter[] | null | undefined,
  chapters2: readonly Chapter[] | null | undefined,
): Chapter[] {
  const list1 = normalizeAndSort(chapters1);
  const list2 = normalizeAndSort(chapters2);

  if (list1.length === 0) return list2;
  if (list2.length === 0) return list1;

  if (list2.length > list1.length) return list2;
  if (list1.length > list2.length) return list1;

  for (let i = 0; i < list2.length; i++) {
    if (Math.abs(list2[i]!.startMs - list1[i]!.startMs) > ALIGNMENT_TOLERANCE_MS) {
      return scoreChapterList(list1) > scoreChapterList(list2) ? list1 : list2;
    }
  }

  const merged: Chapter[] = [];
  for (let i = 0; i < list2.length; i++) {
    const target = list2[i]!;
    const other = list1[i]!;

    const title = hasText(target.title) ? target.title : other.title;
    const link = hasText(target.link) ? target.link : other.link;
    const imageUrl = hasText(target.imageUrl) ? target.imageUrl : other.imageUrl;
    const embeddedImage = target.embeddedImage ?? (hasText(target.imageUrl) ? undefined : other.embeddedImage);

    merged.push({
      startMs: target.startMs,
      source: target.source,
      ...(title !== undefined ? { title } : {}),
      ...(link !== undefined ? { link } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(embeddedImage !== undefined ? { embeddedImage } : {}),
    });
  }

  return merged;
}

/**
 * Applies AntennaPod's two-phase chapter merge (`merge(merge(feed, embedded), external)`)
 * and enumerates any blank titles (`"Chapter 1"`, `"Chapter 2"`, ...).
 */
export function mergeAllChapterSources(sources: {
  readonly feed?: readonly Chapter[] | null | undefined;
  readonly embedded?: readonly Chapter[] | null | undefined;
  readonly external?: readonly Chapter[] | null | undefined;
}): Chapter[] {
  const phase1 = mergeChapters(sources.feed, sources.embedded);
  const combined = mergeChapters(phase1, sources.external);
  return enumerateMissingTitles(combined);
}

export function enumerateMissingTitles(chapters: readonly Chapter[]): Chapter[] {
  return chapters.map((ch, idx) => {
    if (hasText(ch.title)) return ch;
    return {
      ...ch,
      title: `Chapter ${idx + 1}`,
    };
  });
}

export const ChapterMerger = {
  merge: mergeChapters,
  mergeAll: mergeAllChapterSources,
  score: scoreChapterList,
  enumerateMissingTitles,
} as const;
