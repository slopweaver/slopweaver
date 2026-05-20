/**
 * `reconcile` prompt. Explicit reconciliation pass, decoupled from
 * `/session-start`. Use when the deltas have changed since the last
 * snapshot and you want to refresh the bucketed cross-reference without
 * re-fanning-out.
 */

import { okAsync } from '@slopweaver/errors';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const RECONCILE_BODY = `# /reconcile

Run a fresh reconciliation pass over the current work-file open items vs the current state deltas. Same logic as Phase 2 of \`/session-start\` but without the freshness gate or the snapshot — assume the deltas under \`.claude/personal/state/\` are good enough.

## Steps

1. **Branch check.** Call \`ensure_work_console_branch\`. Don't reconcile from a PR branch.

2. **Read inputs.**
   - All work files under \`.claude/personal/work/*.md\`. Pull \`- [ ]\` lines from \`## Programme state (open items only)\` and bullet lines from \`## Active asks owed (this week)\`.
   - All delta files under \`.claude/personal/state/*.md\` (e.g. \`slack-delta.md\`, \`github-delta.md\`, \`linear-delta.md\`).
   - If \`.claude/personal/contexts/core-profile.md\` has a \`## Current priorities (ranked, ...)\` section, hold it for the ranked walk-order step.

3. **Cross-reference per item.**

   For each work-file open item, extract anchors (PR \`#NNNN\`, ticket \`PLT-N\`-style, branch names, free-form keywords) and look them up in the deltas. Classify into:

   - \`[propose-close]\` — found in a "Recently merged" / "Status: Done" delta entry. Prepare the \`## Key decisions\` append text.
   - \`[propose-update]\` — state shifted but not done.
   - \`[state-mismatch]\` — two signals disagree (PR merged but linked ticket still in progress, or PR open but ticket Done).
   - \`[new-attention]\` — item is in the work file AND in a delta with new signal. No edit; just surface.

4. **Inbox sweep.** Scan deltas for items the work file doesn't mention:
   - PRs in "Needs reply" not anchored anywhere → propose adding.
   - Tickets in "Needs action" or "New assigned" → propose adding.
   - Slack threads in "Needs response" not matched to a work-file line → propose adding.

5. **Worktree hygiene.** If git worktrees exist, surface:
   - \`[worktree-prunable]\`: branch with a merged PR.
   - \`[worktree-stale]\`: branch with last commit >14 days ago.

6. **Walk order (priority-ranked).** Read \`## Current priorities\` from \`core-profile.md\`. For each actionable item, assign:
   - **Rank 0 (LIVE)**: anything with \`LIVE\` / \`ACTIVE\` / \`production\` in the item, or a slack thread within the last 4 hours, or a \`[state-mismatch]\` naming production.
   - **Theme rank**: match anchor or keywords against each ranked priority's theme keywords. First match wins.
   - **Unranked (99)**: items with no clear priority match.

7. **Write \`.claude/personal/state/reconciliation.md\`** with the buckets, then the \`## Walk order (priority-ranked)\` section.

8. **Apply prompt.** End the chat output with:
   > Apply these to your work files? \`yes\` / \`apply 1, 3, 5\` / \`no\`.

## Hyperlinks

Every anchor in \`reconciliation.md\` is clickable. Bare anchors are not allowed.

## On apply

If the user says \`yes\` (or a subset), apply the edits via \`write_console_file\`:

- \`[propose-close]\`: change \`- [ ]\` to \`- [x]\` on the matching line. Append the prepared Key decision under \`## Key decisions\`.
- \`[propose-update]\`: rewrite the line with the new text.
- \`[state-mismatch]\`: same as propose-close, plus surface a "consider also moving the linked ticket" reminder (don't auto-write to ticket tools).
- \`[inbox]\`: append the new \`- [ ]\` line under the right section.

Never auto-apply \`[worktree-prunable]\` or \`[worktree-stale]\` — they need explicit \`git worktree remove\`.

Skip \`[new-attention]\` from the apply batch — those are just surfacing.
`;

export function createReconcilePrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'reconcile',
    title: 'SlopWeaver: cross-reference work files against deltas',
    description:
      'Run a fresh reconciliation pass: classify each work-file open item against the latest deltas, build the ranked walk order, write reconciliation.md.',
    handler: () => {
      return okAsync({
        description: 'SlopWeaver reconcile prompt',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: RECONCILE_BODY },
          },
        ],
      });
    },
  });
}
