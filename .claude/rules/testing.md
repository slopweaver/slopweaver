# Testing rules

Philosophy and discipline for writing tests in this repo. Layout is covered in @.claude/rules/workflow.md (the "Tests live next to source" section) — co-located `<name>.test.ts`, with `<name>.smoke.test.ts` and `<name>.cassette.test.ts` suffixes reserved for the day filtering matters.

## Test taxonomy (philosophy, not directories)

Three logical kinds of tests, distinguished by what they touch — not by where they live on disk:

- **Pure-function tests.** Zero I/O, zero network, deterministic. Most existing `*.test.ts` files in this repo. Mocks via dependency injection (`deps: { exec: vi.fn() }`-style) are fine — the bar is determinism, not "no mocks at all." See @.claude/agents/pure-function-test-reviewer.md.

- **Polly-replay tests.** Hit a real platform API once during recording, replay deterministically thereafter. Wired via the per-package `setupFiles` entry that calls `definePollySetup` from `@slopweaver/integrations-core/test-setup/polly`. Cassettes live at `src/__recordings__/<suite>/<test>/recording.har`. See @.claude/agents/polly-replay-test-reviewer.md.

- **Smoke / spawned-process tests.** Intentionally slow: launch a real binary, hit a real port, etc. Opt in via the `*.smoke.test.ts` suffix when filtering matters. No package uses this suffix today; introduce when needed.

The `*.cassette.test.ts` and `*.smoke.test.ts` suffixes are aspirational — every package's `vitest.config.ts` includes only `src/**/*.test.ts` today. Don't introduce the suffixes pre-emptively; if you do, the runner won't pick them up.

## Assertion preferences

These are *preferences with rationale*, not absolutist NEVERs. Some existing tests don't follow them; that's grandfathered. New tests should:

- **Prefer exact value assertions over existence checks.** `expect(x.id).toBe('abc')` over `expect(x).toHaveProperty('id')`. Existence checks pass for any input, so they don't tell you whether the function is right.
- **Prefer `.toBe(true)` over `.toBeTruthy()`** when the value is exactly `true`. `.toBeTruthy()` also passes for `1`, `'a'`, `{}`, etc.
- **Prefer asserting the actual value over `expect(typeof x).toBe('string')`.** The point of a test is to pin behavior, not type.
- `expect.any(String)` inside `toEqual()` is fine for dynamic fields (UUIDs, timestamps, generated IDs).

## Hard rules

These are non-negotiable — they're about test discipline, not style:

- **Never skip tests.** No `.skip`, `.only`, `.todo`, or "if not available, skip" branches. If a test can't run, fix the cause, not the assertion.
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

## Polly modes

Set via the `POLLY_MODE` environment variable:

- `replay` (default) — read cassettes; missing cassette fails the test.
- `record` — hit live API, write cassette. Requires the platform token in the monorepo-root `.env`.
- `passthrough` — skip Polly entirely; debug only.

There's no convenience script for re-recording cassettes today — set `POLLY_MODE=record` inline. When that ergonomics matters, file an issue rather than inventing one.
