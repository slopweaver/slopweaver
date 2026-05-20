/**
 * `start_mega_audit` — the v1.1 headliner. Returns a fresh
 * `audit_id`, the resolved lookback window, and the full instructional
 * body the model should follow to execute the deep audit. The tool
 * itself is light: ID generation + clock math + a body template.
 *
 * Designed as a tool (not an MCP prompt) so it can ship on `main`
 * before the prompt-registry plumbing (PR #54) merges. When that PR
 * lands, a thin `/mega-audit` prompt shim will call this tool and
 * inline the returned instructions.
 */

import { StartMegaAuditArgs, StartMegaAuditResult } from '@slopweaver/contracts';
import { ok } from '@slopweaver/errors';
import { defineTool, type Tool } from '../../registry.ts';
import { renderInstructions } from './instructions.ts';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_PER_SOURCE_TOKEN_BUDGET = 90_000;

export type CreateStartMegaAuditToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** ID generator for tests. Defaults to a date + random shortid pair. */
  generateAuditId?: (nowMs: number) => string;
};

export function createStartMegaAuditTool(args: CreateStartMegaAuditToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const generateAuditId = args.generateAuditId ?? defaultGenerator;

  return defineTool({
    name: 'start_mega_audit',
    description:
      'Returns the instructional body for a cold-start mega-audit: a 1M-context-friendly orchestration that pulls 90 days of history from every connected MCP server in one pass and populates the AI work console (core-profile, team-directory, work files, voice rules). Pair with `record_audit_progress` for live UI streaming.',
    inputSchema: StartMegaAuditArgs,
    outputSchema: StartMegaAuditResult,
    handler: async ({ input }) => {
      const nowMs = now();
      const sinceMs = input.since != null ? Date.parse(`${input.since}T00:00:00Z`) : nowMs - NINETY_DAYS_MS;
      const since = formatDate(new Date(sinceMs));
      const budget = input.per_source_token_budget ?? DEFAULT_PER_SOURCE_TOKEN_BUDGET;
      const auditId = generateAuditId(nowMs);
      return ok({
        audit_id: auditId,
        instructions: renderInstructions({ since }),
        since,
        per_source_token_budget: budget,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}

function defaultGenerator(nowMs: number): string {
  const datePart = formatDate(new Date(nowMs)).replaceAll('-', '');
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `audit_${datePart}_${randomPart}`;
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
