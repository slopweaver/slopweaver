# AI workflow

How work happens in this repo. This is the practical companion to `CONTRIBUTING.md` and `.claude/rules/workflow.md`.

> **Why this exists**: SlopWeaver is built by one person with heavy AI assistance. The orchestration scaffolding is in the repo, in public, so anyone — contributors, curious onlookers, future-me, the founder of a similar project — can see the workflow and adopt it.

---

## The loop

```
GitHub Issue          /fix-issue           PR opens         CI runs
(task or bug)   ──>   (slash command)  ──> on main repo ──> on the PR  ──>  founder reviews / merges
                       spawns worktree      from a worktree   green = ready
```

Every change goes Issue → worktree → PR → main. No direct pushes to `main` (branch protection enforces).

---

## Slash commands

These live in [`.claude/commands/`](../../.claude/commands/) and are invoked from Claude Code.

### `/fix-issue <issue-url>`

Read an issue, spawn a worktree, implement the work, open a PR. The default for any AI-actionable task.

```
/fix-issue https://github.com/slopweaver/slopweaver/issues/42
```

What the agent does:

1. Fetches the issue body and any existing comments
2. Creates a worktree via `pnpm cli worktree-new fix-issue-42`
3. Implements changes against the acceptance criteria in the issue
4. Runs the four CI checks locally (`format:check`, `lint`, `compile`, `test`)
5. Opens a PR with `closes #42` in the body
6. Comments on the issue with the PR link

The founder reviews the PR and merges (or asks for changes).

### `/investigate <topic>`

Research-only. No code changes. Output is either a comment on a `decision-record` issue or a doc PR.

```
/investigate should we use Drizzle or Kysely for the db layer?
```

Use this BEFORE `/fix-issue` when the work involves a non-obvious tradeoff. Investigation produces a recommendation; founder decides; THEN `/fix-issue` runs against the agreed approach.

### `/review-pr <pr-url>`

Second-opinion review on an open PR. Posts a structured review comment (good / concerns / nits / follow-up suggestions). Optionally invokes Codex CLI for an additional perspective.

```
/review-pr https://github.com/slopweaver/slopweaver/pull/42
```

The slash command does NOT approve or merge — only the founder does that. The review comment is informational input.

### `/codex`

The maintainer's hybrid loop: codex plans, Claude implements, codex reviews. Drives a chain end to end via `pnpm cli orchestration prepare/run` (see [chain file format](../orchestration/chain-format.md)). Contributors don't need this — `/fix-issue`, `/investigate`, and `/review-pr` work fine without codex installed.

Full prompt and CLI quick reference in [`.claude/commands/codex.md`](../../.claude/commands/codex.md).

---

## Issues

Three issue templates in [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/):

- **`task.yml`** — AI-actionable unit of work. Includes a copy-paste `/fix-issue` prompt.
- **`bug_report.yml`** — something is broken
- **`feature_request.yml`** — new capability proposal
- **`integration_request.yml`** — request a new platform integration
- **`decision_record.yml`** — significant design decision needing public deliberation

The `decision_record` template is the one that's unusual. See below.

---

## Decisions in public (the `decision-record` pattern)

Significant design decisions live as **GitHub Issues** with the `decision-record` label. Discussion happens in issue comments. The closing comment captures the resolution.

This is the public alternative to a private `DECISIONS.md` doc. Benefits:

- Deliberation is visible to onlookers (this is a **flex** — shows how the project actually thinks)
- Future contributors can search closed issues to find "why was X decided this way?"
- Comments form a chronological record (vs a doc that gets edited over time)
- Encourages clearer thinking — public deliberation is harder to handwave

Examples of what counts:

- Auth model (PAT vs OAuth 2.1 — see #N)
- Database choice (Drizzle vs Kysely vs direct SQL)
- License choice (MIT vs AGPL vs source-available `ee/`)
- Naming conventions (e.g. is the flagship tool `start_session` or `get_priorities`?)
- Whether to ship a feature in v1 vs v1.1
- Architecture tradeoffs that compound (e.g. ports/adapters vs direct imports)

Examples of what does NOT count:

- Trivial code-level decisions (variable names, single-line refactors)
- Reversible choices (e.g. switching a CI step from `pnpm` to `bun` — easy to undo)
- Cloud-tier strategy decisions that legitimately need to stay private (those live in `slopweaver-private`)

To open a decision-record:

1. New Issue → "Decision record" template
2. Title: `Decision: <topic>`
3. Fill in problem, options, recommendation, resources
4. Discussion in comments (founder + any external input)
5. Close with the resolution as a comment

---

## Worktrees

The CLI provides:

```bash
pnpm cli worktree-new <name>          # create ~/dev/worktrees/<name>, install deps
pnpm cli worktree-new <name> --no-install  # skip pnpm install
```

The convention: one worktree = one branch = one PR. Branch is named `worktree/<name>`. Main checkout (`~/dev/slopweaver` on `main`) stays clean and read-only.

When a PR merges, you can clean up the worktree:

```bash
git worktree remove ~/dev/worktrees/<name>
git branch -D worktree/<name>
```

(Or just leave it — disk space is cheap and you can revisit.)

---

## Verification before claiming done

The four CI checks, runnable locally:

```bash
pnpm format:check    # Biome formatter check
pnpm lint            # Biome linter
pnpm compile         # TypeScript typecheck via Turbo
pnpm test            # Vitest via Turbo (when packages have tests)
```

If `format:check` fails, run `pnpm format` (no `:check`) to auto-fix.

CI runs the same four checks on every PR. Don't open for review until they're all green locally.

---

## Codex (optional)

`/review-pr` can optionally invoke [Codex CLI](https://github.com/openai/codex) for a second-opinion review. This is opt-in — if `codex` isn't on PATH, the slash command skips it and just posts the Claude-only review.

The founder's prior workflow used Codex as a planner with Claude as executor. The current Claude (Opus 4.7 high thinking) is strong enough to do both planning and execution for most tasks; Codex is a useful second perspective for complex PRs.

### Codex install (optional)

Needed only if you want to drive the maintainer's hybrid loop locally (`/codex` and `pnpm cli orchestration run`). The `prepare` subcommand and the `--dry-run` flag work without these.

```bash
brew install tmux
curl -fsSL https://bun.sh/install | bash
npm install -g @openai/codex
codex --login

git clone https://github.com/kingbootoshi/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator && bun install

# Add to ~/.zshrc:
export PATH="$HOME/.codex-orchestrator/bin:$HOME/.bun/bin:$PATH"

codex-agent health   # should report tmux, codex CLI, and Status: Ready
```

`codex-orchestrator` is a third-party tool that wraps `codex` in tmux sessions for non-interactive use. The `pnpm cli orchestration run` runner shells out to `codex-agent`, so it must be on `PATH` before the runner can spawn agents.

---

## What's intentionally NOT here

- A `Makefile` — `pnpm` scripts handle everything
- A `Justfile` — same reason
- Pre-commit hooks via Lefthook — adds contributor setup friction; CI catches the same things
- A custom commit-message linter — the `pnpm cli` and conventional-commit prefix discipline is enforced socially via PR review, not tooling

These are deliberate choices to keep the contributor onramp short. We can revisit if the team grows.
