import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const localPublicDir = fileURLToPath(new URL('./public', import.meta.url));
const candidatePublicDir = fileURLToPath(new URL('../../ui/public', import.meta.url));
const publicDir = existsSync(localPublicDir)
  ? localPublicDir
  : existsSync(candidatePublicDir)
    ? candidatePublicDir
    : undefined;

/** Builds the Capacitor `webDir` (`packages/host-android/www`). */
export default defineConfig({
  root: here,
  ...(publicDir ? { publicDir } : {}),
  plugins: [react()],
  build: {
    outDir: '../www',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: { port: 5176 },
});
