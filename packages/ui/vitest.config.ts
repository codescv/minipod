import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'ui',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    // material-color-utilities 0.4 ships ESM with extensionless relative
    // imports that Node's loader rejects; let Vite transform it instead.
    server: { deps: { inline: [/@material\/material-color-utilities/] } },
  },
});
