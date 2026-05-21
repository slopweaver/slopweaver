/**
 * `start_draft` MCP tool. Returns the instructional body the model
 * follows to draft a reply to the referenced thread, plus a
 * slugified suggested path under `drafts/`.
 *
 * Tool-only design (mirroring `start_mega_audit`) so the PR is
 * independent of #54 / the prompt registry. A thin `/draft` slash
 * command shim lands once #54 merges.
 */

import { StartDraftArgs, StartDraftResult } from '@slopweaver/contracts';
import { ok } from '@slopweaver/errors';
import { defineTool, type Tool } from '../../registry.ts';
import { DRAFT_INSTRUCTIONS } from './instructions.ts';

export type CreateStartDraftToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** ID generator for tests. Defaults to a date + shortid. */
  generateDraftId?: (nowMs: number) => string;
};

export function createStartDraftTool(args: CreateStartDraftToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const generateDraftId = args.generateDraftId ?? defaultGenerator;

  return defineTool({
    name: 'start_draft',
    description:
      'Returns the instructional body for drafting a reply to a thread/PR/ticket/email. The model fetches the source thread via whichever MCP server hosts it, pulls stakeholder history via `recall` (if available), applies voice rules via `apply_voice_rules`, saves to .claude/personal/drafts/, and prints the draft to chat. Never sends — `send_via_source` (PR #59) closes that loop.',
    inputSchema: StartDraftArgs,
    outputSchema: StartDraftResult,
    handler: async ({ input }) => {
      const nowMs = now();
      const draftId = generateDraftId(nowMs);
      // Include `draft_id` so calling `/draft` twice for the same thread
      // doesn't overwrite the first draft. The slug stays as the
      // human-readable anchor; the id is the uniqueness guarantee.
      const suggestedPath = `drafts/${slugifyAnchor(input.thread_ref)}-${draftId}.md`;
      return ok({
        draft_id: draftId,
        suggested_path: suggestedPath,
        instructions: DRAFT_INSTRUCTIONS,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}

/**
 * Lowercase, replace non-alphanumeric runs with hyphens, trim leading
 * and trailing hyphens. Same conventions as `register_handoff` (PR #54)
 * so reviewers don't have to remember two slug schemes.
 */
export function slugifyAnchor(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

function defaultGenerator(nowMs: number): string {
  const datePart = new Date(nowMs).toISOString().slice(0, 10).replaceAll('-', '');
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `draft_${datePart}_${randomPart}`;
}
