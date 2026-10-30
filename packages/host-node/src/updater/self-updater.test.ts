import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_RELEASE_API_URL } from '@minipod/core';
import { connectRestPlatformHost } from '../client/rest-host';
import { parseCliArgs } from '../server/main';
import { startServer, type RunningServer } from '../server/start';

const tempDirs: string[] = [];
const runningServers: RunningServer[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    await runningServers.pop()!.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createMockGithubFetch(bundleBytes = new TextEncoder().encode('TAR_GZ_BUNDLE_PAYLOAD')) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === GITHUB_RELEASE_API_URL) {
      return new Response(
        JSON.stringify({
          tag_name: 'v0.1.2',
          name: 'MiniPod v0.1.2',
          body: 'PC self-updater release',
          published_at: '2026-10-30T15:00:00Z',
          html_url: 'https://github.com/codescv/minipod/releases/tag/v0.1.2',
          assets: [
            {
              name: 'minipod-v0.1.2-pc.tar.gz',
              browser_download_url:
                'https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2-pc.tar.gz',
              size: bundleBytes.byteLength,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('minipod-v0.1.2-pc.tar.gz')) {
      return new Response(bundleBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' },
      });
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

describe('@minipod/host-node self-updater & CLI update subcommand', () => {
  it('parses CLI update subcommand and flags without breaking positional feed URLs', () => {
    expect(parseCliArgs(['update'])).toMatchObject({
      command: 'update',
      checkOnly: false,
      forceUpdate: false,
    });
    expect(parseCliArgs(['update', '--check', '--data-dir=/tmp/mp'])).toMatchObject({
      command: 'update',
      checkOnly: true,
      dataDir: '/tmp/mp',
    });
    expect(parseCliArgs(['https://feeds.example.org/show.xml', '--no-open'])).toMatchObject({
      command: 'serve',
      addInput: 'https://feeds.example.org/show.xml',
      openBrowser: false,
    });
  });

  it('serves POST /api/update/check and updates via git pull --ff-only when inside a git worktree', async () => {
    const rootTmp = mkdtempSync(join(tmpdir(), 'minipod-git-upd-'));
    tempDirs.push(rootTmp);

    const originDir = join(rootTmp, 'origin.git');
    const upstreamWork = join(rootTmp, 'upstream');
    const localClone = join(rootTmp, 'clone');
    const dataDir = join(rootTmp, 'data');

    execFileSync('git', ['init', '--bare', '-b', 'main', originDir]);
    execFileSync('git', ['clone', originDir, upstreamWork]);
    execFileSync('git', ['-C', upstreamWork, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', upstreamWork, 'config', 'user.name', 'Test']);
    writeFileSync(join(upstreamWork, 'VERSION'), '0.1.0\n', 'utf8');
    execFileSync('git', ['-C', upstreamWork, 'add', 'VERSION']);
    execFileSync('git', ['-C', upstreamWork, 'commit', '-m', 'v0.1.0']);
    execFileSync('git', ['-C', upstreamWork, 'push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', originDir, localClone]);

    // Advance origin to v0.1.2
    writeFileSync(join(upstreamWork, 'VERSION'), '0.1.2\n', 'utf8');
    execFileSync('git', ['-C', upstreamWork, 'add', 'VERSION']);
    execFileSync('git', ['-C', upstreamWork, 'commit', '-m', 'v0.1.2']);
    execFileSync('git', ['-C', upstreamWork, 'tag', 'v0.1.2']);
    execFileSync('git', ['-C', upstreamWork, 'push', 'origin', 'main', '--tags']);

    const srv = await startServer({
      dataDir,
      appVersion: '0.1.0',
      repoDir: localClone,
      fetchImpl: createMockGithubFetch(),
    });
    runningServers.push(srv);

    const clientHost = await connectRestPlatformHost({
      baseUrl: srv.url,
      enableSse: false,
    });

    const checkRes = await clientHost.updater!.check();
    expect(checkRes.updateAvailable).toBe(true);
    expect(checkRes.release?.version).toBe('0.1.2');

    const applyRes = await clientHost.updater!.apply();
    expect(applyRes.ok).toBe(true);
    expect(applyRes.method).toBe('git-pull');
    expect(applyRes.targetVersion).toBe('0.1.2');
    expect(readFileSync(join(localClone, 'VERSION'), 'utf8').trim()).toBe('0.1.2');

    await clientHost.dispose();
  });

  it('downloads the release tarball atomically when running outside a git repository', async () => {
    const rootTmp = mkdtempSync(join(tmpdir(), 'minipod-bundle-upd-'));
    tempDirs.push(rootTmp);
    const nonGitDir = join(rootTmp, 'standalone');
    const dataDir = join(rootTmp, 'data');

    const srv = await startServer({
      dataDir,
      appVersion: '0.1.0',
      repoDir: nonGitDir,
      fetchImpl: createMockGithubFetch(new TextEncoder().encode('STANDALONE_TARBALL_V012')),
    });
    runningServers.push(srv);

    const applyHttp = await fetch(`${srv.url}/api/update/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(applyHttp.status).toBe(200);
    const payload = (await applyHttp.json()) as {
      ok: boolean;
      data: {
        method: string;
        targetVersion: string;
        bundlePath?: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.method).toBe('release-bundle');
    expect(payload.data.targetVersion).toBe('0.1.2');
    expect(payload.data.bundlePath).toBeTruthy();
    expect(existsSync(payload.data.bundlePath!)).toBe(true);
    expect(readFileSync(payload.data.bundlePath!, 'utf8')).toBe('STANDALONE_TARBALL_V012');
  });
});
