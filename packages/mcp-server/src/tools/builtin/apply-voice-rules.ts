/**
 * `apply_voice_rules` MCP tool. The deterministic last-mile pass between
 * a generated draft and the outgoing surface (chat preview, `/draft`,
 * or eventually `send_via_source` per #59).
 *
 * Reads the rules markdown from the caller, parses it, runs the rewrite,
 * returns the rewritten string plus the edit log. Pure-ish — no fs
 * touches; the caller supplies the rules-file contents.
 *
 * Failure modes: if the rules markdown has an unparseable directive,
 * the tool returns `MCP_TOOL_UNEXPECTED` with the parse error message.
 * Callers can choose to fall back to the un-rewritten draft.
 */

import { ApplyVoiceRulesArgs, ApplyVoiceRulesResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { applyVoiceRules, parseVoiceRules } from '@slopweaver/voice-rules';
import { McpErrors } from '../../errors.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateApplyVoiceRulesToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export function createApplyVoiceRulesTool(args: CreateApplyVoiceRulesToolArgs = {}): Tool {
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'apply_voice_rules',
    description:
      'Deterministic voice-rule post-processor. Parses the rules markdown, applies every rule to the draft in source order, returns the rewritten draft + an edit log. Pure function — no I/O. Use this last-mile before showing a draft to the user or sending one via /lock-in.',
    inputSchema: ApplyVoiceRulesArgs,
    outputSchema: ApplyVoiceRulesResult,
    handler: async ({ input }) => {
      const parsed = parseVoiceRules(input.rules_markdown);
      if (parsed.isErr()) {
        return err(McpErrors.unexpected('apply_voice_rules', undefined, parsed.error.message));
      }
      const { rewritten, edits } = applyVoiceRules(input.draft, parsed.value);
      return ok({
        rewritten,
        edits: edits.map((edit) => ({
          rule_line: edit.ruleLine,
          kind: edit.kind,
          description: edit.description,
          count: edit.count,
        })),
        generated_at: new Date(now()).toISOString(),
      });
    },
  });
}
