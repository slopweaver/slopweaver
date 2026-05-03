# Refactor Example: Rename a Shared Utility Across Packages

> Generic public example used as a fixture for orchestration tests and as
> documentation. Follow the same shape for real chains under
> `.claude/orchestration/`.

## Goal

Demonstrate the orchestration chain format end to end using a small, safe
refactor: rename a shared utility function across the monorepo, update all
call sites, and verify the build is clean.

## Read This First

- `docs/orchestration/chain-format.md` — schema this file follows
- `.claude/rules/workflow.md` — how branches and PRs are handled
- `.claude/commands/codex.md` — the maintainer's hybrid loop

## Variables

- `{worktree}`: `refactor-rename-utility`
- `{pr_url}`: GitHub PR URL (filled in after PR creation)

## Implementation Plan

### Phase 1: Codex Plans

#### Step 1: Initial Plan (codex-plan)

```prompt
Investigate and plan the refactor for renaming a shared utility function
across the monorepo. Identify the function, every call site, and any
documentation references. Produce a file-by-file change plan with an
explicit order: rename declaration first, then call sites, then docs. Call
out any breakage risks (re-exports, public API contracts) before
implementation.
```

#### Step 2: Clarify and Finalize (codex-send)

```prompt
Refine the plan into a single straight-line implementation path. Drop any
optional polish. Surface the smallest set of changes required for the build
to pass, the tests to pass, and the public surface to remain consistent.
```

### Phase 2: Claude Implements

#### Step 3: Handoff to Claude

The handoff preamble (auto-built by the runner) hands the final plan to
Claude with instructions to adopt the plan exactly and implement it in the
current worktree without mutating the plan.

#### Step 4: Claude Implements

Claude executes the plan: rename the declaration, update call sites, update
docs, run the verification loop locally (`pnpm format:check && pnpm lint &&
pnpm compile && pnpm test`), commit, push, and open the PR.

### Phase 3: Codex Reviews

#### Step 5: PR Review (codex-review)

```prompt
Review {pr_url}. Confirm the rename is complete (no stale references to the
old name in code, tests, or docs). Confirm the verification loop runs clean.
Flag any drift from the original plan. Reply LGTM - ready for local testing.
when there are no blocking findings.
```

#### Step 6: Fix Loop

If the reviewer surfaces P0/P1 findings, the runner hands them to Claude as
a fix prompt and pushes a follow-up commit. The loop repeats until the
reviewer returns the success sentinel above.

### Phase 4: Human Review and Manual QA

After CI is green, the runner halts at `awaiting_manual_qa`. The maintainer
reads the diff and merges manually.
