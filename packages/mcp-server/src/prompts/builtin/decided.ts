/**
 * `decided` prompt. Captures a decision the user just made into the
 * matching work file's \`## Key decisions\` section. Mirrors the ev-admin
 * pattern of appending dated decision lines so the log builds up.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const DecidedArgsSchema = z
  .object({
    decision: z
      .string()
      .min(1)
      .describe(
        'The decision in the user\'s own phrasing. Verbatim. E.g. "going with SQLite-backed reconciliation cache, not file-system".',
      ),
    work_file: z
      .string()
      .optional()
      .describe(
        'Relative path under .claude/personal/work/ (without extension). If omitted, the prompt picks the most-recently-modified work file.',
      ),
  })
  .strict();

const DECIDED_BODY = `# /decided

Append a dated entry to the matching work file's
\`## Key decisions (YYYY-MM-DD onward)\` section. The user just made
a call; you record it.

## Steps

1. **Branch check.** \`ensure_work_console_branch\` first.

2. **Pick the work file.**
   - If the user supplied \`work_file\`, use \`<that>.md\` under
     \`.claude/personal/work/\`.
   - Otherwise: list \`.claude/personal/work/\` via \`list_console_files\`,
     pick the most recently modified \`.md\` file.
   - If no work files exist, surface that plainly and stop. Suggest
     \`/fan-out-audit\` if it looks like the console isn't initialized.

3. **Find or create the section.** Read the chosen file via
   \`read_console_file\`. Locate \`## Key decisions\`. If absent, append
   one at the bottom with a header like
   \`## Key decisions (YYYY-MM onward)\`.

4. **Append the entry.** One line, this exact shape:
   \`- **YYYY-MM-DD:** <decision text verbatim>\`. Use today's date.
   Don't paraphrase. Don't expand. The decision says what it says.

5. **Write back atomically** via \`write_console_file\`.

6. **One-line acknowledgement.**
   \`Recorded under work/<file>.md: <decision>.\`

## Voice notes

The acknowledgement gets the same voice rules as everything else — no
em-dashes, no exclamation marks. Two short sentences max.

## Don'ts

- Don't decorate the decision text. The user said it; capture it.
- Don't ask follow-up questions about whether they're sure.
- Don't update other sections of the work file unless the user
  explicitly says so. \`/decided\` is one-purpose: append a decision.
`;

export function createDecidedPrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'decided',
    title: 'SlopWeaver: capture a decision into a work file',
    description:
      "Append a dated entry to the matching work file's `## Key decisions` section. Verbatim. No paraphrasing.",
    argsSchema: DecidedArgsSchema,
    handler: ({ args }) => {
      // `decision` is non-optional per the schema; `work_file` is optional.
      const decision = args.decision;
      const workFile = args.work_file ?? '<auto-detect: most-recently-modified>';
      const text = `${DECIDED_BODY}\n\n---\n\n**Decision (verbatim):**\n\n> ${decision}\n\n**Target work file:** \`${workFile}\``;
      return okAsync({
        description: 'SlopWeaver decided prompt',
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
