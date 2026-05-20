/**
 * `fan-out-audit` prompt. The deep first-run backfill that builds the
 * user's AI work console from scratch. Run once when
 * `get_work_console_state` reports `initialized: false`, or any time the
 * user explicitly asks (e.g. after switching jobs / inheriting a new
 * workstream).
 *
 * The point is to use every MCP server the user has connected — GitHub,
 * Slack, Linear, Gmail, Calendar, Notion, anything else — and write the
 * combined intelligence into the canonical console layout. The output is
 * a set of markdown files Claude can re-read on subsequent sessions
 * without paying the up-front discovery cost again.
 */

import { okAsync } from '@slopweaver/errors';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const FAN_OUT_AUDIT_BODY = `# /fan-out-audit

You are running SlopWeaver's first-run backfill. The user just installed SlopWeaver. You have access to every MCP server they've already connected to Claude Code (Slack, GitHub, Linear, Gmail, Google Calendar, Notion, etc. — whatever they have). Your job is to gather everything you can about them and write a coherent AI work console under \`.claude/personal/\` on the work-console branch.

## Hard rules

- **Always on the work-console branch.** Call \`ensure_work_console_branch\` first. If it returns \`no_git_repo\`, surface that and proceed without branch isolation.
- **Don't ask for tokens.** SlopWeaver never holds tokens; you only use what the user already has in Claude Code.
- **Don't invent.** If a fact isn't in an MCP response or an existing file, mark it as \`TBD\` and move on.
- **Hyperlink every anchor.** PR numbers, ticket IDs, Slack thread timestamps, file references — all clickable.
- **Markdown only.** Write files with \`write_console_file\`. Atomic, jailed to the console dir.

## Files to produce (in this order)

### 1. \`contexts/identities.md\`

Resolve the user's identity on every connected MCP server.

- GitHub: \`mcp__github__*\` if available — fetch the authed user (\`get-authenticated-user\` or equivalent). Record username, primary email.
- Slack: workspaces accessible. For each, the user's user_id (\`U...\`). Look up via the relevant \`auth.test\` / profile tool.
- Linear: user UUID + email. Search for the user by name or grab from the auth tool.
- Gmail / Calendar: email address.
- Notion: user name + workspace.
- Any other MCP server: best-effort identity + cite the tool you called.

Schema (markdown table):

\`\`\`
| Platform | Identifier | Notes |
| --- | --- | --- |
\`\`\`

### 2. \`contexts/team-directory.md\`

Pull the people the user actually interacts with. Heuristics:

- Slack: top N message-volume DMs / mentions over the last 30 days.
- GitHub: top N reviewers + reviewees on the user's PRs in the last 30 days.
- Linear: assignees / mentioners on tickets the user touched.
- Calendar: recurring 1:1 attendees over the last 30 days.

For each person, record: full name, role (best guess from email-domain title / Slack profile / LinkedIn-style description if the user has Notion or similar), platform identifiers, "interacts via" channels. Keep under 25 people; this is the inner circle.

### 3. \`contexts/core-profile.md\`

The always-loaded user fingerprint. ~2K tokens. Sections:

- **Identity.** What the user does, where they work, who they report to. Cite sources.
- **Current priorities (ranked, YYYY-MM-DD).** Best-effort extraction from: recent Linear cycles, recent Slack threads in their priority channels, recent commit messages, recent calendar focus blocks. Rank 1-6 typically. Each priority gets one bullet with the supporting anchors hyperlinked.
- **Voice.** Read 50+ of the user's own messages (\`from:<them>\` searches across Slack, GitHub PR comments, Linear comments). Distill the rules into \`.claude/personal/rules/communication-style.md\` and reference that file here.
- **Decision patterns.** Pulled from recurring framings in their own writing.
- **Workflow rules (never violate).** Anything they've explicitly said in messages like "we always do X" or "rebase, never merge" or "PR descriptions follow this template". Pull from PR descriptions, contributing docs, Slack pinned posts.
- **Open loops (active YYYY-MM-DD).** Their highest-signal in-flight items. Bound by what surfaces in deltas — don't speculate.
- **Where things live.** Pointers to the rest of the console layout.

Write it like the user wrote it (apply their voice once \`communication-style.md\` exists). If voice extraction hasn't happened yet, default to a neutral first-person summary.

### 4. \`contexts/cycle-current.md\`

If the user uses sprints / cycles (Linear cycles, Jira sprints, Notion sprints), produce a one-page snapshot of the current cycle: theme, dates, open tickets assigned to them, blockers.

### 5. \`work/<topic>.md\` — at least one per major programme

Identify the user's top 1-3 programmes / workstreams from the ranked-priorities pass. For each, create a work file with sections:

- **Programme state (open items only).** \`- [ ]\` lines, one per concrete open thing. Each line carries the hyperlinked anchor.
- **Active asks owed (this week).** People waiting on them.
- **Key decisions (YYYY-MM-DD onward).** Append-log of major calls. Backfill from recent PRs / decision-record tickets if any are visible.

Topic naming: \`<programme-keyword>.md\`. E.g. if the user works on observability, \`observability.md\`. Don't hardcode an Everlab-specific name like \`dd-otel-observability.md\` — make it generic to their actual programme.

### 6. \`HANDOVER-FOR-AI-AGENTS.md\`

Top-level operating doc. Tells future AI sessions: "Here's how this user wants AI agents to behave. Always start with \`/session-start\`. Always work on the \`ai-work-console\` branch. Never auto-send messages without confirmation. File-first drafts." Pull the rules from observed patterns; if uncertain, write defaults and flag for the user to refine.

### 7. \`rules/communication-style.md\`

The user's voice rules. Extracted from their own writing. Hard rules (avoid em-dashes / exclamation marks / etc.) + cadence + audience register. Use \`/style-rule\` for ongoing additions.

### 8. \`rules/development-workflow.md\` (only if they're a developer)

Workflow conventions: branch naming, PR descriptions, review expectations, commit style. Pull from their actual PRs.

### 9. \`state/slack-delta.md\`, \`state/github-delta.md\`, \`state/linear-delta.md\` etc.

Fresh deltas. These are produced by Phase 1 of \`/session-start\` but on first run we generate them now so the snapshot has something to chew on.

### 10. \`daily/<YYYY-MM>/<DD>.md\`

Today's empty journal file with the date header. The user fills this themselves; future sessions read it for context.

## Output

When done, print a one-line summary per file written, plus the absolute path. Then say something like: "Console initialized. Run \`/session-start\` again (or just \`/lock-in\`) to start working."

If a section can't be filled because the relevant MCP server isn't connected, write a placeholder file like \`contexts/cycle-current.md\` with \`_Linear not connected — install the Linear MCP server and re-run \`/fan-out-audit\` to populate._\` and move on.

This is the most expensive single operation SlopWeaver runs. Budget 5-15 minutes of tool calls. The user's reward is that every subsequent \`/session-start\` is fast.
`;

export function createFanOutAuditPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'fan-out-audit',
    title: 'SlopWeaver: deep first-run backfill across every MCP server',
    description:
      'Build the AI work console from scratch by fanning out across every connected MCP server. Run once on first install or after a long offline gap.',
    handler: () => {
      return okAsync({
        description: 'SlopWeaver first-run backfill prompt',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: FAN_OUT_AUDIT_BODY },
          },
        ],
      });
    },
  });
}
