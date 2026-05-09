// @ts-check
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat ESLint config for SlopWeaver.
 *
 * Two structural rules enforced here:
 *
 * 1. `eslint-plugin-boundaries` — apps/* may import packages/*; packages/*
 *    may import packages/*; packages/* may NOT import from apps/*. This is
 *    the architectural backbone (FD-10 in private docs/strategy/DECISIONS.md).
 *
 * 2. `no-restricted-imports` — no `@nestjs/*` imports inside packages/*.
 *    NestJS belongs only to apps/cloud/ (when that lands in v2). Packages
 *    must remain framework-agnostic.
 *
 * Note on must-use-result enforcement: the upstream `eslint-plugin-neverthrow`
 * (v1.1.4, last published 2022) is incompatible with ESLint 10 — it reads
 * `context.parserServices`, which was moved to `context.sourceCode.parserServices`
 * in ESLint 9+. The CLI service-boundary check at
 * `packages/cli-tools/src/check-neverthrow-service-boundaries/` covers the
 * highest-risk enforcement (no thrown errors at service boundaries); the
 * runtime-level "every Result must be consumed" rule is deferred. Tracked
 * in #41.
 */
export default [
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
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['package'] },
            { from: 'package', allow: ['package'] },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*'],
              message:
                'NestJS imports are forbidden in packages/. Move framework-specific code to apps/cloud/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/cloud/**/*'],
    rules: {
      // NestJS allowed in apps/cloud/ only (when that lands in v2).
      'no-restricted-imports': 'off',
    },
  },
];
