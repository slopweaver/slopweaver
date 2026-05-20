/**
 * `session-start` prompt. The headline entry-point of the SlopWeaver work
 * console. When the user types `/session-start` (or
 * `/mcp__slopweaver__session-start`), this prompt is what the MCP client
 * sends to the model.
 *
 * Phase summary the prompt instructs Claude to follow:
 *  1. Ensure the user is on the AI work-console branch (call the
 *     `ensure_work_console_branch` MCP tool). Never run this flow on a
 *     PR branch.
 *  2. Probe the console state (call `get_work_console_state`). If
 *     uninitialized OR the user passes `mode: bootstrap`, run the
 *     fan-out-audit (a single big first-run pass) BEFORE the regular
 *     snapshot — by referencing the sister `fan-out-audit` prompt's
 *     instructions inline.
 *  3. Refresh stale deltas via the other MCP servers the user has
 *     connected (Slack, Linear, Gmail, GitHub, etc. — whatever
 *     `tools/list` reports), in parallel.
 *  4. Cross-reference the user's work files against the freshly-pulled
 *     evidence (a lightweight reconcile pass).
 *  5. Produce the snapshot output. End with an apply-confirmation block
 *     and the question "What are we working on this session?".
 *
 * The prompt is intentionally framework-aware: it tells Claude to use
 * the SlopWeaver tools by name and to use whatever other MCP servers the
 * client has wired in, without naming any specific platform. That way
 * the prompt is portable across users with very different MCP stacks.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const SessionStartArgsSchema = z
  .object({
    mode: z
      .enum(['auto', 'bootstrap', 'snapshot-only', 'skip-refresh'])
      .optional()
      .describe(
        "auto (default): bootstrap on first run, otherwise snapshot. bootstrap: force fan-out-audit. snapshot-only: skip refresh, use cached. skip-refresh: don't poll, just reconcile.",
      ),
  })
  .strict();

const SESSION_START_BODY = `# /session-start

You are running SlopWeaver's session-start flow. The user wants a single, trustworthy snapshot of what's on their plate right now — sourced from every MCP server they have connected, written into their AI work console, and ranked so they know what to do next.

## Operating rules (do these every time)

1. **Branch isolation is non-negotiable.** The work console must live on a dedicated git branch (default name: \`ai-work-console\`). Call the \`ensure_work_console_branch\` MCP tool FIRST. If the result's \`action\` is \`no_git_repo\`, surface that and continue without a branch guarantee. If it returns a dirty-worktree error, ask the user to commit, stash, or pass \`allow_switch_with_uncommitted: true\` — never silently lose their changes.

2. **The console is markdown files on disk.** All persistent state lives under \`.claude/personal/\` on the work-console branch. Read with \`read_console_file\`, write with \`write_console_file\`, browse with \`list_console_files\`. Don't invent paths; check what's already there before you write.

3. **Use whatever MCP servers the user has connected.** SlopWeaver does NOT provide tokens. Look at the list of available tools (Slack, GitHub, Linear, Gmail, Google Calendar, Notion, etc. — anything namespaced \`mcp__*__*\`) and call them directly. If a tool is missing, note it in the snapshot and move on. Never tell the user to install something.

## The flow

### Phase 0 — Branch + bootstrap check

Call \`ensure_work_console_branch\` then \`get_work_console_state\`. If \`initialized\` is false OR \`mode\` is \`bootstrap\`, run the fan-out-audit (see the \`fan-out-audit\` prompt for the deep-backfill spec) and then continue with the snapshot. Otherwise skip to Phase 1.

### Phase 1 — Freshness gate

Inventory which MCP servers are connected. For each, decide if its cached delta is stale (more than 30 minutes old by default; 60 minutes for ticket trackers like Linear / Jira). For every stale source, refresh in parallel (one Agent call per source if you need to delegate, otherwise inline parallel tool calls). The output of each refresh is a delta file under \`.claude/personal/state/\` (e.g. \`slack-delta.md\`, \`github-delta.md\`, \`linear-delta.md\`) — write these with \`write_console_file\`.

Each delta file follows the same shape (see existing files in the console or the example below):
- Header with ISO timestamp + scopes covered
- One section per bucket (e.g. **Needs response**, **Needs reply**, **Failed CI**, **Status changes**, **Recently merged**, **Context worth keeping**). Empty sections render \`_none_\` (don't omit the heading)
- Hyperlink every anchor: \`[PR #N](url)\`, \`[TICKET-N](url)\`, channel permalinks. Bare anchors are not allowed
- Use the user's actual identifiers (resolve their username / user ID via the relevant MCP server's identity tool on first run, then cache it in \`.claude/personal/contexts/identities.md\`)

If the user passed \`mode: skip-refresh\`, skip Phase 1 entirely and proceed with whatever's in the deltas already.

### Phase 2 — Reconciliation pass

Read the user's work files (under \`.claude/personal/work/\`). For each open item — typically a \`- [ ]\` checkbox or a bullet under "Active asks owed" — cross-reference against the freshly-written deltas. Classify into buckets:

- \`[propose-close]\` — looks done. Includes a prepared Key decision append (one line for the work file's \`## Key decisions\` section).
- \`[propose-update]\` — state shifted but not done.
- \`[state-mismatch]\` — two sources disagree (e.g. a PR merged but the linked ticket is still in progress). Needs manual review.
- \`[new-attention]\` — item exists in the work file AND in a delta with new signal. No edit; surface in snapshot.
- \`[inbox]\` — delta surfaced something the work file doesn't mention. Propose adding.

Write the bucketed result to \`.claude/personal/state/reconciliation.md\` (overwrite). Include a \`## Walk order (priority-ranked)\` section: order items by live-signal first (anything from the last 4 hours, anything tagged "production", anything in the user's \`## Current priorities (ranked, ...)\` list in \`.claude/personal/contexts/core-profile.md\`), then by theme match against the priorities list, then by recency.

### Phase 3 — Snapshot output

Render the snapshot to the chat (do NOT write to a file — the user reads this directly). Order:

1. **Reconciliation diff.** For each non-empty bucket: list items numbered, with hyperlinked anchors and the proposed action. Lead with \`[propose-close]\` and \`[propose-update]\` (most actionable).
2. **Apply confirmation block:**
   > Apply these to your work files?
   > - \`yes\` — apply all propose-close / propose-update / inbox entries.
   > - \`apply 1, 3, 5\` — subset.
   > - \`no\` — skip work-file edits this run.
3. **Recently done.** Items checked off in the last 7 days (read from work files).
4. **Outstanding next actions.** Open items in priority order.
5. **Needs response.** From slack-delta (or equivalent).
6. **Needs reply / failed CI / review requested.** From github-delta (or equivalent).
7. **Needs action / status changes.** From ticket tracker delta.
8. **Worktree state** — only if there's something notable (stale branch, branch with no PR, etc.).
9. **Anything notable in today's daily journal** (\`.claude/personal/daily/YYYY-MM/DD.md\`).
10. Close with: **"What are we working on this session?"**

## Voice rules (read .claude/personal/rules/communication-style.md if it exists)

Snapshots go straight to the user, so apply their voice rules. If no rules file exists yet, default to: no em-dashes, no exclamation marks, no bold-first-bullet labels, honest hedges over false confidence, plain English. The fan-out-audit captures the user's voice into \`.claude/personal/rules/communication-style.md\` on first run.

## Mode argument

- \`auto\` (default) — bootstrap if uninitialized; otherwise snapshot.
- \`bootstrap\` — force a full fan-out-audit before snapshot. Use after a long offline gap.
- \`snapshot-only\` — use whatever deltas exist on disk; don't refresh.
- \`skip-refresh\` — same as snapshot-only but produce a snapshot anyway, flagging stale sources.

## After the snapshot

If the user types \`yes\` (or a subset like \`apply 1, 3, 5\`), apply the reconciliation edits to the work files. Otherwise wait for direction. Suggest \`/lock-in\` as a natural follow-up to walk the queue.
`;

export function createSessionStartPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'session-start',
    title: 'SlopWeaver: start a session',
    description:
      'Fan out across every connected MCP server, refresh the AI work console, reconcile open items, and surface a ranked snapshot of what to do next.',
    argsSchema: SessionStartArgsSchema,
    handler: ({ args }) => {
      const mode = (args['mode'] as string | undefined) ?? 'auto';
      const text = `${SESSION_START_BODY}\n\n---\n\n**Invocation mode:** \`${mode}\``;
      return okAsync({
        description: 'SlopWeaver session-start orchestration prompt',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text },
          },
        ],
      });
    },
  });
}
