/**
 * PC Web App & CLI self-updater for `@minipod/host-node` (`codescv/minipod`).
 *
 * - `checkNodeUpdate`: queries GitHub Releases (`api.github.com` -> `/releases?per_page=5` -> `releases.atom`).
 * - `applyNodeUpdate`:
 *   1. If running inside a git worktree with an `origin` remote, runs
 *      `git fetch origin --tags && git pull --ff-only`.
 *   2. Otherwise (or if `git pull --ff-only` cannot fast-forward), downloads the release
 *      tarball atomically into `<dataDir>/updates/minipod-v<version>.tar.gz`.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_REPO,
  compareSemver,
  fetchLatestRelease,
  type HostUpdateApplyResult,
  type HostUpdateCheckResult,
  type ReleaseFetchFn,
} from '@minipod/core';

export interface SelfUpdaterOptions {
  readonly currentVersion: string;
  readonly repoDir?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly userAgent?: string | undefined;
  readonly execGitImpl?: ((args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>) | undefined;
}

function defaultExecGit(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          rej(new Error((stderr || err.message).trim()));
          return;
        }
        res({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function defaultRepoDir(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Built `dist/server.mjs` -> `../..` is repo root; source `src/updater/self-updater.ts` -> `../../../..`
    const candidates = [
      resolve(here, '..', '..'),
      resolve(here, '..', '..', '..', '..'),
      process.cwd(),
    ];
    for (const dir of candidates) {
      if (existsSync(join(dir, '.git'))) {
        return dir;
      }
    }
  } catch {
    // ignore
  }
  return process.cwd();
}

function toReleaseFetchFn(fetchImpl?: typeof fetch): ReleaseFetchFn {
  const fn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fn !== 'function') {
    throw new Error('fetch is unavailable in this Node runtime');
  }
  return async (url, init) => {
    const res = await fn(url, {
      method: 'GET',
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json(),
      text: () => res.text(),
    };
  };
}

export async function checkNodeUpdate(
  options: SelfUpdaterOptions & { readonly overrideCurrentVersion?: string | undefined },
): Promise<HostUpdateCheckResult> {
  const currentVersion = options.overrideCurrentVersion?.trim() || options.currentVersion;
  const release = await fetchLatestRelease(toReleaseFetchFn(options.fetchImpl), {
    userAgent: options.userAgent ?? `MiniPod-Updater/${currentVersion}`,
  });
  return {
    currentVersion,
    updateAvailable: compareSemver(release.version, currentVersion) > 0,
    release,
    checkedAt: Date.now(),
  };
}

export async function applyNodeUpdate(
  options: SelfUpdaterOptions & { readonly force?: boolean | undefined },
): Promise<HostUpdateApplyResult> {
  const check = await checkNodeUpdate(options);
  const release = check.release;
  if (!release || (!check.updateAvailable && !options.force)) {
    return {
      ok: true,
      method: 'up-to-date',
      previousVersion: options.currentVersion,
      targetVersion: options.currentVersion,
      message: `MiniPod v${options.currentVersion} is already up to date.`,
    };
  }

  const repoDir = options.repoDir ?? defaultRepoDir();
  const runGit = options.execGitImpl ?? defaultExecGit;

  // 1. Try fast-forward git update if inside a git worktree with an `origin` remote
  let canUseGit = false;
  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], repoDir);
    if (inside.stdout.trim() === 'true') {
      const origin = await runGit(['remote', 'get-url', 'origin'], repoDir);
      canUseGit = origin.stdout.trim().length > 0;
    }
  } catch {
    canUseGit = false;
  }

  if (canUseGit) {
    try {
      await runGit(['fetch', 'origin', '--tags'], repoDir);
      await runGit(['pull', '--ff-only'], repoDir);
      return {
        ok: true,
        method: 'git-pull',
        previousVersion: options.currentVersion,
        targetVersion: release.version,
        restartRequired: true,
        message: `Updated MiniPod to v${release.version} via git pull. Restart MiniPod to run the updated version.`,
      };
    } catch {
      // Fall back to downloading the release bundle when worktree has local changes or cannot ff-only
    }
  }

  // 2. Download the release bundle atomically into `<dataDir>/updates/`
  const fn = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fn !== 'function') {
    throw new Error('fetch is unavailable for downloading release bundle');
  }

  const tarballUrl =
    release.tarballUrl ??
    `https://github.com/${GITHUB_REPO}/archive/refs/tags/${release.tagName}.tar.gz`;
  const baseUpdatesDir =
    options.dataDir && options.dataDir !== ':memory:'
      ? join(options.dataDir, 'updates')
      : join(tmpdir(), 'minipod-updates');
  mkdirSync(baseUpdatesDir, { recursive: true });

  const safeVer = release.version.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = release.tarballName?.toLowerCase().endsWith('.zip') ? '.zip' : '.tar.gz';
  const bundlePath = join(baseUpdatesDir, `minipod-v${safeVer}${ext}`);
  const tmpPath = `${bundlePath}.tmp.${process.pid}`;

  try {
    const res = await fn(tarballUrl, {
      method: 'GET',
      headers: {
        'User-Agent': options.userAgent ?? `MiniPod-Updater/${options.currentVersion}`,
        Accept: 'application/octet-stream, application/gzip, */*',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${tarballUrl}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error('Downloaded release bundle is empty');
    }
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, bundlePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    ok: true,
    method: 'release-bundle',
    previousVersion: options.currentVersion,
    targetVersion: release.version,
    restartRequired: true,
    bundlePath,
    message: `Downloaded MiniPod v${release.version} release bundle to ${bundlePath}.`,
  };
}
