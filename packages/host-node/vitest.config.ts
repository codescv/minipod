import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'host-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
