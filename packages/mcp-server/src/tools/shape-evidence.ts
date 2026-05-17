/**
 * Shared helper for converting an `evidence_log` DB row into the wire-shape
 * `EvidenceLogEntry` returned by read tools (`start_session`, `catch_me_up`,
 * `search_work_context`). Centralizing the conversion keeps the defensive
 * behaviour for malformed `citation_url` / unparseable `payload_json`
 * consistent across every tool that emits evidence.
 *
 * Returns `null` if the row cannot produce a contract-valid `EvidenceLogEntry`
 * — specifically if `integration` or `kind` is an empty string (the contract
 * requires both non-empty). Callers must filter `null` before emitting.
 *
 * Recoverable issues are downgraded inline:
 *   - `citation_url` that fails URL parsing → ref becomes canonical and
 *     `citation_url` is set to `null`; the row is still emitted.
 *   - `payload_json` that fails JSON parsing → `payload_json` is emitted as
 *     `null`.
 */

import { type EvidenceLogEntry, type Reference } from '@slopweaver/contracts';
import { type evidenceLog } from '@slopweaver/db';
import { z } from 'zod';

type EvidenceRow = typeof evidenceLog.$inferSelect;

const UrlSchema = z.url();

export function shapeEvidenceRow(row: EvidenceRow): EvidenceLogEntry | null {
  // EvidenceLogEntry's contract requires non-empty `integration` and `kind`.
  // The DB columns are `NOT NULL` but `text`, so an empty string is possible
  // (poller bug, ill-formed import). Skip rather than emit a row that would
  // fail wire-schema validation downstream.
  if (row.integration.length === 0 || row.kind.length === 0) {
    return null;
  }

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
