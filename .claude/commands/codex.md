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

## Two ways to run

**Direct (codex-agent CLI).** Drive each phase yourself with `codex-agent start/await-turn/send/quit`. Best for one-off planning sessions or ad-hoc review.

**Chain runner.** Author a chain file under `.claude/orchestration/<category>/<name>.md` and run:

```bash
# Preview phases (no codex calls, no side effects)
pnpm cli orchestration run @.claude/orchestration/<chain>.md --dry-run

# Scaffold worktree + prompt artifacts only
pnpm cli orchestration prepare @.claude/orchestration/<chain>.md

# Full hybrid loop end to end
pnpm cli orchestration run @.claude/orchestration/<chain>.md

# Resume is automatic. Use --restart to clear saved state.
pnpm cli orchestration run @.claude/orchestration/<chain>.md --restart
```

State and artifacts persist under `$CODEX_HOME/orchestration-runs/<slug>/`.

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

```
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
