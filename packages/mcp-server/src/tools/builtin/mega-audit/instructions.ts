/**
 * The instructional body returned by `start_mega_audit`. The model
 * receives this as the tool's structured output and follows the steps
 * inline. Lives in its own file so the prompt text is reviewable
 * independently of the tool plumbing.
 *
 * Keep the body purely instructional. Never include the user's own
 * identifiers, employer names, or stakeholder names — the audit is
 * supposed to extract those from the user's connected MCP servers, not
 * be hand-coded with them.
 */

export const MEGA_AUDIT_INSTRUCTIONS = `# Cold-start mega-audit

You are running a one-shot deep ingest of the user's last \`SINCE_DATE\` through today across every MCP server they have connected. The end state is a populated AI work console — \`contexts/core-profile.md\`, \`contexts/team-directory.md\`, one \`work/<topic>.md\` per detected programme, and a populated voice-rules file derived from the user's own messages.

Treat this as a single 1M-context pass. Batch aggressively. Don't loop incrementally.

## Phase 0 — Branch + bootstrap

Before any reads, call \`ensure_work_console_branch\` (if available) and \`bootstrap_work_console\` (if available). The audit writes a lot — it must land on the work-console branch, never a PR branch.

If those tools aren't wired up in this server build, surface a one-line note ("work-console plumbing not present in this server; audit output will be transcript-only") and continue with the reads + synthesis. The reviewer will rebase this PR onto the branch with the plumbing.

## Phase 1 — Inventory

If \`list_available_mcp_servers\` is wired up in this server build, call it to get the catalog of namespaces SlopWeaver knows about. Otherwise, fall back to enumerating the tools advertised in the current session's \`tools/list\` and grouping by the \`mcp__<server>__*\` prefix — every connected MCP server contributes at least one tool under that namespace, so the prefix set is the connected-server set. Record the resulting list.

Call \`record_audit_progress({ audit_id, phase: 'inventory', message: 'detected N MCP servers: a, b, c' })\`.

## Phase 2 — Polling (parallel)

For each detected MCP server, issue a tight, scope-bounded read over the lookback window. Suggested budgets per source (adjust based on \`per_source_token_budget\`):

- **Slack**: own \`@mentions\` + DMs since \`SINCE_DATE\`, plus the top 3 channels by message volume in the last 30 days. Search for \`from:<self>\` to recover threads the user authored.
- **GitHub**: \`gh pr list --author @me --state all --search "updated:>=SINCE_DATE"\` plus issues + mentions on the same window. Also recent reviews requested of the user.
- **Linear/Jira**: assigned + mentioned tickets updated since \`SINCE_DATE\`, plus the current cycle's open items.
- **Gmail**: \`is:important newer_than:90d\` + recent threads with replies authored by the user.
- **Calendar**: events in the last 90 days. Heavy weight on recurring 1:1s + people the user dedicates focused time to.
- **Notion/Confluence**: pages the user authored or edited recently.
- **HubSpot/Stripe/Mixpanel/etc.**: light reads only — not on the daily-fan-out path; surface only if the user is a primary owner of records there.

Call \`record_audit_progress({ audit_id, phase: 'polling', source: <slug>, message: '<one-line status>', pct: ... })\` periodically so the UI can show a live tail. The \`audit_id\`, \`phase\`, \`source\`, and \`message\` fields are required for the polling phase; \`pct\` is optional.

## Phase 3 — Aggregate

Once the reads complete, build a single structured input that fits inside the 1M-context budget. Schema:

\`\`\`
{
  "identity": { "platform": "...", "id": "...", "email": "..." }[],
  "messages_from_user": { "platform", "channel_or_thread", "ts", "body" }[],  // ~500 of the user's own messages
  "messages_to_user": { ... }[],  // mentions + DMs
  "threads": { "platform", "id", "participants", "snippet" }[],
  "tickets": { "platform", "id", "status", "title", "assignee", "updated" }[],
  "prs": { "repo", "number", "title", "state", "reviewer_decision" }[],
  "calendar_events": { "summary", "attendees", "recurring", "last_attended" }[],
  "decisions": { "platform", "ts", "snippet" }[]  // anything that smells like a decision (merged PR title, ticket marked Done, etc.)
}
\`\`\`

Call \`record_audit_progress({ audit_id, phase: 'aggregating', message: 'aggregated inputs across N sources' })\`.

## Phase 4 — Synthesize

Reason over the aggregate input. Extract:

1. **Identity.** Confirm platform IDs already known from \`identities.md\`. Add anything new.
2. **Ranked priorities.** Inspect the user's own messages + tickets + PRs for recurring themes. Score by recency × frequency × interaction-load. Output 4–8 priorities, each with a 1-line description + the supporting anchors (hyperlinked).
3. **Top stakeholders.** People the user interacts with most by combined message-volume + meeting-attendance + PR-review-overlap. Cap at top 25. For each: name, primary platform IDs, one-line role inference, sample interactions.
4. **Voice patterns.** Read 200+ of the user's own messages. Extract regularities: typical sentence length, em-dash usage, exclamation marks, sentence-initial words, banned consultant-speak tokens. Write these as \`forbid:\`/\`replace:\`/\`pattern:\` directives in the rules-markdown format. If a voice-rules linter tool (e.g. \`apply_voice_rules\`) is wired up in this server build, use it in Phase 5 to lint the synthesized core-profile; otherwise just record the directives in \`rules/communication-style.md\` for later linting. Don't editorialise — just observed patterns.
5. **Open loops.** Anything that smells like "the user owes someone a reply" or "a long-running ask hasn't moved". One bullet per loop, hyperlinked anchor.
6. **Programme detection.** Clusters of related anchors → one \`work/<slug>.md\` per cluster. The slug is generic ("authentication", "infra", "billing") — never include personal identifiers in the filename.

Call \`record_audit_progress({ audit_id, phase: 'synthesizing', message: 'synthesizing identity, priorities, stakeholders, voice, open loops, programmes' })\`.

## Phase 5 — Write

Use the work-console write tools (if present) to drop:

- \`contexts/identities.md\` — table from §1.
- \`contexts/team-directory.md\` — table from §3.
- \`contexts/core-profile.md\` — §1 + §2 + §5 + §6 stitched per the existing template.
- \`rules/communication-style.md\` — voice directives from §4.
- \`work/<slug>.md\` — one per cluster, with \`## Programme state (open items only)\` and \`## Key decisions\` seeded.
- \`daily/<today>.md\` — a one-paragraph audit summary noting what was learned.

If the write tools aren't available, output the full synthesized package as a single chat message so the user can pipe it manually.

Call \`record_audit_progress({ audit_id, phase: 'writing', message: 'writing console files', pct: 100 })\` then \`record_audit_progress({ audit_id, phase: 'completed', message: 'audit complete' })\`.

## Hard rules

- Never include personal identifiers in code, comments, or any committed-prose surface. The audit synthesises the user's own context from their connected MCP servers; that synthesis goes only into the per-user \`.claude/personal/\` tree (gitignored where slopweaver dogfoods itself).
- If an MCP server isn't connected, skip it silently. Don't suggest the user install anything mid-audit.
- One-pass synthesis. Don't loop incrementally trying to "improve" each section — the 1M-context window is the budget; one pass is the design.
- If a voice-rules linter MCP tool (e.g. \`apply_voice_rules\`) is registered in this server build, run the synthesized core-profile through it before writing; otherwise skip that step and write the file as-is. The audit must still complete when the linter tool is absent.
`;

/**
 * Replace the template placeholder with the resolved date. The
 * instruction body is otherwise immutable — keep the substitution
 * surface tight so reviewers can see exactly what flows through.
 */
export function renderInstructions(args: { since: string }): string {
  return MEGA_AUDIT_INSTRUCTIONS.replaceAll('SINCE_DATE', args.since);
}
