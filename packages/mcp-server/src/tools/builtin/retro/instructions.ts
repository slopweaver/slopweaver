/**
 * Instructional body returned by `start_retro`. The model receives
 * this as the tool's structured output and follows it inline to
 * produce a weekly retro report.
 *
 * Constraint: this prompt may only reference MCP tools that are
 * actually registered in this server build (`ping`, `start_session`,
 * `get_freshness`, `catch_me_up`, `search_work_context`,
 * `snapshot_profile`, plus `start_retro` itself). Future work-console
 * tools (journal-append, calibration-report, etc.) are referenced
 * defensively — "if available, otherwise return the retro inline."
 */

export const RETRO_INSTRUCTIONS = `# Weekly retro

You are running a 7-day retro on the user's recent work activity.
Goal: surface what shifted in priorities, stakeholders, and signal
volume over the last week, and propose 1-2 concrete follow-ups.

The final retro should be returned **inline as your reply** so the
user can read it directly in the conversation. Only persist it to a
file if the user explicitly asks, or if a work-console journal tool
is available in this server build (see Phase 5).

## Phase 1 — Snapshot the current profile (optional)

If the user maintains a profile file (e.g. \`contexts/core-profile.md\`)
and points you at it, call \`snapshot_profile\` with that path as
\`source_path\`. The path may be absolute or relative to the current
working directory — \`snapshot_profile\` resolves relative paths via
\`process.cwd()\`. The tool writes a sortable, timestamped copy under
\`<source-dir>/profile-snapshots/\` so the next retro has a baseline
to diff against. The tool refuses to overwrite an existing snapshot
file by default; if the user explicitly asks you to replace one, pass
\`overwrite: true\`.

If no profile file is in play, skip this phase.

## Phase 2 — Pull the week's evidence

Call \`catch_me_up\` with \`since: <today minus 7 days, ISO-8601>\`
to retrieve every evidence entry the local server has cached for the
last week. This is your raw material.

Optionally call \`get_freshness\` first to confirm the local cache is
up to date; if every integration is stale, mention that caveat in
the retro so the user knows the picture may be incomplete.

For specific themes (a named project, person, or repository), call
\`search_work_context\` with a targeted \`query\` and optional
\`filters.integration\` / \`filters.kind\` to dig deeper.

## Phase 3 — Identify the week's shifts

From the evidence, extract:

- **Active threads.** Which PRs, issues, channels, or DMs had the
  most activity this week?
- **Top stakeholders.** Which people showed up most often as
  authors, reviewers, or thread participants?
- **Open loops.** What's still waiting on the user (review requests,
  unanswered mentions, open PRs assigned to them)?
- **Quiet zones.** Was there a previously-active area that went
  silent? Worth flagging.

If you previously snapshotted a profile (Phase 1) and a prior
snapshot exists in \`<source-dir>/profile-snapshots/\`, compare the
two and call out any priority / stakeholder shifts.

## Phase 4 — Propose 1-2 follow-ups

For the top 1-2 patterns, propose a concrete next step. Format:

> Pattern: 5 unanswered Slack mentions in \`#proj-foo\` this week,
> all from one stakeholder. Proposed follow-up: schedule a 15-minute
> sync, or send a single batched reply addressing them all.

Don't take the action — the user does. The proposal is the seed.

## Phase 5 — Return the retro

Return the retro inline as your reply, structured by phase. Keep it
to one paragraph per phase, max. The retro is a glance, not a thesis.

If a work-console journal tool (e.g. \`append_daily_journal\`) is
registered in this server build and the user has asked for the retro
to be persisted, call it with heading "Weekly retro" and the same
body. Otherwise, the inline reply is the deliverable.

## Hard rules

- Use only tools that are actually registered in this server build.
  If a referenced tool is not present, fall back to inline reply.
- If a phase has no signal, skip it. An empty retro is fine.
- Propose follow-ups; don't apply them. The user decides.
- Never mutate the user's profile file from this prompt.
`;
