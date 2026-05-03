You are an AI agent fixing a GitHub Issue in the SlopWeaver public repo.

The user invoked you with `/fix-issue <issue-url>`. The argument is the URL of the issue to address.

## Read first

1. **`.claude/rules/workflow.md`** — worktree convention, branch naming, merge rules, decisions-in-issues pattern.
2. **`.claude/rules/pr-conventions.md`** — PR title/description format, size discipline, CI gates.
3. **`CLAUDE.md`** — repo state, stack, dev principles.
4. **The issue itself** — fetch via `gh issue view <number> --repo slopweaver/slopweaver` or by parsing the URL.

## Workflow

### 1. Understand the issue

Read the issue body in full. Note:

- The acceptance criteria (often a checklist)
- Any linked issues, PRs, or docs
- Existing comments — context, decisions, course corrections
- Labels — `decision-record`, `bug`, `enhancement`, `integration-request`, etc.

If the issue is ambiguous or under-specified, **don't guess**. Comment on the issue asking for clarification, then stop. Better to wait than to ship the wrong thing.

### 2. Create a worktree

Use the project CLI:

```bash
pnpm cli worktree-new fix-issue-<N>
# creates ~/dev/worktrees/fix-issue-<N> on branch worktree/fix-issue-<N>
# runs pnpm install
```

Use a slug that includes the issue number so the worktree is identifiable.

### 3. Implement

`cd` into the worktree. Make focused changes that address the issue's acceptance criteria. Don't expand scope.

If you discover a related-but-separate problem, **file a new issue** for it (`gh issue create`) rather than fixing it inline.

Follow the principles in CLAUDE.md:

- TypeScript strict; named object params for any function with 1+ args
- No `any` in production code; `unknown` + type guards
- Direct imports between packages — no premature ports/adapters
- No `@nestjs/*` imports inside `packages/*`
- Composite MCP tools live in `packages/mcp-server/src/tools/composite/`; single-platform tools in `packages/integrations/<platform>/mcp-tools/`

### 4. Verify before opening the PR

Run the same four checks CI runs:

```bash
pnpm format:check
pnpm lint
pnpm compile
pnpm test
```

All four must pass. If `format:check` fails, run `pnpm format` to auto-fix, then re-run `format:check`.

### 5. Open the PR

Use the PR template (`.github/pull_request_template.md`). Title in conventional-commits format (see `.claude/rules/pr-conventions.md`). Description includes:

- What changed and why
- `closes #<issue-number>` so the issue auto-closes on merge
- Test plan with the four CI checks ticked
- Notes for the reviewer if there are tradeoffs

Open as **ready for review**, not draft (unless the work is genuinely incomplete).

### 6. Comment on the issue

Post a comment on the issue linking the PR:

```bash
gh issue comment <issue-number> --repo slopweaver/slopweaver --body "PR: <pr-url>"
```

This gives onlookers a thread between the issue and the implementation.

## Don't

- Don't merge the PR yourself. The founder reviews and merges.
- Don't push to `main` directly. Use the worktree → PR flow always.
- Don't bypass CI. If `compile` or `test` fails, fix it; don't disable.
- Don't include unrelated changes (e.g. fixing a typo in a doc you weren't editing). File a separate issue/PR.
- Don't add new dependencies without explaining why in the PR description. Prefer Node built-ins, then existing repo deps, then new ones.

## When you're done

Reply briefly with:

- Link to the PR you opened
- Summary of what you changed (1-2 sentences)
- Anything you want the founder to look at specifically during review
