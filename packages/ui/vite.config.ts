import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

/** Standalone dev harness: `pnpm dev:ui` runs the app against MockPlatformHost + MockPlayerEngine. */
export default defineConfig({
  root: 'dev',
  publicDir,
  plugins: [react()],
  server: { port: 5174 },
  build: { outDir: '../dist-dev', emptyOutDir: true },
});
