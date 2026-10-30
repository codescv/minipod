import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Each workspace package is a separate project so that
 * `pnpm test` runs everything while `pnpm --filter @kotori/core test` runs a
 * single package. Packages own their `vitest.config.ts` (environment, setup).
 */
export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.*', '**/index.ts', '**/types.ts'],
    },
  },
});
