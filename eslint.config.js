// @ts-check
import boundaries from 'eslint-plugin-boundaries';
import regexpPlugin from 'eslint-plugin-regexp';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for SlopWeaver.
 *
 * This file owns the ESLint-only slice of the three-linter stack
 * (Biome formatter + biome lint + Oxlint + this). Each rule below
 * is here because Biome/Oxlint cannot enforce it — primarily
 * type-aware rules (no-floating-promises, switch-exhaustiveness,
 * etc.) and AST-pattern rules (no-restricted-syntax for Zod /
 * type-assertion bans, sonarjs, regexp/no-super-linear-backtracking).
 *
 * For the division-of-labour across linters see
 * `.claude/rules/code-quality.md`. The short version:
 *   - Biome: formatter + React-stack-specific rules (useExhaustiveDependencies,
 *     useHookAtTopLevel, noLeakedRender, noAccumulatingSpread, etc).
 *   - Oxlint: cheap correctness/perf/suspicious checks + noExplicitAny.
 *   - ESLint (this file): type-aware rules, AST-pattern bans, plugins.
 *   - tsc: noUnusedLocals / noUnusedParameters / allowUnreachableCode.
 *
 * Structural rules enforced here (the original-three):
 *
 * 1. `eslint-plugin-boundaries` — apps/* may import packages/*; packages/*
 *    may import packages/*; packages/* may NOT import from apps/*.
 *
 * 2. `no-restricted-imports` — no `@nestjs/*` imports inside packages/*.
 *
 * 3. `no-restricted-imports` (named) — `ok`, `err`, `okAsync`, `errAsync`,
 *    `Result`, `ResultAsync`, `fromThrowable` may not be imported directly
 *    from `neverthrow`. Use `@slopweaver/errors`.
 *
 * Note on must-use-result enforcement: the upstream `eslint-plugin-neverthrow`
 * (v1.1.4) is incompatible with ESLint 10. The CLI service-boundary check
 * at `packages/cli-tools/src/check-neverthrow-service-boundaries/` covers
 * the highest-risk enforcement. Tracked in #41.
 */
export default [
  {
    ignores: [
      '**/__recordings__/**',
      '**/.turbo/**',
      '**/build/**',
      '**/coverage/**',
      '**/dist/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/out/**',
      // Build / runtime config files live outside any tsconfig include
      '**/vite.config.ts',
      '**/vitest.config.ts',
      '**/drizzle.config.ts',
    ],
  },

  // Boundaries + restricted-imports (structural, not type-aware)
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*' },
        { type: 'package', pattern: 'packages/*' },
        { type: 'package', pattern: 'packages/integrations/*' },
      ],
    },
    rules: {
      'boundaries/no-unknown': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: { type: 'app' }, allow: [{ to: { type: 'package' } }] },
            { from: { type: 'package' }, allow: [{ to: { type: 'package' } }] },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'neverthrow',
              importNames: ['ok', 'err', 'okAsync', 'errAsync', 'Result', 'ResultAsync', 'fromThrowable'],
              message:
                'Import Result helpers from @slopweaver/errors instead. The barrel re-exports neverthrow and is the canonical source.',
            },
          ],
          patterns: [
            {
              group: ['@nestjs/*'],
              message: 'NestJS imports are forbidden in packages/. Move framework-specific code to apps/cloud/.',
            },
          ],
        },
      ],
    },
  },

  // Type-aware linting via typescript-eslint (recommendedTypeChecked baseline)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CRITICAL: Promise safety — pairs with neverthrow ResultAsync
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksConditionals: true,
          checksVoidReturn: { arguments: true, attributes: false, returns: true, variables: true },
        },
      ],

      // HIGH: Type safety
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // TYPE-AWARE rules Oxlint can't do
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/related-getter-setter-pairs': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',
      '@typescript-eslint/no-unnecessary-type-conversion': 'warn',

      // Code quality
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
      '@typescript-eslint/promise-function-async': ['warn', { checkArrowFunctions: false }],
      // DISABLED: autofix is destructive when undefined vs false need different treatment
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',

      // Disabled from recommendedTypeChecked — handled by other linters or too noisy
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off', // Oxlint owns
      '@typescript-eslint/no-unused-vars': 'off', // tsc owns (noUnusedLocals/noUnusedParameters)
      '@typescript-eslint/require-await': 'off', // Oxlint owns
      '@typescript-eslint/no-require-imports': 'off', // Oxlint owns
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      // Type-safety bans: metadata casts, as any, Zod escape hatches
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
          message: 'Do not use `as any` in production code. Decode with a runtime schema instead.',
        },
        {
          selector: "TSTypeAssertion[typeAnnotation.type='TSAnyKeyword']",
          message: 'Do not use `<any>` in production code. Decode with a runtime schema instead.',
        },
        {
          selector: "TSAsExpression[expression.type='TSAsExpression']",
          message: 'Do not use double casts (`as unknown as`). Decode with a runtime schema instead.',
        },
        {
          selector: "CallExpression[callee.object.name='z'][callee.property.name='any']",
          message: 'Do not use z.any(). Define a concrete schema instead.',
        },
        {
          selector: "CallExpression[callee.object.property.name='coerce'][callee.property.name='boolean']",
          message:
            'Do not use z.coerce.boolean(). Boolean("false") === true. Use z.string().transform() instead.',
        },
      ],

      // Module size limit. 2000 is a deliberate bump from the archive's 1000:
      // packages/cli-tools/src/orchestration/runtime.ts is a single coordinated
      // state machine (~1700 lines) where splitting hurts readability more than
      // it helps. Re-evaluate if multiple files start approaching the cap.
      'max-lines': ['error', { max: 2000, skipBlankLines: false, skipComments: true }],
    },
  },

  // eslint-plugin-regexp — ReDoS + unicode safety (Biome/Oxlint have no equivalent)
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: { regexp: regexpPlugin },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-misleading-unicode-character': 'warn',
    },
  },

  // eslint-plugin-sonarjs — code duplication and complexity
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { sonarjs: sonarjsPlugin },
    rules: {
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
    },
  },

  // Test files + test helpers: relax type-aware rules + ban debt-comment markers
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/src/test/**/*.{ts,tsx}',
      '**/src/test-setup/**/*.{ts,tsx}',
      '**/src/__tests__/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },

  // Test-only ban on TODO/FIXME/SKIP comment markers — applies to actual test files
  // (not helpers), where rotted debt markers most often accumulate.
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      'no-warning-comments': [
        'error',
        {
          terms: ['TODO', 'FIXME', 'SKIP', 'SKIPPED'],
          location: 'start',
        },
      ],
    },
  },

  // CLI entry points: error-handling.md carves out `throw envResult.error` here
  // (the CLI boundary unwraps typed errors via .catch + asMessage()).
  {
    files: ['apps/*/src/cli.ts', 'packages/cli-tools/src/cli.ts'],
    rules: {
      '@typescript-eslint/only-throw-error': 'off',
    },
  },

  // packages/errors is the barrel that wraps neverthrow
  {
    files: ['packages/errors/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*'],
              message: 'NestJS imports are forbidden in packages/. Move framework-specific code to apps/cloud/.',
            },
          ],
        },
      ],
    },
  },

  // NestJS allowed in apps/cloud/ only (when that lands in v2)
  {
    files: ['apps/cloud/**/*'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
