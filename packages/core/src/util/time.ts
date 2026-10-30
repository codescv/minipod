import type { EpochMs } from '../types';

/**
 * Parses `<itunes:duration>` or `media:content[duration]` values into milliseconds.
 * Accepts:
 * - `HH:MM:SS` or `HH:MM:SS.mmm`
 * - `MM:SS` or `MM:SS.mmm`
 * - Raw seconds (`"3600"`, `"125.5"`, `3600`)
 */
export function parseDurationMs(raw: string | number | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return Math.round(raw * 1000);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => p.trim());
    if (parts.some((p) => p === '' || !/^\d+(?:\.\d+)?$/.test(p))) return undefined;
    if (parts.length === 3) {
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      const seconds = Number(parts[2]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return undefined;
      const ms = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
      return ms > 0 ? ms : undefined;
    }
    if (parts.length === 2) {
      const minutes = Number(parts[0]);
      const seconds = Number(parts[1]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return undefined;
      const ms = Math.round((minutes * 60 + seconds) * 1000);
      return ms > 0 ? ms : undefined;
    }
    return undefined;
  }

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Parses Normal Play Time (NPT) chapter timestamps used by Podlove Simple Chapters
 * and Ogg/Opus Vorbis comments (`CHAPTER001=00:01:12.850`, `01:30`, `12.5`, `00:00:05.000-->00:01:00`).
 * Preserves full floating-point millisecond precision (fixing AntennaPod's integer cast quirk).
 */
export function parseChapterTimestampMs(raw: string): number | undefined {
  let cleaned = raw.trim();
  if (!cleaned) return undefined;
  const arrowIdx = cleaned.indexOf('-->');
  if (arrowIdx >= 0) {
    cleaned = cleaned.slice(0, arrowIdx).trim();
  }
  // Optional trailing 's' in NPT (e.g. "12.5s")
  if (cleaned.endsWith('s') || cleaned.endsWith('S')) {
    cleaned = cleaned.slice(0, -1).trim();
  }
  if (!cleaned) return undefined;

  const parts = cleaned.split(':');
  if (parts.length === 1) {
    if (!/^\d+(?:\.\d+)?$/.test(parts[0]!)) return undefined;
    const sec = Number.parseFloat(parts[0]!);
    return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : undefined;
  }
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[0]!) || !/^\d+(?:\.\d+)?$/.test(parts[1]!)) return undefined;
    const min = Number.parseInt(parts[0]!, 10);
    const sec = Number.parseFloat(parts[1]!);
    if (!Number.isFinite(min) || !Number.isFinite(sec) || min < 0 || sec < 0) return undefined;
    return Math.round((min * 60 + sec) * 1000);
  }
  if (parts.length >= 3) {
    const hStr = parts[0]!.trim();
    const mStr = parts[1]!.trim();
    let sStr = parts[2]!.trim();
    const sArrow = sStr.indexOf('-->');
    if (sArrow >= 0) sStr = sStr.slice(0, sArrow).trim();
    if (!/^\d+$/.test(hStr) || !/^\d+$/.test(mStr) || !/^\d+(?:\.\d+)?$/.test(sStr)) return undefined;
    const hours = Number.parseInt(hStr, 10);
    const minutes = Number.parseInt(mStr, 10);
    const seconds = Number.parseFloat(sStr);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return undefined;
    if (hours < 0 || minutes < 0 || seconds < 0) return undefined;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }
  return undefined;
}

const TZ_OFFSETS: Readonly<Record<string, string>> = {
  UT: '+0000',
  UTC: '+0000',
  GMT: '+0000',
  Z: '+0000',
  EST: '-0500',
  EDT: '-0400',
  CST: '-0600',
  CDT: '-0500',
  MST: '-0700',
  MDT: '-0600',
  PST: '-0800',
  PDT: '-0700',
  CET: '+0100',
  CEST: '+0200',
  BST: '+0100',
  IST: '+0530',
  JST: '+0900',
  AEST: '+1000',
  AEDT: '+1100',
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Tolerant RSS/Atom/DublinCore publication date parser modelled on AntennaPod's `DateUtils.parse`.
 * Handles RFC 822 / 2822 (including named US/EU/Asia timezone abbreviations and mismatched weekdays),
 * ISO-8601, compact `yyyyMMdd'T'HHmmss`, and ignores the Apple/QuickTime `1904-01-01` placeholder.
 */
export function parsePubDateMs(raw: string | undefined | null): EpochMs | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return undefined;

  // Ignore QuickTime/MP4 default epoch placeholder (AntennaPod LocalFeedUpdater rule)
  if (s.startsWith('19040101') || s.startsWith('1904-01-01')) return undefined;

  // Compact yyyyMMdd'T'HHmmss(.SSS)?(Z)?
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z?$/i.exec(s);
  if (compact) {
    const ms = Date.UTC(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4]),
      Number(compact[5]),
      Number(compact[6]),
      compact[7] ? Number(compact[7].padEnd(3, '0')) : 0,
    );
    return Number.isFinite(ms) ? ms : undefined;
  }

  // Strip leading weekday ("Mon, " / "Monday, " / "Mon ") which may disagree with the actual calendar date
  const strippedWeekday = s.replace(/^[A-Za-z]{3,9},?\s+(?=\d|[A-Za-z]{3}\s+\d)/, '');

  // Replace trailing named timezone abbreviation (e.g. "... EDT") with numeric offset
  const normalizedTz = strippedWeekday.replace(/\s+([A-Z]{1,5})$/, (full, tz: string) => {
    const offset = TZ_OFFSETS[tz.toUpperCase()];
    return offset ? ` ${offset}` : full;
  });

  // Explicit RFC 822 / 2822: DD Mon YYYY HH:MM(:SS)? (+/-HHMM)?
  const rfc =
    /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([+-]\d{2}:?\d{2}))?)?$/.exec(
      normalizedTz,
    );
  if (rfc) {
    const day = Number(rfc[1]);
    const monthKey = rfc[2]!.slice(0, 3).toLowerCase();
    const month = MONTHS[monthKey];
    let year = Number(rfc[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const hour = rfc[4] !== undefined ? Number(rfc[4]) : 0;
    const min = rfc[5] !== undefined ? Number(rfc[5]) : 0;
    const sec = rfc[6] !== undefined ? Number(rfc[6]) : 0;
    if (month !== undefined) {
      let utcMs = Date.UTC(year, month, day, hour, min, sec);
      if (rfc[7]) {
        const tzRaw = rfc[7].replace(':', '');
        const sign = tzRaw.startsWith('-') ? -1 : 1;
        const tzH = Number(tzRaw.slice(1, 3));
        const tzM = Number(tzRaw.slice(3, 5));
        utcMs -= sign * (tzH * 60 + tzM) * 60_000;
      }
      if (Number.isFinite(utcMs)) return utcMs;
    }
  }

  // ISO-8601 date-only YYYY-MM-DD -> UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const parsedIso = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(parsedIso) ? parsedIso : undefined;
  }

  // SQL/space-separated ISO: YYYY-MM-DD HH:MM:SS -> UTC if no offset
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(s)) {
    const parsedSpace = Date.parse(`${s.replace(' ', 'T')}Z`);
    return Number.isFinite(parsedSpace) ? parsedSpace : undefined;
  }

  const fallback = Date.parse(normalizedTz);
  if (Number.isFinite(fallback)) return fallback;

  const rawFallback = Date.parse(s);
  return Number.isFinite(rawFallback) ? rawFallback : undefined;
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Formats an epoch timestamp as an RFC 822 / OPML 2.0 UTC date string.
 */
export function formatRfc822Date(epochMs: EpochMs): string {
  const d = new Date(epochMs);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const dayName = SHORT_DAYS[d.getUTCDay()];
  const day = pad2(d.getUTCDate());
  const month = SHORT_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${dayName}, ${day} ${month} ${year} ${hh}:${mm}:${ss} +0000`;
}
