import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const candidatePublicDir = fileURLToPath(new URL('../../ui/public', import.meta.url));

/** Builds the Capacitor `webDir` (`packages/host-android/www`). */
export default defineConfig({
  root: here,
  ...(existsSync(candidatePublicDir) ? { publicDir: candidatePublicDir } : {}),
  plugins: [react()],
  build: {
    outDir: '../www',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: { port: 5176 },
});
