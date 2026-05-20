# The SlopWeaver workflow

> What you get the moment you finish `claude mcp add slopweaver`.

SlopWeaver is two things: a local-first MCP server with read tools over a polled evidence log, AND a slash-command-driven workflow that turns "I have ten tabs open and don't know what to do first" into a single ranked queue.

This document is the workflow half. The engine half is in [README.md](../README.md) and [docs/CODEBASE_MAP.md](CODEBASE_MAP.md).

## The 30-second pitch

1. `claude mcp add slopweaver`.
2. `/session-start` (or `/mcp__slopweaver__session-start` if you skipped `slopweaver init`).
3. Claude fans out across every other MCP server you've connected (Slack, GitHub, Linear, Gmail, Calendar, Notion, etc.), builds your personal context tree under `.claude/personal/`, reconciles open items, prints a ranked snapshot.
4. `/lock-in` walks the queue one item at a time. You pick `do`, `agent`, `handoff`, `defer`, or `skip` per item. Your choices feed a calibration log.

That's it. No tokens to paste anywhere. No env vars. The only setup is whichever MCP servers you already have wired into Claude Code.

## The AI work console branch

SlopWeaver's slash commands write to `.claude/personal/` on a dedicated branch — default name `ai-work-console`. The point is to keep context, drafts, deltas, and decision logs from polluting your PR branches.

The bootstrap (`bootstrap_work_console` MCP tool, called by `/session-start` on first run; also runnable via `slopweaver init`) creates the branch and writes a memory file at `.claude/SLOPWEAVER-MEMORY.md`. The import line `@.claude/SLOPWEAVER-MEMORY.md` is added to `.claude/CLAUDE.md` (a project-local Claude memory file). Claude Code reads both root `CLAUDE.md` and `.claude/CLAUDE.md`, but we deliberately use the latter so the bootstrap never modifies a tracked root file — public-repo maintainers dogfooding slopweaver get protected by `.gitignore` entries that exclude the bootstrap's generated artifacts. PR work happens on separate feature branches as usual.

If you'd rather call the branch something else, set `SLOPWEAVER_CONSOLE_BRANCH=my-branch` in your env before invoking SlopWeaver.

## Layout under `.claude/personal/`

| Path | Purpose |
| --- | --- |
| `contexts/identities.md` | Your username / user ID on every connected platform. |
| `contexts/team-directory.md` | The people you actually interact with. |
| `contexts/core-profile.md` | Always-loaded user fingerprint. ~2K tokens. Identity, ranked priorities, voice, decision patterns, workflow rules, open loops. |
| `work/<topic>.md` | One file per programme / workstream. Sections: `Programme state (open items only)`, `Active asks owed (this week)`, `Key decisions`. |
| `state/<source>-delta.md` | Generated delta files per MCP source (Slack, GitHub, Linear, etc.). Bucketed: needs response, needs reply, status changes, recently merged, etc. Overwritten by `/session-start`. |
| `state/reconciliation.md` | Bucketed cross-reference of work-file open items vs the latest deltas. Plus a `## Walk order (priority-ranked)` section consumed by `/lock-in`. |
| `state/lock-in-feedback.jsonl` | Walk-feedback log. One JSON line per `/lock-in` resolution. Used by `/calibration-report`. |
| `rules/communication-style.md` | Your voice rules. Captured via `/style-rule` and `/style-edit`. Applied to every draft. |
| `rules/development-workflow.md` | Workflow rules (rebase vs merge, PR description format, etc.). |
| `rules/ai-tropes.md` | Patterns you've flagged as "sounds like AI". |
| `daily/YYYY-MM/DD.md` | Daily journals. |
| `drafts/` | File-first message drafts. Never sent automatically. |
| `handoffs/<anchor>.md` | Self-contained prompts to paste into a parallel Claude Code chat. |
| `HANDOVER-FOR-AI-AGENTS.md` | Top-level operating doc for any AI agent picking up your repo. |

`slopweaver init` scaffolds the dirs and seeds a handful of placeholder markdown files. `/fan-out-audit` populates the actual content from your MCP servers.

## The eleven slash commands

### `/session-start [mode]`

The orchestrator. Steps:

1. **Branch check.** Calls `ensure_work_console_branch`. Refuses to proceed on a dirty PR branch unless you pass `allow_switch_with_uncommitted: true`.
2. **Bootstrap check.** Calls `get_work_console_state`. If `initialized: false` OR `mode: bootstrap`, runs the full `/fan-out-audit` before continuing.
3. **Freshness gate.** Inventories every connected MCP server. For each stale delta (>30 minutes by default; >60 minutes for ticket trackers), refreshes in parallel.
4. **Reconciliation pass.** Cross-references work-file open items vs the freshly-pulled evidence. Writes `state/reconciliation.md`.
5. **Snapshot.** Prints a ranked snapshot to the chat. Ends with: "What are we working on this session?"

Modes:

- `auto` (default) — bootstrap on first run, snapshot otherwise.
- `bootstrap` — force a full `/fan-out-audit` before the snapshot.
- `snapshot-only` — use cached deltas; skip refresh.
- `skip-refresh` — same as snapshot-only but produce the snapshot anyway, flagging stale sources.

### `/fan-out-audit`

The first-run deep backfill. Budget 5-15 minutes of tool calls. Produces:

- `contexts/identities.md` — resolved via auth/profile tools on every connected MCP server.
- `contexts/team-directory.md` — top-N people by interaction volume.
- `contexts/core-profile.md` — identity + ranked priorities + voice + open loops.
- `contexts/cycle-current.md` — current sprint / cycle if applicable.
- `work/<topic>.md` for each major programme.
- `rules/communication-style.md` — voice extracted from 50+ of your own messages.
- `rules/development-workflow.md` — workflow conventions extracted from observed PRs.
- `state/*-delta.md` — initial deltas.
- Empty journal file for today.

Run it again any time after switching jobs, inheriting a new workstream, or just feeling like the context has drifted.

### `/lock-in [from] [dry_run]`

Push-style execution. Reads `state/reconciliation.md` (preferring the `## Walk order (priority-ranked)` section) and walks the queue one item at a time. Per item:

1. State the item in 1-2 sentences with a hyperlinked anchor.
2. Propose a concrete next action.
3. Menu: `do | agent | handoff | defer | skip | note <text> | open-question <text> | jump N`.
4. Wait for the user.
5. Apply the chosen verb. Announce the result. Move to the next item.
6. Silently append one line to `state/lock-in-feedback.jsonl` via the `log_walk_feedback` MCP tool.

`stop` / `pause` / `enough` ends the walk. Produces a closing summary with the totals.

The feedback log captures: which item, what was proposed, what the user picked, whether it was approved as proposed or edited or rejected, and any friction tags. This builds up the calibration substrate over weeks.

### `/reconcile`

Explicit reconciliation pass, decoupled from `/session-start`. Use when the deltas have shifted since the last snapshot and you want to refresh the buckets without re-fanning-out.

Writes `state/reconciliation.md`. Ends with an apply-confirmation block (`yes` / `apply 1, 3, 5` / `no`).

### `/style-rule <rule>` and `/style-edit <edit>`

Capture / amend rules. `/style-rule` appends; `/style-edit` refines or removes. Always uses the user's exact phrasing — no paraphrase. Files live under `rules/`.

### `/correct <correction>`

The user just pushed back on something Claude did. One-line acknowledgement, no apology, classify the correction (voice / workflow / context / proposal), update the right rules or context file, log a calibration breadcrumb.

### `/calibration-report [since]`

Read-only diagnostic over the walk-feedback JSONL log. Shows the total number of walks + items in the window, acceptance / edit / rejection / deferred / dropped / noted rates, and the top friction tags (`friction:wrong-channel`, `friction:wrong-tone`, etc.). Ends with one interpretive sentence — if acceptance is low or one friction tag dominates, it suggests the matching `/style-edit` to make next. No file writes.

### `/recompile-profile [trigger]`

Refresh `contexts/core-profile.md` from the latest signal. Same idea as `/fan-out-audit` but scoped to just the four derived sections (identity, ranked priorities, voice deltas, open loops). Diff-and-apply, never wholesale rewrite. Preserves any sections the user has hand-edited.

### `/decided <decision> [work_file]`

Append a dated entry to the matching work file's `## Key decisions (YYYY-MM-DD onward)` section. The user just made a call; this command records it verbatim. If `work_file` isn't supplied, picks the most-recently-modified file under `work/`.

### `/focus <scope> [duration_minutes]`

Set a session-scoped focus filter. Writes `state/focus.md`. Subsequent `/session-start` snapshots elevate items matching the scope keywords; `/lock-in` skips non-matching items unless the user explicitly walks them. `/focus all` (or just clearing `focus.md`) drops the filter.

## How `/session-start` decides what to call

SlopWeaver itself does NOT carry tokens for upstream platforms. The session-start prompt instructs Claude to look at the list of available tools (anything namespaced `mcp__*__*`) and route to whatever the user has connected. Examples:

- GitHub MCP: `mcp__github__*` — for PR review, issue search.
- Slack MCP: `mcp__slack__*` — for search, channel reads, thread expansion.
- Linear MCP: `mcp__linear__*` — for ticket queries.
- Gmail: `mcp__gmail__*` — for unread / important threads.
- Calendar: `mcp__calendar__*` — for today's focus blocks.

The work-console-side MCP tools SlopWeaver ships (`ensure_work_console_branch`, `read_console_file`, `write_console_file`, `list_console_files`, `log_walk_feedback`, `get_calibration_report`, `get_work_console_state`) are all jailed to the work-console directory. They never touch your PR branches or arbitrary filesystem paths.

## Calibration

After a couple weeks of `/lock-in` walks, `/calibration-report` aggregates the feedback log. You'll see:

- Acceptance rate: fraction of items where you picked `do` and the result matched the proposal.
- Edit rate: fraction where you redirected.
- Rejection rate: fraction where you picked something substantively different.
- Top friction tags: where the proposals consistently miss (`friction:wrong-channel`, `friction:wrong-tone`, etc.).

This is the substrate for tightening the rules over time. The report is read-only; you decide whether to amend rules via `/style-edit` based on what surfaces.

## What's intentionally not here

- **No HTTP MCP transport.** v1 is stdio-only; cloud tier is year 2.
- **No SlopWeaver-side platform tokens.** The whole point of the fan-out model is that you reuse the MCP servers you already have.
- **No auto-send.** Drafts go to disk. The user sends.
- **No agents that act unattended.** Every `/lock-in` item is a confirm step.
- **No bandaids.** When something breaks, investigate root cause; don't disable the gate.

For implementation details (which MCP tools exist, where the code lives, how to add a new tool), see [docs/CODEBASE_MAP.md](CODEBASE_MAP.md).
