/**
 * Formatting helpers for playback clocks, durations, dates, and safe shownotes HTML.
 */

/** Formats milliseconds as `MM:SS` or `H:MM:SS`. */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad2(mins)}:${pad2(secs)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}`;
}

/** Formats remaining milliseconds as `-MM:SS` or `-H:MM:SS`. */
export function formatRemainingClock(positionMs: number, durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return '--:--';
  const remaining = Math.max(0, durationMs - Math.max(0, positionMs));
  return `-${formatClock(remaining)}`;
}

/** Formats milliseconds into compact human duration (`48 min` or `3h 12m`). */
export function formatHumanDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${totalMin} min`;
}

/** Formats epoch ms into a concise date (`30 Oct` or `2025-10-30`). */
export function formatShortDate(epochMs: number | undefined, locale = 'en'): string {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return '';
  const date = new Date(epochMs);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Formats relative elapsed time (`just now`, `2 min ago`, `3 h ago`). */
export function formatRelativeMinutes(epochMs: number | undefined, nowMs = Date.now()): string {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - epochMs) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} d ago`;
}

/** Formats speed multiplier (`1×`, `1.25×`, `1.5×`, `2×`). */
export function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 100) / 100;
  return `${Number(rounded.toFixed(2))}×`;
}

/** Formats byte counts (`0 B`, `840.0 KB`, `4.1 MB`). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(1)} ${units[idx]}`;
}

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'pre',
  'blockquote',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'span',
]);

/**
 * Safely sanitizes untrusted RSS shownotes HTML using DOMParser when available
 * (falling back to tag stripping), keeping only benign formatting and safe `http(s):` / `mailto:` links.
 */
export function sanitizeShownotesHtml(rawHtml: string | undefined): string {
  if (!rawHtml) return '';
  if (typeof DOMParser === 'undefined') {
    return rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
  }

  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const sanitizeNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtml(node.textContent ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      return '';
    }
    let inner = '';
    for (const child of Array.from(el.childNodes)) {
      inner += sanitizeNode(child);
    }
    if (!ALLOWED_TAGS.has(tag)) {
      return inner;
    }
    if (tag === 'br' || tag === 'hr') {
      return `<${tag} />`;
    }
    if (tag === 'a') {
      const href = (el.getAttribute('href') ?? '').trim();
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${inner || escapeHtml(href)}</a>`;
      }
      return inner;
    }
    return `<${tag}>${inner}</${tag}>`;
  };

  let out = '';
  for (const child of Array.from(doc.body.childNodes)) {
    out += sanitizeNode(child);
  }
  return out.trim();
}

export function stripHtmlToText(rawHtml: string | undefined): string {
  if (!rawHtml) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
