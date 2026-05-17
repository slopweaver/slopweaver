# Testing rules

Philosophy and discipline for writing tests in this repo. Layout is covered in @.claude/rules/workflow.md (the "Tests live next to source" section) — co-located `<name>.test.ts`, with `<name>.smoke.test.ts` and `<name>.cassette.test.ts` suffixes reserved for the day filtering matters.

## Test taxonomy (philosophy, not directories)

Three logical kinds of tests, distinguished by what they touch — not by where they live on disk:

- **Pure-function tests.** Zero I/O, zero network, deterministic. Most existing `*.test.ts` files in this repo. Mocks via dependency injection (`deps: { exec: vi.fn() }`-style) are fine — the bar is determinism, not "no mocks at all." See @.claude/agents/pure-function-test-reviewer.md.

- **Polly-replay tests.** Hit a real platform API once during recording, replay deterministically thereafter. Wired via the per-package `setupFiles` entry that calls `definePollySetup` from `@slopweaver/integrations-core/test-setup/polly`. Cassettes live at `src/__recordings__/<suite>/<test>/recording.har`. See @.claude/agents/polly-replay-test-reviewer.md.

- **Smoke / spawned-process tests.** Intentionally slow: launch a real binary, hit a real port, etc. Tag with the `*.smoke.test.ts` suffix so the file is searchable; `apps/mcp-local/src/cli.smoke.test.ts` is the canonical example today. The default `include: ['src/**/*.test.ts']` runs them alongside everything else — the suffix is for organization, not filtering (see the paragraph below).

The default `vitest.config.ts` `include: ['src/**/*.test.ts']` already matches both `*.smoke.test.ts` and `*.cassette.test.ts` because they end in `.test.ts` — `apps/mcp-local/src/cli.smoke.test.ts` is the live example, and its package bumps `testTimeout` to 30s for the spawn cost. The suffix is purely a visibility tag today. To run smoke-only or exclude smoke (e.g. a "fast tests" subset in CI), pass a Vitest filter or update the package's `include`/`exclude` at the point you actually need the split. Don't introduce a new suffix without a concrete reason — extra metadata that nothing filters on is just noise.

## Assertion preferences

These are *preferences with rationale*, not absolutist NEVERs. Some existing tests don't follow them; that's grandfathered. New tests should:

- **Prefer exact value assertions over existence checks.** `expect(x.id).toBe('abc')` over `expect(x).toHaveProperty('id')`. Existence checks pass for any input, so they don't tell you whether the function is right.
- **Prefer `.toBe(true)` over `.toBeTruthy()`** when the value is exactly `true`. `.toBeTruthy()` also passes for `1`, `'a'`, `{}`, etc.
- **Prefer asserting the actual value over `expect(typeof x).toBe('string')`.** The point of a test is to pin behavior, not type.
- `expect.any(String)` inside `toEqual()` is fine for dynamic fields (UUIDs, timestamps, generated IDs).

## Hard rules

These are non-negotiable — they're about test discipline, not style:

- **Don't `.skip` a real test.** No `.skip`, `.only`, `.todo`, or "if not available, skip" branches on a test that should be running. Enforced by Oxlint (`vitest/no-focused-tests` and `vitest/no-disabled-tests`, both `error`). The one acceptable use of `it.skip(...)` is a searchability-placeholder whose body is just a comment pointing readers at where the real test lives — see `packages/integrations/slack/src/mentions.test.ts` ("cassette: real workspace happy path") for the pattern. That single carve-out is documented inline with `// oxlint-disable-next-line vitest/no-disabled-tests -- searchability placeholder`. If you find yourself wanting to skip anything else, fix the cause.
- **No `TODO/FIXME/SKIP:` comment markers in test files.** Enforced by ESLint `no-warning-comments` scoped to `**/*.test.ts`. If a test has debt, fix it, delete it, or open an issue and link it — don't leave it as a comment that everyone learns to ignore.
- **Never weaken an assertion to make a test pass.** If a refactor breaks an assertion, the assertion is the spec — figure out which side is wrong.
- **Never use synthetic stubs in Polly-replay tests.** Cassettes capture real API behavior; faking responses defeats the point.
- **Never push tests without running them locally first.** CI is a sanity check, not a remote test runner.
- **Never manually edit cassettes.** If a cassette is wrong, re-record (`POLLY_MODE=record pnpm test --filter <pkg>`).

## Cassette safety

`.har` cassettes capture real HTTP — including request bodies and response payloads. The shared setup in `packages/integrations/core/src/test-setup/polly.ts` is the single redaction chokepoint:

- Default redactors strip standard auth headers (`authorization`, `cookie`, `set-cookie`, etc.) and grep for token shapes (`gh*_…`, `xox*-…`) in request/response bodies.
- Per-package `extraRedactors` plug in via `definePollySetup({ extraRedactors })` to scrub platform-specific PII (display names, channel names, message bodies).
- If a cassette ends up with an unredacted secret, **fix the redactor**. Don't just delete the cassette — the next recording will leak again.

Before committing a new or refreshed cassette, skim the diff for tokens, cookies, and PII. The pre-commit `gitleaks` hook (see @.claude/rules/workflow.md, "Secret scanning is enforced") is a backstop, not a primary defense.

The `.gitignore` blocks `*.har` by default, with explicit allow-list entries for `packages/integrations/{github,slack}/**/__recordings__/**/*.har`. Putting cassettes anywhere else won't commit.

## Cassette quality is automated

`pnpm cli check-cassette-quality` (chained into `pnpm validate`) scans every committed `.har` cassette for auth/recording-failure signals: HTTP `401`/`403`, response bodies containing `invalid_grant` / `token expired` / `invalid_auth` / `unauthorized` etc, and the `[polly] [adapter:node-http] recording for the following request is not found` sentinel. The single most common cassette regression — re-recording with `POLLY_MODE=record` against an expired OAuth token, ending up with a fixture that "passes" entirely on 401s — is exactly this rule.

An **allowlist of error-path keywords** in the cassette's relative path exempts deliberate failure-mode cassettes: `auth`, `refresh`, `error`, `expired`, `invalid`, `oauth`, `unauthor`, `not-found`, `rate-limit`, `forbidden`, etc. Put your auth-failure cassette under a path containing one of those and the scanner stays out of the way.

If you hit the scanner on a happy-path cassette, refresh the token, re-record, and verify the diff has no auth-failure signals before committing.

## Polly modes

Set via the `POLLY_MODE` environment variable:

- `replay` (default) — read cassettes; missing cassette fails the test.
- `record` — hit live API, write cassette. Requires the platform token in the monorepo-root `.env`.
- `passthrough` — skip Polly entirely; debug only.

There's no convenience script for re-recording cassettes today — set `POLLY_MODE=record` inline. When that ergonomics matters, file an issue rather than inventing one.
