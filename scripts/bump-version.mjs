#!/usr/bin/env node
/**
 * Automatically increments the patch version (e.g. 0.1.0 -> 0.1.1) and Android
 * `versionCode` across the monorepo whenever an Android APK is packaged (or when
 * invoked directly with `node scripts/bump-version.mjs [explicitVersion]`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function bumpPatch(version) {
  const parts = version.trim().split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

const rootPkgPath = resolve(rootDir, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const oldVersion = rootPkg.version;
const explicitVersion = process.argv[2];
const nextVersion = explicitVersion && !explicitVersion.startsWith('-') ? explicitVersion : bumpPatch(oldVersion);

const pkgPaths = [
  'package.json',
  'packages/core/package.json',
  'packages/ui/package.json',
  'packages/host-node/package.json',
  'packages/host-android/package.json',
];

for (const rel of pkgPaths) {
  const full = resolve(rootDir, rel);
  const pkg = JSON.parse(readFileSync(full, 'utf8'));
  pkg.version = nextVersion;
  writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/** Optional secondary version locations; skipped when the file does not exist yet. */
function patchIfExists(rel, replacer) {
  const full = resolve(rootDir, rel);
  if (!existsSync(full)) return;
  writeFileSync(full, replacer(readFileSync(full, 'utf8')), 'utf8');
}

patchIfExists('packages/core/src/updater/updater.ts', (src) =>
  src.replace(/export const CURRENT_APP_VERSION = '[^']+';/, `export const CURRENT_APP_VERSION = '${nextVersion}';`),
);
patchIfExists('packages/host-node/src/server/context.ts', (src) =>
  src.replace(/export const MINIPOD_VERSION = '[^']+';/, `export const MINIPOD_VERSION = '${nextVersion}';`),
);
patchIfExists('packages/host-android/src/default-deps.ts', (src) =>
  src.replace(/version = '[0-9]+\.[0-9]+\.[0-9]+';/, `version = '${nextVersion}';`),
);
patchIfExists('packages/ui/src/features/updater/updater.ts', (src) =>
  src
    .replace(/currentVersion: '[0-9]+\.[0-9]+\.[0-9]+'/g, `currentVersion: '${nextVersion}'`)
    .replace(/appVersion \|\| '[0-9]+\.[0-9]+\.[0-9]+'/g, `appVersion || '${nextVersion}'`),
);

let nextVersionCode = 1;
patchIfExists('packages/host-android/android/app/build.gradle', (gradle) =>
  gradle
    .replace(/versionCode\s+(\d+)/, (_m, code) => {
      nextVersionCode = Number(code) + 1;
      return `versionCode ${nextVersionCode}`;
    })
    .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`),
);

console.log(`[bump-version] ${oldVersion} -> ${nextVersion} (Android versionCode ${nextVersionCode})`);
