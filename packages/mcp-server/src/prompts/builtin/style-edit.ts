/**
 * `style-edit` prompt. Refine, rephrase, or remove a rule already in
 * `.claude/personal/rules/`. Used when the user wants to amend an
 * existing rule rather than capture a new one.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const StyleEditArgsSchema = z
  .object({
    edit: z
      .string()
      .min(1)
      .describe(
        'What to change about an existing rule. E.g. "the em-dash rule should also cover en-dashes" or "drop the no-bold-bullets rule, I\'ve changed my mind".',
      ),
  })
  .strict();

const STYLE_EDIT_BODY = `# /style-edit

Amend an existing rule in \`.claude/personal/rules/\`. Same family as \`/style-rule\`, but for refinement / removal / clarification instead of capture.

## Steps

1. **Branch check.** Call \`ensure_work_console_branch\`.

2. **Find the rule.**
   - Search every file under \`.claude/personal/rules/\` for the rule the user is editing. Use the keywords in the edit string.
   - If multiple candidates surface, list them numbered and ask which one. Don't guess; rules are too high-signal to silently rewrite the wrong one.

3. **Apply the edit.**
   - **Rephrase**: replace the matching bullet text with the user's new phrasing. Use their exact words.
   - **Remove**: strikethrough the bullet (\`~~old text~~\`) and add an inline note \`removed <YYYY-MM-DD>\`. Don't delete; the history of rule churn is useful signal.
   - **Add a constraint**: append a child bullet under the existing rule (\`  - <new constraint>\`).
   - **Generalize**: rewrite the parent bullet, keep the original as a child example.

4. **Write back atomically** via \`write_console_file\`.

5. **Acknowledge in one line.** Format: \`Edited: <one-line summary of what changed>. Applied from now.\`. If a rule was removed, say \`Removed: <rule>. No longer applied.\`.

6. **Update \`ai-tropes.md\`** if relevant. If the edit was triggered by a recent failure mode (e.g. "you keep using em-dashes — strengthen the rule"), append a one-liner to \`rules/ai-tropes.md\` noting the failure pattern.

## Don'ts

- Don't paraphrase the user's amended phrasing.
- Don't bundle multiple edits into one call; each \`/style-edit\` is one rule change.
- Don't delete rule history; strikethrough + dated note.
- Don't ask "are you sure?" before applying. The user asked; they're sure. They can run \`/style-edit\` again to revert.
`;

export function createStyleEditPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'style-edit',
    title: 'SlopWeaver: amend an existing rule',
    description:
      'Refine, rephrase, or remove a rule already captured in .claude/personal/rules/. Same family as /style-rule but for edits, not new entries.',
    argsSchema: StyleEditArgsSchema,
    handler: ({ args }) => {
      const edit = (args['edit'] as string | undefined) ?? '<no edit provided>';
      const text = `${STYLE_EDIT_BODY}\n\n---\n\n**Edit to apply (verbatim):**\n\n> ${edit}`;
      return okAsync({
        description: 'SlopWeaver style-edit prompt',
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
