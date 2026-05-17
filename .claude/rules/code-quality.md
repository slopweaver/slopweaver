# Code-quality enforcement

How the public repo's enforcement stack is divided across **Biome**,
**Oxlint**, **ESLint**, **tsc**, and a small number of **custom CLI
scanners**. Every rule has exactly one owner — no overlap — so a fix
or update has one place to land.

Adopted from the archive (`slopweaver-archive`) and adapted to the
public repo's scope.

## Why three linters

- **Biome** is the formatter and the source of recommended-rules safety
  net for the stack (React hook deps, accumulating spread, JSX
  semicolons, etc.). Fastest, runs first.
- **Oxlint** is the second pass: cheap correctness/perf/suspicious
  checks across a large rule catalog with low overhead.
- **ESLint** (with `typescript-eslint`) does what Biome and Oxlint
  can't: **type-aware rules** that need TS program info, plus
  **AST-pattern rules** (`no-restricted-syntax`) for ad-hoc bans.

Each tool's config is wired so that anything another tool owns is
explicitly turned off — see inline rationale comments in `biome.json`,
`.oxlintrc.jsonc`, and `eslint.config.js`. Every per-file override (test
relaxations, CLI entry-point throw carve-outs, ReDoS false-positives, the
slack searchability-placeholder `.skip`, etc.) carries a `--` rationale
either at the override site or in the relevant rule doc.

## Division of labour

| Concern | Owner |
|---|---|
| Formatting (indent, quotes, semis, line width) | Biome formatter |
| `noExplicitAny` | Oxlint (`typescript/no-explicit-any`) |
| Dead/unreachable code | tsc (`allowUnreachableCode: false`) |
| Unused imports | Biome (`correctness/noUnusedImports`) |
| Unused locals / params | tsc (`noUnusedLocals` / `noUnusedParameters`) |
| `noFloatingPromises` (with TS types) | ESLint `@typescript-eslint/no-floating-promises` |
| `switch-exhaustiveness-check` | ESLint |
| `only-throw-error` | ESLint |
| `await-thenable` | ESLint |
| `prefer-optional-chain` | ESLint |
| `require-array-sort-compare` (string-array exempt) | ESLint |
| `as any` / `<any>` / `as unknown as` bans | ESLint `no-restricted-syntax` |
| `z.any()` / `z.coerce.boolean()` bans | ESLint `no-restricted-syntax` |
| `max-lines` (2000) | ESLint |
| ReDoS / unicode regex | ESLint (`eslint-plugin-regexp`) |
| Code duplication / collapsible-if | ESLint (`eslint-plugin-sonarjs`) |
| `useExhaustiveDependencies` (React hooks) | Biome |
| `useHookAtTopLevel` | Biome |
| `noLeakedRender` | Biome |
| `noAccumulatingSpread` | Biome |
| `noDebugger`, `noEvolvingTypes`, `noImplicitAnyLet`, `noSuspiciousSemicolonInJsx` | Biome |
| `array-callback-return` | Oxlint |
| `no-fallthrough`, `no-self-compare`, `no-constructor-return` | Oxlint |
| `react/button-has-type` | Oxlint |
| `vitest/no-focused-tests` (`.only`) | Oxlint (`error`) |
| `vitest/no-disabled-tests` (`.skip`) | Oxlint (`error`) |
| Test-debt comments (`TODO/FIXME/SKIP:` in `**/*.test.ts`) | ESLint `no-warning-comments` |
| `.mapErr` must preserve `code` field | **Custom**: `pnpm cli check-error-code-preservation` |
| Service files must not `throw` | **Custom**: `pnpm cli check-service-boundaries` |
| HAR cassette auth-failure scan | **Custom**: `pnpm cli check-cassette-quality` |

## Custom CLI scanners (the minimum)

Three custom scanners live in `packages/cli-tools/src/check-*/`. All
follow the same shape: pure `core.ts` + Vitest `core.test.ts` + thin
`index.ts` adapter. Run on demand via `pnpm cli <command>` or as part
of `pnpm validate`.

- **`check-service-boundaries`** — `throw` is banned inside the
  configured service-boundary files. See @.claude/rules/error-handling.md.
- **`check-error-code-preservation`** — `.mapErr((e) => ({ message: e.message }))`
  drops the `code` discriminant. The scanner catches that pattern.
- **`check-cassette-quality`** — committed Polly HAR cassettes get
  scanned for auth-failure signals (`401`, `403`, `invalid_grant`,
  `token expired`, etc.) outside an allowlist of error-path keywords
  (`auth/`, `refresh/`, `error/`). See @.claude/rules/testing.md.

A linter would be preferred over a custom scanner, but the AST
selector for `.mapErr` code-preservation is too gnarly for ESLint,
and no linter scans HAR JSON files semantically.

## tsconfig safety flags

`tsconfig.base.json` enables several "move bugs from runtime to
compile-time" flags on top of `strict: true`:

- `noUnusedLocals` / `noUnusedParameters` — dead identifiers are
  compile errors. Use `_paramName` prefix for intentionally unused.
- `noImplicitReturns` — catch `if (x) return 1;` with no else.
- `allowUnreachableCode: false`, `allowUnusedLabels: false` — closes
  the default "no error" behaviour for dead branches.
- `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` —
  pre-existing public-repo strict flags.

## When you hit a rule you can't live with

1. **Confirm the right owner.** Look at the table above. If the rule
   is misclassified (e.g. you're trying to disable a Biome rule that
   Oxlint actually owns), fix the config not the call site.
2. **Per-line carve-out.** `// eslint-disable-next-line <rule> -- <reason>`,
   `// oxlint-disable-next-line <rule> -- <reason>`, or
   `// biome-ignore lint/<category>/<rule>: <reason>`. The rationale
   is mandatory — review will reject naked disables.
3. **Per-file override.** Add a `files: [...]` block to the relevant
   config and turn the rule off with a comment explaining why. This
   is the pattern for `apps/*/src/cli.ts` (CLI entry-point throws)
   and `**/*.test.ts` (relaxed type-aware rules).
4. **Disable a rule globally.** Only when the rule is fundamentally
   wrong for this codebase. Document why in the config comment.

## Verifying locally

`pnpm validate` runs every gate in the same order as CI. If validate
is green, CI will be too (modulo gitleaks, which the pre-commit hook
mirrors). Time-budget: ~30s on a clean cache.

Individual gates:

```
pnpm cli check-service-boundaries
pnpm cli check-error-code-preservation
pnpm cli check-cassette-quality
pnpm format:check
pnpm lint            # biome lint . && oxlint -c .oxlintrc.jsonc && eslint .
pnpm lint:biome      # biome only
pnpm lint:oxlint     # oxlint only
pnpm lint:eslint     # eslint only
pnpm compile
pnpm test
pnpm knip
```

See @.claude/rules/error-handling.md, @.claude/rules/testing.md, and
@.claude/rules/typescript-patterns.md for the rules these gates enforce.
