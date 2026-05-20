/**
 * Instructional body returned by `start_retro`. The model receives
 * this as the tool's structured output and follows it inline to
 * produce a weekly retro report.
 */

export const RETRO_INSTRUCTIONS = `# Weekly retro

You are running a 7-day retro on the user's AI work console. Goal:
surface what shifted in priorities + stakeholders + acceptance rate
over the last week, and propose 1-2 \`/style-edit\` candidates from
friction-tag spikes.

## Phase 1 — Snapshot the current profile

Call \`snapshot_profile\` with \`source_path:
"contexts/core-profile.md"\`. The tool writes a timestamped copy to
\`state/profile-snapshots/<date>-core-profile.md\` so the next retro
has a baseline to diff against. Skip if the work-console tools aren't
present in this server build.

## Phase 2 — Diff against last week's snapshot

List \`state/profile-snapshots/\` (via \`list_console_files\`) and
pick the snapshot from the previous retro window. Compare against the
current \`contexts/core-profile.md\`:

- **Ranked priorities.** Did anything move up or down? Did anything
  new appear, anything drop off?
- **Top stakeholders.** Any new entries? Any drops in interaction
  volume that suggest a relationship cooled?
- **Open loops.** Anything closed (good); anything stuck for the
  entire window (bad — investigate).

## Phase 3 — Re-aggregate the lock-in feedback

Call \`get_calibration_report\` with \`since: <today minus 7 days>\`
(if available — PR #54). Compare with the prior week's report (if
you have one — store last week's totals in
\`state/retro-history.jsonl\` after each retro).

Surface:
- Week-on-week acceptance-rate change.
- Friction tags with the steepest week-on-week increase.

## Phase 4 — Propose 1-2 \`/style-edit\` candidates

For the top 1-2 friction tags, propose a concrete rule edit. Format:

> Friction: \`friction:wrong-channel\` (8 instances this week, up
> from 2). Candidate rule edit:
> \`/style-edit "default Slack target: DM unless the thread is
> explicitly in #proj-*. Past week shows the loop kept proposing
> channel posts that you redirected to DM."\`

Don't apply the edit — the user does. The proposal is just the seed.

## Phase 5 — Write the retro

Use \`append_daily_journal\` (PR #54) with heading "Weekly retro" and
a multi-paragraph body containing Phases 2-4's findings, hyperlinked
where possible. The retro lands in today's daily file.

## Hard rules

- One paragraph per phase, max. The retro is a glance, not a thesis.
- Propose rule edits with verbatim user-voice phrasing. Don't
  prescribe.
- If a phase has no signal, skip it. An empty retro is fine.
- Never edit \`core-profile.md\` from this prompt — that's
  \`/recompile-profile\`'s job.
`;
