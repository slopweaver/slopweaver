/**
 * `lock-in` prompt. Push-style execution loop. After `/session-start`
 * surfaces the ranked queue, `/lock-in` walks it one item at a time,
 * proposes a concrete next action per item, and waits for the user to
 * pick a verb (`do | agent | handoff | defer | skip | note |
 * open-question | jump`).
 *
 * Every per-item resolution emits one line into the walk-feedback JSONL
 * via the `log_walk_feedback` MCP tool — silent training substrate for
 * `/calibration-report`.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const LockInArgsSchema = z
  .object({
    from: z
      .enum(['reconciliation', 'work-file', 'both'])
      .optional()
      .describe('Restrict the walk source. Default: both.'),
    dry_run: z.boolean().optional().describe('Show the queue + proposed actions but execute nothing.'),
  })
  .strict();

const LOCK_IN_BODY = `# /lock-in

Switch into guided execution mode. Walk the user through every open item from the most recent \`/session-start\` reconciliation, one item at a time. Propose a concrete next action for each and wait for them to choose.

The whole point is to flip the usual snapshot dynamic — Claude pulls and user picks — into a push dynamic: Claude drives the cadence, user just approves, redirects, or hands off.

## Inputs (do not refresh)

\`/lock-in\` is execution, not refresh. Trust whatever the most recent \`/session-start\` produced. If the deltas look stale, say so in your opening line and let the user decide whether to bail and re-run \`/session-start\`.

Read in this order:

1. \`.claude/personal/state/reconciliation.md\`. Pull entries from \`[propose-close]\`, \`[propose-update]\`, \`[state-mismatch]\`, \`[new-attention]\`, \`[inbox]\`. Skip \`[worktree-prunable]\` / \`[worktree-stale]\` unless the user asks.
2. \`.claude/personal/work/*.md\`. Pull \`## Programme state (open items only)\` \`- [ ]\` lines and \`## Active asks owed (this week)\` bullets.

## Build the queue

Preferred path: if \`reconciliation.md\` has a \`## Walk order (priority-ranked)\` section, use it verbatim. It already has live-signal overrides + theme-priority ranking applied.

Fallback: build the queue as: reconciliation \`[propose-close]\` → \`[propose-update]\` → \`[state-mismatch]\` → \`[inbox]\` → \`[new-attention]\` → work-file \`Active asks\` → work-file \`Programme state\` open items. Dedupe by anchor (reconciliation entries win over work-file duplicates).

Number the queue. Tell the user at the top:

> Walking N items. Reply with \`do\`, \`agent\`, \`handoff\`, \`defer\`, \`skip\`, \`note <text>\`, \`open-question <text>\`, or \`jump N\`. \`stop\` ends the walk.

If the ranked path was used, mention that item 1 is the live priority.

## Per-item turn

For each item, in order:

1. **State the item** in 1-2 sentences. Lead with the hyperlinked anchor + a one-line description. Include the source bucket in brackets (e.g. \`[reconciliation/inbox]\`, \`[work-file/active-asks]\`).

2. **Hyperlink every anchor.** Hard requirement. Bare \`#NNNN\`, \`PLT-N\`, or Slack timestamps are not allowed. Use:
   - GitHub PR: \`[#N](https://github.com/<owner>/<repo>/pull/N)\`
   - Ticket: \`[TICKET-N](<ticket-tool-url>)\`
   - Slack thread: \`[<channel-name>](<slack-permalink-with-p-prefix-no-dot>)\`
   - File: \`[\\\`path/to/file.ts:42\\\`](<repo-blob-url>#L42)\` — use the user's main-branch ref (e.g. \`staging\` or \`main\`), not a SHA
   If a permalink isn't reconstructable, say so plainly ("no PR yet, worktree-only") instead of inventing.

3. **Propose the concrete next action** in one sentence. Be specific. Not "look into TICKET-441". Specific is "reply to <person>'s thread on \`wf-deploy.yaml\` line 106 confirming the nitpick, then nudge for the overall review." If the item is a \`[propose-close]\`, plainly say "PR merged at <time>. Want me to spot-check the deploy?".

4. **Menu** (one line at the end):
   \`→ do | agent | handoff | defer | skip | note | open-question | jump N\`

5. **Wait.** Don't volunteer further analysis until they choose.

6. **After resolution, log silently** via \`log_walk_feedback\` (see schema below). Don't tell the user.

## Action handlers

- **\`do\`**: Execute the proposed action in this conversation. Edit files, draft a Slack reply (to disk under \`.claude/personal/drafts/\` — never send), open a ticket, whatever was proposed. Announce the result in one sentence and move on. If \`do\` would take more than ~5 min, ask whether to \`agent\` or \`handoff\` instead.

- **\`agent\`**: Delegate via the \`Agent\` tool. Pick \`subagent_type\` by shape (Explore for lookups, general-purpose for action-taking, Plan for design-first). Brief the agent like a colleague (paths, line numbers, what's already known). Run in background unless the result blocks the next item. Announce \`Agent launched\` and move on.

- **\`handoff\`**: Write a self-contained prompt to \`.claude/personal/handoffs/<anchor-slug>.md\` for the user to paste into a separate Claude Code chat. The prompt must be pickup-cold ready (state of play, what's known, "done" criteria, rules, what to stay out of). Announce \`Handoff written: <path>\` and move on.

- **\`defer\`**: No-op. "deferred" in walk state. Move on.

- **\`skip\`**: Same as defer but don't mention in closing summary.

- **\`note <text>\`**: Append the note to the matching work-file or reconciliation line via \`write_console_file\`. Move on.

- **\`open-question <text>\`**: Stop the walk for this item, answer/investigate, then re-propose. Walk doesn't advance until they pick a non-\`open-question\` verb.

If the reply isn't one of these verbs, interpret it as a natural-language instruction for the current item (treat as \`do\` with the embedded instruction). Don't pedantically force the menu.

## Feedback logging (silent)

After each item resolution, call \`log_walk_feedback\` once with:

\`\`\`
{
  "walk_id": "walk_<YYYY-MM-DD>_<HHMM>",
  "item_index": <1-based>,
  "item_anchor": "<PR# or TICKET-N or short slug>",
  "item_source": "reconciliation/inbox" | "work-file/active-asks" | etc.,
  "item_summary": "<one-line statement>",
  "proposed_action": "<verbatim one-sentence proposal>",
  "user_action": "do" | "agent" | "handoff" | "defer" | "skip" | "note" | "natural-language",
  "outcome": "approved-as-proposed" | "edited" | "rejected" | "deferred" | "dropped" | "noted",
  "user_text": "<literal text if note/natural-language, else null>",
  "edit_diff": "<short prose if outcome=edited, else null>",
  "tags": ["audience:...", "type:...", "stakeholder:...", "theme:...", "friction:..."]
}
\`\`\`

Generate \`walk_id\` once at the top of the walk and reuse for every item. \`outcome\` classifications:

- \`approved-as-proposed\` — user said \`do\` / \`agent\` / \`handoff\` and the executed action matched the proposal.
- \`edited\` — user accepted the gist but redirected. Capture the redirect in \`edit_diff\`.
- \`rejected\` — user chose something substantively different.
- \`deferred\` / \`dropped\` / \`noted\` — straight from the verb.

## Stop

End the walk when the user types \`stop\` / \`pause\` / \`enough\`, or when the queue empties, or when an action explodes scope. On stop, produce a closing summary:

\`\`\`
/lock-in walk: N items processed (X done, Y agent-launched, Z handed off, W deferred, V noted).

Still open:
- <hyperlinked anchor + one line each>

Background agents:
- <agent id> — <description>

Handoffs written:
- <path> — <description>
\`\`\`

Then append one final \`log_walk_feedback\` line with \`item_index: 0\`, \`outcome: "walk-summary"\`, and the \`totals\` object filled in. Silent.

## Don'ts

- Don't refresh deltas mid-walk.
- Don't batch. One item at a time.
- Don't propose generic actions. "Look at X" is not an action.
- Don't keep working after \`stop\`.
- Don't drop hyperlinks. Every anchor gets a URL.
`;

export function createLockInPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'lock-in',
    title: 'SlopWeaver: walk the queue one item at a time',
    description:
      'Push-style execution mode. Walk the ranked queue from the most recent /session-start, propose an action per item, wait for the user to pick a verb.',
    argsSchema: LockInArgsSchema,
    handler: ({ args }) => {
      const from = (args['from'] as string | undefined) ?? 'both';
      const dryRun = args['dry_run'] === true;
      const text = `${LOCK_IN_BODY}\n\n---\n\n**Walk source:** \`${from}\` · **Dry run:** \`${dryRun}\``;
      return okAsync({
        description: 'SlopWeaver lock-in walker prompt',
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
