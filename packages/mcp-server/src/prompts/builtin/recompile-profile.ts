/**
 * `recompile-profile` prompt. Refresh \`.claude/personal/contexts/core-profile.md\`
 * from the latest signal across all MCP servers. Same idea as
 * \`/fan-out-audit\` but scoped to JUST the profile — used when ranked
 * priorities, open loops, or stakeholder list has drifted.
 */

import { okAsync } from '@slopweaver/errors';
import { z } from 'zod';
import { defineMcpPrompt, type McpPrompt } from '../registry.ts';

const RecompileProfileArgsSchema = z
  .object({
    trigger: z
      .string()
      .optional()
      .describe(
        'One-line note about why the recompile was triggered (e.g. "after PR merge", "new sprint"). Goes into the frontmatter.',
      ),
  })
  .strict();

const RECOMPILE_PROFILE_BODY = `# /recompile-profile

Rebuild \`.claude/personal/contexts/core-profile.md\` from the latest
signal across every connected MCP server. Same shape as the \`Identity\`,
\`Current priorities (ranked, YYYY-MM-DD)\`, \`Voice\`, \`Open loops\`
sections the original profile had. **Preserve the user's edits in
sections you don't touch.**

## When to invoke

- After a sprint or cycle boundary (priorities shift).
- After a job transition or new programme assignment.
- When the user notices the snapshot is repeatedly off (acceptance rate
  dropping in \`/calibration-report\`).
- Whenever the user explicitly types \`/recompile-profile\`.

## Steps

1. **Branch check.** \`ensure_work_console_branch\` first.

2. **Read the existing profile.** Use \`read_console_file\` on
   \`contexts/core-profile.md\`. Keep a copy in memory; you'll merge
   conservatively rather than overwrite wholesale.

3. **Re-derive each section in parallel:**
   - **Identity**: cross-check identities cached in
     \`contexts/identities.md\` against fresh \`auth.test\` / current-user
     queries on every connected MCP server. Update only if something
     changed (new platform connected, new username).
   - **Current priorities (ranked, YYYY-MM-DD)**: scan recent activity
     across the user's priority channels / cycle tickets / focus blocks
     in the last 14 days. Reorder accordingly. Use today's date in the
     section header.
   - **Voice**: re-read 50+ of the user's own recent messages. If the
     dominant patterns shifted, note the deltas inline (e.g. "previously
     casual swearing; recent messages avoid it"). DON'T rewrite voice
     from scratch — the user's \`/style-rule\` history in
     \`rules/communication-style.md\` is the source of truth.
   - **Open loops**: cross-reference the user's work files
     (\`work/*.md\`) and recent platform deltas. Surface only items that
     are still open. Date the section: "active YYYY-MM-DD".

4. **Diff before write.** Show the user a section-by-section diff in
   the chat — what's being added, removed, reordered. Wait for \`yes\`
   before the write.

5. **Write the new profile** via \`write_console_file\`. Update the
   frontmatter \`recompiledAt: YYYY-MM-DD\` and \`recompileTrigger:\`
   (use the \`trigger\` argument if supplied; otherwise "manual").

6. **One-line acknowledgement.** Format:
   \`Recompiled core-profile.md. <N> sections changed.\` Don't editorialize.

## Don'ts

- Don't wholesale rewrite. Diff and apply.
- Don't fabricate priorities the deltas can't support.
- Don't touch sections outside the four named above. The user's
  edits to "Workflow rules" / "Where things live" / similar are sacred.
`;

export function createRecompileProfilePrompt(): McpPrompt {
  return defineMcpPrompt({
    name: 'recompile-profile',
    title: 'SlopWeaver: refresh core-profile.md from latest signal',
    description:
      'Rebuild the four derived sections of contexts/core-profile.md (identity, ranked priorities, voice deltas, open loops) from fresh signal across every connected MCP server. Conservative diff-and-apply, never wholesale rewrite.',
    argsSchema: RecompileProfileArgsSchema,
    handler: ({ args }) => {
      const trigger = args.trigger ?? 'manual';
      const text = `${RECOMPILE_PROFILE_BODY}\n\n---\n\n**Recompile trigger:** \`${trigger}\``;
      return okAsync({
        description: 'SlopWeaver recompile-profile prompt',
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
