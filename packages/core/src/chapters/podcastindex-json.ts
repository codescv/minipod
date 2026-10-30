import type { Chapter } from '../types';

interface PodcastIndexChapterJson {
  readonly startTime?: number | string;
  readonly title?: string;
  readonly url?: string;
  readonly img?: string;
  readonly toc?: boolean;
}

interface PodcastIndexChaptersDocJson {
  readonly version?: string;
  readonly chapters?: readonly PodcastIndexChapterJson[];
}

/**
 * Port of AntennaPod's `PodcastIndexChapterParser`, enhanced to read `startTime` as a
 * floating-point `Double` (`Math.round(Number(startTime) * 1000)`) so fractional seconds
 * in the Podcasting 2.0 Chapters spec are preserved to millisecond precision.
 */
export function parsePodcastIndexChapters(jsonText: string): Chapter[] {
  const trimmed = jsonText.trim();
  if (!trimmed) return [];

  let parsed: PodcastIndexChaptersDocJson;
  try {
    parsed = JSON.parse(trimmed) as PodcastIndexChaptersDocJson;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.chapters)) return [];

  const out: Chapter[] = [];
  for (const item of parsed.chapters) {
    if (!item || typeof item !== 'object') continue;
    if (item.toc === false) continue;

    const rawStart =
      typeof item.startTime === 'number'
        ? item.startTime
        : typeof item.startTime === 'string'
          ? Number.parseFloat(item.startTime)
          : Number.NaN;
    if (!Number.isFinite(rawStart) || rawStart < 0) continue;

    const startMs = Math.round(rawStart * 1000);
    const title = typeof item.title === 'string' ? item.title.trim() : undefined;
    const link = typeof item.url === 'string' ? item.url.trim() : undefined;
    const imageUrl = typeof item.img === 'string' ? item.img.trim() : undefined;

    out.push({
      startMs,
      source: 'PI_JSON',
      ...(title ? { title } : {}),
      ...(link ? { link } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}
