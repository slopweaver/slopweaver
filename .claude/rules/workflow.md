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
pnpm validate   # cli check-service-boundaries, format:check, lint, compile, test, knip
```

All six gates must pass. The first gate — `pnpm cli check-service-boundaries` — scans configured service-boundary files for `throw` statements (see `.claude/rules/error-handling.md`); it's the cheapest gate and runs first so regressions surface before the slower passes. CI also runs `gitleaks detect` as a seventh gate; the pre-commit hook covers staged content locally. CI will reject on red.

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
- HAR files, Polly cassettes, or any HTTP recording with real auth headers
- Personal email addresses (other than `admin@slopweaver.ai` which is the project address)

The `.gitignore` excludes common offenders (`.env*`, `*.har`) but verify any test fixture you add doesn't include real data.

## Secret scanning is enforced

A lefthook pre-commit hook runs `gitleaks v8.30.1` against staged content. Contributors and AI agents must install gitleaks locally before committing — see [CONTRIBUTING.md](../../CONTRIBUTING.md) for install instructions. CI runs the same scan over the full tree as a seventh gate, so bypassing the hook with `git commit --no-verify` does not avoid the check; it must be disclosed in the PR description.

## Slash commands

Available slash commands for AI agents:

- `/fix-issue <issue-url>` — read an issue, spawn a worktree, implement, open a PR
- `/investigate <topic>` — research-only; no code changes; output as issue comment or doc
- `/review-pr <pr-url>` — second-opinion review on an open PR
- `/codex` — maintainer's hybrid loop: codex plans, Claude implements, codex reviews. Drives `pnpm cli orchestration prepare/run`. Optional for contributors.

See `.claude/commands/` for the prompts.
