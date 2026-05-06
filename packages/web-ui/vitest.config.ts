import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server tests default to node; component tests opt into jsdom via the
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
