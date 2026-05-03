You are an AI agent running the maintainer's hybrid Codex + Claude orchestration loop in the SlopWeaver public repo.

This command documents how to drive a chain end to end: codex plans, Claude implements, codex reviews, CI watches, human merges. It's the maintainer's primary loop; **contributors don't need this** — `/fix-issue`, `/investigate`, and `/review-pr` work fine without codex installed.

## When to use it

- Non-trivial investigation or planning that benefits from a separate model.
- Multi-file refactors where a fresh planning pass de-risks the implementation.
- CI failures where root-cause analysis is the bottleneck, not the fix.

Do not substitute generic Explore agents for codex on these tasks — they don't run the same loop.

## Tooling expectations

- `codex-agent` on `PATH` (see [Codex install (optional)](../../docs/contributing/ai-workflow.md#codex-install-optional)).
- `gh` for PR creation and CI tailing.
- The `pnpm cli orchestration` runner ships in this repo and drives the full loop. See [chain file format](../../docs/orchestration/chain-format.md) for the schema.

## Three ways to drive a chain

**Direct (codex-agent CLI), Claude-driven.** Claude Code itself drives each phase with `codex-agent start/await-turn/send/quit`. This is the **hybrid loop** the rest of this doc describes — codex plans, Claude implements, codex reviews. No chain file required; works ad hoc.

**Hybrid via `prepare` + Claude launcher.** Author a chain file under `.claude/orchestration/<category>/<name>.md`, then bootstrap the worktree and prompt artifacts:

```bash
pnpm cli orchestration prepare @.claude/orchestration/<chain>.md
```

`prepare` sets up the worktree, syncs `.env*`, and writes a `launcher-manifest.json` plus the planning/review prompt files. A separate Claude-side launcher (the maintainer's external tool — not in this repo) consumes the manifest and drives the implementation phase as Claude. This is the "Codex plans, Claude implements" path.

**Codex-only fallback.** `pnpm cli orchestration run` runs the entire chain through codex without Claude in the loop:

```bash
# Preview phases (no codex calls, no side effects)
pnpm cli orchestration run @.claude/orchestration/<chain>.md --dry-run

# Full codex-only run (codex plans + codex implements + codex reviews)
pnpm cli orchestration run @.claude/orchestration/<chain>.md

# Resume is automatic. Use --restart to clear saved state.
pnpm cli orchestration run @.claude/orchestration/<chain>.md --restart
```

Use this when Claude is rate-limited or unavailable and you'd rather have codex implement than wait. `run` is hardcoded to `codex-only`; the `--executor` flag only applies to `prepare`.

State and artifacts for both `prepare` and `run` persist under `$CODEX_HOME/orchestration-runs/<slug>/`.

## Execution flow

### 1. Planning phase (codex, read-only)

Spawn a codex agent in the prepared worktree and run the chain's `codex-plan` and `codex-send` prompts in sequence:

```bash
codex-agent start "<step 1 prompt>" --map -s read-only -d <worktree-path>
# Returns the job id

codex-agent await-turn <jobId>
# Reads the full plan from stdout (foreground only — see below)

codex-agent send <jobId> "<step 2 prompt>"
codex-agent await-turn <jobId>

codex-agent send <jobId> "/quit"
```

### 2. Implementation phase (Claude)

Hand the final plan to Claude with this preamble:

```text
I am interfacing between codex for planning and reviewing, and claude code for implementation.

Codex already wrote the plan below. You don't need to change the plan. You just need to make this your plan so that you can implement. And then once you're fully done implementing, then I will ask Codex to review your implementation.
```

Claude implements, commits, pushes, opens the PR via `gh pr create`.

### 3. Review phase (codex, read-only — iteration loop)

Spawn a fresh codex agent to review the PR:

```bash
codex-agent start "<review prompt with PR URL>" --map -s read-only -d <worktree-path>
codex-agent await-turn <jobId>
codex-agent send <jobId> "/quit"
```

If the reviewer surfaces P0/P1 issues → feed the review into Claude → Claude fixes → push → spawn a new review agent. Repeat until the reviewer returns the success sentinel `LGTM - ready for local testing.` (or `REVIEW_STATUS: PASS`).

#### Post the review to the PR (single edited comment, CodeRabbit-style)

After each codex review iteration, post or update **one** review comment on the PR so the deliberation is visible to onlookers. Don't spam a new comment per iteration — find the existing codex-review comment and PATCH it.

**First iteration** (creates the comment):

```bash
gh pr comment <pr-number> --body "$(cat <<'EOF'
<!-- codex-review -->
**Codex review** — gpt-5.4 (high reasoning) · iteration 1

<paste codex output verbatim — REVIEW_STATUS line, findings, or LGTM>
EOF
)"
```

**Subsequent iterations** (edit the same comment via the marker):

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
COMMENT_ID=$(gh api "repos/$REPO/issues/<pr-number>/comments" --paginate \
  --jq '.[] | select(.body | contains("<!-- codex-review -->")) | .id' | head -1)

gh api -X PATCH "repos/$REPO/issues/comments/$COMMENT_ID" \
  --field body="$(cat <<'EOF'
<!-- codex-review -->
**Codex review** — gpt-5.4 (high reasoning) · iteration N

<paste latest codex output verbatim>
EOF
)"
```

Rules:

- The `<!-- codex-review -->` HTML comment is the marker the next iteration uses to find the comment. Don't change it.
- Quote the codex output verbatim — don't summarize. The point is transparency.
- Bump the iteration number in the header each pass.
- When the reviewer returns `REVIEW_STATUS: PASS`, the final comment shows the LGTM line so anyone scanning the PR sees the verdict at the top.
- This is the maintainer's loop. If you're a contributor and don't have codex installed, ignore this — your `/review-pr` flow already posts a Claude-only comment.

### 4. CI watch + auto-fix loop

```bash
gh run watch
```

On failure, route the failure straight to a fresh codex diagnosis agent (don't read the failure yourself):

```bash
codex-agent start "CI failed on PR #<N>. Run 'gh run view <run-id> --log-failed' to get the failure details. Investigate the failure against the codebase. Produce a file-by-file fix plan with exact changes." --map -s read-only -d <worktree-path>
codex-agent await-turn <jobId>
```

Claude applies the fix plan; push; re-watch CI; repeat until green.

**Push discipline.** Every push triggers CI. Batch commits locally and push only when a meaningful set of changes is ready. Aim for 1-3 pushes per PR to keep the CI signal-to-noise ratio high — not 20.

### 5. Human review + merge

The maintainer reads the diff and merges. Worktree cleanup (per [`.claude/rules/workflow.md`](../rules/workflow.md)):

```bash
git worktree remove ~/dev/worktrees/<name>
git branch -d worktree/<name>
```

## Reading codex output (CRITICAL)

| Method                  | What it reads                                   | Use for                                    |
| ----------------------- | ----------------------------------------------- | ------------------------------------------ |
| **`await-turn` stdout** | Full agent response via the notify hook         | **Primary method. Always use this.**       |
| `output --clean`        | Full session log file, ANSI-cleaned             | Fallback if you missed `await-turn`        |
| `capture --clean`       | Visible tmux pane only (~50-80 lines)           | Quick "is it still working?" status checks |

**Rules:**

- ALWAYS run `await-turn` in the **foreground** (never `run_in_background`) so the full response appears in the Bash tool output.
- NEVER use `capture` to read plan content. It silently truncates long responses to the visible pane.
- If you missed an `await-turn`, use `output --clean` (full log file) as the fallback.

## CLI quick reference

```bash
codex-agent start "<prompt>" --map -s read-only -d <path>  # Spawn (read-only sandbox)
codex-agent await-turn <jobId>                              # Block until response (FULL response in stdout)
codex-agent send <jobId> "<message>"                        # Follow-up prompt to same job
codex-agent send <jobId> "/quit"                            # Close the agent
codex-agent capture <jobId> --clean                         # Quick status check ONLY (truncated)
codex-agent output <jobId> --clean                          # Full session log (fallback)
codex-agent jobs --json                                     # Status of all running agents
codex-agent health                                          # Verify install
```

## Parallel execution (N tasks)

1. Spawn N planning agents in parallel (one per worktree).
2. Run progressive disclosure on each (parallel agents, sequential `send`s per agent).
3. Capture all N plans.
4. Claude implements each (sequential or parallel via subagents).
5. Spawn N review agents in parallel (one per PR).
6. Claude fixes each (sequential).

## Troubleshooting

| Symptom                                                            | Likely cause                                                                                  | Fix                                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex-agent: command not found`                                   | PATH missing the orchestrator bin dir.                                                        | Add `export PATH="$HOME/.codex-orchestrator/bin:$HOME/.bun/bin:$PATH"` to `~/.zshrc` and restart the shell.                                      |
| `codex-agent health` reports `tmux: FAILED`                        | tmux not installed or not running.                                                            | `brew install tmux`. Verify with `tmux -V`.                                                                                                      |
| `await-turn` hangs forever or times out                            | Running inside cmux/tmux without passthrough. The agent's stdout never reaches the host pane. | Add `set -g allow-passthrough on` to `~/.tmux.conf` and restart the tmux server (`tmux kill-server`).                                            |
| Plan output looks truncated mid-sentence                           | You used `capture` instead of `await-turn`.                                                   | Use `await-turn` in the foreground. Long plans run past the visible tmux pane and `capture` only reads what's visible.                          |
| Review keeps surfacing the same finding                            | Codex saw stale code; the worktree didn't pick up the fix push.                               | `git status` in the worktree, confirm the fix landed, then spawn a fresh review agent (don't reuse the prior `jobId`).                          |
| `codex` CLI complains about authentication                         | `codex --login` not run, or token expired.                                                    | `codex --login` again. Tokens persist in `~/.codex/`.                                                                                            |
| Quick check: is anything broken with my install?                   | —                                                                                             | `pnpm cli doctor` — when `codex-agent` is on PATH, it runs `codex-agent health` and surfaces the same diagnostics inside the doctor output.     |
