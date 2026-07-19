import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // The coverage-floor ratchet reads the V8 json-summary; `text` keeps the terminal readable.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.entry.ts",
        "src/**/index.ts",
        "eval/**",
        "hooks/**",
        "stubs/**",
        "coverage/**",
        "dist/**",
        "**/*.config.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
    },
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
