/**
 * Platform-neutral GitHub Releases update checker for `codescv/minipod`.
 *
 * - Primary: `https://api.github.com/repos/codescv/minipod/releases/latest`
 * - Fallback 1 (e.g. 404 / prerelease-only): `https://api.github.com/repos/codescv/minipod/releases?per_page=5`
 * - Fallback 2 (e.g. 403/429 GitHub API rate-limit): `https://github.com/codescv/minipod/releases.atom`
 */
import type { ReleaseInfo } from '../types';

export const GITHUB_REPO = 'codescv/minipod';
export const CURRENT_APP_VERSION = '0.1.7';
export const GITHUB_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_LIST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`;
export const GITHUB_RELEASES_ATOM_URL = `https://github.com/${GITHUB_REPO}/releases.atom`;
export const GITHUB_RELEASES_HTML_URL = `https://github.com/${GITHUB_REPO}/releases`;

export interface ReleaseFetchResponseLike {
  readonly ok: boolean;
  readonly status?: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ReleaseFetchFn = (
  url: string,
  init?: {
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<ReleaseFetchResponseLike>;

/** Parse a `vX.Y.Z` or `X.Y.Z` tag into numeric `[major, minor, patch]`. */
export function parseSemver(raw: string): readonly [number, number, number] | undefined {
  const cleaned = raw.trim().replace(/^[vV]/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return undefined;
  const major = Number.parseInt(m[1] ?? '0', 10);
  const minor = Number.parseInt(m[2] ?? '0', 10);
  const patch = Number.parseInt(m[3] ?? '0', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }
  return [major, minor, patch];
}

export const parseSemanticVersion = parseSemver;

/**
 * Compare two semantic version strings (`a` vs `b`).
 * Returns `1` if `a > b`, `-1` if `a < b`, `0` if equal or unparseable.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export const compareSemanticVersions = compareSemver;

interface GithubAssetJson {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
}

interface GithubReleaseJson {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly body?: unknown;
  readonly published_at?: unknown;
  readonly html_url?: unknown;
  readonly tarball_url?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

/** Parse a GitHub Release JSON object (or array of releases) into `ReleaseInfo`. */
export function parseGithubReleaseJson(data: unknown): ReleaseInfo | undefined {
  if (Array.isArray(data)) {
    for (const item of data) {
      const parsed = parseGithubReleaseJson(item);
      if (parsed) return parsed;
    }
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const rel = data as GithubReleaseJson;
  if (rel.draft === true) return undefined;

  const tagName = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
  const semver = parseSemver(tagName);
  if (!tagName || !semver) return undefined;
  const version = `${semver[0]}.${semver[1]}.${semver[2]}`;
  const title = typeof rel.name === 'string' && rel.name.trim() !== '' ? rel.name.trim() : tagName;
  const notes = typeof rel.body === 'string' ? rel.body.trim() : '';
  const publishedAt = typeof rel.published_at === 'string' ? rel.published_at : '';
  const htmlUrl =
    typeof rel.html_url === 'string' && rel.html_url.trim() !== ''
      ? rel.html_url.trim()
      : `${GITHUB_RELEASES_HTML_URL}/tag/${tagName}`;

  let apkUrl: string | undefined;
  let apkName: string | undefined;
  let apkSizeBytes: number | undefined;

  let tarballUrl: string | undefined;
  let tarballName: string | undefined;
  let tarballSizeBytes: number | undefined;

  if (Array.isArray(rel.assets)) {
    const assets = rel.assets as GithubAssetJson[];
    const apkAssets = assets.filter(
      (a) =>
        typeof a?.name === 'string' &&
        a.name.toLowerCase().endsWith('.apk') &&
        typeof a?.browser_download_url === 'string',
    );
    const preferredApk =
      apkAssets.find((a) => /^minipod-.*\.apk$/i.test(String(a.name))) ??
      apkAssets.find((a) => String(a.name).toLowerCase() === 'app-release.apk') ??
      apkAssets[0];
    if (preferredApk && typeof preferredApk.browser_download_url === 'string') {
      apkUrl = preferredApk.browser_download_url;
      apkName = typeof preferredApk.name === 'string' ? preferredApk.name : undefined;
      apkSizeBytes =
        typeof preferredApk.size === 'number' && preferredApk.size > 0
          ? preferredApk.size
          : undefined;
    }

    const archiveAssets = assets.filter(
      (a) =>
        typeof a?.name === 'string' &&
        (/\.(tar\.gz|tgz|zip)$/i.test(a.name)) &&
        typeof a?.browser_download_url === 'string',
    );
    const preferredArchive =
      archiveAssets.find((a) => /^minipod-.*\.(tar\.gz|tgz|zip)$/i.test(String(a.name))) ??
      archiveAssets[0];
    if (preferredArchive && typeof preferredArchive.browser_download_url === 'string') {
      tarballUrl = preferredArchive.browser_download_url;
      tarballName = typeof preferredArchive.name === 'string' ? preferredArchive.name : undefined;
      tarballSizeBytes =
        typeof preferredArchive.size === 'number' && preferredArchive.size > 0
          ? preferredArchive.size
          : undefined;
    }
  }

  if (!tarballUrl) {
    tarballUrl =
      typeof rel.tarball_url === 'string' && rel.tarball_url.trim() !== ''
        ? rel.tarball_url.trim()
        : `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`;
  }

  return {
    tagName,
    version,
    title,
    notes,
    publishedAt,
    htmlUrl,
    ...(apkUrl ? { apkUrl } : {}),
    ...(apkName ? { apkName } : {}),
    ...(apkSizeBytes !== undefined ? { apkSizeBytes } : {}),
    ...(tarballUrl ? { tarballUrl } : {}),
    ...(tarballName ? { tarballName } : {}),
    ...(tarballSizeBytes !== undefined ? { tarballSizeBytes } : {}),
  };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/&amp;/g, '&');
}

/**
 * Fallback parser for `https://github.com/codescv/minipod/releases.atom` when
 * `api.github.com` is rate-limited (HTTP 403/429) or unreachable.
 */
export function parseGithubReleasesAtom(xml: string): ReleaseInfo | undefined {
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1] ?? '';
    const linkMatch = /<link[^>]+href="([^"]*\/releases\/tag\/([^"?#]+))"/i.exec(entry);
    const idMatch = /<id>[^<]*\/([^/<]+)<\/id>/i.exec(entry);
    const rawTag = decodeURIComponent((linkMatch?.[2] ?? idMatch?.[1] ?? '').trim());
    const semver = parseSemver(rawTag);
    if (!rawTag || !semver) continue;
    const version = `${semver[0]}.${semver[1]}.${semver[2]}`;
    const titleRaw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(entry)?.[1]?.trim() ?? rawTag;
    const title = decodeHtmlEntities(titleRaw) || rawTag;
    const updated = /<updated>([^<]+)<\/updated>/i.exec(entry)?.[1]?.trim() ?? '';
    const contentRaw = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(entry)?.[1]?.trim() ?? '';
    const notes = decodeHtmlEntities(contentRaw)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const htmlUrl = linkMatch?.[1] ?? `${GITHUB_RELEASES_HTML_URL}/tag/${rawTag}`;
    const normalizedTag = rawTag.startsWith('v') || rawTag.startsWith('V') ? rawTag : `v${version}`;
    const apkName = `minipod-${normalizedTag}.apk`;
    const apkUrl = `${GITHUB_RELEASES_HTML_URL}/download/${rawTag}/${apkName}`;
    const tarballUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${rawTag}.tar.gz`;
    return {
      tagName: rawTag,
      version,
      title,
      notes,
      publishedAt: updated,
      htmlUrl,
      apkUrl,
      apkName,
      tarballUrl,
    };
  }
  return undefined;
}

export interface FetchLatestReleaseOptions {
  readonly signal?: AbortSignal;
  readonly userAgent?: string;
}

/**
 * Queries GitHub Releases `/releases/latest`, falling back to `/releases?per_page=5`
 * on 404/draft and `releases.atom` when `api.github.com` rate-limits.
 */
export async function fetchLatestRelease(
  fetchImpl?: ReleaseFetchFn,
  options?: FetchLatestReleaseOptions,
): Promise<ReleaseInfo> {
  const fn = fetchImpl ?? (globalThis.fetch?.bind(globalThis) as ReleaseFetchFn | undefined);
  if (typeof fn !== 'function') {
    throw new Error('Network fetch is unavailable in this environment');
  }

  const jsonHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(options?.userAgent ? { 'User-Agent': options.userAgent } : {}),
  };
  const reqExtra = options?.signal ? { signal: options.signal } : {};

  let lastStatus: number | undefined;
  let rateLimited = false;

  try {
    const res = await fn(GITHUB_RELEASE_API_URL, { headers: jsonHeaders, ...reqExtra });
    lastStatus = res.status;
    if (res.ok) {
      const info = parseGithubReleaseJson(await res.json());
      if (info) return info;
    } else if (res.status === 403 || res.status === 429) {
      rateLimited = true;
    }
  } catch {
    // Fall through to list / Atom feed
  }

  if (!rateLimited) {
    try {
      const listRes = await fn(GITHUB_RELEASES_LIST_URL, { headers: jsonHeaders, ...reqExtra });
      lastStatus = listRes.status;
      if (listRes.ok) {
        const info = parseGithubReleaseJson(await listRes.json());
        if (info) return info;
      }
    } catch {
      // Fall through to Atom feed
    }
  }

  try {
    const atomHeaders: Record<string, string> = {
      Accept: 'application/atom+xml, application/xml, text/xml, */*',
      ...(options?.userAgent ? { 'User-Agent': options.userAgent } : {}),
    };
    const atomRes = await fn(GITHUB_RELEASES_ATOM_URL, { headers: atomHeaders, ...reqExtra });
    lastStatus = atomRes.status;
    if (atomRes.ok) {
      const info = parseGithubReleasesAtom(await atomRes.text());
      if (info) return info;
    }
  } catch {
    // Handled below
  }

  if (lastStatus !== undefined && lastStatus >= 400) {
    throw new Error(`HTTP ${lastStatus}`);
  }
  throw new Error('No published MiniPod release found');
}
