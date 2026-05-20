/**
 * `style-rule` prompt. Capture a voice / style / workflow rule the user
 * just gave you and append it to the matching rules file. Driven by
 * conversational triggers like "rule: never use em-dashes" or "style
 * rule: PR descriptions get four sections".
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const StyleRuleArgsSchema = z
  .object({
    rule: z
      .string()
      .min(1)
      .describe(
        'The rule to capture, in the user\'s own phrasing. Don\'t paraphrase. E.g. "never use em-dashes — write two sentences or a comma instead".',
      ),
    category: z
      .enum([
        'communication-style',
        'development-workflow',
        'pr-descriptions',
        'pr-review-responses',
        'decision-making',
        'autonomy-ladder',
        'ai-tropes',
        'file-shape',
      ])
      .optional()
      .describe('Target rules file. Defaults to communication-style.'),
  })
  .strict();

const STYLE_RULE_BODY = `# /style-rule

Capture a new voice / style / workflow rule the user just stated. Apply it from this moment forward across every subsequent message and append it to the matching file under \`.claude/personal/rules/\`.

## Steps

1. **Branch check.** Call \`ensure_work_console_branch\`.

2. **Pick the file.** Use the \`category\` argument if provided; otherwise infer:
   - "no em-dashes / no exclamation marks / lowercase opener / cadence" → \`rules/communication-style.md\`
   - "rebase / one commit per PR / feature branch / squash" → \`rules/development-workflow.md\`
   - "PR description format / 4 sections / file-first body" → \`rules/pr-descriptions.md\`
   - "review responses / batch via snapshot" → \`rules/pr-review-responses.md\`
   - "WAP / discovery first / numbered options" → \`rules/decision-making.md\`
   - "stage / escalate / auto" → \`rules/autonomy-ladder.md\`
   - "delve / notably / it's worth noting" → \`rules/ai-tropes.md\`
   - "file shape / 200-line ceiling" → \`rules/file-shape.md\`
   - Anything else → \`rules/communication-style.md\` with a sub-heading.

3. **Read the existing file.** Use \`read_console_file\`. If missing, create with a minimal frontmatter header.

4. **Append the rule.** Use the user's exact phrasing. Wrap in a one-line bullet under the most relevant existing sub-heading; create a new sub-heading if no existing one fits.

5. **Write back atomically** via \`write_console_file\`.

6. **Acknowledge in one line.** Format: \`Captured: <rule>. Applied from now.\`. No exclamation marks, no enthusiasm. The acknowledgement is the proof you registered it.

7. **Don't paraphrase.** If the user said "no em-dashes, ever", that's the rule. Don't expand it to "use commas or two sentences instead". The rule says what it says.

8. **Don't ask follow-up questions.** If the rule is ambiguous, capture it as stated and trust the user to refine via \`/style-edit\` later.

## Edge cases

- **Rule contradicts an existing one** in the file: write both, mark the older with a \`~~strikethrough~~\` and a one-line note that it was superseded on \`<date>\`. Surface this in your acknowledgement: "Captured. Superseded the earlier rule about <X>."

- **Rule is really a correction of something I just did**: also write a corresponding line into \`rules/ai-tropes.md\` describing the failure mode (e.g. "I used em-dashes in 3/5 paragraphs of the snapshot just now"). The user's \`/correct\` flow handles this more thoroughly; this is the lightweight version.

- **Rule is workflow-specific** (e.g. "DD monitors never use warning thresholds"): drop it in \`rules/development-workflow.md\` with a category sub-heading like \`## Monitoring\`.
`;

export function createStyleRulePrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'style-rule',
    title: 'SlopWeaver: capture a voice / style / workflow rule',
    description:
      "Capture a rule the user just stated, append it to the matching .claude/personal/rules/ file, apply it from now on. Don't paraphrase; use the user's exact phrasing.",
    argsSchema: StyleRuleArgsSchema,
    handler: ({ args }) => {
      const rule = (args['rule'] as string | undefined) ?? '<no rule provided>';
      const category = (args['category'] as string | undefined) ?? 'communication-style';
      const text = `${STYLE_RULE_BODY}\n\n---\n\n**Rule to capture (verbatim):**\n\n> ${rule}\n\n**Target category:** \`${category}\``;
      return okAsync({
        description: 'SlopWeaver style-rule capture prompt',
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
