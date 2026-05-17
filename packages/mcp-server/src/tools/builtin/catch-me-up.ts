/**
 * Builtin `catch_me_up` tool. Returns the 50 most recent `evidence_log` rows
 * whose `occurred_at_ms` is at or after the caller-supplied `since` cutoff.
 * Read-only — does not trigger any polls or refresh integration state.
 *
 * `since` is an ISO datetime string on the wire so MCP clients don't need to
 * think in epoch ms; we convert to ms once for the SQL filter. Rows are sorted
 * newest-first because that's the question the tool answers ("what happened
 * recently?"). The cap of 50 is fixed by the contract — callers who need more
 * pages can advance `since` and re-query.
 */

import { CatchMeUpArgs, CatchMeUpResult, type EvidenceLogEntry } from '@slopweaver/contracts';
import { evidenceLog } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { desc, gte } from 'drizzle-orm';
import { defineTool, type Tool } from '../registry.ts';
import { shapeEvidenceRow } from '../shape-evidence.ts';

const MAX_RESULTS = 50;

export type CreateCatchMeUpToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. Affects only `generated_at`. */
  now?: () => number;
};

export function createCatchMeUpTool(args: CreateCatchMeUpToolArgs = {}): Tool {
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'catch_me_up',
    description:
      'Returns up to 50 evidence rows from the local cache that occurred at or after `since` (ISO datetime), newest first. Read-only.',
    inputSchema: CatchMeUpArgs,
    outputSchema: CatchMeUpResult,
    handler: async ({ input, ctx: { db } }) => {
      const sinceMs = Date.parse(input.since);
      const nowMs = now();

      const rows = db
        .select()
        .from(evidenceLog)
        .where(gte(evidenceLog.occurredAtMs, sinceMs))
        .orderBy(desc(evidenceLog.occurredAtMs))
        .limit(MAX_RESULTS)
        .all();

      const evidence: EvidenceLogEntry[] = rows.map(shapeEvidenceRow);

      return ok({
        evidence,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}
