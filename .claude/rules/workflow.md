# Workflow rules

How AI agents (and humans) work in this repo.

## Worktrees, not direct branches on the main checkout

Never edit files in the main checkout (`~/dev/slopweaver` on the `main` branch). All work happens in a git worktree:

```bash
pnpm cli worktree-new fix-issue-42
# → ~/dev/worktrees/fix-issue-42 on branch worktree/fix-issue-42, deps installed
```

Reasons: parallel work streams without branch-switching overhead; main checkout stays clean for reading; matches the GitHub PR-per-branch model.

## Branch naming

`worktree/<short-task-slug>`. The `worktree/` prefix is a convention so it's obvious what a branch is for; the slug should be ≤30 chars, lowercase, hyphenated.

For issue-driven work: include the issue number in the slug. `worktree/fix-issue-42` or `worktree/issue-42-add-x`.

## PR per worktree

One worktree = one branch = one PR. Don't pile multiple changes into a single worktree.

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
pnpm format:check
pnpm lint
pnpm compile
pnpm test
```

All four must pass. CI will reject on red.

If you change formatting, run `pnpm format` (no `:check`) to auto-fix, then re-run `format:check` to verify.

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

A lefthook pre-commit hook runs `gitleaks v8.30.1` against staged content. Contributors and AI agents must install gitleaks locally before committing — see [CONTRIBUTING.md](../../CONTRIBUTING.md) for install instructions. CI runs the same scan over the full tree as a sixth gate, so bypassing the hook with `git commit --no-verify` does not avoid the check; it must be disclosed in the PR description.

## Slash commands

Available slash commands for AI agents:

- `/fix-issue <issue-url>` — read an issue, spawn a worktree, implement, open a PR
- `/investigate <topic>` — research-only; no code changes; output as issue comment or doc
- `/review-pr <pr-url>` — second-opinion review on an open PR
- `/codex` — maintainer's hybrid loop: codex plans, Claude implements, codex reviews. Drives `pnpm cli orchestration prepare/run`. Optional for contributors.

See `.claude/commands/` for the prompts.
