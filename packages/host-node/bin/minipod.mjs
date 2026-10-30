#!/usr/bin/env node
/**
 * MiniPod PC Web App launcher (`ARCHITECTURE.md §10.2`).
 * Runs `dist/server.mjs` when built, or falls back to `tsx` in source checkouts.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const minor = Number.parseInt(process.versions.node.split('.')[1] ?? '0', 10);
if (major < 22 || (major === 22 && minor < 5)) {
  process.stderr.write(
    `[minipod] Node.js >= 22.5.0 is required for built-in node:sqlite (found ${process.versions.node}).\n`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', 'dist', 'server.mjs');

if (existsSync(distEntry)) {
  const mod = await import(pathToFileURL(distEntry).href);
  await mod.runCli(process.argv.slice(2));
} else {
  const { spawn } = await import('node:child_process');
  const srcMain = join(here, '..', 'src', 'server', 'main.ts');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', srcMain, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}
