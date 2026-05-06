# Secret Scanning: gitleaks + lefthook + CI gate

> Public-repo hardening. Adds gitleaks scanning at three layers (pre-commit
> hook, pre-push hook, CI gate) so contributors cannot accidentally land
> secrets in `slopweaver/slopweaver`.

## Goal

Land a layered secret-scanning stack so any contributor — including AI
agents driving the repo — gets a fast local check (pre-commit), a backstop
before push (pre-push), and an enforced CI gate. The maintainer can no
longer be the last line of defence. Out of an abundance of caution: this
is a **public repo**, so the chain itself must not embed any real-looking
tokens, internal API patterns, or references to the private monorepo's
shape.

## Read This First

- `docs/orchestration/chain-format.md` — schema this file follows.
- `.claude/rules/workflow.md` — branch + PR conventions; the new
  `pnpm validate` order needs to land here too.
- `.claude/rules/pr-conventions.md` — PR template + size discipline.
- `.github/workflows/ci.yml` — the existing five gates; gitleaks lands as
  a sixth (or as part of `pnpm validate`).
- The repo's `package.json` for the existing `validate` script and pnpm
  10 + Node 22 + ESM constraints.
- `CLAUDE.md` "Security and privacy" — the non-negotiable rules this PR
  enforces in code rather than prose.

## Locked Scope For This PR

### In scope

- Add `lefthook` as a root devDependency. Wire a `prepare` root script
  (`lefthook install || echo 'lefthook install skipped (not a git repository)'`)
  so contributors get hooks installed automatically on `pnpm install`.
- Add `lefthook.yml` at repo root with two stages:
  - `pre-commit` — runs `gitleaks protect --staged --redact --no-banner`
    on staged files. Fails the commit if any rule matches.
  - `pre-push` — runs `gitleaks detect --redact --no-banner` over the
    full working tree (defence-in-depth; catches anything that bypassed
    pre-commit via `--no-verify`).
- Add `.gitleaks.toml` at repo root. Start from gitleaks's default rule
  pack (do not redefine it). Add a minimal `[allowlist]` covering the
  known false positives in the current tree:
  - `xoxb-test`, `xoxp-test`, `xoxa-test` literals used in
    `packages/integrations/slack/src/**/*.test.ts`.
  - The placeholder UUIDs (`11111111-1111-4111-8111-111111111111`,
    `aaaaaaaa-...`, `bbbbbbbb-...`) used in identity tests.
  - `.gitleaks.toml` itself (so example regexes inside the config don't
    self-trigger).
- Add a CI step in `.github/workflows/ci.yml` that runs
  `gitleaks detect --redact --no-banner --exit-code 1`. Pin the
  gitleaks installer action by full SHA per repo convention. The CI
  step must run on every PR and on `push` to `main`. It is independent
  of `pnpm validate` (gitleaks is not a Node tool — keep CI installation
  separate so we don't depend on an npm wrapper of unclear maintenance).
- Optionally add `pnpm secret-scan` script to root `package.json`
  (`gitleaks detect --redact --no-banner`) so contributors can run the
  same check locally without a hook. Do NOT add it to `pnpm validate`
  yet — `validate` assumes Node-only tooling. Document the local install
  path (Homebrew / Scoop / direct binary) in `CONTRIBUTING.md` and in
  `.claude/rules/workflow.md`.
- Update `CONTRIBUTING.md` (and `.claude/rules/workflow.md` if needed)
  with: how to install gitleaks locally, what to do when the hook fires,
  how to allowlist a confirmed false positive, and the explicit rule
  that `git commit --no-verify` is reserved for emergencies and must be
  flagged in the PR description.

### Explicitly out of scope

- trufflehog, detect-secrets, or any second scanner. One scanner, well
  configured, beats two scanners with overlapping noise.
- Rewriting git history. If gitleaks finds an existing leak in `main`'s
  history, raise a separate decision-record issue — do not silently
  rewrite history in this PR.
- Secret rotation runbooks. That's an incident-response doc, not a
  tooling PR.
- Adding biome / prettier / oxlint to pre-commit. The private monorepo
  does this; the public repo's `pnpm format` is fast enough that
  duplicating it as a hook is noise. Keep `lefthook.yml` to one job
  (gitleaks) so the cognitive cost stays near zero.
- Custom gitleaks rules beyond the stock pack. Stock catches AWS / GCP /
  Stripe / Slack tokens / GitHub PATs / OAuth client secrets / SSH keys
  / generic high-entropy strings. Custom rules are scope creep.
- Cassette redaction tightening (the `__recordings__` content-aware
  redaction concern raised in PR #31). That's a separate, larger
  concern; this PR is about preventing _commits_ of secrets, not
  scrubbing recorded HTTP fixtures.

### Non-negotiable constraints

- Public repo. The chain doc, the prompts, the allowlist, the CI logs —
  none of them may contain a real token, real workspace identifier,
  real customer name, or anything that could be confused for one.
  Allowlist patterns must use the literal `xox[abp]-test` style values
  already present in the slack package; do not invent new placeholder
  shapes that resemble real tokens.
- The hook must not block a clean commit on a clean branch. If
  `gitleaks` is missing from PATH, lefthook should print an actionable
  error pointing to install instructions and exit non-zero. It must not
  silently no-op.
- No npm wrapper of `gitleaks`. The Go binary is the source of truth;
  npm wrappers are third-party and have spotty maintenance. CI installs
  via a pinned official action; locally, contributors install via
  Homebrew / Scoop / a direct download (documented).
- Pin every new GitHub Action by full commit SHA (existing repo
  convention — see the comments in `ci.yml`).
- The `prepare` script must tolerate non-git checkouts (the published
  npm tarball, sandbox containers, `npm pack` extractions). The fallback
  string `lefthook install skipped (not a git repository)` is the
  pattern from the private monorepo and is fine to reuse verbatim.
- All five existing CI gates must continue to pass on this PR. The new
  gate is additive.

## Variables

- `{worktree}`: `secret-scanning-gitleaks`
- `{pr_url}`: GitHub PR URL (filled in after PR creation)

## Implementation Plan

### Phase 1: Codex Plans

#### Step 1: Initial Plan (codex-plan)

```prompt
Plan the implementation of a layered gitleaks + lefthook secret-scanning
stack for the public slopweaver/slopweaver repo. The chain doc this turn
came from is the source of truth for scope; do not expand beyond it.

Investigate first, plan second:
- Read package.json (root + each workspace) to confirm pnpm 10 + Node 22 +
  ESM. Note the existing `validate` script composition.
- Read .github/workflows/ci.yml to find the existing five gates and the
  pinned-by-SHA GitHub Action style. The new gitleaks step must follow
  the same pinning convention.
- Read lefthook docs (current stable version) to confirm: (a) the
  `prepare` -> `lefthook install` lifecycle works for monorepos, (b)
  pre-commit `{staged_files}` interpolation, (c) pre-push hook semantics
  on commits without a remote.
- Read gitleaks docs to confirm: `gitleaks protect --staged` is the
  correct command for pre-commit (it scans staged content, not the
  working tree); `gitleaks detect` is correct for pre-push and CI.
  Confirm the official GitHub Action repo + a current release SHA to
  pin against.
- Sweep the current tree for any string that gitleaks's stock rules
  would flag as a positive: every `xox*-` literal, every long
  base64-looking string, every UUID, every API URL with a query param
  that looks token-shaped. List every match. The allowlist must cover
  exactly that set and nothing wider. Pay special attention to
  packages/integrations/slack/src/ tests, the existing /patches dir,
  and pnpm-lock.yaml.
- Confirm whether pnpm-lock.yaml triggers any rule. If it does, decide
  between an allowlist on the file path and adjusting the rule scope.
  Prefer a path allowlist; document the reason.

Then produce a file-by-file change plan listing exactly:
- New files (lefthook.yml, .gitleaks.toml).
- Edited files (package.json scripts, .github/workflows/ci.yml,
  CONTRIBUTING.md, .claude/rules/workflow.md).
- The exact lefthook.yml shape and the exact .gitleaks.toml allowlist.
- The CI step body, including the SHA-pinned action reference.
- The CONTRIBUTING.md additions (install paths for macOS, Linux,
  Windows; what to do when the hook fires; --no-verify policy).
- A verification section: how to prove the hook fires on a planted
  fake secret, how to prove it allows the existing tree, how to prove
  CI catches a bypassed commit.

Do NOT write code yet. Surface every risk: false positives, contributor
friction, the platform matrix for the local install, the failure mode
if a contributor doesn't have gitleaks on PATH.
```

#### Step 2: Tighten and Finalise (codex-send)

```prompt
Reduce the plan to the smallest straight-line set of edits that lands
the layered scanning stack. For each item: keep, drop, or defer to a
follow-up issue. Specifically:

- Confirm whether the pre-push hook is worth landing now or whether it
  duplicates the CI gate enough to defer. Pick one and justify.
- Confirm the allowlist is the minimum viable. Every entry needs a
  matching real string in the tree right now; if it doesn't, drop it.
- Confirm the CONTRIBUTING.md addition is concise. Three short
  paragraphs at most: install, what to do if the hook fires, --no-verify
  policy.
- Confirm pnpm-lock.yaml handling has a real plan, not a TODO.
- Confirm the prepare script change is the only package.json change
  needed besides adding lefthook to devDependencies. No new scripts
  unless explicitly required.

Output: the final straight-line plan as a numbered list of edits, in
the order they should be applied. The implementer will follow this
list verbatim.
```

### Phase 2: Claude Implements

#### Step 3: Handoff to Claude

The runner builds the handoff preamble automatically. Claude receives
the final plan from Step 2 and applies it without modification.

#### Step 4: Claude Implements

Claude executes the plan in order:

1. Add `lefthook` to root `devDependencies`; add the `prepare` script.
2. Write `lefthook.yml` and `.gitleaks.toml`.
3. Edit `.github/workflows/ci.yml` to add the SHA-pinned gitleaks step.
4. Edit `CONTRIBUTING.md` and (if the plan calls for it)
   `.claude/rules/workflow.md`.
5. Run `pnpm install` to register the hooks locally.
6. Plant a fake `xoxb-1234567890123-1234567890123-test-secret-DELETE`
   in a scratch file, attempt to commit, confirm the hook blocks it.
   Remove the file.
7. Run the full local verification loop:
   `pnpm format:check && pnpm lint && pnpm compile && pnpm test &&
   pnpm knip` — all five existing gates must pass.
8. Run `pnpm secret-scan` (if added) and `gitleaks detect` directly
   to confirm the existing tree is clean.
9. Commit using the conventional-commits style:
   `chore(security): wire gitleaks via lefthook + CI gate`.
10. Push, open the PR titled exactly the same, body referencing
    `refs #2` and explaining the three-layer model.

### Phase 3: Codex Reviews

#### Step 5: PR Review (codex-review)

```prompt
Review {pr_url}. This PR adds layered gitleaks scanning to the public
slopweaver/slopweaver repo via lefthook (pre-commit + optional
pre-push) and a CI gate. The repo is public — extra scrutiny on
anything that could embed sensitive data.

Confirm specifically:
- The .gitleaks.toml allowlist contains only entries with a matching
  real string in the current tree. Any entry without justification is
  a finding.
- No real token, real workspace ID, real customer name, or anything
  resembling them appears in the new files (lefthook.yml,
  .gitleaks.toml, CI step, CONTRIBUTING.md additions). The allowlist
  uses the existing test-fixture shapes (xox[abp]-test, placeholder
  UUIDs) and nothing that resembles a real credential.
- The CI gitleaks step is pinned by full commit SHA, matches the
  formatting of the other steps in ci.yml, and runs on both
  pull_request and push to main.
- The lefthook pre-commit command uses `gitleaks protect --staged`,
  not `detect`. (--staged scans the staged content; detect scans the
  working tree and would miss un-added secrets in committed files.)
- The prepare script uses the documented fallback for non-git
  checkouts so `pnpm install` doesn't break in tarball or sandbox
  contexts.
- All five pre-existing CI gates remain green on this PR.
- A planted fake secret would be blocked. (Look for a verification
  step in the PR description showing the implementer planted and
  removed a fake token.)
- The PR body explains the three-layer model and links the v1
  roadmap (refs #2).
- Diff size is reasonable for the scope (≤500 lines excluding
  lockfile).

Flag any drift from the chain's locked scope. Reply
LGTM - ready for local testing. when there are no blocking findings.
```

#### Step 6: Fix Loop

If the reviewer surfaces P0/P1 findings, the runner hands them to the
implementer as a fix prompt and pushes a follow-up commit. The loop
repeats until the reviewer returns the success sentinel.

### Phase 4: Human Review and Manual QA

After CI is green, the runner halts at `awaiting_manual_qa`. The
maintainer:

1. Reads the diff with public-repo eyes — are any of the new files
   (lefthook.yml, .gitleaks.toml, CI step) embedding anything that
   should be scrubbed?
2. Plants a different fake secret locally, attempts to commit, confirms
   the hook fires.
3. Runs `gitleaks detect` over the full repo at HEAD; confirms zero
   findings.
4. Merges via squash-merge.
