You are an AI agent reviewing a pull request in the SlopWeaver public repo.

The user invoked you with `/review-pr <pr-url>`. The argument is the URL of the PR to review.

## What this command is for

A **second-opinion review** on an open PR. The founder has already (or will shortly) read it, but wants a fresh pair of eyes — particularly for:

- Logic correctness
- Architectural fit (does it follow CLAUDE.md and `.claude/rules/`?)
- Edge cases the author may have missed
- Naming and ergonomics
- Things that should be in a follow-up PR, not this one

This is not "approve the PR" (you can't; only the founder merges). It's "post a thorough review comment that the founder can react to."

## Read first

1. **`CLAUDE.md`** — dev principles
2. **`.claude/rules/workflow.md`** + **`pr-conventions.md`** — what a good PR looks like
3. **The PR itself**:

   ```bash
   gh pr view <number> --repo slopweaver/slopweaver
   gh pr diff <number> --repo slopweaver/slopweaver
   ```

4. **The linked issue** if any (PR description usually has `closes #N`)

## Workflow

### 1. Read the diff thoroughly

Don't just skim. For each changed file:

- Does the change accomplish what the PR description says?
- Is anything missing (tests, docs, error handling, type safety)?
- Are there obvious bugs (off-by-one, null handling, race conditions)?
- Does it follow the project's conventions (named params, no `any`, no `@nestjs/*` in packages, etc.)?

For new files:

- Does the file have a single clear purpose?
- Is the size reasonable (≤300 lines for source files; longer is OK for generated/migration files)?
- Does it belong where it was placed (per the package layout in CLAUDE.md)?

### 2. Optional: run a second-opinion model

If the PR is tricky and you want another perspective, invoke Codex CLI:

```bash
codex review <pr-url>
```

(The Codex CLI is a separate tool the founder may have installed. If `codex` isn't on PATH, skip this step — it's optional.)

Compare Codex's findings to your own. Where they overlap, that's high-confidence feedback. Where they differ, surface both views in your review and let the founder weigh.

### 3. Write the review comment

Post a single comment on the PR (don't spam multiple inline comments unless they're file-specific concerns):

```bash
gh pr comment <number> --repo slopweaver/slopweaver --body "$(cat <<'EOF'
## Review

### What I think is good
- [bullet list of things the PR does well]

### Concerns / questions
- [bullet list of things to address before merge]

### Nits (non-blocking)
- [bullet list of small style/naming things]

### Suggestions for follow-up PRs
- [things that are out of scope for this PR but worth tracking]
EOF
)"
```

Keep the review **specific**. Bad: "the code could be cleaner." Good: "`packages/auth/src/token.ts` line 42 — the `expires_at` check uses `<=` but should be `<` because of the [reasoning]."

### 4. Don't approve or merge

Even if the PR is excellent, don't approve it via `gh pr review --approve`. The founder is the merger; review comments inform the merge decision but don't make it.

## When you're done

Reply briefly with:

- Link to your review comment
- Top-line verdict (LGTM / minor concerns / blocking concerns)
- Anything you want to flag specifically to the founder
