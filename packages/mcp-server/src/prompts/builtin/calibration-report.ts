/**
 * `calibration-report` prompt. Read-only diagnostic that shows how often
 * Claude's `/lock-in` proposals were accepted, edited, or rejected — the
 * substrate the user feeds back into `/style-rule` and `/style-edit`.
 *
 * Calls the `get_calibration_report` MCP tool, then formats the result as
 * a one-page snapshot. No file writes.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const CalibrationReportArgsSchema = z
  .object({
    since: z
      .string()
      .optional()
      .describe('ISO datetime cutoff. Lines older than this are excluded. Defaults to 30 days back.'),
  })
  .strict();

const CALIBRATION_REPORT_BODY = `# /calibration-report

Read the walk-feedback JSONL log and surface where Claude's \`/lock-in\`
proposals consistently miss. The user uses this to refine the rules
under \`.claude/personal/rules/\`.

## Steps

1. **Branch check.** Call \`ensure_work_console_branch\` first.

2. **Pull the aggregate.** Call \`get_calibration_report\` with the
   user-supplied \`since\` (or omit for the default 30-day window).

3. **Print the snapshot to chat.** Layout:

   \`\`\`
   /calibration-report — last <window>

   <total_walks> walks · <total_items> items

   Acceptance:  <approved>%  (approved-as-proposed)
   Edit rate:   <edited>%    (gist accepted, redirected)
   Rejection:   <rejected>%  (substantively different choice)
   Deferred:    <deferred>%
   Dropped:     <dropped>%
   Noted:       <noted>%

   Top friction tags:
   - friction:wrong-channel    × <n>
   - friction:wrong-tone       × <n>
   - friction:scope-too-big    × <n>
   ...
   \`\`\`

4. **Interpret one sentence.** If acceptance < 60%, suggest the user
   review \`rules/communication-style.md\` or \`rules/ai-tropes.md\`. If
   rejection > 20%, suggest the user run \`/style-edit\` on whichever
   rule the top friction tag points to. Be brief — one sentence, no
   essays. The user picks what to do.

5. **No file writes.** Calibration is read-only. The user uses
   \`/style-rule\` or \`/style-edit\` to actually amend behaviour.

## Voice notes

Apply \`.claude/personal/rules/communication-style.md\` to the
interpretive sentence. No em-dashes, no exclamation marks, honest
hedges.
`;

export function createCalibrationReportPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'calibration-report',
    title: 'SlopWeaver: show /lock-in calibration over a window',
    description:
      'Read the walk-feedback JSONL log via get_calibration_report and surface acceptance / edit / rejection rates plus top friction tags. Read-only.',
    argsSchema: CalibrationReportArgsSchema,
    handler: ({ args }) => {
      const since = args.since ?? '<default 30d window>';
      const text = `${CALIBRATION_REPORT_BODY}\n\n---\n\n**Window cutoff:** \`${since}\``;
      return okAsync({
        description: 'SlopWeaver calibration-report prompt',
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
