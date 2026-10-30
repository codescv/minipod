/**
 * CLI entry point for `@minipod/host-node` (`bin/minipod.mjs` & `pnpm dev`).
 *
 * Supports:
 * - `--port <n>` (default `0` ephemeral, or `47821` in `--dev` mode)
 * - `--data-dir <dir>` (default `~/.minipod`)
 * - `--no-open` (do not launch browser)
 * - `--new-browser` / `--app` (prefer standalone Chrome/Edge `--app=<url>` window)
 * - Positional podcast URL / deep-link (`itpc://`, `pcast://`, `feed://`, `antennapod-subscribe://`, `https://...`)
 *   opened as `/?add=<encoded>` (`ARCHITECTURE.md §3.2`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';
import { defaultOpenExternal } from './context';
import { startServer } from './start';

export interface ParsedCliArgs {
  readonly port: number;
  readonly dataDir?: string;
  readonly openBrowser: boolean;
  readonly appWindow: boolean;
  readonly dev: boolean;
  readonly addInput?: string;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let port: number | undefined;
  let dataDir: string | undefined;
  let openBrowser = true;
  let appWindow = false;
  let dev = false;
  let addInput: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dev') {
      dev = true;
    } else if (arg === '--no-open') {
      openBrowser = false;
    } else if (arg === '--new-browser' || arg === '--app') {
      appWindow = true;
    } else if (arg === '--port' && argv[i + 1]) {
      port = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i]!;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (!arg.startsWith('-') && !addInput) {
      addInput = arg;
    }
  }

  const resolvedPort =
    port !== undefined && Number.isFinite(port) && port >= 0
      ? port
      : dev
        ? 47821
        : 0;

  return {
    port: resolvedPort,
    openBrowser: dev ? false : openBrowser,
    appWindow,
    dev,
    ...(dataDir ? { dataDir } : {}),
    ...(addInput ? { addInput } : {}),
  };
}

function findChromiumBinary(): string | undefined {
  const plat = osPlatform();
  if (plat === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return macCandidates.find((p) => existsSync(p));
  }
  if (plat === 'linux') {
    const linuxCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];
    return linuxCandidates.find((p) => existsSync(p));
  }
  return undefined;
}

async function launchBrowserWindow(targetUrl: string, preferAppMode: boolean): Promise<void> {
  if (preferAppMode) {
    const bin = findChromiumBinary();
    if (bin) {
      await new Promise<void>((resolve) => {
        const child = spawn(bin, [`--app=${targetUrl}`], {
          stdio: 'ignore',
          detached: true,
        });
        child.once('error', () => resolve());
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return;
    }
  }
  await defaultOpenExternal(targetUrl).catch(() => undefined);
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);
  const running = await startServer({
    port: args.port,
    ...(args.dataDir ? { dataDir: args.dataDir } : {}),
  });

  const launchUrl = args.addInput
    ? `${running.url}/?add=${encodeURIComponent(args.addInput)}`
    : running.url;

  process.stdout.write(`MiniPod listening on ${running.url}\n`);

  if (args.addInput) {
    running.bundle.emit({ type: 'open-add', input: args.addInput });
  }

  if (args.openBrowser) {
    await launchBrowserWindow(launchUrl, args.appWindow);
  }

  const shutdown = async (): Promise<void> => {
    await running.close().catch(() => undefined);
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/main.ts') || process.argv[1].endsWith('\\main.ts'));

if (isDirectExecution) {
  void runCli().catch((err) => {
    process.stderr.write(`[minipod] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
