import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'host-android',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Installs IDBRequest/IDBKeyRange/… globals that `idb`'s `wrap` relies on;
    // each test still injects its own `new IDBFactory()` for isolation.
    setupFiles: ['fake-indexeddb/auto'],
  },
});
