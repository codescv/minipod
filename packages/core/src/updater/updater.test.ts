import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASES_ATOM_URL,
  GITHUB_RELEASES_LIST_URL,
  compareSemver,
  fetchLatestRelease,
  parseGithubReleaseJson,
  parseGithubReleasesAtom,
  parseSemver,
  type ReleaseFetchFn,
} from './updater';

describe('@minipod/core updater', () => {
  it('parses and compares semantic versions', () => {
    expect(parseSemver('v0.1.2')).toEqual([0, 1, 2]);
    expect(parseSemver('1.10.3-rc.1')).toEqual([1, 10, 3]);
    expect(parseSemver('invalid')).toBeUndefined();

    expect(compareSemver('v0.1.2', '0.1.1')).toBe(1);
    expect(compareSemver('0.1.2', 'v0.1.2')).toBe(0);
    expect(compareSemver('0.1.1', '0.2.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('not-a-ver', '0.1.2')).toBe(0);
  });

  it('parses GitHub /releases/latest JSON with APK and PC tarball assets', () => {
    const info = parseGithubReleaseJson({
      tag_name: 'v0.1.2',
      name: 'MiniPod v0.1.2',
      body: '### Added\n- Cross-platform in-app auto-updater',
      published_at: '2026-10-30T15:00:00Z',
      html_url: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
      assets: [
        {
          name: 'app-release.apk',
          browser_download_url:
            'https://github.com/codescv/minipod/releases/download/v0.1.2/app-release.apk',
          size: 4_100_000,
        },
        {
          name: 'minipod-v0.1.2.apk',
          browser_download_url:
            'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
          size: 4_123_456,
        },
        {
          name: 'minipod-v0.1.2-pc.tar.gz',
          browser_download_url:
            'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2-pc.tar.gz',
          size: 850_000,
        },
      ],
    });

    expect(info).toEqual({
      tagName: 'v0.1.2',
      version: '0.1.2',
      title: 'MiniPod v0.1.2',
      notes: '### Added\n- Cross-platform in-app auto-updater',
      publishedAt: '2026-10-30T15:00:00Z',
      htmlUrl: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
      apkUrl: 'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
      apkName: 'minipod-v0.1.2.apk',
      apkSizeBytes: 4_123_456,
      tarballUrl:
        'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2-pc.tar.gz',
      tarballName: 'minipod-v0.1.2-pc.tar.gz',
      tarballSizeBytes: 850_000,
    });
  });

  it('skips draft releases when parsing an array from /releases?per_page=5', () => {
    const info = parseGithubReleaseJson([
      {
        tag_name: 'v0.2.0',
        draft: true,
        assets: [],
      },
      {
        tag_name: 'v0.1.2',
        draft: false,
        prerelease: true,
        assets: [
          {
            name: 'app-release.apk',
            browser_download_url:
              'https://github.com/codescv/minipod/releases/download/v0.1.2/app-release.apk',
            size: 3_900_000,
          },
        ],
      },
    ]);

    expect(info?.version).toBe('0.1.2');
    expect(info?.apkName).toBe('app-release.apk');
    expect(info?.tarballUrl).toBe('https://github.com/codescv/minipod/archive/refs/tags/v0.1.2.tar.gz');
  });

  it('parses GitHub releases.atom feed when API is rate-limited', () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/12345/v0.1.2</id>
    <updated>2026-10-30T15:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/codescv/minipod/releases/tag/v0.1.2"/>
    <title>MiniPod v0.1.2 &amp; Auto-Updater</title>
    <content type="html">&lt;p&gt;Added APK &amp;amp; PC auto-update&lt;/p&gt;</content>
  </entry>
</feed>`;

    const info = parseGithubReleasesAtom(atom);
    expect(info).toEqual({
      tagName: 'v0.1.2',
      version: '0.1.2',
      title: 'MiniPod v0.1.2 & Auto-Updater',
      notes: 'Added APK & PC auto-update',
      publishedAt: '2026-10-30T15:00:00Z',
      htmlUrl: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
      apkUrl: 'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk',
      apkName: 'minipod-v0.1.2.apk',
      tarballUrl: 'https://github.com/codescv/minipod/archive/refs/tags/v0.1.2.tar.gz',
    });
  });

  it('falls back from /releases/latest 404 to /releases?per_page=5', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<ReleaseFetchFn>(async (url: string) => {
      calls.push(url);
      if (url === GITHUB_RELEASE_API_URL) {
        return {
          ok: false,
          status: 404,
          json: async (): Promise<unknown> => ({ message: 'Not Found' }),
          text: async (): Promise<string> => 'Not Found',
        };
      }
      if (url === GITHUB_RELEASES_LIST_URL) {
        return {
          ok: true,
          status: 200,
          json: async (): Promise<unknown> => [
            {
              tag_name: 'v0.1.2',
              name: 'MiniPod v0.1.2',
              body: 'Pre-release fallback',
              html_url: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
              assets: [],
            },
          ],
          text: async (): Promise<string> => '[]',
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const rel = await fetchLatestRelease(fetchMock);
    expect(calls).toEqual([GITHUB_RELEASE_API_URL, GITHUB_RELEASES_LIST_URL]);
    expect(rel.version).toBe('0.1.2');
  });

  it('falls back directly to releases.atom when API returns 403 rate-limit', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<ReleaseFetchFn>(async (url: string) => {
      calls.push(url);
      if (url === GITHUB_RELEASE_API_URL) {
        return {
          ok: false,
          status: 403,
          json: async (): Promise<unknown> => ({ message: 'API rate limit exceeded' }),
          text: async (): Promise<string> => 'API rate limit exceeded',
        };
      }
      if (url === GITHUB_RELEASES_ATOM_URL) {
        return {
          ok: true,
          status: 200,
          json: async (): Promise<unknown> => ({}),
          text: async (): Promise<string> => `<feed><entry>
            <link href="https://github.com/codescv/minipod/releases/tag/v0.1.3"/>
            <title>v0.1.3</title>
            <updated>2026-10-30T16:00:00Z</updated>
            <content>Fast update</content>
          </entry></feed>`,
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const rel = await fetchLatestRelease(fetchMock);
    expect(calls).toEqual([GITHUB_RELEASE_API_URL, GITHUB_RELEASES_ATOM_URL]);
    expect(rel.version).toBe('0.1.3');
    expect(rel.apkUrl).toBe(
      'https://github.com/codescv/minipod/releases/download/v0.1.3/minipod-v0.1.3.apk',
    );
  });
});
