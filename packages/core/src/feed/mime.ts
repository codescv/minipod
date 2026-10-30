import type { MediaType } from '../types';

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

function mimeFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const noQuery = url.split(/[?#]/)[0] ?? '';
  const dot = noQuery.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = noQuery.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}

/**
 * Port of AntennaPod's `MimeTypeUtils.getMimeType(type, filename)`.
 */
export function inferMediaMimeType(declaredMime: string | undefined, url: string | undefined): string | undefined {
  const cleaned = declaredMime?.split(';')[0]?.trim().toLowerCase();
  if (
    cleaned &&
    cleaned !== 'application/octet-stream' &&
    cleaned !== 'binary/octet-stream' &&
    cleaned !== 'audio/x-mpeg'
  ) {
    if (cleaned === 'audio/mp3') return 'audio/mpeg';
    return cleaned;
  }
  if (cleaned === 'audio/x-mpeg') return 'audio/mpeg';
  return mimeFromUrl(url) ?? (cleaned || undefined);
}

export function isMediaMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  return (
    lower.startsWith('audio/') ||
    lower.startsWith('video/') ||
    lower === 'application/ogg' ||
    lower === 'application/x-ogg'
  );
}

export function isImageMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.toLowerCase().startsWith('image/');
}

export function classifyMediaType(mime: string | undefined, url?: string): MediaType {
  const effective = inferMediaMimeType(mime, url);
  if (!effective) return 'UNKNOWN';
  if (effective.startsWith('video/')) return 'VIDEO';
  if (effective.startsWith('audio/') || effective === 'application/ogg' || effective === 'application/x-ogg') {
    return 'AUDIO';
  }
  return 'UNKNOWN';
}
