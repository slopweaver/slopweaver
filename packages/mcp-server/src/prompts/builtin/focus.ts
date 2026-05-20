/**
 * `focus` prompt. Sets the scope for the current session — what the user
 * is willing to be interrupted by and what they want filtered out.
 *
 * Writes the focus state to \`.claude/personal/state/focus.md\` so
 * subsequent \`/session-start\` snapshots and \`/lock-in\` walks can read
 * it and filter accordingly.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const FocusArgsSchema = z
  .object({
    scope: z
      .string()
      .min(1)
      .describe(
        'What the user wants to focus on in this session. Free-form. E.g. "PR review only, ignore Slack" or "PMS event-loop deep dive".',
      ),
    duration_minutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional time-box. After this many minutes, the focus state is treated as stale and dropped from snapshot filtering.',
      ),
  })
  .strict();

const FOCUS_BODY = `# /focus

Set the focus scope for this session. Subsequent \`/session-start\`
snapshots and \`/lock-in\` walks should filter to items that match this
scope and de-prioritize everything else.

## Steps

1. **Branch check.** \`ensure_work_console_branch\` first.

2. **Write the focus state.** Use \`write_console_file\` on
   \`state/focus.md\` with this shape:

   \`\`\`markdown
   # Focus — <ISO timestamp>

   **Scope:** <scope text verbatim>
   **Expires:** <ISO timestamp of now + duration_minutes>  (or "no expiry")
   **Set by:** /focus on <date>

   ## What this means

   - \`/session-start\` snapshots elevate items matching this scope; everything else is folded into a single "Other" line at the bottom.
   - \`/lock-in\` skips items that don't match unless the user explicitly walks them with \`jump N\`.
   - \`/reconcile\` still classifies everything; the filter is applied at the snapshot / walk layer, not the data layer.
   \`\`\`

3. **One-line acknowledgement.**
   \`Focus set: <scope>. Active until <expiry or session end>.\`

## How other prompts read this

When \`/session-start\` runs, it should:
- Call \`read_console_file\` on \`state/focus.md\` first.
- If present and not expired, derive a keyword set from the scope line
  (case-insensitive token match).
- Filter the ranked snapshot: items whose anchors or descriptions match
  any keyword stay in the main sections; others get summarized in a
  collapsed "Other (filtered by /focus)" tail.

When \`/lock-in\` runs, it should:
- Read \`state/focus.md\`.
- Skip items that don't match the focus keywords during the per-item
  walk, but list them in the closing summary as "skipped by /focus".

## Cancelling focus

Type \`/focus all\` or \`/focus off\` to clear: this prompt deletes
\`state/focus.md\` (via \`write_console_file\` with empty content + a
note that focus was cleared) and acknowledges in one line.

## Don'ts

- Don't paraphrase the scope. Verbatim.
- Don't filter at the reconcile layer. Keep the data complete; only
  filter the presentation.
`;

export function createFocusPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'focus',
    title: 'SlopWeaver: set the focus scope for this session',
    description:
      'Set a session-scoped focus filter so /session-start and /lock-in elevate matching items and de-prioritize the rest. Writes state/focus.md.',
    argsSchema: FocusArgsSchema,
    handler: ({ args }) => {
      // `scope` is non-optional per the schema; `duration_minutes` is optional.
      const scope = args.scope;
      const durationMinutes = args.duration_minutes;
      const durationLabel = durationMinutes != null ? `${durationMinutes} minutes` : 'no expiry';
      const text = `${FOCUS_BODY}\n\n---\n\n**Scope (verbatim):**\n\n> ${scope}\n\n**Duration:** \`${durationLabel}\``;
      return okAsync({
        description: 'SlopWeaver focus-mode prompt',
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
