import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@minipod/core': resolve(webDir, '../../core/src/index.ts'),
      '@minipod/ui': resolve(webDir, '../../ui/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:47821',
      '/media': 'http://127.0.0.1:47821',
    },
  },
  build: {
    outDir: resolve(webDir, '../dist/web'),
    emptyOutDir: true,
  },
});
