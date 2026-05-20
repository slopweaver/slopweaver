/**
 * `correct` prompt. The user just pushed back on something Claude did
 * or said. Capture the correction, classify it, and update the right
 * rules / context files so the same failure doesn't recur.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const CorrectArgsSchema = z
  .object({
    correction: z
      .string()
      .min(1)
      .describe('What the user said. Verbatim. E.g. "stop section-heading every Slack reply, just write the message".'),
  })
  .strict();

const CORRECT_BODY = `# /correct

The user just pushed back. Take the correction seriously: it's high-signal training data. Capture it, classify it, and update the right files so the same failure doesn't recur.

## Steps

1. **Branch check.** Call \`ensure_work_console_branch\`.

2. **Acknowledge in one line, no defense.** Format: \`Got it: <one-line restatement>.\`. No "I'll do better next time", no apology essay, no explanation of what you were trying to do. The user wants the behaviour fixed, not a justification.

3. **Classify the correction.** One of:
   - **Voice / style failure** — output sounded off. Update \`rules/communication-style.md\` (or the relevant rules file). If a rule already covers this, strengthen it; if not, add a new one. If the failure is a known AI tell, append to \`rules/ai-tropes.md\`.
   - **Workflow violation** — used the wrong command, edited the wrong branch, sent a message instead of drafting, etc. Update \`rules/development-workflow.md\` or \`rules/autonomy-ladder.md\`.
   - **Context error** — got a fact wrong about a person, a programme, or a stakeholder preference. Update \`contexts/team-directory.md\`, \`contexts/stakeholder-prefs.md\`, or \`contexts/core-profile.md\`.
   - **Proposal mistake** — proposed the wrong action during a \`/lock-in\` walk. The JSONL log already captured this with \`outcome: edited\` or \`rejected\`. Surface the \`friction:\` tag.

4. **Apply the rule update.**
   - For voice / workflow corrections: invoke the same logic as \`/style-rule\` but skip the acknowledgement step (already done in step 2).
   - For context errors: update the right \`contexts/*.md\` file directly via \`write_console_file\`.

5. **Log a calibration breadcrumb.** If the current session is mid-\`/lock-in\` walk, append a \`log_walk_feedback\` line with \`outcome: rejected\` (or \`edited\`) and a \`friction:<short-tag>\` in \`tags\`. If not, write a one-line entry to \`.claude/personal/state/corrections.jsonl\` (create the file if missing) with shape:

   \`\`\`
   {"ts":"<ISO>","correction":"<verbatim user text>","category":"<one of the four above>","applied_to":["<file path>", ...]}
   \`\`\`

6. **Don't escalate scope.** A correction about voice is not a license to overhaul the system prompt. A correction about workflow is not a license to rewrite \`development-workflow.md\` from scratch. Touch the minimum surface that fixes the recurrence.

## Don'ts

- **Don't apologize.** Acknowledgement is a one-liner restatement.
- **Don't explain why you did the thing the user is correcting.** They saw the output; they know.
- **Don't ask "got it?" or "is that right?"** Capture, apply, move on.
- **Don't promise to remember.** The capture IS the remembering. Filesystem > assurances.
`;

export function createCorrectPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'correct',
    title: 'SlopWeaver: capture a correction',
    description:
      'Capture a user pushback as high-signal training data: classify it, update the right rules / context file, log a calibration breadcrumb. No apology essays.',
    argsSchema: CorrectArgsSchema,
    handler: ({ args }) => {
      const correction = (args['correction'] as string | undefined) ?? '<no correction provided>';
      const text = `${CORRECT_BODY}\n\n---\n\n**User correction (verbatim):**\n\n> ${correction}`;
      return okAsync({
        description: 'SlopWeaver correction-capture prompt',
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
