# Chain file format

A **chain file** is a markdown document that describes an end-to-end
orchestration run: planning prompts for codex, an implementation handoff,
review prompts for the PR, and the human-merge stop point. The orchestration
runner (`pnpm cli orchestration prepare/run`) parses this format.

Real chains live under `.claude/orchestration/<category>/<name>.md`. A
public worked example lives in
[`docs/orchestration/examples/refactor-example.md`](examples/refactor-example.md).

## Schema

```markdown
# <Chain title — required>

> <optional blockquote: status, deprecation, etc.>

## Goal (optional)

One paragraph on the outcome.

## Read This First (optional)

- Pointers to relevant rules, READMEs, or context docs.

## Locked Scope For This PR (optional)

### In scope / Explicitly out of scope / Non-negotiable constraints

## Variables (optional)

- `{worktree}`: `my-task-slug`
- `{pr_url}`: GitHub PR URL (filled in after PR creation)

## Implementation Plan (required heading; structure below)

### Phase 1: Codex Plans

#### Step 1: Initial Plan (codex-plan)

\`\`\`prompt
<codex planning prompt — required when role is codex-plan>
\`\`\`

#### Step 2: Refine (codex-send)

\`\`\`prompt
<follow-up prompt sent to the same codex job>
\`\`\`

### Phase 2: Claude Implements

#### Step 3: Handoff to Claude

Descriptive text. The runner builds the handoff preamble automatically.

### Phase 3: Codex Reviews

#### Step 5: PR Review (codex-review)

\`\`\`prompt
Review {pr_url}. Reply LGTM - ready for local testing. when clean.
\`\`\`
```

## Parsing rules

- **Title line** (`# ...`) is required and becomes `chain.title`.
- **Step heading** matches `## Step N: <title> (<role>)` at heading level
  2-4 inclusive. The role is optional; steps without a role are descriptive
  text, not prompts.
- **Roles** must be one of: `codex-plan`, `codex-send`, `claude-implement`,
  `codex-review`. Unknown roles are ignored.
- **Prompt blocks** are triple-backtick fenced blocks with the `prompt`
  language identifier, placed inside a step's body. Only the first prompt
  block per step is used.
- **Variables** are list items inside `## Variables` matching
  `` - `{name}`: value ``. The value can be a backtick-wrapped inline code
  span; if so, the surrounding backticks are stripped. Variables are
  interpolated into prompt templates via `{name}` placeholders. Unknown
  placeholders pass through unchanged.

## Roles drive the phases

| Role               | When                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `codex-plan`       | First codex turn. Read-only sandbox. Produces the initial plan.              |
| `codex-send`       | Follow-up prompts sent to the same codex job (progressive disclosure).       |
| `claude-implement` | Marker step. The runner hands the final plan to claude (or a codex worker). |
| `codex-review`     | Codex reviews the PR. Replies `LGTM - ready for local testing.` to pass.    |

## Lifecycle

`prepare` and `run` are different entrypoints:

- **`prepare`** bootstraps the worktree + prompt artifacts. The Claude-side
  launcher (a maintainer-external tool) consumes the resulting
  `launcher-manifest.json` and drives implementation as Claude. This is the
  "codex plans, Claude implements" hybrid path.
- **`run`** is the codex-only fallback runner. It executes every phase
  (planning, implementation, review, CI fix) through codex with no Claude
  in the loop. Use it when Claude is rate-limited or unavailable.

```bash
# Preview the resolved phase order without running anything (codex-only fallback)
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --dry-run

# Bootstrap the worktree + write artifacts for the hybrid path (no codex calls)
pnpm cli orchestration prepare @docs/orchestration/examples/refactor-example.md

# Codex-only fallback: end-to-end run through codex (requires codex-agent on PATH)
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md

# Resume is automatic. Use --restart to clear saved state and start over.
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --restart

# Send a cmux notification when the run pauses for human review
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --notify
```

`run` is hardcoded to `codex-only`. The `--executor` flag (`hybrid` |
`codex-only`) only applies to `prepare`, where it's recorded in the
launcher manifest for the Claude-side launcher to consume.

The leading `@` on the chain path is optional; the parser strips it for
ergonomics with shell completion.

## State and artifacts

State persists per chain at `$CODEX_HOME/orchestration-runs/<run-slug>/`
(default `$CODEX_HOME` is `~/.codex`). The runner writes:

- `state.json` — current phase, branch, PR URL, retry counts, output buffers.
- `artifacts/launcher-manifest.json` — paths the maintainer's `Claude /codex
  run @chain` launcher reads to know which worktree and prompts to use.
- `artifacts/final-plan.md` — codex's final plan (after any
  `codex-send` follow-ups).
- `artifacts/<role>-<id>-<model>.md` — per-attempt prompt outputs for
  debugging.

## Required tooling

- `pnpm cli orchestration prepare` runs without codex installed. It only
  scaffolds the worktree, syncs `.env*` files (if any), and writes prompt
  artifacts.
- `pnpm cli orchestration run` requires `codex-agent` on `PATH`. See
  [Codex install](../contributing/ai-workflow.md#codex-install-optional) in
  the contributor docs.
- `docs/CODEBASE_MAP.md` is auto-injected as a prompt prefix when
  present (the runner always passes `--map`). Without it, codex still
  runs but starts with no project context. See
  [Codebase map](../contributing/ai-workflow.md#codebase-map-recommended)
  for setup.
- `gh` (GitHub CLI) is required for PR creation and CI watching.
- `--notify` requires `cmux` (otherwise the call no-ops via the `enabled`
  guard in the runner's notify hook).
