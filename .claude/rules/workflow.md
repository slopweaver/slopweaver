# Workflow rules

How AI agents (and humans) work in this repo.

## Worktrees, not direct branches on the main checkout

Never edit files in the main checkout (`~/dev/slopweaver` on the `main` branch). All work happens in a git worktree:

```bash
pnpm cli worktree-new fix-issue-42
# → ~/dev/worktrees/fix-issue-42 on branch worktree/fix-issue-42, deps installed
```

Reasons: parallel work streams without branch-switching overhead; main checkout stays clean for reading; matches the GitHub PR-per-branch model.

After the PR merges (squash), clean up:

```bash
git worktree remove ~/dev/worktrees/<name>
git branch -d worktree/<name>
```

## Branch naming

`worktree/<short-task-slug>`. The `worktree/` prefix is a convention so it's obvious what a branch is for; the slug should be ≤30 chars, lowercase, hyphenated.

For issue-driven work: include the issue number in the slug. `worktree/fix-issue-42` or `worktree/issue-42-add-x`.

## PR per worktree

One worktree = one branch = one PR. Don't pile multiple changes into a single worktree.

Open as a **draft** initially (`gh pr create --draft`); convert to ready-for-review only after `pnpm validate` is locally green. Drafts skip CI on some setups but always skip code-review notification noise.

## Squash-merge only

The repo is configured for squash-only merges. The PR title becomes the squashed commit message on `main`. Write PR titles as good commit messages: imperative, concise, conventional-commit-style prefix (`feat`, `fix`, `docs`, `chore`, `ci`, `refactor`).

Examples:

- `feat(cli-tools): add worktree subcommand`
- `fix: handle empty integration response in start_session`
- `docs: clarify OAuth flow in CONTRIBUTING.md`

## Always merge, never rebase

When a worktree branch needs to catch up to `main`:

```bash
git fetch origin main
git merge origin/main
```

NEVER `git rebase origin/main` — it rewrites history that's already pushed and confuses other agents reading the branch.

## Verify before claiming complete

Before declaring work done (or before opening a PR for review), run the same checks CI runs:

```bash
pnpm validate   # format:check → lint (biome+oxlint+eslint) → compile → check-service-boundaries → check-error-code-preservation → check-cassette-quality → test → knip
```

All eight gates must pass. Formatting and the three linters (Biome + Oxlint + ESLint, run sequentially with explicit no-overlap ownership and **zero-warning mode** — `--error-on-warnings`, `--deny-warnings`, `--max-warnings 0`; see @.claude/rules/code-quality.md) run first because they're the cheapest. Then `tsc` (`compile`), which is also what produces the workspace `dist/` that the next three CLI scanners (`check-service-boundaries`, `check-error-code-preservation`, `check-cassette-quality`) need at runtime — they `import` from `@slopweaver/errors`, so they require its built `dist/` to resolve. Tests and dead-code detection (`knip`) run last. CI runs `pnpm validate` as a single step plus `gitleaks detect` as the ninth gate; the pre-commit hook covers staged content locally.

If you change formatting, run `pnpm format` (no `:check`) to auto-fix, then re-run `validate` to verify.

## Tests live next to source

Tests are co-located with source as `<name>.test.ts`. No `__tests__/` directories, no `unit/component/integration/e2e` subtrees — that ceremony is in `slopweaver-private` because it has hundreds of integration tests against real platform APIs; this repo doesn't (yet).

When a test class needs to be filtered separately (e.g. cassette-replay tests that hit the network on `POLLY_MODE=record`, or smoke tests that spawn a process), tag the file with a suffix:

- `<name>.smoke.test.ts` — exercises a real binary or process; slow.
- `<name>.cassette.test.ts` — replays Polly cassettes; offline-but-disk-bound.

Vitest's `include` pattern in each package's `vitest.config.ts` decides which run. Do not introduce these suffixes pre-emptively; add the tag the first time you actually need to filter.

Shared per-package test helpers go in `src/test/` (e.g. `packages/integrations/slack/src/test/db.ts`, `setup-polly.ts`). Cassette fixtures go under `src/__recordings__/`. Both are package-local — there is no cross-package test-helpers package.

For test taxonomy (pure / Polly-replay / smoke), assertion preferences, and cassette safety: see @.claude/rules/testing.md.

## Decisions live in GitHub Issues

Significant design decisions (architecture, tradeoffs, naming, scope cuts) get filed as GitHub Issues with the `decision-record` label. The discussion happens in issue comments. The closing comment captures the resolution.

This means deliberation is visible to contributors and onlookers — no hidden private decision docs (unless they're cloud-tier-specific, which lives in the private repo).

When opening a `decision-record` issue, use the template: `.github/ISSUE_TEMPLATE/decision_record.yml`.

## Don't commit user data

This repo is public. Never commit:

- API keys, OAuth secrets, MCP tokens, bearer tokens
- Real customer / employer / coworker names
- HAR files / Polly cassettes that still contain real auth headers, real PII, or any token shape. **Scrubbed cassettes under `packages/integrations/{github,slack}/**/__recordings__/` are explicitly allowlisted** (see @.claude/rules/testing.md "Cassette safety" + the gitignore allow-list); the redactors in `packages/integrations/core/src/test-setup/polly.ts` are the chokepoint. If a cassette ends up with an unredacted secret, **fix the redactor and re-record** — don't just delete the cassette.
- Personal email addresses (other than `admin@slopweaver.ai` which is the project address)

The `.gitignore` excludes `.env`, `.env.local`, and `.env.*.local`, and blocks `*.har` everywhere except the integration `__recordings__/` allow-list. **Note**: other env-like files (`.env.test`, `.env.example`, etc.) are **not** ignored — keep secrets out of any committed `.env*` file. Verify any test fixture you add doesn't include real data; `pnpm cli check-cassette-quality` catches the most common regression (re-recording against an expired token), and gitleaks is the per-commit and CI backstop for everything else.

## Secret scanning is enforced

A lefthook pre-commit hook runs `gitleaks v8.30.1` against staged content. Contributors and AI agents must install gitleaks locally before committing — see [CONTRIBUTING.md](../../CONTRIBUTING.md) for install instructions. CI runs the same scan over the full tree as a separate post-validate step (the ninth gate overall), so bypassing the hook with `git commit --no-verify` does not avoid the check; it must be disclosed in the PR description.

## Slash commands

Available slash commands for AI agents:

- `/fix-issue <issue-url>` — read an issue, spawn a worktree, implement, open a PR
- `/investigate <topic>` — research-only; no code changes; output as issue comment or doc
- `/review-pr <pr-url>` — second-opinion review on an open PR
- `/codex` — maintainer's hybrid loop: codex plans, Claude implements, codex reviews. Drives `pnpm cli orchestration prepare/run`. Optional for contributors.

See `.claude/commands/` for the prompts.
