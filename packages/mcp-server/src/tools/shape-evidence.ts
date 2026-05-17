/**
 * Shared helper for converting an `evidence_log` DB row into the wire-shape
 * `EvidenceLogEntry` returned by read tools (`start_session`, `catch_me_up`,
 * `search_work_context`). Centralizing the conversion keeps the defensive
 * behaviour for malformed `citation_url` / unparseable `payload_json`
 * consistent across every tool that emits evidence.
 *
 * Notes:
 *   - Always succeeds: every NOT-NULL DB column maps to a contract-valid field.
 *     Callers that need additional invariants (e.g. start_session also requires
 *     a non-empty title for its ranking item) layer those checks on top.
 *   - `citation_url` that fails URL parsing is downgraded to a canonical ref
 *     plus `citation_url: null` — the row is still emitted, just without the
 *     broken URL.
 *   - `payload_json` that fails JSON parsing is emitted as `null`.
 */

import { type EvidenceLogEntry, type Reference } from '@slopweaver/contracts';
import { type evidenceLog } from '@slopweaver/db';
import { z } from 'zod';

type EvidenceRow = typeof evidenceLog.$inferSelect;

const UrlSchema = z.url();

export function shapeEvidenceRow(row: EvidenceRow): EvidenceLogEntry {
  const ref = buildRef(row);
  const citationUrl = ref.kind === 'url' ? ref.url : null;
  const payload = tryParseJson(row.payloadJson);

  return {
    id: String(row.id),
    integration: row.integration,
    kind: row.kind,
    ref,
    occurred_at: new Date(row.occurredAtMs).toISOString(),
    payload_json: payload,
    citation_url: citationUrl,
  };
}

function buildRef(row: EvidenceRow): Reference {
  if (row.citationUrl != null && row.citationUrl.length > 0) {
    const parsed = UrlSchema.safeParse(row.citationUrl);
    if (parsed.success) {
      return { kind: 'url', url: parsed.data };
    }
  }
  return { kind: 'canonical', integration: row.integration, id: row.externalId };
}

function tryParseJson(json: string): EvidenceLogEntry['payload_json'] {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
