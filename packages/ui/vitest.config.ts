import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server tests default to node; component tests opt into jsdom via the
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Auto-restore `vi.stubGlobal(...)` between tests so a stubbed
    // `globalThis.fetch` (or any other global) in one component test
    // can't leak into the next. `vi.restoreAllMocks()` alone does NOT
    // clear stubGlobal — only `vi.unstubAllGlobals()` does — so we let
    // Vitest run that cleanup for us automatically.
    unstubGlobals: true,
  },
});
