import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Smoke test spawns a child process and runs migrations on a fresh
    // SQLite file; default 5s is tight on cold caches.
    testTimeout: 30_000,
  },
});
